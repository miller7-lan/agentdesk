const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const Store = require('./store');
const { Lines, Relay } = require('./transport');
const { Endpoint, direct, expireMessages } = require('./rpc');
const { WindowsOperations, RemoteFiles } = require('./windows');
const { Scheduler } = require('./scheduler');
const { modelProfiles } = require('./model-profiles');

function relayConfig(config, role) {
  return {
    host: config.host, port: config.port, servername: config.servername, deviceId: config.deviceId, role,
    token: fs.readFileSync(config.tokenFile, 'utf8').trim(),
    ca: config.caFile ? fs.readFileSync(config.caFile) : undefined,
  };
}

function unixServer(filename, handler) {
  if (process.platform === 'win32') return createServer(handler).listen(filename);
  try {
    if (!fs.lstatSync(filename).isSocket()) throw new Error('socket_path_occupied');
    fs.unlinkSync(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const server = createServer(handler);
  server.listen(filename, () => fs.chmodSync(filename, 0o600));
  return server;
}

// A CLI configured by template (see OPERATIONS.md): which flags to pass, how the prompt is given and
// which JSON fields hold the reply, the session ID and token use. Every value is checked here.
function validateTemplate(template, name) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw new Error(name + '_template_required');
  const lists = ['args', 'readonlyArgs', 'writeArgs', 'modelArgs', 'resumeArgs'];
  const fields = ['outputField', 'sessionField', 'usageField'];
  const allowed = new Set([...lists, ...fields, 'prompt', 'output', 'session']);
  if (Object.keys(template).some((key) => !allowed.has(key)) ||
      lists.some((key) => template[key] !== undefined && (!Array.isArray(template[key]) || template[key].length > 32 ||
        template[key].some((arg) => typeof arg !== 'string' || arg.length > 200))) ||
      fields.some((key) => template[key] !== undefined && (typeof template[key] !== 'string' || !/^[A-Za-z0-9_.]{1,80}$/.test(template[key]))) ||
      !['stdin', 'arg'].includes(template.prompt ?? 'stdin') || !['plain', 'jsonl'].includes(template.output ?? 'plain') ||
      !['none', 'generate', 'field'].includes(template.session ?? 'none') ||
      (template.prompt === 'arg' && !(template.args || []).some((arg) => arg.includes('{prompt}'))) ||
      (template.output === 'jsonl' && !template.outputField)) {
    throw new Error('invalid_' + name + '_template');
  }
  return { prompt: 'stdin', output: 'plain', session: 'none', ...structuredClone(template) };
}

function providerSettings(settings, name, home) {
  const safe = ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'TZ'];
  const env = Object.fromEntries(safe.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  env.HOME = home;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [key, filename] of Object.entries(settings.credentials || {})) {
    const permitted = { codex: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', grok: 'XAI_API_KEY', gemini: 'GEMINI_API_KEY' };
    if (key !== permitted[name]) throw new Error('unsupported_provider_credential');
    env[key] = fs.readFileSync(filename, 'utf8').trim();
  }
  const adapter = { bin: settings.bin, env, profiles: modelProfiles(settings), quotaFile: settings.quotaFile };
  if (settings.template !== undefined || name === 'antigravity') adapter.template = validateTemplate(settings.template, name);
  if (name !== 'gemini' || adapter.template) return adapter;
  fs.accessSync(settings.bin, fs.constants.X_OK);
  const reviewPolicy = path.join(home, 'agentdesk-review.toml');
  fs.writeFileSync(reviewPolicy, `[[rule]]
toolName = "*"
decision = "deny"
priority = 980

[[rule]]
toolName = ["read_file", "list_directory", "glob", "grep_search"]
decision = "allow"
priority = 990
`, { mode: 0o600 });
  return { ...adapter, reviewPolicy };
}

function start(config) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  // Codex and Claude are required (implementation and planning); the others join when configured.
  const namesOfAdapters = ['codex', 'claude', ...['grok', 'gemini', 'antigravity'].filter((name) => config.adapters[name])];
  config.adapters = Object.fromEntries(namesOfAdapters.map((name) =>
    [name, providerSettings(config.adapters[name], name, path.join(config.stateDir, 'homes', name))]));
  const store = new Store(path.join(config.stateDir, 'orchestrator.sqlite'));
  const endpoint = new Endpoint(store, (frame, route) => scheduler.control(frame, route));
  endpoint.on('fault', (code) => console.error('endpoint:', code));
  const files = new RemoteFiles(endpoint);
  const capabilities = new Map();
  config.mcp = { socket: path.join(config.stateDir, 'mcp.sock'), capabilities };
  const grokDir = config.adapters.grok && path.join(config.adapters.grok.env.HOME, '.grok');
  if (grokDir) fs.mkdirSync(grokDir, { recursive: true, mode: 0o700 });
  if (grokDir) try {
    const args = [path.join(__dirname, 'mcp.js'), '${AGENTDESK_MCP_SOCKET}', '${AGENTDESK_MCP_CAPABILITY}'];
    fs.writeFileSync(path.join(grokDir, 'config.toml'),
      '[mcp_servers.agentdesk_windows]\ncommand = ' + JSON.stringify(process.execPath) +
      '\nargs = ' + JSON.stringify(args) + '\n',
      { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const scheduler = new Scheduler({ config, store, files });
  const sockets = new Set();
  const names = config.sshBridges ||= [];
  config.relayBridges ||= {};
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !/^[a-z0-9]{1,16}$/.test(name)) ||
      new Set(names).size !== names.length) throw new Error('invalid_ssh_bridges');
  const relays = new Map();
  const bridges = new Map();
  function attachRelay(route, settings) {
    relays.get(route)?.stop();
    const relay = new Relay(settings);
    endpoint.attach(route, relay);
    relay.on('ready', () => scheduler.pump());
    relay.on('presence', () => scheduler.pump());
    relay.start();
    relays.set(route, relay);
  }
  function attachBridge(name) {
    if (bridges.has(name)) return;
    const socketName = name ? 'bridge-' + name + '.sock' : 'bridge.sock';
    const route = name ? 'ssh:' + name : 'ssh';
    const server = unixServer(path.join(config.stateDir, socketName), (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      endpoint.attach(route, direct(new Lines(socket), () => socket.destroy()));
      scheduler.pump();
    });
    bridges.set(name, server);
  }
  if (config.relay) attachRelay('relay', relayConfig(config.relay, 'orchestrator'));
  for (const [name, relay] of Object.entries(config.relayBridges)) {
    if (!names.includes(name)) throw new Error('unknown_relay_bridge');
    attachRelay('relay:' + name, relayConfig(relay, 'orchestrator'));
  }
  for (const name of ['', ...names]) attachBridge(name);
  const dynamic = new Map();

  function syncEnrollment() {
    const settings = config.enrollmentSessions;
    if (!settings) return;
    const active = new Set();
    const now = Date.now() / 1000;
    for (const file of fs.readdirSync(settings.directory)) {
      if (!/^d[0-9a-f]{14}\.json$/.test(file)) continue;
      const record = JSON.parse(fs.readFileSync(path.join(settings.directory, file)));
      const { id, expires, token } = record;
      if (id + '.json' !== file || typeof expires !== 'number' || expires <= now ||
          !/^[A-Za-z0-9_-]{43}$/.test(token)) continue;
      active.add(id);
      if (dynamic.get(id) === expires) continue;
      if (!dynamic.has(id)) names.push(id);
      config.workspaces[id] = { repository: settings.repository, sshBridge: id };
      config.relayBridges[id] = true;
      attachBridge(id);
      attachRelay('relay:' + id, {
        role: 'orchestrator', deviceId: id + '-orchestrator', token,
        host: settings.relayHost, port: settings.relayPort || 22022,
        ca: fs.readFileSync(settings.relayCaFile),
      });
      dynamic.set(id, expires);
    }
    for (const id of dynamic.keys()) {
      if (active.has(id)) continue;
      dynamic.delete(id);
      names.splice(names.indexOf(id), 1);
      delete config.workspaces[id];
      delete config.relayBridges[id];
      endpoint['ssh:' + id]?.close();
      bridges.get(id)?.close();
      bridges.delete(id);
      relays.get('relay:' + id)?.stop();
      relays.delete('relay:' + id);
    }
  }
  syncEnrollment();
  const enrollmentTimer = config.enrollmentSessions && setInterval(() => {
    try { syncEnrollment(); } catch (error) { console.error('enrollment sync:', error.code || error.message); }
  }, 1000).unref();
  function bridgeRoute(frame) {
    if (frame.bridge !== undefined) {
      if (!names.includes(frame.bridge)) throw new Error('unknown_ssh_bridge');
      return scheduler.namedBridgeRoute(frame.bridge);
    }
    const workspace = frame.body?.workspace ?? scheduler.tasks.get(frame.task_id)?.workspace;
    return scheduler.bridgeRoute(workspace);
  }
  const admin = unixServer(path.join(config.stateDir, 'admin.sock'), (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const wire = new Lines(socket);
    wire.on('fault', (error) => console.error('admin:', error.message));
    wire.on('frame', async (frame) => {
      try {
        const timeout = frame.kind === 'command.execute' ? 910000
          : frame.kind === 'file.patch' ? 90000 : frame.kind === 'task.request' ? 60000 : 30000;
        const value = frame.operation === 'bridge'
          ? await files.call(bridgeRoute(frame), frame.task_id, frame.kind, frame.body, timeout)
          : await scheduler.control(frame, 'admin');
        if (!socket.destroyed) wire.send({ ok: true, value });
      } catch (error) {
        if (!socket.destroyed) wire.send({ ok: false, error: error.message, request_id: error.requestId });
      }
    });
  });
  const mcp = unixServer(config.mcp.socket, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const wire = new Lines(socket);
    wire.on('fault', (error) => console.error('mcp:', error.message));
    wire.once('frame', async (frame) => {
      try {
        const scope = capabilities.get(frame.capability);
        if (!scope || !['read', 'list', 'stat', 'search'].includes(frame.operation)) throw new Error('mcp_permission_denied');
        const value = await files.call(scheduler.bridgeRoute(scope.workspace), scope.taskId, 'file.read', {
          operation: frame.operation, workspace: scope.workspace, path: frame.path,
          query: frame.query, offset: frame.offset, version: frame.version,
        });
        if (!socket.destroyed) wire.send({ ok: true, value });
      } catch (error) {
        if (!socket.destroyed) wire.send({ ok: false, error: error.message });
      }
    });
  });
  const maintenance = setInterval(() => {
    try { expireMessages(store); } catch (error) { console.error('maintenance:', error.message); }
  }, 60000).unref();
  function close() {
    clearInterval(maintenance);
    clearInterval(enrollmentTimer);
    scheduler.stopped = true;
    for (const controller of scheduler.running.values()) controller.abort(new Error('service_stopping'));
    for (const relay of relays.values()) relay.stop();
    for (const socket of sockets) socket.destroy();
    for (const bridge of bridges.values()) bridge.close();
    admin.close();
    mcp.close();
  }
  return { scheduler, endpoint, close };
}

