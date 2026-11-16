const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const Store = require('./store');
const { Lines, Relay } = require('./transport');
const { Endpoint, direct, expireMessages } = require('./rpc');
const { WindowsOperations, RemoteFiles } = require('./windows');
const { Scheduler } = require('./scheduler');

function relayConfig(config, role) {
  return {
    host: config.host, port: config.port, servername: config.servername, deviceId: config.deviceId, role,
    token: fs.readFileSync(config.tokenFile, 'utf8').trim(),
    ca: config.caFile ? fs.readFileSync(config.caFile) : undefined,
  };
}

function unixServer(filename, handler) {
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

function providerSettings(settings, name, home) {
  const safe = ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'TZ'];
  const env = Object.fromEntries(safe.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  env.HOME = home;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [key, filename] of Object.entries(settings.credentials || {})) {
    const permitted = { codex: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', grok: 'XAI_API_KEY' };
    if (key !== permitted[name]) throw new Error('unsupported_provider_credential');
    env[key] = fs.readFileSync(filename, 'utf8').trim();
  }
  return { bin: settings.bin, env };
}

function start(config) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  config.adapters = Object.fromEntries(['codex', 'claude', 'grok'].map((name) =>
    [name, providerSettings(config.adapters[name], name, path.join(config.stateDir, 'homes', name))]));
  const store = new Store(path.join(config.stateDir, 'orchestrator.sqlite'));
  const endpoint = new Endpoint(store, (frame, route) => scheduler.control(frame, route));
  endpoint.on('fault', (code) => console.error('endpoint:', code));
  const files = new RemoteFiles(endpoint);
  const capabilities = new Map();
  config.mcp = { socket: path.join(config.stateDir, 'mcp.sock'), capabilities };
  const grokDir = path.join(config.adapters.grok.env.HOME, '.grok');
  fs.mkdirSync(grokDir, { recursive: true, mode: 0o700 });
  try {
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
  const names = config.sshBridges || [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !/^[a-z0-9]{1,16}$/.test(name)) ||
      new Set(names).size !== names.length) throw new Error('invalid_ssh_bridges');
  const namedRelays = Object.entries(config.relayBridges || {});
  if (namedRelays.some(([name]) => !names.includes(name))) throw new Error('unknown_relay_bridge');
  const relays = [
    ...(config.relay ? [['relay', config.relay]] : []),
    ...namedRelays.map(([name, relay]) => ['relay:' + name, relay]),
  ].map(([route, settings]) => {
    const relay = new Relay(relayConfig(settings, 'orchestrator'));
    endpoint.attach(route, relay);
    relay.on('ready', () => scheduler.pump());
    relay.on('presence', () => scheduler.pump());
    relay.start();
    return relay;
  });
  const bridges = ['', ...names].map((name) => {
    const socketName = name ? 'bridge-' + name + '.sock' : 'bridge.sock';
    const route = name ? 'ssh:' + name : 'ssh';
    return unixServer(path.join(config.stateDir, socketName), (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      endpoint.attach(route, direct(new Lines(socket), () => socket.destroy()));
      scheduler.pump();
    });
  });
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
    scheduler.stopped = true;
    for (const controller of scheduler.running.values()) controller.abort(new Error('service_stopping'));
    for (const relay of relays) relay.stop();
    for (const socket of sockets) socket.destroy();
    for (const bridge of bridges) bridge.close();
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
    wire.once('frame', async ({ operation, taskId, prompt, provider, model, route }) => {
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
        if (!['submit', 'status', 'cancel', 'apply', 'reconcile', 'select_route'].includes(operation)) {
          throw new Error('unsupported_operation');
        }
        const active = value.route?.split(':')[0];
        const selected = operation === 'select_route' ? route : active;
        // Management and status can travel on either live channel, including when the selected route is down.
        const channel = value[selected] ? selected : value.ssh ? 'ssh' : value.relay ? 'relay' : null;
        if (!channel || (operation === 'submit' && !value[active])) throw new Error('bridge_offline');
        const kind = operation === 'submit' ? 'task.request' : 'task.status';
        const body = operation === 'submit' ? { workspace: config.controlWorkspace, prompt, provider, model } : { operation, route };
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
    control?.close();
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

module.exports = { start, startBridge, relayConfig, providerSettings };
