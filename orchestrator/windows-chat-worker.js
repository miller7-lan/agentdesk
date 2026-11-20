const fs = require('node:fs');
const path = require('node:path');
const { createServer, connect } = require('node:net');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { Lines } = require('./transport');
const { WindowsProjectLeases } = require('./windows-project-leases');
const { createWindowsLocalShell } = require('./windows-local-shell');

const FRAME_LIMIT = 512 * 1024;

function endpoint(stateDir) {
  const name = createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest('hex').slice(0, 24);
  return '\\\\.\\pipe\\agentdesk-windows-chat-' + name;
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

function connectWorker(stateDir, secret, { onUpdate } = {}) {
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

function serveWorker(stateDir, setup = {}) {
  const secret = readSecret(stateDir);
  const leases = new WindowsProjectLeases(path.join(stateDir, 'leases.json'));
  const clients = new Set();
  const shell = createWindowsLocalShell({
    leases, journal: () => path.join(stateDir, 'runs.json'),
    notify: (scope, value) => {
      for (const client of clients) {
        try { client.send({ event: 'command', scope, value }); }
        catch { client.output.destroy(); }
      }
    },
    ...setup,
  });
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
        switch (operation) {
          case 'acquire': return leases.acquire(binding);
          case 'suspend': return leases.suspend(binding);
          case 'reconcile':
          case 'release': return leases.settle(binding, shell.canResume, { release: operation === 'release' });
          case 'shell': return shell.call(binding, args, { requestId });
          default: throw new Error('invalid_windows_chat_worker_operation');
        }
      }).then(
        (value) => { if (!socket.destroyed) wire.send({ id, ok: true, value }); },
        (error) => { if (!socket.destroyed) wire.send({ id, ok: false, error: error.message }); },
      ).catch(() => socket.destroy());
    });
  });
  return server.listen(endpoint(stateDir));
}

if (require.main === module) {
  if (process.platform !== 'win32' || !process.argv[2]) process.exit(2);
  serveWorker(process.argv[2]).once('error', () => { process.exitCode = 1; });
}

module.exports = { connectWorker, createSecret, serveWorker };
