const fs = require('node:fs');
const path = require('node:path');
const { createServer, connect } = require('node:net');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Lines } = require('./transport');
const { WindowsProjectLeases } = require('./windows-project-leases');
const { createWindowsLocalShell } = require('./windows-local-shell');
const { makeProtocol, errorResponse } = require('./windows-native-protocol');

const FRAME_LIMIT = 512 * 1024;

// Windows: a named pipe. macOS (and Linux, for tests): a Unix socket in the per-user temporary folder (socket
// paths are limited to about 100 characters, too short for Application Support); the worker key still guards it.
function endpoint(stateDir, suffix = '') {
  const name = createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return '\\\\.\\pipe\\agentdesk-windows-chat-' + name + suffix;
  return path.join(require('node:os').tmpdir(), 'agentdesk-chat-' + name + suffix + '.sock');
}
function listenOn(server, address) {
  if (process.platform !== 'win32') {
    try { if (fs.lstatSync(address).isSocket()) fs.unlinkSync(address); } catch {}
    return server.listen(address, () => { try { fs.chmodSync(address, 0o600); } catch {} });
  }
  return server.listen(address);
}

function readSecret(stateDir) {
  const file = path.join(stateDir, 'worker.key');
  const value = fs.readFileSync(file);
  if (value.length !== 32) throw new Error('invalid_windows_chat_worker_key');
  return value;
}

function createSecret(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(path.join(stateDir, 'worker.key'), randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readSecret(stateDir);
}

function connectWorker(stateDir, secret, { onUpdate, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint(stateDir));
    const wire = new Lines(socket, socket, FRAME_LIMIT);
    const pending = new Map();
    let connected = false;
    let next = 0;
    const timer = setTimeout(() => socket.destroy(new Error('windows_chat_worker_timeout')), 5000);
    const connection = {
      request(operation, fields = {}) {
        if (socket.destroyed) return Promise.reject(new Error('windows_chat_worker_disconnected'));
        const id = ++next;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try { wire.send({ ...fields, id, operation }); }
          catch (error) { pending.delete(id); reject(error); }
        });
      },
      close: () => socket.destroy(),
      get connected() { return connected && !socket.destroyed; },
      async openSftp(binding) {
        const { token } = await connection.request('prepareSftp', { binding });
        return new Promise((resolve, reject) => {
          const stream = connect(endpoint(stateDir, '-sftp'));
          const timeout = setTimeout(() => stream.destroy(new Error('windows_chat_worker_timeout')), 5000);
          const fail = (error) => { clearTimeout(timeout); reject(error); };
          stream.once('error', fail);
          stream.once('close', () => fail(new Error('windows_chat_worker_disconnected')));
          stream.once('connect', () => stream.write(token + '\n'));
          stream.once('data', (data) => {
            clearTimeout(timeout);
            if (data[0] !== 1) { stream.destroy(new Error('native_chat_lease_denied')); return; }
            stream.pause();
            if (data.length > 1) stream.unshift(data.subarray(1));
            resolve(stream);
          });
        });
      },
    };
    socket.once('connect', () => wire.send({ auth: secret.toString('hex') }));
    wire.on('frame', (frame) => {
      if (!connected) {
        if (frame.ready !== true) { socket.destroy(new Error('windows_chat_worker_auth_failed')); return; }
        connected = true;
        clearTimeout(timer);
        resolve(connection);
        return;
      }
      if (frame.event === 'command') { onUpdate?.(frame.scope, frame.value); return; }
      if (frame.event === 'lock' || frame.event === 'terminal') { onEvent?.(frame.event, frame.value); return; }
      const pendingCall = pending.get(frame.id);
      if (!pendingCall) return;
      pending.delete(frame.id);
      if (frame.ok) pendingCall.resolve(frame.value);
      else pendingCall.reject(new Error(frame.error || 'windows_chat_worker_failed'));
    });
    wire.on('fault', (error) => { if (!connected) reject(error); });
    wire.once('closed', () => {
      clearTimeout(timer);
      const error = new Error('windows_chat_worker_disconnected');
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      if (!connected) reject(error);
    });
  });
}

