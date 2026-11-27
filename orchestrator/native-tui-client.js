// Native CLI single chats, the computer's side (see native-tui.js). One open session = one carrier process on
// VPS2 (native-tui-host.js through the root codex app-server's command/exec) multiplexing the project's SFTP, the
// CLI's terminal, the agentdesk tool relay and uploads.
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { Lines } = require('./transport');
const { NativeChannel, VERSION, TUI_TYPES } = require('./native-channel');

const HOST = '/opt/agentdesk-orchestrator/native-tui-host.js';
const UPLOAD_CHUNK = 48 * 1024;

// remote: remote.js connection; worker: Worker connection; binding: the project's acquired binding.
// tools: [{ name, description, inputSchema }]; callTool(name, args) -> MCP { content, isError }.
// onData(Buffer), onControl(object), onClose(error|null).
async function openNativeTui({ remote, worker, binding, provider, mode, sessionKey, platform = process.platform, name,
  cols = 120, rows = 32, tools = [], callTool, onData = () => {}, onControl = () => {}, onClose = () => {}, hostPath = HOST }) {
  const mount = await worker.openSftp(binding);
  const binaryIn = new PassThrough();
  const binaryOut = new PassThrough();
  const channel = new NativeChannel(binaryIn, binaryOut, TUI_TYPES);
  const relayIn = new PassThrough();
  const relayOut = new PassThrough();
  const relay = new Lines(relayIn, relayOut, 8 * 1024 * 1024);
  const uploadOut = new PassThrough();
  const uploads = new Lines(new PassThrough(), uploadOut, 1024 * 1024);
  const carrier = randomUUID();
  const waiting = new Map();
  let closed = false;
  let ready = false;
  let queued = Promise.resolve();
  let bytesPending = 0;
  let resolveReady;
  let rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  started.catch(() => {});
  const finish = (error = null) => {
    if (closed) return;
    closed = true;
    remote.off('notification', packet);
    remote.off('codex-down', down);
    mount.destroy();
    for (const stream of [binaryIn, binaryOut, relayIn, relayOut, uploadOut]) stream.destroy();
    for (const entry of waiting.values()) entry.reject(error || new Error('native_tui_closed'));
    waiting.clear();
    rejectReady(error || new Error('native_tui_closed'));
    onClose(error);
  };
  const down = () => finish(new Error('native_bridge_disconnected'));
  const packet = ({ method, params }) => {
    if (method !== 'command/exec/outputDelta' || params?.processId !== carrier) return;
    if (params.capReached) { finish(new Error('native_carrier_output_truncated')); return; }
    if (params.stream === 'stdout') binaryIn.write(Buffer.from(params.deltaBase64, 'base64'));
  };
  const send = (type, data) => { try { channel.send(type, data); } catch (error) { finish(error); } };
  remote.on('notification', packet);
  remote.on('codex-down', down);
  mount.once('error', (error) => finish(error));
  mount.once('close', () => finish(new Error('native_mount_closed')));
  mount.on('data', (data) => send('s', data));
  channel.on('s', (data) => {
    if (mount.writableLength + data.length > 8 * 1024 * 1024) finish(new Error('native_channel_backpressure'));
    else mount.write(data);
  });
  channel.on('t', (data) => onData(data));
  channel.on('m', (data) => relayIn.write(data));
  channel.on('c', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { finish(new Error('invalid_native_tui_control')); return; }
    if (message.protocolVersion !== VERSION) { finish(new Error('native_protocol_version_mismatch')); return; }
    if (message.state === 'ready') { ready = true; resolveReady(message); }
    if (message.state === 'failed') rejectReady(new Error(/^[a-z_]+$/.test(message.code || '') ? message.code : 'native_tui_failed'));
    if ((message.state === 'uploaded' || message.state === 'upload_failed') && waiting.has(message.id)) {
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.state === 'uploaded') entry.resolve(message.path);
      else entry.reject(new Error(message.code || 'upload_failed'));
    }
    onControl(message);
  });
  channel.on('failure', (error) => finish(error));
  relay.on('fault', (error) => finish(error));
  relayOut.on('data', (data) => send('m', data));
  uploadOut.on('data', (data) => send('u', data));
  // A tool call from the CLI (through the agentdesk MCP server): answered here, on this computer.
  relay.on('frame', (frame) => {
    if (frame?.type !== 'call' || !Number.isSafeInteger(frame.id)) return;
    Promise.resolve().then(() => {
      if (!tools.some((tool) => tool.name === frame.name)) throw new Error('tool_not_offered');
      return callTool(frame.name, frame.arguments || {});
    }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message || error).slice(0, 500) }))
      .then((answer) => { if (!closed) { try { relay.send({ type: 'result', id: frame.id, ...answer }); } catch {} } });
  });
  binaryOut.on('data', (data) => {
    bytesPending += data.length;
    if (bytesPending > 8 * 1024 * 1024) { finish(new Error('native_channel_backpressure')); return; }
    queued = queued.then(() => {
      if (!closed) return remote.request('command/exec/write', { processId: carrier, deltaBase64: data.toString('base64') });
    }).finally(() => { bytesPending -= data.length; });
    queued.catch((error) => finish(error));
  });
  const argv = ['/usr/bin/unshare', '--mount', '--propagation', 'private', '/opt/agentdesk-orchestrator/node', hostPath,
    provider, mode, sessionKey, platform, Buffer.from(String(name || 'project'), 'utf8').toString('hex').slice(0, 480),
    String(cols), String(rows)];
  const process = remote.request('command/exec', { command: argv, cwd: '/var/tmp', streamStdin: true,
    streamStdoutStderr: true, disableOutputCap: true, disableTimeout: true, processId: carrier,
    sandboxPolicy: { type: 'dangerFullAccess' } }, { timeoutMs: 7 * 24 * 60 * 60_000 });
  process.then(() => finish(null), (error) => finish(error));
  mount.resume();
  try { relay.send({ type: 'tools', tools }); } catch (error) { finish(error); }
  const timeout = setTimeout(() => finish(new Error('native_mount_timeout')), 60_000);
  let info;
  try { info = await started; } catch (error) {
    clearTimeout(timeout);
    finish(error);
    await remote.request('command/exec/terminate', { processId: carrier }).catch(() => {});
    throw error;
  }
  clearTimeout(timeout);
  return {
    info,
    get closed() { return closed; },
    get ready() { return ready; },
    input(data) { if (!closed) send('t', Buffer.from(data, typeof data === 'string' ? 'utf8' : undefined)); },
    resize(nextCols, nextRows) {
      if (!closed && Number.isInteger(nextCols) && Number.isInteger(nextRows)) {
        send('c', JSON.stringify({ protocolVersion: VERSION, op: 'resize', cols: nextCols, rows: nextRows }));
      }
    },
    // Sends one file to /uploads on VPS2; resolves with the path the CLI sees.
    upload(fileName, bytes) {
      if (closed) return Promise.reject(new Error('native_tui_closed'));
      const id = randomUUID();
      const done = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
      for (let offset = 0; offset < bytes.length || offset === 0; offset += UPLOAD_CHUNK) {
        const last = offset + UPLOAD_CHUNK >= bytes.length;
        uploads.send({ id, name: fileName, data: bytes.subarray(offset, offset + UPLOAD_CHUNK).toString('base64'), last });
        if (last) break;
      }
      return done;
    },
    async close() {
      if (!closed) send('c', JSON.stringify({ protocolVersion: VERSION, op: 'close' }));
      setTimeout(() => remote.request('command/exec/terminate', { processId: carrier }).catch(() => {}), 3000).unref?.();
      await Promise.race([process.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
      finish(null);
    },
  };
}

module.exports = { openNativeTui };
