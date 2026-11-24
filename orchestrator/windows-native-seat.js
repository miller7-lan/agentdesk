const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { Lines } = require('./transport');
const { NativeChannel, VERSION } = require('./native-channel');
// The local_shell the model sees matches this computer: PowerShell/CMD on Windows, zsh/bash on a Mac.
const localShellSpec = require('./windows-local-shell').shellSpecFor();
const { terminalSpec, lockSpec } = require('./terminal-sessions');
const { nativePermissionPrompt } = require('./permission-prompt');
const NATIVE_TOOLS = new Set(['local_shell', 'terminal', 'file_lock_acquire']);

const METHODS = new Set(['thread/start', 'thread/resume', 'thread/read', 'thread/name/set', 'thread/archive', 'thread/delete',
  'thread/unsubscribe', 'turn/start', 'turn/interrupt', 'turn/steer', 'skills/list', 'model/list',
  'attachment/reset', 'attachment/chunk']);

function workspacePolicy(folder, mode) {
  return mode === 'read' ? { type: 'readOnly', networkAccess: false } :
    // Network on, as for the other CLIs' shells on VPS2 (package installs, fetching references).
    { type: 'workspaceWrite', writableRoots: [folder], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

async function openWindowsNativeSeat({
  remote, worker, identity, binding, hostPath = '/opt/agentdesk-orchestrator/native-project-session-host.js',
  sessionKey, historyRoot, onNotification = () => {}, onServerRequest = null, checkpoints = true,
}) {
  // What this computer's Worker offers: an interactive terminal only where node-pty is installed (gate G2).
  const optional = (operation, fields) => Promise.resolve().then(() => worker.request(operation, fields)).catch(() => null);
  const offered = (await optional('capabilities', {})) || {};
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
  let timeout;
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
        error: { code, message: '连接已中断，请先核对本机文件与后台命令的状态。' } } });
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
      // D15 / Q6: the machine or this device is at its limit; the seat waits in line (no mount timeout meanwhile).
      if (control.state === 'queued' && Number.isSafeInteger(control.position)) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fail(new Error('native_seat_queue_timeout')), 30 * 60_000);
        onNotification({ method: 'agentdesk/seatQueued', params: { threadId: threadId || identity.threadId, position: control.position } });
        return;
      }
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
    // A question for the person (Codex request_user_input, or agentdesk_ask_user from a chat CLI) of this seat's
    // running turn goes to the app; nothing else but the native tools below is let through.
    if (frame.method === 'item/tool/requestUserInput' && frame.id !== undefined) {
      const p = frame.params || {};
      Promise.resolve().then(() => {
        if (!onServerRequest || !threadId || p.threadId !== threadId || !turnId || p.turnId !== turnId) throw new Error('native_question_not_authorized');
        return onServerRequest(frame);
      }).then((result) => { if (!closed) wire.send({ id: frame.id, result }); },
        (error) => { if (!closed) wire.send({ id: frame.id, error: { code: -32603, message: error?.message || 'native_question_failed' } }); });
      return;
    }
    if (frame.method && frame.id !== undefined) {
      const p = frame.params || {};
      Promise.resolve().then(async () => {
        if (frame.method !== 'item/tool/call' || !NATIVE_TOOLS.has(p.tool) || !threadId || p.threadId !== threadId ||
            !turnId || p.turnId !== turnId || !turnWritable || !p.arguments || p.namespace) throw new Error('native_tool_not_authorized');
        const requestId = createHash('sha256').update(JSON.stringify([threadId, turnId, p.itemId || frame.id])).digest('hex');
        const value = p.tool === 'terminal' ? await worker.request('terminal', { binding, args: p.arguments })
          : p.tool === 'file_lock_acquire' ? await worker.request('lockFiles', { binding, files: p.arguments.paths })
            : await worker.request('shell', { binding, args: p.arguments, requestId });
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
      }).then((result) => { if (!closed) wire.send({ id: frame.id, result }); }, () => {
        if (!closed) wire.send({ id: frame.id, result: { success: false, contentItems: [
          { type: 'inputText', text: '本机命令未获授权或状态有待核对。请查询原运行，遇到未知结果先核对本机。' },
        ] } });
      }).catch(fail);
      return;
    }
    if (frame.method) {
      const p = frame.params || {};
      if (p.threadId !== threadId) return;
      if (frame.method === 'turn/started') turnId = p.turn.id;
      if (frame.method === 'turn/completed') {
        turnId = null;
        turnWritable = false;
        // Q2: this session's file locks end with its turn.
        optional('endTurn', { binding });
      }
      onNotification(frame);
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(frame.error.message));
    else entry.resolve(frame.result);
  });
  timeout = setTimeout(() => fail(new Error('native_mount_timeout')), 45_000);
  try {
    await ready;
    clearTimeout(timeout);
    // A chat CLI (not Codex) may offer agentdesk_ask_user only when its questions reach the app (onServerRequest).
    await call('initialize', { clientInfo: { name: 'agentdesk-native', version: '1.0.0' },
      capabilities: { experimentalApi: true, ...(identity.provider !== 'codex' && onServerRequest && { questionCards: true }) } });
    wire.send({ method: 'initialized', params: {} });
  } catch (error) {
    clearTimeout(timeout);
    fail(error);
    await remote.request('command/exec/terminate', { processId: carrier }).catch(() => {});
    throw error;
  }
  return {
    get closed() { return closed; },
    get busy() { return Boolean(turnId || startingTurn); },
    onClose: (listener) => seatClosed.once('close', listener),
    async request(method, params = {}) {
      if (method === 'review/start') throw new Error('原生项目请在只读规划模式下发起审查。');
      if (!METHODS.has(method) || (params.threadId && threadId !== params.threadId)) throw new Error('native_provider_request_denied');
      const launch = method === 'thread/start' || method === 'thread/resume';
      if (method === 'thread/start' && threadId) throw new Error('native_provider_request_denied');
      const isTurn = method === 'turn/start';
      if (isTurn && (turnId || startingTurn)) throw new Error('该会话已有正在启动或运行的轮次。');
      const activeMode = params.sandboxPolicy?.type === 'readOnly' ? 'read' : mode;
      if (isTurn && activeMode === 'write' && params.approvalPolicy && params.approvalPolicy !== 'never') {
        throw new Error('原生单聊请选择完全访问或只读规划。');
      }
      const toolSet = activeMode === 'write' ? [localShellSpec, lockSpec, ...(offered.pty ? [terminalSpec()] : [])] : [];
      let value = { ...params };
      if (launch || isTurn) {
        value = { ...value, cwd: folder, approvalPolicy: 'never', sandboxPolicy: workspacePolicy(folder, activeMode) };
      }
      if (launch && provider === 'codex') {
        delete value.sandboxPolicy;
        value.sandbox = mode === 'write' ? 'workspace-write' : 'read-only';
        if (method === 'thread/start') value.ephemeral = false;
        // The permission statement every model in a native chat gets (chat-server.js uses the same text).
        value.developerInstructions = [nativePermissionPrompt({ platform: process.platform, writable: mode === 'write' }),
          typeof params.developerInstructions === 'string' ? params.developerInstructions : ''].filter(Boolean).join('\n\n');
      }
      if (method === 'thread/start' && provider !== 'codex') value.nativePlatform = process.platform;
      if (launch || (method === 'turn/start' && provider !== 'codex')) value.dynamicTools = toolSet;
      if (method === 'skills/list') value.cwds = [folder];
      if (isTurn) { startingTurn = true; turnWritable = activeMode === 'write'; }
      // D8: before a turn that may write, record the project state under refs/agentdesk/checkpoints/*.
      if (isTurn && activeMode === 'write' && checkpoints) {
        await optional('checkpoint', { binding, turn: 't' + Date.now() });
      }
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
      if (method === 'thread/archive' || method === 'thread/delete' || method === 'thread/unsubscribe') await this.close({ confirmedIdle: !turnId });
      if (launch) return { ...reply, windowsNative: true, activeTurnId: turnId };
      return reply;
    },
    // A skill from this computer (~/.codex/skills, ~/.agents/skills) for a Codex native chat. Codex runs sandboxed
    // on VPS2 and sees only its own CODEX_HOME there, so the files go into CODEX_HOME/agentdesk-skills through this
    // seat's app-server, that folder is registered as an extra skill root, and the list is reloaded to confirm.
    async installSkill({ name, folder: skillFolder, files } = {}) {
      if (provider !== 'codex') throw new Error('只有 Codex 支持本地技能。');
      if (typeof name !== 'string' || !name || typeof skillFolder !== 'string' || !/^[\w.-]{1,80}$/.test(skillFolder) ||
          skillFolder.startsWith('.') || !Array.isArray(files) || !files.length) throw new Error('invalid_skill');
      const listed = await call('skills/list', { cwds: [folder] });
      const system = (listed?.data || []).flatMap((entry) => entry.skills || []).find((skill) => skill.scope === 'system' &&
        typeof skill.path === 'string' && skill.path.includes('/skills/.system/'));
      if (!system) throw new Error('VPS 上的 Codex 没有返回技能目录，无法安装本地技能。');
      const home = system.path.slice(0, system.path.indexOf('/skills/.system/'));
      const root = home + '/agentdesk-skills';
      const dest = root + '/' + skillFolder;
      const made = new Set();
      for (const file of files) {
        const rel = String(file?.rel || '');
        if (!rel || rel.startsWith('/') || rel.split('/').some((part) => !part || part === '.' || part === '..') ||
            typeof file.b64 !== 'string') throw new Error('invalid_skill');
        // One frame per file; the provider wire takes 4 MB lines.
        if (file.b64.length > 3 * 1024 * 1024) throw new Error('技能里有单个文件超过 2 MB，未上传。');
        const full = dest + '/' + rel;
        const dir = full.slice(0, full.lastIndexOf('/'));
        if (!made.has(dir)) { await call('fs/createDirectory', { path: dir, recursive: true }); made.add(dir); }
        await call('fs/writeFile', { path: full, dataBase64: file.b64 });
      }
      await call('skills/extraRoots/set', { extraRoots: [root] });
      const reloaded = await call('skills/list', { cwds: [folder], forceReload: true });
      const found = (reloaded?.data || []).some((entry) => (entry.skills || []).some((skill) => skill.enabled !== false && skill.name === name));
      if (!found) throw new Error('技能已上传，但 Codex 没有识别；请升级 VPS 上的 Codex。');
      return { path: dest + '/SKILL.md' };
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
