const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('./store');
const { Lines, Relay } = require('./transport');
const { Endpoint, direct, expireMessages } = require('./rpc');
const { WindowsOperations, RemoteFiles } = require('./windows');
const { Scheduler } = require('./scheduler');
const { sweepAttachments } = require('./attachments');
const { EFFORT_LEVELS, modelProfiles } = require('./model-profiles');

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
  const lists = ['args', 'readonlyArgs', 'writeArgs', 'modelArgs', 'resumeArgs', 'effortArgs'];
  const fields = ['outputField', 'sessionField', 'usageField', 'errorField'];
  const allowed = new Set([...lists, ...fields, 'prompt', 'output', 'session', 'efforts']);
  if (Object.keys(template).some((key) => !allowed.has(key)) ||
      lists.some((key) => template[key] !== undefined && (!Array.isArray(template[key]) || template[key].length > 32 ||
        template[key].some((arg) => typeof arg !== 'string' || arg.length > 200))) ||
      (template.efforts !== undefined && (!Array.isArray(template.efforts) || !template.efforts.length ||
        new Set(template.efforts).size !== template.efforts.length || template.efforts.some((effort) => !EFFORT_LEVELS.includes(effort)))) ||
      (template.effortArgs !== undefined && template.efforts === undefined) ||
      fields.some((key) => template[key] !== undefined && (typeof template[key] !== 'string' || !/^[A-Za-z0-9_.]{1,80}$/.test(template[key]))) ||
      !['stdin', 'arg'].includes(template.prompt ?? 'stdin') || !['plain', 'jsonl'].includes(template.output ?? 'plain') ||
      !['none', 'generate', 'field'].includes(template.session ?? 'none') ||
      (template.prompt === 'arg' && !(template.args || []).some((arg) => arg.includes('{prompt}'))) ||
      (template.output === 'jsonl' && !template.outputField)) {
    throw new Error('invalid_' + name + '_template');
  }
  return { prompt: 'stdin', output: 'plain', session: 'none', ...structuredClone(template) };
}

// Roughly how many CLI calls a subscription allows per window, for CLIs that report no quota of their own.
function callLimits(value, name) {
  const ok = (n) => n === undefined || (Number.isInteger(n) && n > 0 && n <= 100000);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['fiveHour', 'weekly'].includes(key)) ||
      !ok(value.fiveHour) || !ok(value.weekly) || (value.fiveHour === undefined && value.weekly === undefined)) {
    throw new Error('invalid_call_limits:' + name);
  }
  return { ...(value.fiveHour && { fiveHour: value.fiveHour }), ...(value.weekly && { weekly: value.weekly }) };
}

