const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { Lines } = require('./transport');
const { NativeChannel, VERSION } = require('./native-channel');
const { localShellSpec } = require('./windows-local-shell');

const METHODS = new Set(['thread/start', 'thread/resume', 'thread/read', 'thread/name/set', 'thread/archive',
  'thread/unsubscribe', 'turn/start', 'turn/interrupt', 'turn/steer', 'skills/list', 'model/list',
  'attachment/reset', 'attachment/chunk']);

function workspacePolicy(folder, mode) {
  return mode === 'read' ? { type: 'readOnly', networkAccess: false } :
    { type: 'workspaceWrite', writableRoots: [folder], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

async function openWindowsNativeSeat({
  remote, worker, identity, binding, hostPath = '/opt/agentdesk-orchestrator/native-project-session-host.js',
  sessionKey, historyRoot, onNotification = () => {},
}) {
  let closed = false;
  let threadId = identity.threadId.startsWith('pending-') ? null : identity.threadId;
  let turnId = null;
  let turnWritable = false;
  let startingTurn = false;
  const pending = new Map();
  const seatClosed = new EventEmitter();
  const mount = await worker.openSftp(binding);
  const binaryIn = new PassThrough();
  const binaryOut = new PassThrough();
  const providerIn = new PassThrough();
  const providerOut = new PassThrough();
  const channel = new NativeChannel(binaryIn, binaryOut);
  const wire = new Lines(providerIn, providerOut, 4 * 1024 * 1024);
  const carrier = randomUUID();
  let queued = Promise.resolve();
  let bytesPending = 0;
  let next = 0;
  let folder;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const fail = (reason = new Error('native_bridge_disconnected')) => {
    if (closed) return;
    closed = true;
    remote.off('notification', packet);
    remote.off('codex-down', fail);
    mount.destroy();
    for (const stream of [binaryIn, binaryOut, providerIn, providerOut]) stream.destroy();
    rejectReady(reason);
    for (const call of pending.values()) call.reject(reason);
    pending.clear();
    if (threadId && turnId) {
      const code = /^[a-z0-9_]{2,80}$/i.test(reason?.message || '') ? reason.message : 'native_bridge_disconnected';
      onNotification({ method: 'error', params: { threadId, willRetry: false,
        error: { code, message: '连接已中断，请先核对 Windows 文件与后台命令的状态。' } } });
      onNotification({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', error: { code } } } });
    }
    seatClosed.emit('close');
  };
  const packet = ({ method, params }) => {
    if (method !== 'command/exec/outputDelta' || params?.processId !== carrier) return;
    if (params.capReached) { fail(new Error('native_carrier_output_truncated')); return; }
    if (params.stream === 'stdout') binaryIn.write(Buffer.from(params.deltaBase64, 'base64'));
  };
  const send = (type, data) => {
    try { channel.send(type, data); } catch (error) { fail(error); }
  };
  remote.on('notification', packet);
  remote.on('codex-down', fail);
  mount.once('error', fail);
  mount.once('close', () => fail());
  mount.on('data', (data) => send('s', data));
  channel.on('s', (data) => {
    if (mount.writableLength + data.length > 8 * 1024 * 1024) fail(new Error('native_channel_backpressure'));
    else mount.write(data);
  });
  channel.on('p', (data) => providerIn.write(data));
  channel.on('c', (data) => {
    try {
      const control = JSON.parse(data.toString());
      if (control.protocolVersion !== VERSION) throw new Error('native_protocol_version_mismatch');
      if (control.state !== 'ready' || typeof control.mountPath !== 'string' ||
          !/^\/var\/tmp\/agentdesk-native-seat-[\w-]+\/windows-chat-mounts\/project-[\w-]+$/.test(control.mountPath)) {
        throw new Error(typeof control.code === 'string' && /^[a-z_]+$/.test(control.code) ? control.code : 'invalid_native_mount_status');
      }
      folder = control.mountPath;
      resolveReady();
    } catch (error) { fail(error); }
  });
  channel.on('failure', fail);
  wire.on('fault', fail);
  providerOut.on('data', (data) => send('p', data));
  binaryOut.on('data', (data) => {
    bytesPending += data.length;
    if (bytesPending > 8 * 1024 * 1024) { fail(new Error('native_channel_backpressure')); return; }
    queued = queued.then(() => {
      if (!closed) return remote.request('command/exec/write', { processId: carrier, deltaBase64: data.toString('base64') });
    }).finally(() => { bytesPending -= data.length; });
    queued.catch(fail);
  });
  const provider = identity.provider;
  const mode = identity.fullAccess ? 'write' : 'read';
  const argv = ['/usr/bin/unshare', '--mount', '--propagation', 'private', '/opt/agentdesk-orchestrator/node', hostPath, provider, mode,
    ...(sessionKey ? [sessionKey, ...(historyRoot ? [historyRoot] : [])] : [])];
  const process = remote.request('command/exec', { command: argv, cwd: '/var/tmp', streamStdin: true,
    streamStdoutStderr: true, disableOutputCap: true, disableTimeout: true, processId: carrier,
    sandboxPolicy: { type: 'dangerFullAccess' } }, { timeoutMs: 24 * 60 * 60_000 });
  process.then(() => fail(), fail);
  mount.resume();
  const call = (method, params) => {
    if (closed) return Promise.reject(new Error('native_bridge_disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => fail(new Error('native_provider_request_timeout')), 120_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      try { wire.send({ id, method, params }); } catch (error) { fail(error); }
    });
  };
  wire.on('frame', (frame) => {
    if (frame.method && frame.id !== undefined) {
      const p = frame.params || {};
      Promise.resolve().then(async () => {
        if (frame.method !== 'item/tool/call' || p.tool !== 'local_shell' || !threadId || p.threadId !== threadId ||
            !turnId || p.turnId !== turnId || !turnWritable || !p.arguments || p.namespace) throw new Error('native_tool_not_authorized');
        const requestId = createHash('sha256').update(JSON.stringify([threadId, turnId, p.itemId || frame.id])).digest('hex');
        const value = await worker.request('shell', { binding, args: p.arguments, requestId });
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
      }).then((result) => { if (!closed) wire.send({ id: frame.id, result }); }, () => {
        if (!closed) wire.send({ id: frame.id, result: { success: false, contentItems: [
          { type: 'inputText', text: 'Windows 命令未获授权或状态有待核对。请查询原运行，遇到未知结果先核对本机。' },
        ] } });
      }).catch(fail);
      return;
    }
    if (frame.method) {
      const p = frame.params || {};
      if (p.threadId !== threadId) return;
      if (frame.method === 'turn/started') turnId = p.turn.id;
      if (frame.method === 'turn/completed') { turnId = null; turnWritable = false; }
      onNotification(frame);
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(frame.error.message));
    else entry.resolve(frame.result);
  });
  const timeout = setTimeout(() => fail(new Error('native_mount_timeout')), 45_000);
  try {
    await ready;
    clearTimeout(timeout);
    await call('initialize', { clientInfo: { name: 'agentdesk-native', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    wire.send({ method: 'initialized', params: {} });
  } catch (error) {
    clearTimeout(timeout);
    fail(error);
    await remote.request('command/exec/terminate', { processId: carrier }).catch(() => {});
    throw error;
  }
  return {
    get closed() { return closed; },
    onClose: (listener) => seatClosed.once('close', listener),
    async request(method, params = {}) {
      if (method === 'review/start') throw new Error('Windows 原生项目请在只读规划模式下发起审查。');
      if (!METHODS.has(method) || (params.threadId && threadId !== params.threadId)) throw new Error('native_provider_request_denied');
      const launch = method === 'thread/start' || method === 'thread/resume';
      if (method === 'thread/start' && threadId) throw new Error('native_provider_request_denied');
      const isTurn = method === 'turn/start';
      if (isTurn && (turnId || startingTurn)) throw new Error('该会话已有正在启动或运行的轮次。');
      const activeMode = params.sandboxPolicy?.type === 'readOnly' ? 'read' : mode;
      if (isTurn && activeMode === 'write' && params.approvalPolicy && params.approvalPolicy !== 'never') {
        throw new Error('原生单聊请选择完全访问或只读规划。');
      }
      const toolSet = activeMode === 'write' ? [localShellSpec] : [];
      let value = { ...params };
      if (launch || isTurn) {
        value = { ...value, cwd: folder, approvalPolicy: 'never', sandboxPolicy: workspacePolicy(folder, activeMode) };
      }
      if (launch && provider === 'codex') {
        delete value.sandboxPolicy;
        value.sandbox = mode === 'write' ? 'workspace-write' : 'read-only';
        if (method === 'thread/start') value.ephemeral = false;
      }
      if (launch || (method === 'turn/start' && provider !== 'codex')) value.dynamicTools = toolSet;
      if (method === 'skills/list') value.cwds = [folder];
      if (isTurn) { startingTurn = true; turnWritable = activeMode === 'write'; }
      let reply;
      try { reply = await call(method, value); }
      catch (error) {
        if (isTurn && !turnId) turnWritable = false;
        throw error;
      } finally { if (isTurn) startingTurn = false; }
      if (method === 'thread/start') {
        const actual = reply.thread.id;
        const promoted = await worker.request('promote', { binding, threadId: actual });
        binding = { ...binding, ...promoted, threadId: actual };
        threadId = actual;
      }
      if (method === 'thread/archive' || method === 'thread/unsubscribe') await this.close({ confirmedIdle: !turnId });
      return reply;
    },
    async close({ confirmedIdle = false } = {}) {
      let recognized = false;
      if (confirmedIdle && !turnId && !startingTurn && !closed) {
        recognized = await worker.request('completeSftp', { binding }).catch(() => false);
      }
      fail();
      await remote.request('command/exec/terminate', { processId: carrier }).catch(() => {});
      await process.catch(() => {});
      if (recognized) await worker.request('release', { binding }).catch(() => {});
    },
  };
}

module.exports = { openWindowsNativeSeat, workspacePolicy };
