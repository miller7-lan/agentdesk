const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createWorkerClient, createSecret, connectWorker } = require('./windows-chat-worker');
const { openWindowsNativeSeat } = require('./windows-native-seat');
const { openNativeTui } = require('./native-tui-client');
const { TUI_PROVIDERS } = require('./native-tui');
const { shellSpecFor } = require('./windows-local-shell');
const { terminalSpec } = require('./terminal-sessions');
const { NATIVE_PROVIDERS } = require('./native-channel');

const HOST = '/opt/agentdesk-orchestrator/native-project-session-host.js';
const TUI_HOST = '/opt/agentdesk-orchestrator/native-tui-host.js';
const supported = new Set(NATIVE_PROVIDERS);

function sameRoot(left, right) {
  try { return fs.realpathSync.native(left).toLowerCase() === fs.realpathSync.native(right).toLowerCase(); }
  catch { return false; }
}

// Windows and macOS: the official CLI on VPS2 works directly in this computer's project (mounted over SFTP),
// and its local_shell runs here.
function createWindowsNativeDesktop({ stateDir, remote, findProject, findWorktree, bridgeSettings, onEvent, onRequest, onCommand, reviewUnknown, adminShell,
  onTerminal = () => {}, onTui = () => {}, isDeletingProject = () => false }) {
  const worker = createWorkerClient(stateDir, {
    onUpdate: (scope, run) => {
      try {
        const [, provider, threadId] = JSON.parse(scope);
        onCommand(provider, threadId, { ...run, id: run.runId, code: run.exitCode });
      } catch {}
    },
    // Terminal events (output, exit, takeover) go to the chat window of the conversation the terminal belongs to.
    onEvent: (kind, value) => {
      if (kind !== 'terminal' || typeof value?.scope !== 'string') return;
      try {
        const [, provider, threadId] = JSON.parse(value.scope);
        const { scope, ...event } = value;
        onTerminal({ provider, threadId, ...event });
      } catch {}
    },
  });
  const file = path.join(stateDir, 'threads.json');
  const records = new Map();
  try {
    for (const entry of JSON.parse(fs.readFileSync(file, 'utf8'))) records.set(entry.threadId, entry);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const seats = new Map();
  const startingProjects = new Map();
  const finishStart = id => {
    const remaining = (startingProjects.get(id) || 1) - 1;
    if (remaining) startingProjects.set(id, remaining);
    else startingProjects.delete(id);
  };
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
        const sameHost = bridge?.ssh && bridge.ssh.host === remote.cfg.host && Number(bridge.ssh.port || 22) === Number(remote.cfg.port || 22);
        throw new Error(!bridge?.ssh ? '这台电脑没有可用的主控 Bridge 配置，群聊工作区的项目暂时不能开完全访问单聊。'
          : !sameHost ? '这台电脑的主控 Bridge 连接的不是当前 VPS（主机或端口不一致），请检查 Bridge 配置。'
          : config?.write !== true || !config?.root
          ? `这台电脑的主控 Bridge 没有授权写入「${project.orchestratorWorkspace}」工作区，请检查 Bridge 配置。`
          : `项目文件夹（${project.localRoot}）和主控 Bridge 的工作目录（${config.root}）不一致。` +
            '桌面、文稿、下载等个人文件夹不能作为项目文件夹，请在项目「···」里「更改本机文件夹…」选一个子文件夹；其他情况重启 AgentDesk 会自动对齐。');
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
          onNotification: (event) => onEvent(record.provider, event),
          onServerRequest: onRequest ? (frame) => onRequest(record.provider, frame) : null,
          adminShell: adminShell ? { spec: adminShell.spec, call: (args, context) => adminShell.call(record.provider, args, context) } : null });
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
  // ---- Native CLI single chats (native-tui.js): one official CLI TUI per provider and project. ----
  const tuiFile = path.join(stateDir, 'tui.json');
  const tuiRecords = new Map();
  try { for (const entry of JSON.parse(fs.readFileSync(tuiFile, 'utf8'))) tuiRecords.set(entry.key, entry); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tuiSessions = new Map();   // key -> { session, opening, buffer, state, mode, cwd, error }
  const TUI_BUFFER = 768 * 1024;
  const saveTui = () => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temp = tuiFile + '.' + randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify([...tuiRecords.values()]), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, tuiFile);
    } finally { try { fs.unlinkSync(temp); } catch {} }
  };
  const tuiKey = (provider, projectId) => provider + ':' + projectId;
  const tuiView = (key) => {
    const entry = tuiSessions.get(key);
    return { key, state: entry?.state || 'closed', mode: entry?.mode || null, cwd: entry?.cwd || null, error: entry?.error || null };
  };
  const tuiEmit = (key, event) => { try { onTui({ key, ...event }); } catch {} };
  const tuiState = (key, entry, state, extra = {}) => {
    Object.assign(entry, { state, ...extra });
    tuiEmit(key, { type: 'state', ...tuiView(key) });
  };
  async function tuiOpen({ provider, projectId, mode = 'write', cols, rows }) {
    if (!TUI_PROVIDERS.includes(provider)) throw new Error('tui_provider_invalid');
    if (!['write', 'read'].includes(mode)) throw new Error('tui_mode_invalid');
    if (isDeletingProject(projectId)) throw new Error('项目正在删除。');
    const project = resolveProject(projectId);
    if (!project) throw new Error('原生 CLI 需要一个本机项目：请先为这个单聊选择项目文件夹。');
    const key = tuiKey(provider, project.id);
    const current = tuiSessions.get(key);
    if (current?.session && !current.session.closed) return { ...tuiView(key), replay: Buffer.concat(current.buffer) };
    if (current?.opening) { await current.opening; return { ...tuiView(key), replay: Buffer.concat(tuiSessions.get(key).buffer) }; }
    if (!await remote.wake()) throw new Error('VPS 连接未就绪，请重连后重试。');
    const hostReady = await remote.request('command/exec', { command: ['/usr/bin/test', '-r', TUI_HOST], cwd: '/var/tmp',
      timeoutMs: 3000, sandboxPolicy: { type: 'dangerFullAccess' } }, { timeoutMs: 8000 }).then((result) => result.exitCode === 0, () => false);
    if (!hostReady) throw new Error('VPS2 还没有原生 CLI 服务，请先更新 VPS2 上的 AgentDesk 主控。');
    let record = tuiRecords.get(key);
    if (!record || !sameRoot(record.root, project.root)) {
      record = { key, provider, projectId: project.id, root: project.root, id: randomUUID(),
        sessionKey: createHash('sha256').update(deviceId() + ':tui:' + randomUUID()).digest('hex') };
      tuiRecords.set(key, record);
      saveTui();
    }
    const entry = { buffer: [], size: 0, mode, state: 'connecting', cwd: null, error: null };
    tuiSessions.set(key, entry);
    tuiState(key, entry, 'connecting');
    entry.opening = (async () => {
      const connection = await worker.get();
      const identity = { device: deviceId(), provider, projectId: project.id, root: project.root, threadId: 'tui-' + record.id, fullAccess: true };
      let binding = { ...identity, ...await connection.request('acquire', { binding: identity }) };
      if (binding.suspended) {
        if (!await connection.request('reconcile', { binding })) throw new Error('本机项目已暂停。请先核对上次连接中的本机文件和命令。');
        binding = { ...identity, ...await connection.request('acquire', { binding: identity }) };
      }
      const offered = await connection.request('capabilities', {}).catch(() => ({})) || {};
      const specs = mode === 'write' ? [shellSpecFor(process.platform), ...(offered.pty ? [terminalSpec(process.platform)] : []),
        ...(adminShell ? [adminShell.spec] : [])] : [];
      const tools = specs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      const callTool = async (name, args) => {
        const value = adminShell && name === adminShell.spec.name ? await adminShell.call(provider, args, { threadId: 'tui-' + record.id })
          : name === 'terminal' ? await connection.request('terminal', { binding, args })
            : await connection.request('shell', { binding, args, requestId: createHash('sha256').update(randomUUID()).digest('hex') });
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      };
      const release = async () => {
        const idle = await connection.request('completeSftp', { binding }).catch(() => false);
        if (idle) await connection.request('release', { binding }).catch(() => {});
      };
      try {
        entry.session = await openNativeTui({ remote, worker: connection, binding, provider, mode, sessionKey: record.sessionKey,
          name: path.basename(project.root), cols, rows, tools, callTool,
          onData: (data) => {
            entry.buffer.push(data);
            entry.size += data.length;
            while (entry.size > TUI_BUFFER && entry.buffer.length > 1) entry.size -= entry.buffer.shift().length;
            tuiEmit(key, { type: 'data', data });
          },
          onControl: (message) => {
            if (message.state === 'exited') tuiState(key, entry, 'exited', { exitCode: message.code });
          },
          onClose: (error) => {
            if (entry.state !== 'exited') tuiState(key, entry, error ? 'disconnected' : 'closed', { error: error?.message || null });
            release();
          },
        });
      } catch (error) {
        await release();
        throw error;
      }
      tuiState(key, entry, 'ready', { cwd: entry.session.info.cwd });
    })();
    try { await entry.opening; }
    catch (error) {
      tuiState(key, entry, 'failed', { error: error.message });
      throw error;
    } finally { entry.opening = null; }
    return { ...tuiView(key), replay: Buffer.concat(entry.buffer) };
  }
  const liveTui = (key) => {
    const entry = tuiSessions.get(key);
    if (!entry?.session || entry.session.closed) throw new Error('原生 CLI 未连接。');
    return entry.session;
  };

  return {
    async select(provider, method, params = {}) {
      if (!supported.has(provider)) return null;
      const existing = params.threadId && records.get(params.threadId);
      if (isDeletingProject(existing?.projectId || params.projectId)) throw new Error('项目正在删除。');
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
      // D14: when the native seat cannot be had for a NEW conversation, it starts on the MCP tools instead and
      // says so. Same device, nothing replayed; an existing native conversation is never switched silently.
      const fallback = (reason) => {
        onEvent(provider, { method: 'agentdesk/fallback', params: { reason, at: new Date().toISOString() } });
        return null;
      };
      if (!await remote.wake()) return fallback('VPS 连接未就绪');
      if (!await hasHost().catch(() => false)) return fallback('VPS 缺少原生单聊服务');
      if (isDeletingProject(project.id)) throw new Error('项目正在删除。');
      startingProjects.set(project.id, (startingProjects.get(project.id) || 0) + 1);
      const pending = { provider, worktreeSession: params.worktreeSession, projectId: project.id, root: project.root, threadId: 'pending-' + randomUUID(),
        sessionKey: createHash('sha256').update(deviceId() + ':' + randomUUID()).digest('hex') };
      let seat;
      try { seat = await attached(pending, project); }
      catch (error) { finishStart(project.id); return fallback('原生会话启动失败：' + String(error.message).slice(0, 120)); }
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
          } finally { finishStart(project.id); }
        },
      };
    },
    async projectBusy(projectId) {
      if (startingProjects.has(projectId)) return true;
      for (const record of records.values()) {
        if (record.projectId !== projectId || !seats.has(record.threadId)) continue;
        if ((await seats.get(record.threadId)).busy) return true;
      }
      return false;
    },
    // Projects that have records here but no longer exist in the app (deleted while these were left behind).
    orphanProjects(known) {
      return [...new Set([...records.values()].map(record => record.projectId))].filter(id => !known.has(id));
    },
    projectRecords(projectId) {
      return [...records.values()].filter(record => record.projectId === projectId);
    },
    record(threadId) { return records.get(threadId); },
    // One conversation: its CLI history on VPS2 goes first, then the local record. Nothing else of the project changes.
    async deleteThread(threadId) {
      const record = records.get(threadId);
      if (!record) return false;
      if (seats.has(threadId) && (await seats.get(threadId).catch(() => null))?.busy) throw new Error('这个单聊仍在执行，请先停止后再删除。');
      let seat;
      try {
        const project = resolveProject(record.projectId, record.worktreeSession);
        // Left over from a project that no longer exists: nothing local to attach to, so only the record goes.
        if (project) {
          seat = await attached(record, project);
          await seat.request('thread/delete', { threadId });
        }
      } catch (error) { if (!/thread_not_found|thread not (found|loaded)|no rollout found|尚无可恢复的历史记录/.test(error.message)) throw error; }
      await seat?.close?.({ confirmedIdle: true });
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temp = file + '.' + randomUUID();
      fs.writeFileSync(temp, JSON.stringify([...records.values()].filter(item => item.threadId !== threadId)), { mode: 0o600 });
      fs.renameSync(temp, file);
      records.delete(threadId); seats.delete(threadId);
      return true;
    },
    async deleteProject(projectId) {
      const selected = [...records.values()].filter(record => record.projectId === projectId);
      for (const record of selected) {
        let seat;
        try {
          const project = resolveProject(projectId, record.worktreeSession);
          if (project) {
            seat = await attached(record, project);
            await seat.request('thread/delete', { threadId: record.threadId });
          }
        } catch (error) { if (!/thread_not_found|thread not (found|loaded)|no rollout found|尚无可恢复的历史记录/.test(error.message)) throw error; }
        await seat?.close?.({ confirmedIdle: true });
      }
      let connection;
      try { connection = await connectWorker(stateDir, createSecret(stateDir)); }
      catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
      if (!connection && ['leases.json', 'runs.json'].some(name => fs.existsSync(path.join(stateDir, name)))) connection = await worker.get();
      if (connection) {
        try { await connection.request('projectDelete', { projectId, device: deviceId() }); }
        finally { connection.close(); }
      }
      const kept = [...records.values()].filter(record => record.projectId !== projectId);
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temp = file + '.' + randomUUID();
      fs.writeFileSync(temp, JSON.stringify(kept), { mode: 0o600 });
      fs.renameSync(temp, file);
      for (const record of selected) { records.delete(record.threadId); seats.delete(record.threadId); }
      return selected.map(record => record.threadId);
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
    // The interactive terminals of one native conversation (D4). The Worker keeps them running when this window
    // or the whole app is closed; reopening the conversation finds them again here.
    async terminal(provider, threadId, op, fields = {}) {
      const record = records.get(threadId);
      if (!record || record.provider !== provider) return undefined;
      const project = resolveProject(record.projectId, record.worktreeSession);
      if (!project || !sameRoot(project.root, record.root)) throw new Error('本机项目与原会话授权目录不匹配。');
      const identity = { device: deviceId(), provider, threadId, projectId: project.id, root: project.root, fullAccess: true };
      const connection = await worker.get();
      if (op === 'capabilities') return connection.request('capabilities', {});
      const found = await connection.request('lookup', { binding: identity });
      if (!found) throw new Error('这个会话的本机授权已结束，请重新打开会话。');
      const binding = { ...identity, ...found };
      const id = typeof fields.terminalId === 'string' ? fields.terminalId : undefined;
      switch (op) {
        case 'list': return connection.request('terminalRead', { binding });
        case 'read': return connection.request('terminalRead', { binding, terminalId: id, cursor: fields.cursor });
        case 'open': return connection.request('terminalOpen', { binding, shell: fields.shell, cols: fields.cols, rows: fields.rows });
        case 'input': return connection.request('terminalInput', { binding, terminalId: id, data: fields.data });
        case 'takeover': return connection.request('terminalTakeover', { binding, terminalId: id, on: fields.on === true });
        case 'resize': return connection.request('terminalResize', { binding, terminalId: id, cols: fields.cols, rows: fields.rows });
        case 'signal': return connection.request('terminalSignal', { binding, terminalId: id, signal: fields.signal || 'SIGINT' });
        case 'close': return connection.request('terminalClose', { binding, terminalId: id });
        default: throw new Error('invalid_terminal_operation');
      }
    },
    // Native CLI single chats (renderer: src/native-cli.js).
    async tui(op, fields = {}) {
      let key = fields.key;
      if (typeof key !== 'string') {
        let project = null;
        try { project = resolveProject(fields.projectId); } catch {}
        if (op === 'status' && !project) return { key: null, state: 'no_project' };
        key = tuiKey(fields.provider, project?.id ?? fields.projectId);
      }
      switch (op) {
        case 'status': {
          const entry = tuiSessions.get(key);
          return { ...tuiView(key), replay: entry?.buffer.length ? Buffer.concat(entry.buffer) : null, known: tuiRecords.has(key) };
        }
        case 'open': return tuiOpen(fields);
        case 'input': liveTui(key).input(String(fields.data ?? '')); return true;
        case 'resize': liveTui(key).resize(fields.cols, fields.rows); return true;
        case 'upload': {
          const bytes = Buffer.from(fields.bytes || []);
          if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('文件为空或超过 25 MB。');
          return liveTui(key).upload(String(fields.name || 'file'), bytes);
        }
        case 'close': {
          const entry = tuiSessions.get(key);
          await entry?.session?.close();
          tuiSessions.delete(key);
          tuiEmit(key, { type: 'state', ...tuiView(key) });
          return true;
        }
        default: throw new Error('invalid_tui_operation');
      }
    },
    closeAllTui: () => Promise.all([...tuiSessions.values()].map((entry) => entry.session?.close().catch(() => {}))),
    disconnect: () => worker.disconnect(),
    // Update gate (orchestrator/worker-idle.js): asks the Worker over a separate connection — never launches it,
    // never stops anything in it.
    idleProbe({ listProcesses } = {}) {
      const { probeWorker, legacyWorkerEvidence, listProcessCommandLines } = require('./worker-idle');
      return probeWorker({
        stateDir, platform: process.platform,
        connect: () => connectWorker(stateDir, createSecret(stateDir)),
        listProcesses: listProcesses || (() => listProcessCommandLines(process.platform)),
        legacyEvidence: async (connection) => {
          const identities = [];
          const reasons = [];
          for (const record of records.values()) {
            const project = resolveProject(record.projectId, record.worktreeSession);
            if (!project) { reasons.push('有单聊会话的本机项目无法核对'); continue; }
            identities.push({ device: deviceId(), provider: record.provider, threadId: record.threadId, projectId: project.id,
              root: project.root, fullAccess: true });
          }
          return [...reasons, ...await legacyWorkerEvidence(connection, identities)];
        },
      });
    },
    // Last step before installing an update: the Worker ends itself only if it is idle at that moment.
    async shutdownIfIdle() {
      let connection;
      try { connection = await connectWorker(stateDir, createSecret(stateDir)); } catch (error) {
        return ['ENOENT', 'ECONNREFUSED'].includes(error?.code) ? { shutdown: false, absent: true } : { shutdown: false, error: 'connect_failed' };
      }
      try { return await connection.request('shutdownIfIdle', {}); } catch (error) {
        return { shutdown: false, error: error.message === 'invalid_windows_chat_worker_operation' ? 'legacy_worker' : 'request_failed' };
      } finally { try { connection.close(); } catch {} }
    },
  };
}

const createNativeDesktop = createWindowsNativeDesktop;

module.exports = { createWindowsNativeDesktop, createNativeDesktop };