// Version of the idle/shutdown operations below; an older Worker answers them with
// invalid_windows_chat_worker_operation, which the app treats as "cannot confirm" (orchestrator/worker-idle.js).
const WORKER_IDLE_PROTOCOL = 1;

function serveWorker(stateDir, setup = {}) {
  const { resolveSession, mount, onShutdown, ...shellOptions } = setup;
  let closing = false;
  let sftpSessions = 0;
  const secret = readSecret(stateDir);
  const leases = new WindowsProjectLeases(path.join(stateDir, 'leases.json'));
  const clients = new Set();
  const acceptedStreams = new Map();
  const shell = createWindowsLocalShell({
    leases, journal: () => path.join(stateDir, 'runs.json'), stateDir,
    notify: (scope, value) => {
      for (const client of clients) {
        try { client.send({ event: 'command', scope, value }); }
        catch { client.output.destroy(); }
      }
    },
    ...shellOptions,
  });
  const protocol = makeProtocol({ leases, shell, mount });
  const broadcast = (event, value) => {
    for (const client of clients) {
      try { client.send({ event, value }); }
      catch { client.output.destroy(); }
    }
  };
  // File-lock events (waiting, released, stale write, bypassed) and terminal events go to every app window.
  leases.locks.on('event', (value) => broadcast('lock', value));
  const { TerminalSessions } = require('./terminal-sessions');
  const { macSandboxProfile } = require('./windows-local-shell');
  const terminals = setup.terminals || new TerminalSessions({
    profile: () => process.platform === 'darwin' ? macSandboxProfile({ extra: [stateDir] }) : undefined,
    onEvent: (value) => broadcast('terminal', value),
  });
  if (setup.terminals) {
    // A caller-provided TerminalSessions (tests, packaged smoke checks) still streams its events to the windows.
    const own = terminals.onEvent;
    terminals.onEvent = (value) => { try { own?.(value); } catch {} broadcast('terminal', value); };
  }
  function idleStatus() {
    const runs = shell.activity();
    // A terminal registry this Worker cannot read counts as busy (-1), never as "no terminals".
    const live = terminals.terminals instanceof Map ? [...terminals.terminals.values()].filter((item) => !item.exited).length : -1;
    const leaseList = [...leases.leases.values()];
    const status = {
      protocol: WORKER_IDLE_PROTOCOL, version: (() => { try { return require('../package.json').version; } catch { return null; } })(),
      runningCommands: runs.running, unknownCommands: runs.unknown, liveTerminals: live,
      fileOperations: leaseList.filter((lease) => lease.fileOperation).length,
      reconciling: leases.reconciling.size, fileLocks: leases.locks.locks?.size ?? 0,
      pendingStreams: acceptedStreams.size, sftpSessions, leases: leaseList.length,
    };
    status.idle = !status.runningCommands && !status.unknownCommands && status.liveTerminals === 0 && !status.fileOperations &&
      !status.reconciling && !status.fileLocks && !status.pendingStreams;
    return status;
  }
  const sweep = setInterval(() => terminals.sweep(), 10 * 60_000);
  sweep.unref();
  const { createCheckpoint, restoreCheckpoint, list: listCheckpoints } = require('./git-checkpoints');
  const server = createServer((socket) => {
    const wire = new Lines(socket, socket, FRAME_LIMIT);
    let authed = false;
    const timer = setTimeout(() => socket.destroy(), 3000);
    wire.on('fault', () => socket.destroy());
    wire.on('closed', () => { clients.delete(wire); clearTimeout(timer); });
    wire.on('frame', (frame) => {
      if (!authed) {
        if (!/^[0-9a-f]{64}$/.test(frame.auth || '') ||
            !timingSafeEqual(secret, Buffer.from(frame.auth, 'hex'))) { socket.destroy(); return; }
        authed = true;
        clients.add(wire);
        clearTimeout(timer);
        wire.send({ ready: true });
        return;
      }
      const { id, operation, binding, args, requestId } = frame;
      Promise.resolve().then(() => {
        if (closing) throw new Error('windows_chat_worker_shutting_down');
        switch (operation) {
          // Read-only: what is still running or unsettled here. Nothing is stopped or changed.
          case 'idleStatus': return idleStatus();
          // Ends this Worker only when idleStatus is idle at this very moment (checked and acted on in one step,
          // so no new command can slip in between). Otherwise nothing happens and the status is returned.
          case 'shutdownIfIdle': {
            const status = idleStatus();
            if (!status.idle) return { ...status, shutdown: false };
            closing = true;
            setImmediate(() => {
              terminals.closeAll?.();
              server.close();
              for (const client of clients) { try { client.output.destroy(); } catch {} }
              try { onShutdown?.(); } catch {}
            });
            return { ...status, shutdown: true };
          }
          case 'acquire': return leases.acquire(binding);
          case 'lookup': return leases.lookup(binding);
          case 'suspend': return leases.suspend(binding);
          case 'promote': return leases.promote(binding, frame.threadId);
          case 'completeSftp': return leases.completeSftp(binding);
          case 'reconcile':
          case 'release': return leases.settle(binding, shell.canResume, { release: operation === 'release' });
          case 'acknowledge': return leases.settle(binding, (lease) => shell.canResume(lease, { acknowledgeUnknown: true }),
            { acknowledgeFiles: true });
          case 'shell': return shell.call(binding, args, { requestId });
          case 'capabilities': return { pty: terminals.available, locks: true, checkpoints: true, sharedWrite: true };
          case 'endTurn': return leases.endTurn(binding);
          case 'lockFiles': return leases.lockFiles(binding, frame.files);
          case 'lockStatus': return leases.lockStatus(binding);
          case 'terminal': {
            const lease = leases.get(binding, { writable: true });
            return terminals.call(lease.scope, args, { cwd: lease.directory });
          }
          // From the app window, not the model: the person takes a terminal over, types into it, hands it back.
          case 'terminalTakeover': {
            const lease = leases.get(binding, { allowSuspended: true });
            return terminals.takeover(lease.scope, frame.terminalId, frame.on === true);
          }
          case 'terminalInput': {
            const lease = leases.get(binding, { allowSuspended: true });
            return terminals.write(lease.scope, frame.terminalId, frame.data, { byUser: true });
          }
          // The person's own terminal actions from the chat window (open, resize, Ctrl+C, close). They work while the
          // lease is suspended too: the terminal belongs to the person, not to a model turn.
          case 'terminalOpen': {
            const lease = leases.get(binding, { allowSuspended: true });
            if (!lease.fullAccess) throw new Error('native_chat_read_only');
            return terminals.open(lease.scope, { cwd: lease.directory, shell: frame.shell, cols: frame.cols, rows: frame.rows });
          }
          case 'terminalResize': {
            const lease = leases.get(binding, { allowSuspended: true });
            return terminals.resize(lease.scope, frame.terminalId, frame.cols, frame.rows);
          }
          case 'terminalSignal': {
            const lease = leases.get(binding, { allowSuspended: true });
            return terminals.signal(lease.scope, frame.terminalId, frame.signal);
          }
          case 'terminalClose': {
            const lease = leases.get(binding, { allowSuspended: true });
            return terminals.close(lease.scope, frame.terminalId);
          }
          case 'terminalRead': {
            const lease = leases.get(binding, { allowSuspended: true });
            return frame.terminalId ? terminals.read(lease.scope, frame.terminalId, frame.cursor) : { terminals: terminals.list(lease.scope) };
          }
          case 'checkpoint': {
            const lease = leases.get(binding, { writable: true, current: true });
            return createCheckpoint(lease.directory, { session: lease.id.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '_'),
              turn: String(frame.turn || Date.now()).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80), enabled: frame.enabled !== false });
          }
          case 'checkpoints': {
            const lease = leases.get(binding, { allowSuspended: true });
            return listCheckpoints(lease.directory);
          }
          case 'restoreCheckpoint': {
            const lease = leases.get(binding, { writable: true, current: true });
            const others = leases.lockStatus(binding).locks.some((item) => !item.mine);
            return restoreCheckpoint(lease.directory, frame.ref, { othersHoldLocks: others });
          }
          case 'prepareSftp': {
            leases.get(binding, { current: true });
            const token = randomBytes(32).toString('base64url');
            const timeout = setTimeout(() => acceptedStreams.delete(token), 5000);
            timeout.unref();
            acceptedStreams.set(token, { binding, timeout });
            return { token };
          }
          case 'native': return Promise.resolve(resolveSession?.(frame.sessionId))
            .then((context) => protocol(args, context), (error) => errorResponse(error, args?.requestId));
          default: throw new Error('invalid_windows_chat_worker_operation');
        }
      }).then(
        (value) => { if (!socket.destroyed) wire.send({ id, ok: true, value }); },
        (error) => { if (!socket.destroyed) wire.send({ id, ok: false, error: error.message }); },
      ).catch(() => socket.destroy());
    });
  });
  const sftp = createServer((socket) => {
    let header = Buffer.alloc(0);
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => {});
    socket.once('close', () => clearTimeout(deadline));
    const collect = (chunk) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf(10);
      if (end < 0 && header.length < 44) return;
      if (end !== 43) { socket.destroy(); return; }
      const token = header.subarray(0, end).toString('ascii');
      const ticket = acceptedStreams.get(token);
      if (!ticket) { socket.destroy(); return; }
      clearTimeout(deadline);
      clearTimeout(ticket.timeout);
      acceptedStreams.delete(token);
      socket.off('data', collect);
      socket.pause();
      if (header.length > end + 1) socket.unshift(header.subarray(end + 1));
      try {
        sftpSessions++;
        socket.once('close', () => { sftpSessions--; });
        leases.serveSftp(ticket.binding, socket, socket).done.catch(() => socket.destroy());
        socket.write(Buffer.from([1]));
      } catch { socket.destroy(); }
    };
    socket.on('data', collect);
  });
  sftp.on('error', (error) => {
    server.close();
    server.emit('error', error);
  });
  server.once('close', () => { sftp.close(); clearInterval(sweep); });
  listenOn(sftp, endpoint(stateDir, '-sftp'));
  return listenOn(server, endpoint(stateDir));
}

