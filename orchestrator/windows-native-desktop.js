const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createWorkerClient, createSecret } = require('./windows-chat-worker');
const { openWindowsNativeSeat } = require('./windows-native-seat');
const { NATIVE_PROVIDERS } = require('./native-channel');

const HOST = '/opt/agentdesk-orchestrator/native-project-session-host.js';
const supported = new Set(NATIVE_PROVIDERS);

function sameRoot(left, right) {
  try { return fs.realpathSync.native(left).toLowerCase() === fs.realpathSync.native(right).toLowerCase(); }
  catch { return false; }
}

// Windows and macOS: the official CLI on VPS2 works directly in this computer's project (mounted over SFTP),
// and its local_shell runs here.
function createWindowsNativeDesktop({ stateDir, remote, findProject, findWorktree, bridgeSettings, onEvent, onCommand, reviewUnknown }) {
  const worker = createWorkerClient(stateDir, { onUpdate: (scope, run) => {
    try {
      const [, provider, threadId] = JSON.parse(scope);
      onCommand(provider, threadId, { ...run, id: run.runId, code: run.exitCode });
    } catch {}
  } });
  const file = path.join(stateDir, 'threads.json');
  const records = new Map();
  try {
    for (const entry of JSON.parse(fs.readFileSync(file, 'utf8'))) records.set(entry.threadId, entry);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const seats = new Map();
  let checkedAt = 0;
  let capability = false;
  let checking;
  const deviceId = () => createHash('sha256').update(createSecret(stateDir)).digest('hex');
  const save = (record) => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID();
    const snapshot = new Map(records).set(record.threadId, record);
    try {
      fs.writeFileSync(temp, JSON.stringify([...snapshot.values()]), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      records.set(record.threadId, record);
    } finally { try { fs.unlinkSync(temp); } catch {} }
  };
  function resolveProject(projectId, worktreeSession) {
    const project = findProject(projectId);
    if (project?.kind !== 'local' || !project.localRoot) return null;
    if (project.orchestratorWorkspace) {
      const bridge = bridgeSettings();
      const config = bridge?.workspaces?.[project.orchestratorWorkspace];
      if (!bridge?.ssh || bridge.ssh.host !== remote.cfg.host ||
          Number(bridge.ssh.port || 22) !== Number(remote.cfg.port || 22) ||
          config?.write !== true || !sameRoot(config.root, project.localRoot)) {
        throw new Error('该项目的 Bridge 写入授权与本机目录不匹配，请检查项目绑定。');
      }
    }
    if (worktreeSession !== undefined) {
      const tree = typeof worktreeSession === 'string' && findWorktree(worktreeSession);
      if (!tree || tree.projectId !== project.id || !sameRoot(tree.repo, project.localRoot)) {
        throw new Error('独立工作树与当前项目不匹配。');
      }
      return { id: project.id, root: fs.realpathSync.native(tree.path) };
    }
    return { id: project.id, root: fs.realpathSync.native(project.localRoot) };
  }
  async function hasHost() {
    if (Date.now() - checkedAt < 10_000) return capability;
    checking ||= remote.request('command/exec', { command: ['/usr/bin/test', '-r', HOST], cwd: '/var/tmp',
      timeoutMs: 3000, sandboxPolicy: { type: 'dangerFullAccess' } }, { timeoutMs: 8000 })
      .then((result) => {
        checkedAt = Date.now();
        capability = result.exitCode === 0;
        return capability;
      }).finally(() => { checking = null; });
    return checking;
  }
  async function attached(record, project) {
    const current = seats.get(record.threadId);
    if (current) return current;
    const opening = (async () => {
      const connection = await worker.get();
      const identity = { device: deviceId(), provider: record.provider, projectId: project.id, root: project.root,
        threadId: record.threadId, fullAccess: true };
      let binding = { ...identity, ...await connection.request('acquire', { binding: identity }) };
      if (binding.suspended) {
        let ready = await connection.request('reconcile', { binding });
        if (!ready && reviewUnknown) {
          const status = await connection.request('shell', { binding, args: { action: 'list' } });
          const active = status.runs.some((run) => ['running', 'cancelling', 'queued'].includes(run.state));
          if (!active && await reviewUnknown()) ready = await connection.request('acknowledge', { binding });
        }
        if (!ready) throw new Error('本机项目已暂停。请先核对上次连接中的本机文件和命令。');
        binding = { ...identity, ...await connection.request('acquire', { binding: identity }) };
      }
      let seat;
      try {
        seat = await openWindowsNativeSeat({ remote, worker: connection, identity, binding, sessionKey: record.sessionKey,
          onNotification: (event) => onEvent(record.provider, event) });
      } catch (error) {
        await connection.request('release', { binding }).catch(() => {});
        throw error;
      }
      seat.onClose(() => {
        for (const [key, value] of seats) if (value === opening) seats.delete(key);
      });
      if (!record.threadId.startsWith('pending-')) {
        try { await seat.request('thread/resume', { threadId: record.threadId }); }
        catch (error) {
          // Codex may create a thread ID before any rollout exists. Here it explicitly confirmed
          // that there is no history to resume; no model turn has been started on this attachment.
          const missingHistory = record.provider === 'codex' && /\bno rollout found\b/i.test(error.message);
          await seat.close({ confirmedIdle: missingHistory }).catch(() => {});
          if (missingHistory) throw new Error('Codex 尚无可恢复的历史记录，已尝试释放空会话租约。请重新打开会话或新建单聊。');
          throw error;
        }
      }
      return seat;
    })();
    seats.set(record.threadId, opening);
    opening.catch(() => { if (seats.get(record.threadId) === opening) seats.delete(record.threadId); });
    return opening;
  }
  return {
    async select(provider, method, params = {}) {
      if (!supported.has(provider)) return null;
      const existing = params.threadId && records.get(params.threadId);
      if (existing) {
        if (existing.provider !== provider || (params.projectId && existing.projectId !== params.projectId)) {
          throw new Error('该单聊属于另一个已授权的本机项目。');
        }
        const project = resolveProject(existing.projectId, existing.worktreeSession);
        if (!project || !sameRoot(project.root, existing.root)) throw new Error('本机项目与原会话授权目录不匹配。');
        if (!seats.has(existing.threadId) && !await remote.wake()) throw new Error('本机终端所需的 VPS 连接未就绪，请重连后重试。');
        return attached(existing, project);
      }
      if (method !== 'thread/start' || params.approvalPolicy !== 'never' ||
          (params.sandboxPolicy?.type !== 'dangerFullAccess' && params.sandbox !== 'danger-full-access')) return null;
      const project = resolveProject(params.projectId, params.worktreeSession);
      if (!project) return null;
      if (!await remote.wake()) throw new Error('本机终端所需的 VPS 连接未就绪，请重连后重试。');
      if (!await hasHost()) throw new Error('VPS 缺少原生单聊服务，请更新服务端后重试。');
      const pending = { provider, worktreeSession: params.worktreeSession, projectId: project.id, root: project.root, threadId: 'pending-' + randomUUID(),
        sessionKey: createHash('sha256').update(deviceId() + ':' + randomUUID()).digest('hex') };
      const seat = await attached(pending, project);
      return {
        async request(name, request) {
          try {
            const reply = await seat.request(name, request);
            const record = { ...pending, threadId: reply.thread.id };
            save(record);
            seats.set(record.threadId, seats.get(pending.threadId));
            seats.delete(pending.threadId);
            return reply;
          } catch (error) {
            await seat.close().catch(() => {});
            throw error;
          }
        },
      };
    },
    async commands(provider, threadId, action, runId) {
      const record = records.get(threadId);
      if (!record || record.provider !== provider) return undefined;
      const project = resolveProject(record.projectId, record.worktreeSession);
      if (!project || !sameRoot(project.root, record.root)) return action === 'list' ? [] : null;
      const identity = { device: deviceId(), provider, threadId, projectId: project.id, root: project.root, fullAccess: true };
      const connection = await worker.get();
      const binding = await connection.request('lookup', { binding: identity });
      if (!binding) return action === 'list' ? [] : null;
      const value = await connection.request('shell', { binding: { ...identity, ...binding }, args: { action, runId } });
      const normalize = (run) => ({ ...run, id: run.runId, code: run.exitCode });
      return action === 'list' ? value.runs.map(normalize) : normalize(value);
    },
    disconnect: () => worker.disconnect(),
  };
}

const createNativeDesktop = createWindowsNativeDesktop;

module.exports = { createWindowsNativeDesktop, createNativeDesktop };