function startBridge({ config, desktop, recycle, spawnSsh, log = console.error }) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(config.stateDir, 'bridge.sqlite'));
  const operations = new WindowsOperations({ config, store, desktop, recycle });
  const endpoint = new Endpoint(store, (frame) => operations.call(frame));
  endpoint.on('fault', (code) => log('windows bridge:', code));
  const relay = config.relay && new Relay(relayConfig(config.relay, 'bridge'));
  if (relay) {
    endpoint.attach('relay', relay);
    relay.start();
  }
  let stopped = false;
  let child;
  let restart;
  let delay = 1000;
  function connect() {
    if (stopped) return;
    const session = child = spawnSsh(config.ssh);
    const wire = new Lines(session.stdout, session.stdin);
    session.stderr?.setEncoding('utf8').on('data', (chunk) => log('bridge SSH:', chunk.trim().slice(0, 500)));
    session.stdin.on('error', () => session.kill());
    wire.once('frame', () => { delay = 1000; });
    endpoint.attach('ssh', direct(wire, () => session.kill()));
    session.on('error', (error) => log('bridge SSH:', error.code || error.message));
    session.once('close', () => {
      if (stopped) return;
      restart = setTimeout(connect, delay);
      delay = Math.min(30000, delay * 2);
    });
  }
  const control = config.controlSocket && unixServer(config.controlSocket, (socket) => {
    const wire = new Lines(socket);
    wire.once('frame', async ({ operation, taskId, prompt, provider, model, route, revision, reply }) => {
      try {
        const id = taskId || randomUUID();
        const status = async () => {
          for (const channel of ['ssh', 'relay']) {
            try {
              return await endpoint.request(channel, randomUUID(), 'task.status', { operation: 'route_status' }, 2500);
            } catch {}
          }
          return { route: null, ssh: false, relay: false };
        };
        const value = await status();
        if (operation === 'routes') {
          wire.send({ ok: true, value });
          return;
        }
        if (!['submit', 'start_plan', 'plan_reply', 'plan_approve', 'status', 'cancel', 'apply', 'reconcile', 'select_route', 'quota_status'].includes(operation)) {
          throw new Error('unsupported_operation');
        }
        const active = value.route?.split(':')[0];
        const selected = operation === 'select_route' ? route : active;
        // Management and status can travel on either live channel, including when the selected route is down.
        const channel = value[selected] ? selected : value.ssh ? 'ssh' : value.relay ? 'relay' : null;
        if (!channel || (['submit', 'start_plan'].includes(operation) && !value[active])) throw new Error('bridge_offline');
        const kind = operation === 'submit' ? 'task.request' : 'task.status';
        const body = ['submit', 'start_plan'].includes(operation)
          ? { operation, workspace: config.controlWorkspace, prompt, provider, model }
          : { operation, route, revision, reply };
        const answer = await endpoint.request(channel, id, kind, body, operation === 'apply' ? 300000 : 10000);
        wire.send({ ok: true, value: answer });
      } catch (error) {
        if (!socket.destroyed) wire.send({ ok: false, error: error.message });
      } finally {
        socket.end();
      }
    });
  });
  if (config.ssh) connect();
  const maintenance = setInterval(() => {
    try { expireMessages(store); } catch (error) { log('bridge maintenance:', error.message); }
    operations.sweepStreams().catch((error) => log('stream cleanup:', error.message));
  }, 60000).unref();
  return () => {
    clearInterval(maintenance);
    stopped = true;
    clearTimeout(restart);
    control?.close(() => {
      try { store.close(); } catch {}
    });
    child?.kill();
    relay?.stop();
    for (const command of operations.commands.values()) command.controller.abort(new Error('bridge_stopping'));
  };
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { close } = start(config);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

module.exports = { start, startBridge, relayConfig, providerSettings, validateTemplate };