function createWorkerClient(stateDir, { onUpdate, onEvent, launch = spawn, executable = process.execPath } = {}) {
  let connection;
  let opening;
  let launching = false;
  const connect = () => connectWorker(stateDir, createSecret(stateDir), { onUpdate, onEvent });
  return {
    async get() {
      if (connection?.connected) return connection;
      opening ||= (async () => {
        try { connection = await connect(); }
        catch (error) {
          if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
          if (!launching) {
            launching = true;
            const child = launch(executable, [__filename, stateDir], { detached: true, windowsHide: true,
              stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
            child.on('error', () => { launching = false; });
            child.once('exit', () => { launching = false; });
            child.unref();
          }
          for (let attempt = 0; attempt < 30; attempt++) {
            await delay(100);
            try { connection = await connect(); break; }
            catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
          }
          if (!connection?.connected) throw new Error('windows_chat_worker_timeout');
        }
        return connection;
      })().finally(() => { opening = null; });
      return opening;
    },
    disconnect() { connection?.close(); },
  };
}

if (require.main === module) {
  if (!['win32', 'darwin'].includes(process.platform) || !process.argv[2]) process.exit(2);
  serveWorker(process.argv[2], { onShutdown: () => setTimeout(() => process.exit(0), 200) }).once('error', () => { process.exitCode = 1; });
}

module.exports = { connectWorker, createSecret, createWorkerClient, serveWorker, endpoint, WORKER_IDLE_PROTOCOL };