function providerSettings(settings, name, home) {
  const safe = ['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'TZ'];
  const env = Object.fromEntries(safe.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  env.HOME = home;
  // Scheduler worktrees are created from the user's authorized repository, never an arbitrary folder.
  if (name === 'gemini') env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [key, filename] of Object.entries(settings.credentials || {})) {
    const permitted = { codex: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', grok: 'XAI_API_KEY', gemini: 'GEMINI_API_KEY' };
    if (key !== permitted[name]) throw new Error('unsupported_provider_credential');
    env[key] = fs.readFileSync(filename, 'utf8').trim();
  }
  const adapter = { bin: settings.bin, env, profiles: modelProfiles(settings), quotaFile: settings.quotaFile,
    authRequired: settings.authRequired === true, ...(settings.callLimits !== undefined && { callLimits: callLimits(settings.callLimits, name) }),
    // sandbox: run this CLI inside bubblewrap so it may run shell commands like Codex (see orchestrator/sandbox.js).
    ...(settings.sandbox && name !== 'codex' && { sandbox: {
      bin: typeof settings.sandbox === 'object' && settings.sandbox.bin || '/usr/bin/bwrap',
      stateDir: path.dirname(path.dirname(home)),
    } }) };
  if (settings.template !== undefined || name === 'antigravity') adapter.template = validateTemplate(settings.template, name);
  if (name === 'antigravity') {
    const directory = path.join(home, '.gemini', 'config');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, 'mcp_config.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    existing.mcpServers ||= {};
    // The MCP server enforces per-step write permission; the client list must include the write tools or a
    // member can see the Desktop but never change it. Existing installs are migrated, not only fresh ones.
    const tools = ['windows_list_locations', 'windows_list_directory', 'windows_stat_file',
      'windows_search_files', 'windows_grep_files', 'windows_read_file_chunk',
      'windows_write_file', 'windows_make_directory', 'windows_move_path', 'windows_delete_path'];
    const server = existing.mcpServers.agentdesk_windows;
    const before = JSON.stringify(server?.enabledTools);
    if (!server) {
      existing.mcpServers.agentdesk_windows = { command: process.execPath, args: [path.join(__dirname, 'mcp.js')], enabledTools: tools };
    } else {
      server.enabledTools = [...new Set([...(Array.isArray(server.enabledTools) ? server.enabledTools : []), ...tools])];
    }
    if (!server || JSON.stringify(existing.mcpServers.agentdesk_windows.enabledTools) !== before) {
      const temporary = filename + '.' + randomUUID();
      try {
        fs.writeFileSync(temporary, JSON.stringify(existing, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filename);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  }
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
  const writePolicy = path.join(home, 'agentdesk-write.toml');
  if (settings.allowWrites) fs.writeFileSync(writePolicy, `[[rule]]
toolName = "*"
decision = "deny"
priority = 980

[[rule]]
toolName = ["read_file", "list_directory", "glob", "grep_search", "write_file", "replace"]
decision = "allow"
priority = 990
`, { mode: 0o600 });
  return { ...adapter, reviewPolicy, ...(settings.allowWrites && { writePolicy }) };
}

function start(config) {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  // Codex and Claude are required (implementation and planning); the others join when configured.
  const namesOfAdapters = ['codex', 'claude', ...['grok', 'gemini', 'antigravity'].filter((name) => config.adapters[name])];
  config.adapters = Object.fromEntries(namesOfAdapters.map((name) =>
    [name, providerSettings({ ...config.adapters[name], allowWrites: config.writeProviders?.includes(name) }, name, path.join(config.stateDir, 'homes', name))]));
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
  // New models from the providers show up by themselves: every few hours (discoverModelsHours, default 6) each
  // CLI's list is read again — and Claude's from Anthropic's model list. It runs in the background: a slow or
  // signed-out CLI must not delay the service or hide another CLI's catalog.
  const modelCatalogTimer = config.discoverModels && setInterval(() => {
    scheduler.refreshModelCatalog().catch((error) => console.error('model catalog:', error.message));
  }, Math.min(48, Math.max(1, Number(config.discoverModelsHours) || 6)) * 3600_000);
  modelCatalogTimer?.unref();
  if (config.discoverModels) {
    scheduler.refreshModelCatalog().catch((error) => console.error('model catalog:', error.message));
  }
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
        if (!scope) throw new Error('mcp_permission_denied');
        const route = scheduler.bridgeRoute(scope.workspace);
        let value;
        if (['locations', 'read', 'list', 'stat', 'search', 'grep'].includes(frame.operation)) {
          const anyFolder = frame.root === 'computer';
          if (anyFolder && scope.readAnyFolder !== true) throw new Error('mcp_permission_denied: this step cannot read the whole computer');
          value = await files.call(route, scope.taskId, 'file.read', {
            operation: frame.operation, workspace: scope.workspace, root: frame.root, path: frame.path,
            query: frame.query, offset: frame.offset, version: frame.version, caseSensitive: frame.caseSensitive === true,
            ...(anyFolder && { anyFolder: true }),
          });
          if (frame.operation === 'locations' && Array.isArray(value?.locations)) {
            value = { ...value, locations: value.locations.filter((location) => location?.id !== 'computer' || scope.readAnyFolder === true) };
          }
        } else if (['write', 'mkdir', 'move', 'delete'].includes(frame.operation)) {
          // Any folder on the person's computer; the project itself only changes through reviewed patches.
          if (!scope.writeFiles) throw new Error('mcp_permission_denied: this step cannot change files on the person\'s computer');
          if (frame.root !== 'computer') throw new Error('mcp_permission_denied: write with root "computer" and an absolute path; project files are changed in the task workspace');
          const target = { workspace: scope.workspace, root: 'computer', anyFolder: true, path: frame.path };
          let current = frame.version;
          if (current === undefined && frame.operation !== 'mkdir') {
            // The model did not say which version it replaces: use the one there now (or none for a new file).
            current = await files.call(route, scope.taskId, 'file.read', { ...target, operation: 'stat' })
              .then((info) => info.version ?? null, (error) => { if (/invalid_path|ENOENT|no such/i.test(error.message)) return null; throw error; });
          }
          if (frame.operation === 'write') {
            if (typeof frame.content !== 'string') throw new Error('invalid_content');
            const bytes = Buffer.from(frame.content, frame.encoding === 'base64' ? 'base64' : 'utf8');
            const stream = await files.upload(route, scope.taskId, bytes);
            value = await files.call(route, scope.taskId, 'file.write', { ...target, operation: 'write', stream_id: stream, version: current ?? null });
          } else {
            value = await files.call(route, scope.taskId, 'file.write', { ...target, operation: frame.operation,
              ...(frame.operation !== 'mkdir' && { version: current ?? null }), ...(frame.operation === 'move' && { destination: frame.destination }) });
          }
        } else if (frame.operation === 'commands' || frame.operation === 'run') {
          // Commands run in the person's real project, so only scout and code-changing steps may use them,
          // and only the commands that workspace lists in agentCommands.
          if (!scope.runCommands) throw new Error('mcp_permission_denied: this step cannot run local commands');
          value = frame.operation === 'commands'
            ? await files.call(route, scope.taskId, 'command.execute', { operation: 'list_agent_commands', workspace: scope.workspace })
            : await files.call(route, scope.taskId, 'command.execute', {
              operation: 'run', workspace: scope.workspace, command: frame.command, permission: 'agent', timeout_ms: 300000,
            }, 310000);
          if (frame.operation === 'run') {
            const tail = (text) => typeof text === 'string' && text.length > 8000 ? '…' + text.slice(-8000) : text;
            value = { ...value, stdout: tail(value.stdout), stderr: tail(value.stderr) };
          }
        } else {
          throw new Error('mcp_permission_denied');
        }
        if (!socket.destroyed) wire.send({ ok: true, value });
      } catch (error) {
        if (!socket.destroyed) wire.send({ ok: false, error: error.message });
      }
    });
  });
  const maintenance = setInterval(() => {
    try { expireMessages(store); } catch (error) { console.error('maintenance:', error.message); }
    try { scheduler.tick(); } catch (error) { console.error('scheduler tick:', error.message); }
  }, 60000).unref();
  function close() {
    clearInterval(maintenance);
    clearInterval(enrollmentTimer);
    clearInterval(modelCatalogTimer);
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
      restart = setTimeout(connect, delay * (0.8 + Math.random() * 0.2));
      delay = Math.min(60000, delay * 2);
    });
  }
  // The person's home folder, read-only, for VPS2 to mount with sshfs (see sftp-readonly.js): a second SSH
  // session that asks the gateway for the mount socket and carries SFTP. Opt-in with "mountHome": true.
  let mountChild;
  let mountRestart;
  let mountDelay = 2000;
  const serveSftp = config.mountHome === true && config.ssh && require('./sftp-readonly').createReadOnlySftp({
    root: config.mountRoot || os.homedir(),
    // the Bridge's own state (keys, database) and its SSH key are never served
    hidden: [config.stateDir, config.ssh.key, config.ssh.certificate].filter(Boolean),
  });
  function connectMount() {
    if (stopped || !serveSftp) return;
    const session = mountChild = spawnSsh({ ...config.ssh, command: 'agentdesk-mount' });
    session.stderr?.setEncoding('utf8').on('data', (chunk) => log('home mount SSH:', chunk.trim().slice(0, 300)));
    session.stdin.on('error', () => session.kill());
    session.stdout.once('data', () => { mountDelay = 2000; });
    serveSftp(session.stdout, session.stdin);
    session.on('error', (error) => log('home mount SSH:', error.code || error.message));
    session.once('close', () => {
      if (stopped) return;
      mountRestart = setTimeout(connectMount, mountDelay * (0.8 + Math.random() * 0.2));
      mountDelay = Math.min(60000, mountDelay * 2);
    });
  }
  const control = config.controlSocket && unixServer(config.controlSocket, (socket) => {
    const wire = new Lines(socket);
    wire.once('frame', async ({ operation, taskId, prompt, provider, model, route, revision, reply, mode, project, replyTo, via, tags, reviewOf, stepId, artifact, attachments, after, group, leadEffort, leadModel, approval, autoHandover, stop, role, effort, routeOrder, action, reason, source, workspace: requestedWorkspace }) => {
      try {
        if (operation === 'attachment_state') {
          wire.send({ ok: true, value: config.stateDir });
          return;
        }
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
        if (!['submit', 'start_plan', 'plan_reply', 'plan_approve', 'status', 'cancel', 'stop_step', 'steer_step', 'revise_plan', 'approve_addition', 'handover_choose', 'apply', 'reconcile', 'select_route', 'quota_status', 'resource_status', 'broadcast', 'compact_project', 'project_tasks', 'task_diff', 'task_log', 'task_artifacts', 'task_activity', 'onboarding_check', 'diagnostics', 'maintenance'].includes(operation)) {
          throw new Error('unsupported_operation');
        }
        const active = value.route?.split(':')[0];
        const selected = operation === 'select_route' ? route : active;
        // Management and status can travel on either live channel, including when the selected route is down.
        const channel = value[selected] ? selected : value.ssh ? 'ssh' : value.relay ? 'relay' : null;
        if (!channel || (['submit', 'start_plan', 'broadcast'].includes(operation) && !value[active])) throw new Error('bridge_offline');
        const kind = operation === 'submit' ? 'task.request' : 'task.status';
        const body = { operation, route, revision, reply, project, after, stepId, artifact, action, reason, source,
          ...(operation === 'handover_choose' && { stop, role, model, effort }) };
        if (['submit', 'start_plan', 'broadcast', 'compact_project', 'project_tasks'].includes(operation)) {
          body.project ??= config.controlProject ?? (value.projects?.length === 1 ? value.projects[0] : undefined);
          const workspaces = config.controlWorkspaces || {};
          const workspace = requestedWorkspace ?? (Object.hasOwn(workspaces, body.project) ? workspaces[body.project] : config.controlWorkspace);
          if (operation !== 'project_tasks' || body.project === undefined) body.workspace = workspace;
          if (['submit', 'start_plan', 'broadcast'].includes(operation)) {
            Object.assign(body, { prompt, provider, model, mode, replyTo, via, tags, reviewOf, attachments, group, leadEffort, leadModel, approval, autoHandover, routeOrder });
          }
        }
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
  if (serveSftp) connectMount();
  const maintenance = setInterval(() => {
    try { expireMessages(store); } catch (error) { log('bridge maintenance:', error.message); }
    operations.sweepStreams().catch((error) => log('stream cleanup:', error.message));
    sweepAttachments(config.stateDir).catch((error) => log('attachment cleanup:', error.code || error.message));
  }, 60000).unref();
  return () => {
    clearInterval(maintenance);
    stopped = true;
    clearTimeout(restart);
    clearTimeout(mountRestart);
    mountChild?.kill();
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
