const { app, BrowserWindow, ipcMain, nativeTheme, dialog, Notification, shell, powerMonitor, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID, createHash } = require('crypto');
const os = require('node:os');
const { createUpdateManager } = require('./updates');
const { createUpdateGate, countProbe, groupTasksProbe, idle: gateIdle, busy: gateBusy, unknown: gateUnknown } = require('./update-gate');
const connectionConfig = require('./connection-config');
const { createLogger } = require('./logger');
const { collectDiagnostics, exportDiagnostics } = require('./diagnostics');
const { AppConfig, migrate } = require('./app-config');
const { normalizeSettings } = require('./src/appearance');
const { steps: onboardingSteps, configuredHost, verified } = require('./onboarding');
// Connection settings from the installer are kept in this computer's user-data folder and read from there first, so an
// update (which never carries them) cannot lose them (connection-config.js). Runs before remote.js reads them.
let connectionMigration = { migrated: [], conflicts: [] };
if (app.isPackaged) {
  try { connectionMigration = connectionConfig.migrate(connectionConfig.electronDirs()); } catch (error) {
    console.error('AgentDesk: connection settings could not be copied:', error.code || 'failed');
  }
}
const bootstrapPath = app.isPackaged ? connectionConfig.resolve('agentdesk-enrollment.json', connectionConfig.electronDirs())
  : path.join(__dirname, 'agentdesk-enrollment.json');
const enrollment = fs.existsSync(bootstrapPath) && JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
if (enrollment) process.env.AGENTDESK_ENROLLED = '1';
const clawd = require('./clawd');
const remote = require('./remote');
const ws = require('./workspace');
const { Desktop, desktopExecutable } = require('./desktop');
const desktop = new Desktop(desktopExecutable(app));
const desktopThreads = new Set();
const windowsFiles = require('./windows-files');
const localFiles = require('./local-files');
const localCommands = require('./local-commands');
const { CommandRuns } = require('./orchestrator/command-runs');
const commandScope = (agent, threadId) => JSON.stringify([agent, threadId]);
// The Codex app-server's working folder on VPS2 (orchestrator/codex-desktop.sh). Shared by all projects; never deleted.
const SHARED_REMOTE_WORKSPACE = '/var/lib/agentdesk-orchestrator/desktop-workspace';
const commandRuns = new CommandRuns((scope, run) => {
  const [agent, threadId] = JSON.parse(scope);
  toUi('local-command:update', { agent, threadId, run });
}, () => path.join(app.getPath('userData'), 'local-command-runs.json'));
const codexCommandRoots = new Map();
// Where the person's authorized commands are defined: the Bridge configuration (Windows runs its Bridge in the
// app), or on a Mac the file named by agentCommandsFile in mac-remote.json (normally the Mac Bridge's config).
// A Mac whose mac-remote.json never named agentCommandsFile still has its Bridge at the place the installer puts it
// (the launchd job local.agentdesk.mac-bridge runs <userData>/bridge/mac-bridge.json). Without this fallback the
// app thought there was no Bridge at all: full-access chats in a project connected to the orchestrator failed with
// 「没有可用的主控 Bridge 配置」, the Bridge never followed the project's folder, and the command list was empty.
function macBridgeFile() {
  if (process.platform !== 'darwin') return null;
  const file = path.join(app.getPath('userData'), 'bridge', 'mac-bridge.json');
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}
const commandsFile = () => remote.cfg.agentCommandsFile || remote.cfg.orchestratorBridge || macBridgeFile();
const chatFileTools = process.platform === 'win32' ? windowsFiles : localFiles;
const chatFileSpecs = chatFileTools.specs.map((tool) =>
  ({ ...tool, name: tool.name.replace(/^windows_file_/, 'agentdesk_file_') }));
const chatToolSpecs = () => [...chatFileSpecs, ...localCommands.specs];
const { ChatLink, AGENTS: CHAT_AGENTS } = require('./chat-link');
const { detectOs, parseBuild, materialFor, isWindows11 } = require('./src/platform');
const mac = process.platform === 'darwin';
const platformName = detectOs({ platform: process.platform });
const systemVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
const windowsBuild = platformName === 'win' ? parseBuild(systemVersion) : 0;
let windowsNative;
const nativeQuestions = new Map();
let nativeQuestionSeq = 0;
function answerNativeQuestion(id, result, error) {
  const entry = typeof id === 'string' && nativeQuestions.get(id);
  if (!entry) return false;
  nativeQuestions.delete(id);
  entry.resolve(error ? { answers: {}, cancelled: true } : result || { answers: {} });
  return true;
}
function expireNativeQuestion(agent, frame) {
  for (const [id, entry] of nativeQuestions) {
    if (entry.agent === agent && entry.threadId === frame.params?.threadId && entry.frameId === frame.params?.requestId) {
      nativeQuestions.delete(id);
      entry.resolve({ answers: {}, cancelled: true });
      return { ...frame, params: { ...frame.params, requestId: id } };
    }
  }
  return frame;
}
function questionSummary(message) {
  const list = Array.isArray(message?.params?.questions) ? message.params.questions : [];
  return list.map((question) => String(question?.question || question?.header || '')).filter(Boolean).join(' / ').slice(0, 160);
}
// Native single chats: on Windows and on a Mac the official CLIs on VPS2 work directly in the local project
// (mounted over SFTP) and run commands here with local_shell.
function macBridgeSettings() {
  // The Mac's Bridge runs on its own (launchd); its configuration is the file named in mac-remote.json.
  try { const file = commandsFile(); return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}
function nativeDesktop() {
  if (!['win32', 'darwin'].includes(process.platform) || enrollment) return null;
  if (!windowsNative) {
    const { createNativeDesktop } = require('./orchestrator/windows-native-desktop');
    windowsNative = createNativeDesktop({
      stateDir: path.join(app.getPath('userData'), process.platform === 'win32' ? 'windows-native-chat' : 'native-chat'), remote,
      isDeletingProject: (id) => deletingProjects.has(id),
      findProject: (id) => id ? appConfig?.value.projects.find((item) => item.id === id) : appConfig?.active,
      findWorktree: (key) => worktrees().get(key),
      bridgeSettings: () => localBridgeSettings || (mac ? macBridgeSettings() : null),
      onEvent: (agent, frame) => {
        // The seat's own id for a withdrawn question → the id the app's card knows.
        if (frame?.method === 'agentdesk/requestExpired') frame = expireNativeQuestion(agent, frame);
        trackNativeTurn(agent, frame);
        if (agent === 'codex') toUi('codex:event', frame);
        else toUi('chat:event', { ...frame, agent });
      },
      // A question from a native seat's running turn: shown like any other question card, answered through
      // codex:respond / chat:respond with its own id (never a remote request id).
      onRequest: (agent, frame) => new Promise((resolve, reject) => {
        const id = 'native-question-' + (++nativeQuestionSeq);
        const threadId = frame.params?.threadId;
        // The same 15 minutes as the chat server; then the card is told the question is gone.
        const timer = setTimeout(() => {
          nativeQuestions.delete(id);
          toUi(agent === 'codex' ? 'codex:event' : 'chat:event', { method: 'agentdesk/requestExpired',
            params: { threadId, requestId: id }, ...(agent !== 'codex' && { agent }) });
          reject(new Error('question_timeout'));
        }, 15 * 60_000);
        nativeQuestions.set(id, { agent, threadId, frameId: frame.id, resolve: (value) => { clearTimeout(timer); resolve(value); } });
        const message = { ...frame, id, ...(agent !== 'codex' && { agent }) };
        toUi(agent === 'codex' ? 'codex:server-request' : 'chat:server-request', message);
        notifyIfAway(`${agent === 'codex' ? 'Codex' : CHAT_LABEL[agent] || agent} 有问题要问你`, questionSummary(frame));
      }),
      onCommand: (agent, threadId, run) => toUi('local-command:update', { agent, threadId, run }),
      onTerminal: (event) => toUi('terminal:event', event),
      reviewUnknown: async () => {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning', message: '上次断线时有本机操作的结果未确认。',
          detail: '请检查本机项目和后台进程。仅在确认旧操作已结束、文件状态已核对后继续原会话。',
          buttons: ['稍后核对', '已核对，继续'], defaultId: 0, cancelId: 0,
        });
        return response === 1;
      },
    });
  }
  return windowsNative;
}
const windowMaterial = materialFor({ os: platformName, build: windowsBuild });
const translucentWindow = windowMaterial === 'vibrancy' || windowMaterial === 'acrylic';
// One id per app launch: a renderer reload inside the same process must not replay the boot.
const launchId = randomUUID();
let bootMode = process.env.AGENTDESK_SHOT_SKIP_BOOT === '1' ? 'off' : 'on';
if (process.env.AGENTDESK_APPEARANCE) {
  try {
    if (JSON.parse(process.env.AGENTDESK_APPEARANCE).boot === 'off') bootMode = 'off';
  } catch (_) {}
}
const fileTurns = new Map();
// Per-turn file checkpoints, so a turn that changed files on this computer can be undone (checkpoints.js).
const { Checkpoints } = require('./checkpoints');
let checkpointStore;
const checkpointCompletions = new Map();
const checkpoints = () => checkpointStore ||= new Checkpoints(path.join(app.getPath('userData'), 'checkpoints'),
  { trash: (target) => shell.trashItem(target), allowed: (target) => {
    try { localFiles.allowedPath(target, true); } catch (error) { if (mac) throw error; windowsFiles.allowedPath(target, true); }
  } });
function finishCheckpoint(turnId) {
  if (!turnId) return;
  const store = checkpoints();
  const threadId = store.turns.get(turnId)?.threadId;
  const done = store.finish(turnId).then((summary) => { if (summary) toUi('checkpoint:ready', summary); })
    .catch((error) => logger?.log('checkpoint_failed', { status: 'failed', error: error.message }))
    .finally(() => checkpointCompletions.delete(turnId));
  checkpointCompletions.set(turnId, { threadId, done });
}
const filePolicies = new Map();
// Claude / Grok / Antigravity 单聊：线程在 VPS 上，工具调用回到本机执行
const deviceIdentity = require('./device-identity');
const deviceHello = () => deviceIdentity.hello({ appVersion: app.getVersion(), capabilities: ['attachmentsV2', 'statusSubscribe', 'localShell', 'nativeSeat'] });
const chatLinks = new Map([...CHAT_AGENTS].map((agent) => [agent, new ChatLink({ agent, deviceHello })]));
const chatThreads = new Map();
const deletingProjects = new Set();
const chatTurns = new Map();

function toggleDesktop(value) {
  desktop.enabled = value;
  if (!value) desktop.stop();
  toUi('desktop:enabled', value);
  return value;
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const OVERLAY = {
  dark: { color: '#191c20', symbolColor: '#e5e8ed', height: 49 },
  light: { color: '#f5f7f8', symbolColor: '#222b32', height: 49 },
};

let win;
let appConfig;
let logger;
let updates;
// Turns in progress, as seen by this process (update gate): Codex over remote.js, and the native single chats.
const codexTurns = new Set();
const nativeTurns = new Map();
function trackNativeTurn(agent, frame) {
  const id = frame?.params?.turn?.id;
  if (typeof id !== 'string') return;
  if (frame.method === 'turn/started') nativeTurns.set(agent + ':' + id, frame.params.threadId);
  if (frame.method === 'turn/completed') nativeTurns.delete(agent + ':' + id);
}
const updateGate = createUpdateGate();
// While the gate is closed for an installation, nothing new starts (the second check must stay true until quitting).
const updateLocked = () => updateGate.locked;
const UPDATE_LOCKED = '正在安装更新，暂不能开始新的任务。';
let updateQuit = false;
let configError;
let trustedHost = { host: '', fingerprints: [] };
let connectivityStarted = false;
const skipOnboarding = process.env.AGENTDESK_ONBOARDING === '0' ||
  (process.env.AGENTDESK_ONBOARDING !== '1' && Boolean(process.env.AGENTDESK_SHOT || process.env.AGENTDESK_LIVETEST));
const legacyDir = path.join(os.homedir(), '.agentdesk');
const preferredRoot = (() => {
  if (mac || enrollment) return path.join(os.homedir(), 'AgentDeskWorkspace');
  const previous = 'C:\\CodexSSH\\windows-dev';
  return fs.existsSync(previous) ? previous : undefined;
})();

function activateProject() {
  const project = appConfig?.active;
  ws.setRoot(project?.localRoot || null);
  toUi('projects:changed', appConfig.list());
}

// Points each bound workspace's Bridge root at its project's folder (bridge-root.js) and restarts the Bridge when
// anything moved: on Windows the Bridge runs in this process; on a Mac it is a launchd job (KeepAlive) that is
// kick-started. Returns the problems the person should hear about (a folder that cannot be a Bridge root).
async function syncBridgeRoots() {
  if (!appConfig || configError || enrollment) return [];
  const { syncBridgeRoots: sync } = require('./bridge-root');
  let result;
  try {
    result = sync({ file: commandsFile(), projects: appConfig.value.projects, activeId: appConfig.active?.id });
  } catch (error) {
    logger?.audit('bridge_root', { status: 'failed', error: String(error.code || error.message).slice(0, 120) });
    return [{ error: 'Bridge 配置无法更新：' + (error.code || error.message) }];
  }
  if (result.changed.length) {
    logger?.audit('bridge_root', { status: 'ok', workspaces: result.changed });
    if (stopBridge) {
      try { stopBridge(); } catch {}
      stopBridge = null;
      startOrchestratorBridge();
    } else if (mac) {
      await new Promise((resolve) => require('node:child_process').execFile('/bin/launchctl',
        ['kickstart', '-k', `gui/${process.getuid()}/local.agentdesk.mac-bridge`], { timeout: 15000 }, (error) => {
          if (error) logger?.audit('bridge_root', { status: 'restart_failed', error: String(error.code || 'failed') });
          resolve();
        }));
    }
  }
  for (const problem of result.problems) logger?.audit('bridge_root', { status: 'refused', workspace: problem.workspace });
  return result.problems;
}

async function loadAppConfig() {
  const legacyFiles = (mac ? ['remote.json', 'mac.json', 'mac-remote.json'] : ['mac.json', 'remote.json', 'windows.json'])
    .map((name) => path.join(legacyDir, name));
  appConfig = new AppConfig(path.join(app.getPath('userData'), 'config.json'), {
    legacyFiles, localRoot: preferredRoot, remoteCwd: remote.cfg.workspace,
    name: mac ? 'Mac 工作区' : 'Windows 开发机',
  });
  try {
    await appConfig.load();
  } catch (error) {
    configError = error.code || error.message;
    appConfig.value = await migrate(legacyFiles, appConfig.defaults);
  }
  if (!process.env.AGENTDESK_APPEARANCE && appConfig.value.appearance?.boot === 'off') bootMode = 'off';
  activateProject();
  pruneOrphanNativeChats();
  syncBridgeRoots().catch(() => {});
}

// Native single chats whose project is gone (deleted before 0.3.8 cleaned them up, or by hand) are listed under any
// project that shares the cloud folder and fail there with 「属于另一个已授权的本机项目」/「找不到本机项目目录」.
// Their local records and leases are dropped once the configuration has loaded cleanly; nothing else is touched.
function pruneOrphanNativeChats() {
  const native = nativeDesktop();
  if (!native?.orphanProjects || configError || !appConfig?.value.projects.length) return;
  const orphans = native.orphanProjects(new Set(appConfig.value.projects.map(({ id }) => id)));
  (async () => {
    for (const id of orphans) {
      try {
        const removed = await native.deleteProject(id);
        logger?.audit('native_orphan_prune', { projectId: id, threads: removed.length, status: 'ok' });
      } catch (error) {
        logger?.audit('native_orphan_prune', { projectId: id, status: 'failed', error: String(error.message).slice(0, 300) });
      }
    }
  })();
}

function fromMainWindow(event) {
  return Boolean(win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
}

function hostConfirmed() {
  return skipOnboarding || verified(trustedHost, appConfig?.value.confirmedHost);
}

function onboardingStatus() {
  const saved = appConfig.value;
  const confirmed = hostConfirmed();
  const complete = saved.onboardingComplete === true && (!trustedHost.host || confirmed);
  const savedStep = onboardingSteps.includes(saved.onboardingStep) ? saved.onboardingStep : 'welcome';
  let step = savedStep;
  if (trustedHost.host && !confirmed && !['welcome', 'fingerprint'].includes(savedStep)) step = 'fingerprint';
  else if (enrollment && !enrolledSession && !complete && onboardingSteps.indexOf(savedStep) > 2) step = 'login';
  const { host, fingerprints } = trustedHost;
  return { ok: true, enabled: !skipOnboarding, complete, confirmed, trust: { host, fingerprints }, step,
    enrollmentRequired: Boolean(enrollment), signedIn: Boolean(enrolledSession),
    project: appConfig.active, configurationError: Boolean(configError) };
}

function startConnectivity() {
  if (connectivityStarted || enrollment || !hostConfirmed() || process.env.AGENTDESK_SHOT || process.env.AGENTDESK_OFFLINE) return;
  if (trustedHost.host && !skipOnboarding) {
    try {
      const pin = trustedHost.records.get(appConfig.value.confirmedHost.fingerprint);
      const directory = path.join(app.getPath('userData'), 'ssh');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, 'known_hosts');
      const temporary = file + '.' + randomUUID();
      try {
        fs.writeFileSync(temporary, pin, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
      remote.cfg.knownHosts = file;
    } catch {
      logger?.log('host_pin', { status: 'failed' });
      return;
    }
  }
  connectivityStarted = true;
  remote.start();
  startOrchestratorBridge();
  startMacDesktop();
}

ipcMain.handle('onboarding:status', (event) => fromMainWindow(event) ? onboardingStatus() : { ok: false });
ipcMain.handle('onboarding:advance', async (event, { step, fingerprint } = {}) => {
  if (!fromMainWindow(event) || configError || !onboardingSteps.includes(step)) return { ok: false, error: 'invalid_request' };
  const current = onboardingStatus();
  if (current.step !== step) return current;
  if (step === 'fingerprint' && trustedHost.host && !trustedHost.fingerprints.includes(fingerprint)) {
    return { ok: false, error: '请先核对并确认主机指纹。' };
  }
  if (step === 'login' && enrollment && !enrolledSession) return { ok: false, error: '请先在应用内登录。' };
  if (step === 'workspace') {
    const project = appConfig.active;
    try {
      if (!project || project.kind === 'local' && !project.localRoot) throw new Error('请先选择工作区。');
      if (project.localRoot) await require('./app-config').validateDirectory(project.localRoot);
    } catch (error) { return { ok: false, error: error.message }; }
  }
  try {
    await appConfig.mutate((draft) => {
      if (step === 'fingerprint' && trustedHost.host) {
        if (!current.confirmed) draft.onboardingComplete = false;
        draft.confirmedHost = { host: trustedHost.host, fingerprint };
      }
      if (!(step === 'login' && onboardingSteps.indexOf(draft.onboardingStep) > 2)) {
        draft.onboardingStep = onboardingSteps[Math.min(onboardingSteps.length - 1, onboardingSteps.indexOf(step) + 1)];
      }
    });
    if (step === 'fingerprint') startConnectivity();
    return onboardingStatus();
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('onboarding:complete', async (event) => {
  if (!fromMainWindow(event) || configError || onboardingStatus().step !== 'complete') return { ok: false, error: 'invalid_request' };
  await appConfig.mutate((draft) => { draft.onboardingComplete = true; });
  return onboardingStatus();
});
ipcMain.handle('onboarding:reset', async (event) => {
  if (!fromMainWindow(event) || configError) return { ok: false, error: 'invalid_request' };
  await appConfig.mutate((draft) => {
    draft.onboardingComplete = false;
    draft.onboardingStep = 'welcome';
    delete draft.confirmedHost;
  });
  return onboardingStatus();
});

function currentRemoteDirectory(projectId) {
  const project = projectId === undefined ? appConfig?.active : appConfig?.value.projects.find(({ id }) => id === projectId);
  if (projectId !== undefined && !project) throw new Error('project_not_found');
  if (deletingProjects.has(project?.id)) throw new Error('项目正在删除，请等待清理完成。');
  return project?.remoteCwd || enrolledSession?.remote.workspace;
}

// The 新建项目 dialog picks its local folder before 创建. The chosen path stays here; the window only gets a one-time
// token (and the path to show), so a page can never hand the main process a folder the person did not pick.
const pickedFolders = new Map();
ipcMain.handle('projects:pickFolder', async (event) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
  const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择本机工作文件夹（普通文件夹将初始化 Git）' });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
  const token = randomUUID();
  pickedFolders.clear();
  pickedFolders.set(token, picked.filePaths[0]);
  return { ok: true, token, path: picked.filePaths[0] };
});

for (const operation of ['list', 'add', 'update', 'remove', 'select']) {
  ipcMain.handle('projects:' + operation, async (event, request = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
    try {
      if (operation === 'list') return { ok: true, ...appConfig.list(), configError };
      if (configError) throw new Error('配置文件无法读取，请修复或移走后再修改。');
      const { id, name, kind, remoteCwd, orchestratorWorkspace, pickLocal } = request;
      if (['add', 'update', 'remove'].includes(operation) && deletingProjects.size) throw new Error('项目正在删除，完成后再编辑工作区。');
      if (operation === 'update' && appConfig.value.projects.find(project => project.id === id)?.deletionPlan) throw new Error('项目清理尚未完成，请先重试删除。');
      if (operation === 'add' || operation === 'update') {
        let localRoot;
        const pickedToken = operation === 'add' && typeof request.folderToken === 'string' ? request.folderToken : '';
        if (pickedToken) {
          localRoot = pickedFolders.get(pickedToken);
          pickedFolders.delete(pickedToken);
          if (!localRoot || kind !== 'local') throw new Error('所选文件夹已失效，请重新选择。');
        } else if (kind === 'local' && (pickLocal || operation === 'add')) {
          const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择本机工作文件夹（普通文件夹将初始化 Git）' });
          if (picked.canceled) return { ok: false, cancelled: true };
          [localRoot] = picked.filePaths;
        }
        appConfig.lastInit = undefined;
        await appConfig.saveProject(operation === 'update' ? id : undefined, { name, kind, remoteCwd, orchestratorWorkspace }, localRoot, request.groupId);
      } else if (operation === 'remove') {
        const removed = await removeProjectData(id);
        if (removed.cancelled) return { ok: false, cancelled: true };
      } else await appConfig[operation](id);
      activateProject();
      logger?.audit('project_change', { operation, projectId: id || appConfig.active?.id, status: 'ok' });
      // What binding the folder did to Git (D7/Q3/Q4), so the window can tell the person.
      const init = (operation === 'add' || operation === 'update') ? appConfig.lastInit : undefined;
      const bridgeProblems = operation === 'list' ? [] : await syncBridgeRoots();
      const bridgeWarning = bridgeProblems.length ? '主控 Bridge 没有切到这个项目的文件夹：' + bridgeProblems.map((item) => item.error).join('；') +
        '。群聊和完全访问单聊暂时不能在这里工作，请在项目「···」里「更改本机文件夹…」换一个子文件夹。' : undefined;
      return { ok: true, ...appConfig.list(), ...(init && { init }), ...(bridgeWarning && { bridgeWarning }) };
    } catch (error) {
      if (operation === 'remove') logger?.audit('project_change', { operation, projectId: request.id, status: 'failed', error: removeFailure(error.message) });
      return { ok: false, error: error.message };
    }
  });
}

// The audit log keeps only plain identifiers, so a failed deletion is recorded as a category, not its Chinese message.
function removeFailure(message) {
  const text = String(message || '');
  const rules = [
    [/重叠/, 'overlaps_other_project'], [/用户目录或系统目录/, 'system_or_home_folder'], [/AgentDesk 程序或配置/, 'app_folder'],
    [/外部 Git 目录/, 'external_git_dir'], [/仍在执行/, 'chat_running'], [/VPS 未连接|单聊服务未连接/, 'vps_offline'],
    [/远程项目清理未完成/, 'remote_cleanup_failed'], [/远程目录覆盖/, 'remote_folder_shared'], [/项目目录已变化/, 'folder_changed'],
    [/项目正在删除/, 'already_deleting'], [/找不到该项目/, 'project_not_found'], [/任务已变化/, 'tasks_changed'],
    [/EBUSY|EPERM|EACCES/, 'folder_in_use_or_denied'], [/ENOENT/, 'not_found'],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || 'other';
}

async function removeProjectData(id) {
  const project = appConfig.value.projects.find(item => item.id === id);
  if (!project) throw new Error('找不到该项目。');
  if (deletingProjects.has(id)) throw new Error('项目正在删除。');
  const removal = require('./project-deletion');
  const native = nativeDesktop();
  const nativeRecords = native?.projectRecords(id) || [];
  const nativeIds = new Set(nativeRecords.map(record => record.threadId));
  const projects = appConfig.value.projects;
  const cwd = project.remoteCwd || remote.cfg.workspace;
  const call = async (frame) => {
    const result = await orchestratorControl({ ...frame, projectId: id, group: id, operation: 'project_delete' });
    if (!result.ok) throw new Error('远程项目清理未完成：' + result.error);
    return result.value;
  };
  deletingProjects.add(id);
  try {
    return await removal.deleteProject({
      project, projects, protectedPaths: [__dirname, app.getPath('userData'), path.join(os.homedir(), '.agentdesk')],
      preview: async () => {
        if (await native?.projectBusy(id)) throw new Error('这个项目的原生单聊仍在执行，请先停止后再删除。');
        if ([...nativeTurns.values()].some(threadId => nativeIds.has(threadId)) ||
          [...fileTurns.values(), ...chatTurns.values()].some(turn => turn.projectId === id || turn.binding?.projectId === id || chatThreads.get(turn.threadId)?.projectId === id ||
          nativeIds.has(turn.threadId) || codexCommandRoots.get(turn.threadId)?.projectId === id)) {
          throw new Error('这个项目的单聊仍在执行，请先停止后再删除。');
        }
        if (!await remote.wake()) throw new Error('VPS 未连接，暂时无法完整删除项目。');
        const codexIds = new Set([...codexCommandRoots].filter(([, entry]) => entry.projectId === id).map(([threadId]) => threadId));
        const directories = new Set(cwd ? [cwd] : []);
        for (const record of nativeRecords.filter(record => record.provider === 'codex')) {
          try {
            const info = await remote.request('thread/read', { threadId: record.threadId, includeTurns: false });
            if (info.thread?.cwd) directories.add(info.thread.cwd);
          } catch (error) { if (!/thread.*not (found|loaded)|no rollout found|does not exist/i.test(error.message)) throw error; }
        }
        // A remote folder other projects also use (usually the shared default workspace): its conversations cannot be
        // told apart by folder, so only the ones known to be this project's (codexIds above, native records) are
        // deleted, and the rest stay for the projects still using the folder.
        const sharedCwd = Boolean(cwd) && projects.some(other => other.id !== id && (other.remoteCwd || remote.cfg.workspace) === cwd);
        for (const directory of directories) {
          if (directory === cwd && sharedCwd) continue;
          for (const archived of [false, true]) {
            let cursor;
            do {
              const page = await remote.request('thread/list', { cwd: directory, archived, sourceKinds: require('./orchestrator/codex-sessions').SOURCE_KINDS, limit: 100, ...(cursor && { cursor }) });
              const matching = (page.data || []).filter(thread => thread.cwd === directory && !nativeIds.has(thread.id));
              for (const thread of matching) codexIds.add(thread.id);
              cursor = page.nextCursor;
            } while (cursor);
          }
        }
        const chatPlans = [];
        for (const agent of CHAT_AGENTS) {
          const link = chatLink(agent);
          if (!await link.wake()) throw new Error(agent + ' 单聊服务未连接，暂时无法删除其项目数据。');
          chatPlans.push({ agent, ...await link.request('project/delete', { projectId: id, preview: true }) });
        }
        const tasks = await call({ action: 'preview' });
        let nextOffset = tasks.nextOffset;
        while (nextOffset !== null && nextOffset !== undefined) {
          const page = await call({ action: 'preview', after: nextOffset });
          if (page.revision !== tasks.revision) throw new Error('项目任务已变化，请重新删除。');
          tasks.taskIds.push(...page.taskIds);
          nextOffset = page.nextOffset;
        }
        const threadIds = [...new Set([...nativeIds, ...codexIds, ...chatPlans.flatMap(plan => plan.threadIds)])];
        // Only a folder bound to this project alone is removed on the VPS. The shared default workspace (the Codex
        // app-server's own folder, used by every project without remoteCwd) is never deleted; this project's
        // conversations there are deleted one by one above.
        const shared = new Set([remote.cfg.workspace, enrolledSession?.remote?.workspace, SHARED_REMOTE_WORKSPACE].filter(Boolean));
        const remoteDirectory = project.remoteCwd && !shared.has(project.remoteCwd) ? project.remoteCwd : null;
        // The shared workspace is emptied (the folder itself stays, codex-desktop.sh starts in it) when no other
        // project uses it; otherwise it is left as it is.
        const sharedDirectory = remoteDirectory ? null : (project.remoteCwd || remote.cfg.workspace || enrolledSession?.remote?.workspace || null);
        const remoteClear = sharedDirectory && !projects.some(other => other.id !== id &&
          (other.remoteCwd || remote.cfg.workspace || enrolledSession?.remote?.workspace) === sharedDirectory) &&
          path.posix.resolve(sharedDirectory) === sharedDirectory && sharedDirectory.startsWith('/var/lib/agentdesk-orchestrator/') &&
          sharedDirectory.split('/').length >= 5 ? sharedDirectory : null;
        if (remoteDirectory) {
          const protectedDirectories = ['/root', '/home', '/etc', '/usr', '/var', '/opt',
            '/var/lib/agentdesk-orchestrator', '/opt/agentdesk-orchestrator'];
          if (path.posix.resolve(remoteDirectory) !== remoteDirectory || protectedDirectories.some(target =>
            target === remoteDirectory || target.startsWith(remoteDirectory + '/')) ||
            remoteDirectory === '/' || (remoteDirectory !== remote.cfg.workspace &&
              ['/var/lib/agentdesk-orchestrator', '/opt/agentdesk-orchestrator'].some(target => remoteDirectory.startsWith(target + '/'))) ||
            projects.some(other => {
              const directory = other.remoteCwd || remote.cfg.workspace;
              return other.id !== id && directory && (removal.inside(remoteDirectory, directory) || removal.inside(directory, remoteDirectory));
            })) {
            throw new Error('远程目录覆盖了共享或系统目录，请先绑定独立的项目目录。');
          }
          const resolved = await remote.request('command/exec', { command: ['/usr/bin/readlink', '-m', '--', remoteDirectory],
            cwd: '/var/tmp', timeoutMs: 5000, sandboxPolicy: { type: 'dangerFullAccess' } });
          if (resolved.exitCode !== 0 || resolved.stdout.trim() !== remoteDirectory) throw new Error('远程目录包含路径链接，请先绑定到实际目录后再删除。');
        }
        const previous = project.deletionPlan && shared.has(project.deletionPlan.remoteDirectory)
          ? { ...project.deletionPlan, remoteDirectory: null } : project.deletionPlan;
        const combine = (left, right) => [...new Set([...(left || []), ...right])];
        if (previous && previous.remoteDirectory !== remoteDirectory) throw new Error('远程目录已变化，请先恢复原目录完成清理。');
        return { tasks: { ...tasks, taskIds: combine(previous?.tasks?.taskIds, tasks.taskIds) }, chatPlans,
          codexIds: combine(previous?.codexIds, [...codexIds].filter(threadId => !nativeIds.has(threadId))),
          threadIds: combine(previous?.threadIds, threadIds), remoteDirectory, remoteClear };
      },
      confirm: async plan => {
        const lines = [plan.worktrees?.length && '本机关联工作树\n' + plan.worktrees.join('\n'),
          plan.root && plan.missing && '本机文件夹已不存在，跳过本机文件，只解除绑定\n' + plan.root,
          plan.root && !plan.keepFolder && '本机目录（包括 .git）\n' + plan.root,
          plan.root && plan.keepFolder && !plan.missing && '本机目录保留（个人文件夹或磁盘根下的文件夹），文件全部不动，只解除绑定\n' + plan.root +
            (plan.removeGit ? '\n（AgentDesk 建的空 .git 会删除，里面没有任何提交）' : ''),
          plan.remoteDirectory ? 'VPS 项目目录（包括 .git）\n' + plan.remoteDirectory
            : plan.remoteClear ? 'VPS 工作区内容全部清空（目录本身保留）\n' + plan.remoteClear
              : 'VPS 工作区还有其他项目在用，保留，只删除本项目的会话',
          plan.tasks.repository && 'VPS Git 副本\n' + plan.tasks.repository,
          `关联单聊 ${plan.threadIds.length} 个，群聊任务 ${plan.tasks.tasks} 个`,
          '会话、附件、工作树、项目 Git 分支和撤销存档将一并删除。',
          plan.tasks.sharedRepository && '共用 Git 缓存中的本项目分支会清除，其他项目的分支由其项目管理。',
          'GitHub 仓库保留。此操作不能撤销。'].filter(Boolean);
        const answer = await dialog.showMessageBox(win, { type: 'warning', title: '删除项目及全部数据',
          message: `彻底删除「${project.name}」？`, detail: lines.join('\n\n'),
          buttons: ['取消', '删除全部数据'], defaultId: 0, cancelId: 0, noLink: true });
        return answer.response === 1;
      },
      savePlan: plan => appConfig.mutate(draft => { draft.projects.find(project => project.id === id).deletionPlan = plan; }),
      remote: async plan => {
        // The remote task list is checked again using its preview revision before any local data is removed.
        await call({ action: 'delete', revision: plan.tasks.revision });
        await native?.deleteProject(id);
        for (const { agent } of plan.chatPlans) await chatLink(agent).request('project/delete', { projectId: id });
        for (const threadId of plan.codexIds) {
          try { await remote.request('thread/delete', { threadId }); }
          catch (error) { if (!/thread.*not (found|loaded)|no rollout found|does not exist/i.test(error.message)) throw error; }
        }
        if (plan.remoteDirectory) await remote.request('fs/remove', { path: plan.remoteDirectory, recursive: true, force: true });
        if (plan.remoteClear) {
          const target = plan.remoteClear;
          if (path.posix.resolve(target) !== target || !target.startsWith('/var/lib/agentdesk-orchestrator/') ||
              target.split('/').length < 5) throw new Error('VPS 工作区路径异常，已停止清理：' + target);
          const cleared = await remote.request('command/exec', { command: ['/usr/bin/find', target, '-xdev', '-mindepth', '1', '-delete'],
            cwd: '/var/tmp', timeoutMs: 60000, sandboxPolicy: { type: 'dangerFullAccess' } });
          if (cleared.exitCode !== 0) throw new Error('VPS 工作区清空失败：' + String(cleared.stderr || '').slice(0, 200));
        }
      },
      local: async plan => {
        for (let offset = 0; offset < plan.tasks.taskIds.length; offset += 1000) {
          await call({ action: 'local', taskIds: plan.tasks.taskIds.slice(offset, offset + 1000) });
        }
        for (const [sessionId, record] of Object.entries(worktrees().records)) {
          if (record.projectId !== id) continue;
          await worktrees().discard(sessionId);
          await fs.promises.rm(record.path, { recursive: true, force: true });
        }
        for (const taskId of plan.tasks.taskIds) await fs.promises.rm(path.join(os.homedir(), '.agentdesk', 'patches', taskId + '.patch'), { force: true });
        await Promise.all([...checkpointCompletions.values()].filter(entry => plan.threadIds.includes(entry.threadId)).map(entry => entry.done));
        await removal.purgeCheckpoints(path.join(app.getPath('userData'), 'checkpoints'), plan.threadIds);
        for (const [threadId, mapping] of chatThreads) if (mapping.projectId === id) forgetChatThread(threadId);
        commandRuns.forgetScopes(scope => {
          try { return plan.threadIds.includes(JSON.parse(scope)[1]); } catch { return false; }
        });
        for (const [threadId, mapping] of codexCommandRoots) if (mapping.projectId === id) codexCommandRoots.delete(threadId);
        for (const [attachmentId, attachment] of chatAttachments) if (attachment.projectId === id) chatAttachments.delete(attachmentId);
      },
      unregister: projectId => appConfig.remove(projectId, { purged: true }),
    });
  } finally { deletingProjects.delete(id); }
}

// A project made in the group chat (群聊项目: no local folder, not in the app's project list): after a warning, its
// group tasks go on VPS2 (task records, logs, worktrees, CLI sessions, Git branches) and here (downloaded patches).
// The window then drops the project, its group chats and dispatched records.
ipcMain.handle('groupProjects:remove', async (event, request = {}) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
  const { id, name, workspace } = request;
  try {
    if (typeof id !== 'string' || !/^group-[a-f0-9-]{1,64}$/.test(id)) throw new Error('项目编号无效。');
    if (workspace !== undefined && (typeof workspace !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(workspace))) throw new Error('工作区名称无效。');
    if (appConfig?.value.projects.some(project => project.id === id)) throw new Error('这个项目绑定了本机目录，请用「删除项目…」。');
    if (deletingProjects.has(id)) throw new Error('项目正在删除。');
    deletingProjects.add(id);
    try {
      const call = async (frame) => {
        const result = await orchestratorControl({ ...frame, group: id, ...(workspace && { workspace }), operation: 'project_delete' });
        if (!result.ok) throw new Error('VPS 上的群聊任务没能清理：' + result.error);
        return result.value;
      };
      const tasks = await call({ action: 'preview' });
      let nextOffset = tasks.nextOffset;
      while (nextOffset !== null && nextOffset !== undefined) {
        const page = await call({ action: 'preview', after: nextOffset });
        if (page.revision !== tasks.revision) throw new Error('群聊任务已变化，请重新删除。');
        tasks.taskIds.push(...page.taskIds);
        nextOffset = page.nextOffset;
      }
      const detail = [`VPS：群聊任务 ${tasks.tasks} 个，连同它们的日志、工作树、CLI 会话和项目 Git 分支`,
        tasks.repository && 'VPS Git 副本\n' + tasks.repository,
        tasks.sharedRepository && '共用 Git 缓存里只清除本项目的分支，其他项目不受影响。',
        '本机：这个项目的群聊、消息、派遣记录、单聊会话和下载的补丁',
        '本机文件不受影响（这个项目没有绑定本机目录）。此操作不能撤销。'].filter(Boolean).join('\n\n');
      const answer = await dialog.showMessageBox(win, { type: 'warning', title: '删除群聊项目',
        message: `彻底删除「${String(name || '群聊项目').slice(0, 80)}」？`, detail,
        buttons: ['取消', '删除全部数据'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return { ok: false, cancelled: true };
      await call({ action: 'delete', revision: tasks.revision });
      for (let offset = 0; offset < tasks.taskIds.length; offset += 1000) {
        await orchestratorControl({ operation: 'project_delete', action: 'local', taskIds: tasks.taskIds.slice(offset, offset + 1000) });
      }
      for (const taskId of tasks.taskIds) await fs.promises.rm(path.join(os.homedir(), '.agentdesk', 'patches', taskId + '.patch'), { force: true });
      logger?.audit('project_change', { operation: 'remove_group', status: 'ok' });
      return { ok: true, tasks: tasks.tasks };
    } finally { deletingProjects.delete(id); }
  } catch (error) {
    logger?.audit('project_change', { operation: 'remove_group', status: 'failed', error: String(error.message).slice(0, 300) });
    return { ok: false, error: error.message };
  }
});

// Deleting one conversation (右键 → 删除…): after a native warning, its history goes on VPS2 (the CLI session and
// the thread record) and then here (undo checkpoints, command runs, attachments, its worktree). The project stays.
ipcMain.handle('sessions:remove', async (event, request = {}) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
  const { agent, threadId, sessionId, title } = request;
  try {
    if (!['codex', ...CHAT_AGENTS].includes(agent)) throw new Error('未知的单聊类型。');
    if (threadId !== undefined && (typeof threadId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(threadId))) throw new Error('会话编号无效。');
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) throw new Error('会话编号无效。');
    const native = nativeDesktop();
    const record = threadId && native?.record?.(threadId);
    const projectId = record?.projectId || chatThreads.get(threadId)?.projectId || codexCommandRoots.get(threadId)?.projectId;
    if (projectId && deletingProjects.has(projectId)) throw new Error('项目正在删除。');
    if (threadId && ([...nativeTurns.values()].includes(threadId) ||
      [...fileTurns.values(), ...chatTurns.values()].some(turn => turn.threadId === threadId))) {
      throw new Error('这个单聊仍在执行，请先停止后再删除。');
    }
    const worktree = worktrees().get(sessionId);
    const detail = [threadId ? 'VPS：这个会话的对话记录和 CLI 会话文件' : 'VPS：没有这个会话的记录',
      '本机：会话列表记录、撤销存档、命令记录和附件' + (worktree ? '\n本机：这个会话的独立工作树和分支\n' + worktree.path : ''),
      '项目文件和其他会话不受影响。此操作不能撤销。'].join('\n\n');
    const answer = await dialog.showMessageBox(win, { type: 'warning', title: '删除单聊',
      message: `删除「${String(title || '新会话').slice(0, 80)}」？`, detail,
      buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return { ok: false, cancelled: true };
    if (threadId) {
      const missing = (error) => /thread.*not.?(found|loaded)|no rollout found|does not exist/i.test(error.message);
      if (record) await native.deleteThread(threadId);
      else if (agent === 'codex') {
        if (!await remote.wake()) throw new Error('VPS 未连接，暂时无法删除会话。');
        try { await remote.request('thread/delete', { threadId }); } catch (error) { if (!missing(error)) throw error; }
      } else {
        const link = chatLink(agent);
        if (!await link.wake()) throw new Error(agent + ' 单聊服务未连接，暂时无法删除会话。');
        try { await link.request('thread/delete', { threadId }); } catch (error) { if (!missing(error)) throw error; }
      }
      await Promise.all([...checkpointCompletions.values()].filter(entry => entry.threadId === threadId).map(entry => entry.done));
      await require('./project-deletion').purgeCheckpoints(path.join(app.getPath('userData'), 'checkpoints'), [threadId]);
      forgetChatThread(threadId);
      codexCommandRoots.delete(threadId);
      commandRuns.forgetScopes(scope => { try { return JSON.parse(scope)[1] === threadId; } catch { return false; } });
    }
    if (worktree) {
      await worktrees().discard(sessionId);
      await fs.promises.rm(worktree.path, { recursive: true, force: true });
    }
    logger?.audit('chat_thread', { status: 'deleted', agent });
    return { ok: true };
  } catch (error) {
    logger?.audit('chat_thread', { status: 'delete_failed', agent, error: String(error.message).slice(0, 300) });
    return { ok: false, error: error.message };
  }
});

// "已设置，补做首个提交": commits .gitignore in a repository AgentDesk initialized empty, once the person's own
// Git identity exists (Q4). It never writes any gitconfig.
ipcMain.handle('projects:initialCommit', async (event, { id } = {}) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
  const project = appConfig?.value.projects.find((item) => item.id === id);
  if (!project?.localRoot) return { ok: false, error: '找不到该本机项目。' };
  try { return { ok: true, ...await require('./app-config').retryInitialCommit(project.localRoot) }; }
  catch (error) { return { ok: false, error: error.message }; }
});

// D6: what the person gives the administrator for `ad device approve` (public keys only; no private key is read).
ipcMain.handle('device:info', (event) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
  try {
    const keys = {};
    for (const agent of CHAT_AGENTS) keys['chat-' + agent] = chatLinks.get(agent)?.key;
    keys.codex = remote.cfg.codexKey;
    return { ok: true, ...deviceIdentity.registrationInfo(keys) };
  } catch (error) { return { ok: false, error: error.message }; }
});

// Q4 / requirement 7: a group patch downloaded from VPS2 is kept only when its bytes match the sha256 the
// orchestrator sent; the window then says it arrived. The project is not changed here (that is "应用补丁").
ipcMain.handle('orchestrator:save-patch', async (event, frame = {}) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
  try {
    const { taskId, patch, sha256 } = frame || {};
    if (typeof taskId !== 'string' || !/^[\w-]{1,80}$/.test(taskId) || typeof patch !== 'string' || !/^[0-9a-f]{64}$/.test(sha256 || '')) {
      return { ok: false, error: 'invalid_patch' };
    }
    const bytes = Buffer.from(patch, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) return { ok: false, error: 'patch_checksum_mismatch' };
    const folder = path.join(os.homedir(), '.agentdesk', 'patches');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, taskId + '.patch');
    fs.writeFileSync(file + '.tmp', bytes, { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    logger?.audit('patch_download', { taskId, bytes: bytes.length, status: 'ok' });
    return { ok: true, path: file, bytes: bytes.length };
  } catch (error) { return { ok: false, error: error.message }; }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'AgentDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    // macOS vibrancy and Windows 11 acrylic only show through a transparent window background.
    backgroundColor: translucentWindow ? '#00000000' : OVERLAY.light.color,
    ...(platformName === 'mac' ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    ...(windowMaterial === 'acrylic' ? { backgroundMaterial: 'acrylic' } : {}),
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    // Aqua is the default skin, so the first frame uses the light caption colours; app.js corrects
    // this to the saved theme once the renderer boots.
    titleBarOverlay: mac ? false : OVERLAY.light,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Synchronous platform information for the preload bridge: no async flash before first paint.
      additionalArguments: [
        '--agentdesk-os=' + platformName,
        '--agentdesk-build=' + windowsBuild,
        '--agentdesk-material=' + windowMaterial,
        '--agentdesk-version=' + app.getVersion(),
        '--agentdesk-launch=' + launchId,
        '--agentdesk-boot=' + bootMode,
      ],
    },
  });
  win.setMenuBarVisibility(false);
  // Zoom keys handled here, the same on every keyboard: the default menu's zoom-in is Ctrl+Plus, which on Windows needs
  // Shift, so Ctrl+= did nothing. Ctrl/⌘ with = or + zooms in, - zooms out, 0 resets (main keys and the number pad).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || !(process.platform === 'darwin' ? input.meta : input.control)) return;
    const contents = win.webContents;
    const level = contents.getZoomLevel();
    const zoomIn = ['=', '+'].includes(input.key) || ['Equal', 'NumpadAdd'].includes(input.code);
    const zoomOut = ['-', '_'].includes(input.key) || ['Minus', 'NumpadSubtract'].includes(input.code);
    const reset = (input.key === '0' && !input.shift) || input.code === 'Numpad0';
    if (!zoomIn && !zoomOut && !reset) return;
    event.preventDefault();
    contents.setZoomLevel(reset ? 0 : Math.max(-3, Math.min(4, level + (zoomIn ? 0.5 : -0.5))));
  });
  // 拖进来的文件由页面处理；万一漏到窗口上也不要跳转去打开它
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Links in model output never open a new Electron window; http(s) goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 验证用：AGENTDESK_LIVETEST=<脚本.js> 时，在界面里执行该脚本（真实连接），按脚本要求截图后退出
  const liveTest = process.env.AGENTDESK_LIVETEST;
  if (liveTest) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    ipcMain.handle('test:shot', async (_e, name) => {
      const img = await win.webContents.capturePage();
      const out = liveTest.replace(/\.js$/, '') + '-' + name + '.png';
      require('fs').writeFileSync(out, img.toPNG()); return out;
    });
    ipcMain.on('test:done', () => app.quit());
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      let code;
      try { code = require('fs').readFileSync(liveTest, 'utf8'); } catch (e) { console.log('[test] error', e.message); app.quit(); return; }
      win.webContents.executeJavaScript(code).catch((e) => { console.log('[test] error', e); app.quit(); });
    }, 800));
  }

  // 验证用：设置 AGENTDESK_SHOT=<png路径> 时，加载完成后截图并退出
  const shot = process.env.AGENTDESK_SHOT;
  if (shot) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.AGENTDESK_THEME) {
        const theme = process.env.AGENTDESK_THEME === 'dark' ? 'dark' : 'light';
        await win.webContents.executeJavaScript(
          `(() => { if (window.__desk.state.theme !== ${JSON.stringify(theme)}) document.getElementById('themeToggle').click(); })()`);
      }
      if (process.env.AGENTDESK_APPEARANCE) {
        let settings;
        try { settings = JSON.parse(process.env.AGENTDESK_APPEARANCE); } catch (_) {}
        if (settings && win && !win.isDestroyed()) {
          await win.webContents.executeJavaScript(
            `window.__appearance && window.__appearance.apply(${JSON.stringify(settings)})`);
        }
      }
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage();
      require('fs').writeFileSync(shot, img.toPNG());
      app.quit();
    }, 1200));
  }
}

ipcMain.on('theme:set', (_e, theme) => {
  const t = theme === 'light' ? 'light' : 'dark';
  nativeTheme.themeSource = t;
  if (win && !win.isDestroyed()) {
    // The caption-button colours follow the skin; the window itself stays transparent for vibrancy.
    try { win.setTitleBarOverlay(OVERLAY[t]); } catch (_) {}
    if (!translucentWindow) win.setBackgroundColor(OVERLAY[t].color);
  }
});

ipcMain.handle('platform:info', () => ({
  os: platformName,
  build: windowsBuild,
  material: windowMaterial,
  isWindows11: isWindows11(windowsBuild),
  version: app.getVersion(),
  electron: process.versions.electron,
}));

const WALLPAPER_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const WALLPAPER_MAX = 8 * 1024 * 1024;
const wallpaperFile = () => Object.keys(WALLPAPER_TYPES)
  .map((ext) => path.join(app.getPath('userData'), 'wallpaper' + ext))
  .find((file) => fs.existsSync(file));

function readWallpaper(file) {
  const mime = WALLPAPER_TYPES[path.extname(file).toLowerCase()];
  return mime ? 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64') : null;
}

ipcMain.handle('appearance:pickWallpaper', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择壁纸',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const source = result.filePaths[0];
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error('wallpaper_invalid');
  if (stat.size > WALLPAPER_MAX) throw new Error('wallpaper_too_large');
  const ext = path.extname(source).toLowerCase();
  if (!WALLPAPER_TYPES[ext]) throw new Error('wallpaper_type');
  const dir = app.getPath('userData');
  for (const old of Object.keys(WALLPAPER_TYPES)) {
    try { fs.unlinkSync(path.join(dir, 'wallpaper' + old)); } catch (_) {}
  }
  const target = path.join(dir, 'wallpaper' + ext);
  fs.copyFileSync(source, target);
  return { name: path.basename(source), url: readWallpaper(target) };
});

ipcMain.handle('appearance:wallpaper', () => {
  const file = wallpaperFile();
  return file ? { name: path.basename(file), url: readWallpaper(file) } : null;
});

ipcMain.handle('appearance:set', (_e, settings = {}) => {
  const theme = settings.theme === 'dark' ? 'dark' : 'light';
  const skin = settings.skin === 'classic' ? 'classic' : 'aqua';
  nativeTheme.themeSource = theme;
  if (win && !win.isDestroyed()) {
    try { win.setTitleBarOverlay(OVERLAY[theme]); } catch (_) {}
    if (platformName === 'win' && isWindows11(windowsBuild)
        && typeof win.setBackgroundMaterial === 'function') {
      try {
        win.setBackgroundMaterial(skin === 'aqua' ? 'acrylic' : 'none');
        win.setBackgroundColor(skin === 'aqua' ? '#00000000' : OVERLAY[theme].color);
      } catch (_) {}
    } else if (!translucentWindow) {
      win.setBackgroundColor(skin === 'aqua' ? (theme === 'dark' ? '#060b15' : '#eef3f9') : OVERLAY[theme].color);
    }
  }
  if (appConfig && !configError && !process.env.AGENTDESK_SHOT && !process.env.AGENTDESK_LIVETEST) {
    const appearance = { ...normalizeSettings(settings), theme };
    let changed = false;
    appConfig.mutate((draft) => {
      if (JSON.stringify(draft.appearance) === JSON.stringify(appearance)) return false;
      draft.appearance = appearance;
      changed = true;
    }).then(() => {
      if (changed) logger?.audit('appearance_change', { status: 'ok' });
    }).catch((error) => console.error('appearance:', error.code || 'config_write_failed'));
  }
  return { theme, skin };
});

// 远程 Codex：状态、事件、审批请求转发给界面
// started: whether this client has begun connecting at all. Before the server is confirmed in onboarding (or before
// the enrollment login) nothing connects, so the boot screen must not wait for a connection that will not come.
const remoteStatus = (state) => ({ ...state, started: connectivityStarted || Boolean(enrolledSession) });
const toUi = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
let lastRemoteState;
let lastRemoteRoute;
remote.on('status', (s) => {
  const route = s.route?.route;
  if (route !== lastRemoteRoute) {
    lastRemoteRoute = route;
    logger?.log('ssh_route', { route });
  }
  if (s.codex !== lastRemoteState) {
    lastRemoteState = s.codex;
    logger?.log('remote_connection', { status: s.codex, route });
  }
  toUi('remote:status', remoteStatus(s));
});
remote.on('notification', (m) => toUi('codex:event', m));
remote.on('server-request', (m) => {
  if (m.method === 'item/tool/call') {
    const connection = remote.codexProc;
    const params = m.params || {};
    const command = !enrollment && typeof params.tool === 'string' && localCommands.isCommandTool(params.tool);
    if (command) {
      const turn = fileTurns.get(params.turnId);
      const allowedTurn = !params.namespace && turn && turn.threadId === params.threadId;
      (allowedTurn
        ? codexCommand(params, turn, m.id)
        : Promise.resolve(localFiles.result(false, { error: '本机命令需要处于活动轮次' })))
        .then((result) => { if (connection === remote.codexProc && remote.pendingReqs.has(m.id)) remote.respond(m.id, result); }).catch(() => {});
      return;
    }
    const winFile = !mac && !enrollment && typeof params.tool === 'string' && params.tool.startsWith('windows_file_');
    const macFile = mac && !enrollment && typeof params.tool === 'string' && params.tool.startsWith('agentdesk_file_');
    const turn = fileTurns.get(params.turnId);
    const active = !params.namespace && turn && turn.threadId === params.threadId;
    const scopedRead = /_file_(?:list|read|read_batch|glob|grep)$/.test(params.tool || '');
    const scopedWrite = /_file_(?:write_batch|edit)$/.test(params.tool || '');
    const allowed = active && (turn.policy === 'full' || scopedRead || (scopedWrite && turn.policy === 'ask'));
    const trackBatch = (filename, run) => checkpoints().around(params.turnId, params.threadId, params.tool.replace(/(?:write_batch|edit)$/, 'write'), { path: filename }, run);
    const task = (async () => {
      if (!winFile && !macFile) return desktop.call(params);
      const files = winFile ? windowsFiles : localFiles;
      if (!allowed) return files.result(false, { error: '当前轮次没有本机文件权限' });
      if (scopedWrite && turn.policy === 'ask') {
        const edit = params.tool.endsWith('_edit');
        let paths;
        if (edit) {
          if (typeof params.arguments?.path !== 'string') return files.result(false, { error: 'invalid_edit' });
          paths = [params.arguments.path];
        } else {
          try { require('./orchestrator/file-batch').validate(params.arguments?.items, true); }
          catch (error) { return files.result(false, { error: error.message }); }
          paths = params.arguments.items.map((item) => item.path);
        }
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', message: edit ? 'Codex 请求替换本机文件中的文本' : `Codex 请求批量写入 ${paths.length} 个本机文件`,
          detail: paths.map((filename) => filename.replace(/[\r\n]/g, ' ')).join('\n'), buttons: ['取消', '允许这一次'], defaultId: 0, cancelId: 0,
        });
        if (response !== 1 || fileTurns.get(params.turnId) !== turn) return files.result(false, { error: '本机文件修改未获批准' });
      }
      return checkpoints().around(params.turnId, params.threadId, params.tool, params.arguments,
        () => files.call(params.tool, params.arguments, (target) => shell.trashItem(target), trackBatch));
    })();
    task.then((result) => {
      if (connection === remote.codexProc && remote.pendingReqs.has(m.id)) remote.respond(m.id, result);
    }).catch(() => {});
    return;
  }
  toUi('codex:server-request', m);
  notifyIfAway('Codex 等待你的审批', approvalSummary(m));
});
remote.on('notification', ({ method, params }) => {
  if (method === 'turn/started' && params?.turn?.id) codexTurns.add(params.turn.id);
  if (method === 'turn/completed' && params?.turn?.id) codexTurns.delete(params.turn.id);
  if (method === 'turn/started' && desktopThreads.has(params.threadId)) {
    desktop.active.set(params.turn.id, params.threadId);
  }
  if (method === 'turn/started' && filePolicies.has(params.threadId)) {
    fileTurns.set(params.turn.id, { threadId: params.threadId, ...filePolicies.get(params.threadId) });
  }
  if (method === 'turn/completed') {
    desktop.active.delete(params.turn.id);
    desktopThreads.delete(params.threadId);
    fileTurns.delete(params.turn.id);
    commandRuns.cancelTurn(commandScope('codex', params.threadId), params.turn.id);
    finishCheckpoint(params.turn.id);
    filePolicies.delete(params.threadId);
  } else if (method === 'serverRequest/resolved') {
    remote.pendingReqs.delete(params.requestId);
  }
});
remote.on('notification', (m) => {
  if (m.method === 'turn/completed') {
    const st = m.params?.turn?.status;
    notifyIfAway(st === 'failed' ? 'Codex 本轮失败' : 'Codex 已完成', st === 'interrupted' ? '本轮已停止' : '点击查看结果');
  }
});
remote.on('codex-sleep', () => toUi('codex:sleep', null));
remote.on('codex-ready', (info) => toUi('codex:ready', info));
remote.on('codex-down', () => toUi('codex:down', null));
function clearLocalTools() {
  desktopThreads.clear();
  filePolicies.clear();
  fileTurns.clear();
  desktop.stop();
}
remote.on('codex-down', clearLocalTools);
// The Codex connection is gone: its turns no longer run anything on this computer.
remote.on('codex-down', () => codexTurns.clear());
remote.on('codex-sleep', clearLocalTools);
ipcMain.handle('desktop:enabled', () => desktop.enabled);
ipcMain.handle('desktop:toggle', (event) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return desktop.enabled;
  return toggleDesktop(!desktop.enabled);
});
ipcMain.handle('remote:status', () => remoteStatus(remote.state));
ipcMain.handle('remote:reconnect', () => { if (!hostConfirmed() || enrollment && !enrolledSession) return false; remote.reconnect(); return true; });
ipcMain.handle('remote:wake', () => !hostConfirmed() || enrollment && !enrolledSession ? false : remote.wake());
ipcMain.handle('remote:touch', () => { remote.touch(); return true; });

// 窗口不在前台时，用系统通知提醒审批 / 完成（与官方桌面端一致）
function approvalSummary(m) {
  const p = m.params || {};
  const tp = p._meta?.tool_params || {};
  const cmd = tp.command || (Array.isArray(p.command) ? p.command.join(' ') : p.command) || p.message || m.method;
  return String(cmd).replace(/\s+/g, ' ').slice(0, 140);
}
function notifyIfAway(title, body) {
  if (!win || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'build', 'icon.png'), silent: false });
  n.on('click', () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  n.show();
  win.flashFrame(true);
}

// 本机工作区（只读）：文件树 / 预览 / Git 改动
ws.on('changed', () => toUi('ws:changed', null));
ipcMain.handle('ws:access', async () => { const a = await ws.access(); if (a.ok) ws.watch(); return a; });
ipcMain.handle('ws:tree', () => ws.tree().catch((e) => ({ error: e.message, items: [] })));
ipcMain.handle('ws:read', (_e, rel) => ws.read(rel).catch((e) => ({ error: e.message })));
ipcMain.handle('ws:changes', () => ws.changes().catch((e) => ({ error: e.message, files: [] })));
ipcMain.handle('ws:diff', (_e, rel) => ws.diff(rel).catch((e) => ({ error: e.message, text: '' })));

// 技能：本机技能列表；用到时把该技能目录上传到 VPS（同一次连接内按签名缓存）
const skillCache = new Map();
ipcMain.handle('skills:local', () => ws.localSkills().catch(() => []));
ipcMain.handle('skills:upload', async (_e, skill, projectId) => {
  try {
    const approved = (await ws.localSkills()).find(({ folder, name }) => folder === skill?.folder && name === skill?.name);
    if (!approved) throw new Error('找不到本机技能。');
    const pack = await ws.packSkill(approved.dir);
    const workspace = currentRemoteDirectory(projectId);
    if (!workspace) throw new Error('请配置远程工作区目录。');
    const root = path.posix.join(workspace, '.agentdesk-skills');
    const dest = path.posix.join(root, skill.folder.replace(/[^\w.-]/g, '_'));
    if (skillCache.get(dest) !== pack.sig) { await remote.upload(dest, pack.files); skillCache.set(dest, pack.sig); }
    // Codex 只从已注册的技能根目录装载技能；上传后注册该目录并刷新目录缓存。
    await remote.request('skills/extraRoots/set', { extraRoots: [root] });
    const listed = await remote.request('skills/list', { cwds: [workspace], forceReload: true });
    const found = (listed?.data || []).some((entry) => (entry.skills || []).some((s) => s.enabled !== false && s.name === approved.name));
    if (!found) throw new Error('技能已上传，但 Codex 没有识别；请升级 VPS 上的 Codex。');
    return { ok: true, path: path.posix.join(dest, 'SKILL.md') };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
remote.on('codex-down', () => skillCache.clear());

// 附件：选择或粘贴的文件上传到 VPS 的 .agentdesk-uploads（VPS 端 7 天后自动清理）
// Codex attachments go up one whole file per request, so the window is told which file of how many is on its way
// (a progress bar per batch); progress() with no arguments ends the batch.
function uploadProgress(count) {
  const batch = randomUUID();
  return (index, name) => toUi('files:uploadProgress', index === undefined ? { batch, done: true }
    : { batch, index, count, name: String(name).slice(0, 120) });
}
async function uploadOne(name, b64, projectId) {
  const safe = randomUUID() + '-' + String(name).replace(/[^\w.\-一-龥]/g, '_').slice(-80);
  const workspace = currentRemoteDirectory(projectId);
  if (!workspace) throw new Error('请配置远程工作区目录。');
  const dir = path.posix.join(workspace, '.agentdesk-uploads');
  const [full] = await remote.upload(dir, [{ rel: safe, b64 }]);
  return { name, path: full, image: /\.(png|jpe?g|gif|webp)$/i.test(name) };
}
ipcMain.handle('files:pick', async (_event, folders = false, projectId = appConfig?.active?.id) => {
  const r = await dialog.showOpenDialog(win, {
    properties: [folders ? 'openDirectory' : 'openFile', 'multiSelections'],
    title: '选择要发给 Codex 的附件（每个不超过 25 MB）',
  });
  if (r.canceled) return { ok: true, files: [] };
  const out = [];
  const progress = uploadProgress(r.filePaths.length);
  try {
    for (const [index, f] of r.filePaths.entries()) {
      progress(index, path.basename(f));
      const d = await readAttachment(f, attachmentLimit);
      out.push(await uploadOne(d.name, d.bytes.toString('base64'), projectId));
    }
  } catch (e) { return { ok: false, error: String(e.message || e), files: out }; }
  finally { progress(); }
  return { ok: true, files: out };
});
const { attachmentLimit, maxAttachments, attachmentRoot, validAttachments } = require('./orchestrator/attachments');
const { readAttachment, cleanName } = require('./attachment-files');
const chatAttachments = new Map();
const chatAttachmentUploads = new Set();
// Attachments for Claude / Grok / Antigravity chats and for group tasks: any file type, a folder as one .zip.
// They wait here until the message is sent; the VPS gets them only with that message.
const chatProject = (event, projectId) => fromMainWindow(event) && typeof projectId === 'string' &&
  appConfig?.value.projects.some(item => item.id === projectId);
function stageChat(projectId, name, bytes) {
  if (bytes.length > attachmentLimit) throw Error('单个附件必须不超过 25 MB。');
  if (chatAttachments.size >= maxAttachments * 3) throw Error('待发送的附件过多，请先移除或发送已有附件。');
  const item = { id: randomUUID(), name: cleanName(name), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  chatAttachments.set(item.id, { item, bytes, projectId });
  return item;
}
async function stagePaths(projectId, paths) {
  const files = [], errors = [];
  if (paths.length > maxAttachments) return { files, errors: [`一条消息最多 ${maxAttachments} 个附件。`] };
  for (const filename of paths) {
    try {
      const { name, bytes, folder } = await readAttachment(filename, attachmentLimit);
      files.push({ ...stageChat(projectId, name, bytes), ...(folder && { folder }) });
    } catch (error) { errors.push(path.basename(filename) + '：' + error.message); }
  }
  return { files, errors };
}
ipcMain.handle('files:pickChat', async (event, projectId, folders = false) => {
  if (!chatProject(event, projectId)) return { files: [], errors: ['无法为此项目添加附件。'] };
  const picked = await dialog.showOpenDialog(win, { properties: [folders ? 'openDirectory' : 'openFile', 'multiSelections'],
    title: folders ? '选择文件夹（打包成 .zip 发送）' : `选择附件（任意类型，每条消息最多 ${maxAttachments} 个，每个不超过 25 MB）` });
  if (picked.canceled) return { files: [], errors: [] };
  return stagePaths(projectId, picked.filePaths);
});
ipcMain.handle('files:dropChat', async (event, projectId, paths) => {
  if (!chatProject(event, projectId) || !Array.isArray(paths) || !paths.every(item => typeof item === 'string' && path.isAbsolute(item))) {
    return { files: [], errors: ['无法为此项目添加附件。'] };
  }
  return stagePaths(projectId, paths);
});
ipcMain.handle('files:pasteChat', async (event, projectId, name, b64) => {
  if (!chatProject(event, projectId) || typeof name !== 'string' || typeof b64 !== 'string' ||
      b64.length > Math.ceil(attachmentLimit / 3) * 4) return { files: [], errors: ['粘贴的文件超过 25 MB。'] };
  try { return { files: [stageChat(projectId, name, Buffer.from(b64, 'base64'))], errors: [] }; }
  catch (error) { return { files: [], errors: [error.message] }; }
});
// Single chats in their own Git worktree (session-worktrees.js). The page names a session; the paths come
// from the main process's own record.
const { SessionWorktrees } = require('./session-worktrees');
let worktreeStore;
const worktrees = () => worktreeStore ||= new SessionWorktrees(path.join(app.getPath('userData'), 'worktrees.json'));
const worktreeView = (record, key) => record && { key, path: record.path, branch: record.branch, baseBranch: record.baseBranch, mergedAt: record.mergedAt };
ipcMain.handle('worktrees:create', async (event, projectId, sessionId) => {
  if (!fromMainWindow(event) || typeof projectId !== 'string' || typeof sessionId !== 'string') return { ok: false, error: 'invalid_request' };
  const root = localRootFor(projectId);
  if (!root) return { ok: false, error: '请先为这个项目选择本机目录' };
  try { return { ok: true, worktree: worktreeView(await worktrees().create(projectId, root, sessionId), sessionId) }; }
  catch (error) { return { ok: false, error: error.message }; }
});
for (const action of ['diff', 'merge', 'discard']) {
  ipcMain.handle('worktrees:' + action, async (event, sessionId) => {
    if (!fromMainWindow(event) || typeof sessionId !== 'string') return { ok: false, error: 'invalid_request' };
    try {
      const value = await worktrees()[action](sessionId);
      logger?.audit('session_worktree', { status: action, projectId: worktrees().get(sessionId)?.projectId });
      return { ok: true, ...value, worktree: worktreeView(worktrees().get(sessionId), sessionId) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}
ipcMain.handle('worktrees:bind', (event, sessionId, threadId) => {
  if (!fromMainWindow(event) || typeof sessionId !== 'string' || typeof threadId !== 'string') return false;
  worktrees().bindThread(sessionId, threadId);
  return true;
});
ipcMain.handle('worktrees:forThread', (event, threadId) => {
  if (!fromMainWindow(event) || typeof threadId !== 'string') return null;
  const record = worktrees().forThread(threadId);
  return record ? worktreeView(record, record.key) : null;
});
ipcMain.handle('checkpoints:undo', async (event, turnId, force) => {
  if (!fromMainWindow(event) || typeof turnId !== 'string') return { ok: false, error: 'invalid_request' };
  try { return { ok: true, ...(await checkpoints().undo(turnId, { force: force === true })) }; }
  catch (error) { return { ok: false, error: error.code === 'ENOENT' ? '找不到这一轮的存档（可能已被清理）' : error.message }; }
});
ipcMain.handle('checkpoints:list', (event, threadId) =>
  fromMainWindow(event) && typeof threadId === 'string' ? checkpoints().list(threadId) : []);
ipcMain.handle('files:forgetChat', (event, id) => fromMainWindow(event) && chatAttachments.delete(id));
// 拖入的文件：测试目录内的文件/文件夹直接引用路径（Codex 能通过 ssh_exec 访问）；
// 其他文件上传到 VPS；外部文件夹不上传（体积不可控），提示用户
ipcMain.handle('files:drop', async (_e, paths, projectId = appConfig?.active?.id) => {
  const root = localRootFor(projectId);
  const files = [], mentions = [], errors = [];
  const list = (Array.isArray(paths) ? paths : []).slice(0, 20);
  const progress = uploadProgress(list.length);
  try {
    for (const [index, p] of list.entries()) {
      try {
        const rel = ws.relIfInside(p, root);
        if (rel !== null) { mentions.push(rel); continue; }
        // Any file; a folder outside the test folder is packed into one .zip.
        progress(index, path.basename(p));
        const d = await readAttachment(p, attachmentLimit);
        files.push(await uploadOne(d.name, d.bytes.toString('base64'), projectId));
      } catch (e) { errors.push(`${path.basename(p)}：${e.message || e}`); }
    }
  } finally { progress(); }
  return { files, mentions, errors };
});
ipcMain.handle('files:uploadData', async (_e, name, b64, projectId = appConfig?.active?.id) => {
  const progress = uploadProgress(1);
  try {
    if (typeof b64 !== 'string' || b64.length > Math.ceil(attachmentLimit / 3) * 4) throw new Error('文件超过 25 MB');
    progress(0, name);
    return { ok: true, file: await uploadOne(name, b64, projectId) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { progress(); }
});
ipcMain.handle('remote:config', () => ({ workspace: currentRemoteDirectory(), host: remote.cfg.host, localWorkspace: ws.root, projectId: appConfig?.active?.id }));
ipcMain.handle('codex:request', async (event, method, params) => {
  try {
    if (!fromMainWindow(event) || !hostConfirmed()) throw new Error('invalid_request');
    if (updateLocked() && method === 'turn/start') throw new Error(UPDATE_LOCKED);
    const { projectId, worktreeSession, ...request } = params || {};
    if (deletingProjects.has(projectId || codexCommandRoots.get(params?.threadId)?.projectId)) throw new Error('项目正在删除。');
    const native = await nativeDesktop()?.select('codex', method, params);
    if (native) return { ok: true, result: await native.request(method, request) };
    params = request;
    const directory = currentRemoteDirectory(projectId);
    const project = projectId ?? (method === 'thread/start' ? appConfig?.active?.id : undefined);
    if (method === 'thread/start' || method === 'thread/list') params = { ...params, cwd: directory };
    if (method === 'skills/list') params = { ...params, cwds: directory ? [directory] : [] };
    if (enrollment && !enrolledSession) throw new Error('sign_in_required');
    if (method === 'thread/start' && directory) await remote.request('fs/createDirectory', { path: directory, recursive: true });
    if (method === 'thread/start' || method === 'thread/resume') {
      const desktopSpecs = desktop.enabled ? await desktop.specs() : [];
      params = { ...params, dynamicTools: [...desktopSpecs, ...(mac && !enrollment ? localFiles.specs : []), ...(mac || enrollment ? [] : windowsFiles.specs),
        ...(enrollment ? [] : localCommands.specs)] };
      if (method === 'thread/resume' && desktop.enabled && params?.threadId) desktopThreads.add(params.threadId);
    }
    if (method === 'turn/start') {
      // A read-only (plan) turn must not be able to click, type or take screenshots.
      const readOnly = params.sandboxPolicy?.type === 'readOnly';
      if (desktop.enabled && !readOnly) {
        await desktop.specs();
        desktopThreads.add(params.threadId);
      } else {
        desktopThreads.delete(params.threadId);
      }
      const fullAccess = params.approvalPolicy === 'never' && params.sandboxPolicy?.type === 'dangerFullAccess';
      if (fullAccess && nativeDesktop() && codexCommandRoots.get(params.threadId)?.root) {
        throw new Error('此会话使用旧线路。要启用 Windows 本机终端，请在该项目新建完全访问单聊。原对话保留。');
      }
      filePolicies.set(params.threadId, { policy: readOnly ? 'read' : fullAccess ? 'full' : 'ask',
        binding: codexCommandRoots.get(params.threadId) });
    }
    if (method === 'turn/interrupt' && typeof params.threadId === 'string' && typeof params.turnId === 'string') {
      fileTurns.delete(params.turnId);
      commandRuns.cancelTurn(commandScope('codex', params.threadId), params.turnId);
    }
    const result = await remote.request(method, params);
    if ((method === 'thread/start' || method === 'thread/resume') && result?.thread?.id && project) {
      const threadId = result.thread.id;
      if (!codexCommandRoots.has(threadId)) codexCommandRoots.set(threadId, { projectId: project, root: localRootFor(project) });
    }
    if (method === 'thread/archive') codexCommandRoots.delete(params.threadId);
    // This thread is on the MCP route although native chats exist here: 完全访问 would be refused on it (turn/start
    // above), so the app offers that mode only in a new chat.
    if ((method === 'thread/start' || method === 'thread/resume') && result?.thread?.id && nativeDesktop() &&
        codexCommandRoots.get(result.thread.id)?.root) return { ok: true, result: { ...result, fullAccessNeedsNewChat: true } };
    return { ok: true, result };
  } catch (e) {
    if (method === 'turn/start') {
      desktopThreads.delete(params?.threadId);
      filePolicies.delete(params?.threadId);
    }
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('codex:respond', (event, id, result, error) => {
  if (!fromMainWindow(event)) return false;
  if (answerNativeQuestion(id, result, error)) return true;
  try {
    if (!remote.respond(id, result, error)) return false;
    const outcome = ['accept', 'acceptForSession', 'approve', 'approved', 'approved_for_session'].includes(result?.decision) || result?.action === 'accept'
      ? 'approved' : result?.answers ? 'answered' : 'declined';
    logger?.audit('codex_approval', { status: outcome, projectId: appConfig.active?.id });
    return true;
  } catch { return false; }
});

/* ---------- Claude / Grok / Antigravity 单聊 ---------- */
const CHAT_LABEL = { claude: 'Claude', grok: 'Grok', antigravity: 'Antigravity' };

function chatLink(agent) {
  if (typeof agent !== 'string' || !CHAT_AGENTS.has(agent)) throw new Error('unknown_chat_agent');
  const link = chatLinks.get(agent);
  for (const key of ['host', 'port', 'knownHosts', 'chatUser', 'chatScript',
    'claudeKey', 'grokKey', 'antigravityKey', 'claudeUser', 'grokUser', 'antigravityUser', 'jump']) {
    if (remote.cfg[key] !== undefined) link.cfg[key] = remote.cfg[key];
  }
  if (remote.cfg.jump === undefined) delete link.cfg.jump;
  if (remote.cfg.configError === undefined) delete link.cfg.configError;
  else link.cfg.configError = remote.cfg.configError;
  link.key = link.cfg[agent + 'Key'];
  link.user = link.cfg[agent + 'User'] || link.cfg.chatUser;
  link.route = remote.route;
  return link;
}

function localRootFor(projectId) {
  const project = projectId === undefined || projectId === null
    ? appConfig?.active
    : appConfig?.value.projects.find(({ id }) => id === projectId);
  if (projectId !== undefined && projectId !== null && !project) throw new Error('project_not_found');
  if (deletingProjects.has(project?.id)) throw new Error('项目正在删除，请等待清理完成。');
  return project?.localRoot || null;
}

function rememberChatThread(agent, threadId, { projectId, localRoot, tools, approvalPolicy, sandboxPolicy }) {
  chatThreads.set(threadId, {
    agent,
    threadId,
    projectId: projectId ?? null,
    localRoot: localRoot || '',
    commandRoot: projectId ? localRootFor(projectId) : localRoot,
    tools: tools instanceof Set
      ? new Set(tools)
      : new Set((tools || chatToolSpecs()).map((tool) => tool.name)),
    approvalPolicy,
    sandboxPolicy,
  });
}

function commandWorktree(params, projectId) {
  const worktree = worktrees().forThread(params.threadId);
  return worktree?.projectId === projectId ? worktree?.path : undefined;
}

function commandPreview(params, projectId, root) {
  const selected = localCommands.catalogue(commandsFile(), root).find(({ name }) => name === params.arguments?.name);
  return selected && { argv: selected.argv, cwd: commandWorktree(params, projectId) || selected.cwd };
}

function directCommand(agent, params, requestId, projectId, root, approved) {
  const scope = commandScope(agent, params.threadId);
  return Promise.resolve().then(() => localCommands.call(params.tool, params.arguments, {
    configFile: commandsFile(),
    localRoot: root,
    worktree: commandWorktree(params, projectId),
    approved,
    runs: commandRuns,
    scope,
    turnId: params.turnId,
    itemId: params.itemId,
    key: JSON.stringify([scope, params.turnId, params.itemId || requestId]),
  })).catch((error) => localFiles.result(false, { error: error.message }));
}

async function codexCommand(params, turn, requestId) {
  const { root, projectId } = turn.binding || {};
  if (!root) return localFiles.result(false, { error: '没有绑定本机项目目录，请重新打开会话' });
  let approved;
  if (localCommands.isRunTool(params.tool)) {
    if (turn.policy === 'read') return localFiles.result(false, { error: '只读轮次不能在本机运行命令' });
    if (turn.policy === 'ask') {
      approved = commandPreview(params, projectId, root);
      if (!approved) return localFiles.result(false, { error: 'command_not_enabled_for_agents' });
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', message: 'Codex 请求运行本机命令',
        detail: approved.cwd + '\n' + JSON.stringify(approved.argv), buttons: ['取消', '允许运行'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1 || fileTurns.get(params.turnId) !== turn) {
        return localFiles.result(false, { error: '本机命令未获批准' });
      }
    }
  }
  return directCommand('codex', params, requestId, projectId, root, approved);
}

ipcMain.handle('local-command:list', async (event, agent, threadId) => {
  if (!fromMainWindow(event) || typeof agent !== 'string' || typeof threadId !== 'string') return [];
  return await nativeDesktop()?.commands(agent, threadId, 'list') ?? commandRuns.list(commandScope(agent, threadId));
});
ipcMain.handle('local-command:cancel', async (event, agent, threadId, id) => {
  if (!fromMainWindow(event) || typeof agent !== 'string' || typeof threadId !== 'string' || typeof id !== 'string') return null;
  const native = await nativeDesktop()?.commands(agent, threadId, 'stop', id);
  return native === undefined ? commandRuns.cancel(commandScope(agent, threadId), id) : native;
});

// Interactive terminals of native conversations (D4): the chat window's panel. The Worker owns the processes, so
// they keep running when the conversation is switched or the window is closed.
const TERMINAL_OPS = new Set(['capabilities', 'list', 'read', 'open', 'input', 'takeover', 'resize', 'signal', 'close']);
ipcMain.handle('terminal:call', async (event, agent, threadId, op, fields = {}) => {
  if (!fromMainWindow(event) || typeof agent !== 'string' || typeof threadId !== 'string' || !TERMINAL_OPS.has(op) ||
      !fields || typeof fields !== 'object' || Array.isArray(fields)) return { ok: false, error: 'invalid_request' };
  if (updateLocked() && ['open', 'input'].includes(op)) return { ok: false, error: UPDATE_LOCKED };
  try {
    const native = nativeDesktop();
    if (!native) return { ok: false, error: 'terminal_unavailable' };
    const value = await native.terminal(agent, threadId, op, fields);
    if (value === undefined) return { ok: false, error: 'terminal_needs_native_chat' };
    return { ok: true, value };
  } catch (error) { return { ok: false, error: error.message }; }
});

function forgetChatThread(threadId) {
  chatThreads.delete(threadId);
  for (const [turnId, turn] of chatTurns) if (turn.threadId === threadId) finishChatTurn(turnId);
}

function finishChatTurn(turnId) {
  chatTurns.delete(turnId);
  desktop.active.delete(turnId);
}

async function chatToolTask(agent, params, requestId) {
  const mapping = chatThreads.get(params.threadId);
  const invalid = (message) => localFiles.result(false, { error: message });
  if (!mapping || mapping.agent !== agent) return invalid('单聊线程不存在或已归档，请重新打开会话');
  const turn = chatTurns.get(params.turnId);
  if (!turn || turn.agent !== agent || turn.threadId !== params.threadId) return invalid('单聊轮次已结束，请重试');
  if (turn.desktopTools.has(params.tool)) return desktop.call(params);
  if (typeof params.tool !== 'string' || !mapping.tools.has(params.tool)) return invalid('该工具在当前单聊中不可用');
  if (localCommands.isCommandTool(params.tool)) {
    if (turn.readOnly && localCommands.isRunTool(params.tool)) return invalid('只读轮次不能在本机运行命令');
    const approved = turn.commandApprovals?.get(params.itemId);
    if (params.requiresApproval && !approved) return invalid('找不到已审批的本机命令');
    return directCommand(agent, params, requestId, mapping.projectId, mapping.commandRoot, approved);
  }
  if (turn.readOnly && localFiles.isWriteTool(params.tool)) return invalid('只读轮次不能修改本机文件');
  const tool = chatFileTools === windowsFiles ? params.tool.replace(/^agentdesk_file_/, 'windows_file_') : params.tool;
  const trackBatch = (filename, run) => checkpoints().around(params.turnId, params.threadId, tool.replace(/(?:write_batch|edit)$/, 'write'), { path: filename }, run);
  return checkpoints().around(params.turnId, params.threadId, tool, params.arguments,
    () => chatFileTools.call(tool, params.arguments, (target) => shell.trashItem(target), trackBatch));
}

for (const [agent, link] of chatLinks) {
  link.on('status', (status) => toUi('chat:status-event', status));
  // VPS2 says a client version is available (Q3): the main process looks it up itself; the notice proves nothing.
  link.on('ready', (info) => { if (info?.clientUpdate?.available === true) updates?.serverNotice(); });
  link.on('ready', () => logger?.log('chat_connection', {
    status: 'ready', projectId: appConfig?.active?.id, agent, route: link.status().route?.route,
  }));
  link.on('down', (info) => {
    for (const [turnId, turn] of chatTurns) if (turn.agent === agent) finishChatTurn(turnId);
    logger?.log('chat_connection', { status: 'down', agent, route: link.status().route?.route });
    toUi('chat:down', info);
  });
  link.on('sleep', () => toUi('chat:sleep', { agent }));
  link.on('event', (message) => {
    if (message.method === 'agentdesk/clientUpdate') { updates?.serverNotice(); return; }
    if (message.method === 'turn/completed') {
      finishChatTurn(message.params?.turn?.id);
      commandRuns.cancelTurn(commandScope(agent, message.params?.threadId), message.params?.turn?.id);
      finishCheckpoint(message.params?.turn?.id);
      const status = message.params?.turn?.status;
      notifyIfAway(`${CHAT_LABEL[agent]} ${status === 'failed' ? '本轮失败' : '已完成'}`,
        status === 'interrupted' ? '本轮已停止' : '点击查看结果');
    }
    toUi('chat:event', message);
  });
  link.on('server-request', (message) => {
    if (message.method === 'item/tool/call') {
      if (!hostConfirmed()) {
        try { link.respond(message.id, localFiles.result(false, { error: 'AgentDesk 尚未完成主机确认' })); } catch {}
        return;
      }
      chatToolTask(agent, message.params || {}, message.id).then((result) => {
        try { link.respond(message.id, result); } catch {}
      }).catch(() => {});
      return;
    }
    if (message.method === 'item/tool/requestApproval' && localCommands.isRunTool(message.params?.tool)) {
      const params = message.params;
      const turn = chatTurns.get(params.turnId);
      const mapping = chatThreads.get(params.threadId);
      const preview = turn?.agent === agent && turn.threadId === params.threadId &&
        commandPreview(params, mapping?.projectId, mapping?.commandRoot);
      if (!preview) {
        try { link.respond(message.id, { decision: 'decline' }); } catch {}
        return;
      }
      if (params.itemId) (turn.commandApprovals ||= new Map()).set(params.itemId, preview);
      message = { ...message, params: { ...params, localCommand: preview } };
    }
    toUi('chat:server-request', message);
    if (message.method === 'item/tool/requestUserInput') notifyIfAway(`${CHAT_LABEL[agent]} 有问题要问你`, questionSummary(message));
    if (message.method === 'item/tool/requestApproval') {
      const tool = message.params?.tool || '文件修改';
      notifyIfAway(`${CHAT_LABEL[agent]} 等待你的审批`, tool + ' · ' + String(message.params?.arguments?.path || '').slice(0, 120));
    }
  });
}

ipcMain.handle('chat:status', (_event, agent) => {
  if (agent === undefined || agent === null) {
    return { ok: true, agents: Object.fromEntries([...chatLinks].map(([id, link]) => [id, link.status()])) };
  }
  if (typeof agent !== 'string' || !chatLinks.has(agent)) return { ok: false, error: 'unknown_chat_agent' };
  return { ok: true, ...chatLinks.get(agent).status() };
});

ipcMain.handle('chat:wake', async (event, agent) => {
  if (!fromMainWindow(event) || !hostConfirmed()) return false;
  try { return await chatLink(agent).wake(); } catch { return false; }
});

ipcMain.handle('chat:reconnect', (event, agent) => {
  if (!fromMainWindow(event) || !hostConfirmed()) return false;
  try { return chatLink(agent).reconnect(); } catch { return false; }
});

// D9: upload a staged attachment to its conversation now, and report each state to the window. Success is shown
// only from the server's commit receipt (size and sha256 checked, stored, bound to this device and session).
async function uploadChatAttachmentV2(link, agent, threadId, id) {
  const file = chatAttachments.get(id);
  if (!file) throw Error('invalid_attachment');
  const state = file.v2?.threadId === threadId ? file.v2 : null;
  if (state?.state === 'received') return state.attachmentId;
  if (state?.uploading) return state.uploading;
  const notify = (fields) => toUi('chat:attachment', { agent, threadId, id, name: file.item.name, size: file.item.size, ...fields });
  const job = (async () => {
    let attachmentId = state?.attachmentId;
    let offset = 0;
    if (attachmentId) {
      // Resume where the server stopped (after a failure or a reconnect).
      const listed = await link.request('attachment/list', { threadId });
      const known = listed?.data?.find((entry) => entry.attachmentId === attachmentId);
      if (known?.state === 'received') offset = file.bytes.length;
      else if (known?.state === 'uploading') offset = known.nextOffset;
      else attachmentId = undefined;
    }
    if (!attachmentId) {
      const begun = await link.request('attachment/begin', { threadId, name: file.item.name, size: file.item.size, sha256: file.item.sha256 });
      attachmentId = begun.attachmentId;
    }
    file.v2 = { threadId, attachmentId, state: 'uploading', uploading: file.v2?.uploading };
    notify({ state: 'uploading', progress: file.bytes.length ? offset / file.bytes.length : 0 });
    while (offset < file.bytes.length) {
      const chunk = file.bytes.subarray(offset, offset + 192 * 1024);
      const answer = await link.request('attachment/chunk', { threadId, attachmentId, offset, data: chunk.toString('base64') });
      offset = answer.nextOffset;
      notify({ state: 'uploading', progress: offset / file.bytes.length });
    }
    const receipt = await link.request('attachment/commit', { threadId, attachmentId });
    if (receipt?.state !== 'received' || receipt.sha256 !== file.item.sha256 || receipt.size !== file.item.size) throw Error('attachment_receipt_mismatch');
    file.v2 = { threadId, attachmentId, state: 'received', receivedAt: receipt.receivedAt };
    notify({ state: 'received', attachmentId, receivedAt: receipt.receivedAt, sha256: receipt.sha256 });
    return attachmentId;
  })();
  file.v2 = { ...(file.v2 || { threadId }), threadId, uploading: job };
  try { return await job; }
  catch (error) {
    file.v2 = { threadId, attachmentId: file.v2?.attachmentId, state: 'failed' };
    notify({ state: 'failed', error: error.message });
    throw error;
  }
}

ipcMain.handle('files:uploadChat', async (event, agent, threadId, ids) => {
  if (!fromMainWindow(event) || !hostConfirmed() || typeof threadId !== 'string' || !Array.isArray(ids)) return { ok: false, error: 'invalid_request' };
  const mapping = chatThreads.get(threadId);
  const link = chatLinks.get(agent);
  if (!mapping || mapping.agent !== agent || !link) return { ok: false, error: 'invalid_request' };
  if (link.info?.features?.attachmentsV2 !== true) return { ok: true, v2: false };
  const results = [];
  for (const id of ids.slice(0, maxAttachments)) {
    try { results.push({ id, attachmentId: await uploadChatAttachmentV2(link, agent, threadId, id), state: 'received' }); }
    catch (error) { results.push({ id, state: 'failed', error: error.message }); }
  }
  return { ok: true, v2: true, results };
});

ipcMain.handle('chat:request', async (event, agent, method, params) => {
  try {
    if (!fromMainWindow(event) || !hostConfirmed()) throw new Error('invalid_request');
    if (typeof method !== 'string') throw new Error('invalid_method');
    if (deletingProjects.has(params?.projectId || chatThreads.get(params?.threadId)?.projectId)) throw new Error('项目正在删除。');
    if (method.startsWith('attachment/') || method.startsWith('project/')) throw new Error('invalid_method');
    if (updateLocked() && method === 'turn/start') throw new Error(UPDATE_LOCKED);
    // Grok can hang during native session initialization on macOS. Start new chats
    // on the existing direct channel, without replaying or moving any existing native chat.
    const useGrokDirect = mac && agent === 'grok';
    const native = useGrokDirect && method === 'thread/start'
      ? null : await nativeDesktop()?.select(agent, method, params);
    const link = native || chatLink(agent);
    if (enrollment && !enrolledSession) throw new Error('sign_in_required');
    let request = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
    // See the turn/start check below: on the MCP route, with native chats available, 完全访问 needs a new chat.
    const legacyRoute = (result) => (!native && !useGrokDirect && nativeDesktop() && result && typeof result === 'object'
      ? { ...result, fullAccessNeedsNewChat: true } : result);

    if (method === 'thread/start') {
      const { projectId, worktreeSession, ...rest } = request;
      let localRoot = localRootFor(projectId);
      if (!localRoot) throw new Error('请先为当前项目选择本机目录，再开始单聊');
      if (worktreeSession !== undefined) {
        // The conversation works in its own worktree instead of the project folder.
        const record = typeof worktreeSession === 'string' && worktrees().get(worktreeSession);
        if (!record || record.projectId !== projectId) throw new Error('找不到这个会话的独立工作树');
        localRoot = record.path;
      }
      request = {
        ...rest,
        projectId: projectId ?? appConfig?.active?.id ?? null,
        localRoot,
        dynamicTools: chatToolSpecs(),
      };
      const result = await link.request(method, request);
      const threadId = result?.thread?.id;
      if (!threadId) throw new Error('单聊服务没有返回会话 ID');
      if (worktreeSession !== undefined) worktrees().bindThread(worktreeSession, threadId);
      rememberChatThread(agent, threadId, {
        projectId: request.projectId,
        localRoot,
        tools: chatToolSpecs(),
        approvalPolicy: request.approvalPolicy,
        sandboxPolicy: request.sandboxPolicy,
      });
      if (useGrokDirect) toUi('chat:event', { agent, method: 'agentdesk/fallback',
        params: { threadId, reason: 'Grok Mac 原生会话初始化暂不可用' } });
      logger?.audit('chat_thread', { status: 'started', projectId: request.projectId, agent });
      return { ok: true, result: legacyRoute(result) };
    }

    if (method === 'thread/resume') {
      const result = await link.request(method, request);
      const threadId = result?.thread?.id || request.threadId;
      if (threadId) {
        const previous = chatThreads.get(threadId);
        rememberChatThread(agent, threadId, {
          projectId: result?.projectId ?? previous?.projectId,
          localRoot: result?.localRoot || previous?.localRoot || localRootFor(result?.projectId ?? previous?.projectId),
          tools: chatToolSpecs(),
          approvalPolicy: result?.approvalPolicy ?? previous?.approvalPolicy,
          sandboxPolicy: result?.sandboxPolicy ?? previous?.sandboxPolicy,
        });
      }
      return { ok: true, result: legacyRoute(result) };
    }

    if (method === 'turn/start') {
      const mapping = chatThreads.get(request.threadId);
      if (!mapping || mapping.agent !== agent) throw Error('请重新打开单聊后再发送。');
      const policy = request.sandboxPolicy || mapping.sandboxPolicy;
      if (!native && !useGrokDirect && nativeDesktop() && mapping.commandRoot && policy?.type === 'dangerFullAccess' &&
          (request.approvalPolicy ?? mapping.approvalPolicy) === 'never') {
        throw new Error('此会话使用旧线路。要启用 Windows 本机终端，请在该项目新建完全访问单聊。原对话保留。');
      }
      const readOnly = policy?.type === 'readOnly';
      const desktopSpecs = desktop.enabled && !readOnly ? await desktop.specs().catch(() => []) : [];
      request.dynamicTools = [...chatToolSpecs(), ...desktopSpecs];
      const attachments = request.attachments;
      let result;
      // Direct chat v2: the server keeps only a hash of the project path, so the path goes with every turn; and
      // attachments are sent as server-confirmed ids (D9) instead of raw chunks with the turn.
      const v2 = !native && link.info?.features?.attachmentsV2 === true;
      if (v2) request.localRoot = mapping.localRoot;
      if (v2 && attachments !== undefined) {
        if (!validAttachments(attachments)) throw Error('invalid_attachment');
        const ids = [];
        for (const item of attachments) {
          const file = chatAttachments.get(item.id);
          if (!file || file.projectId !== mapping.projectId || file.item.sha256 !== item.sha256) throw Error('invalid_attachment');
          ids.push(await uploadChatAttachmentV2(link, agent, request.threadId, item.id));
        }
        delete request.attachments;
        request.attachmentIds = ids;
        result = await link.request(method, request);
        for (const item of attachments) chatAttachments.delete(item.id);
      } else if (attachments !== undefined) {
        if (!mapping || mapping.agent !== agent || !validAttachments(attachments)) throw Error('invalid_attachment');
        const files = attachments.map(item => {
          const file = chatAttachments.get(item.id);
          if (!file || file.projectId !== mapping.projectId || file.item.sha256 !== item.sha256 ||
              file.item.name !== item.name || file.item.size !== item.size) throw Error('invalid_attachment');
          return file;
        });
        const threadId = request.threadId;
        if (chatAttachmentUploads.has(agent)) throw Error('该模型正在上传另一条消息的附件，请稍后再试。');
        chatAttachmentUploads.add(agent);
        try {
          await link.request('attachment/reset', { threadId });
          for (const { item, bytes } of files) {
            for (let offset = 0; offset < Math.max(1, bytes.length); offset += 192 * 1024) {
              const chunk = bytes.subarray(offset, offset + 192 * 1024);
              await link.request('attachment/chunk', { threadId, id: item.id, offset, data: chunk.toString('base64') });
            }
          }
          result = await link.request(method, request);
          for (const { item } of files) chatAttachments.delete(item.id);
        } catch (error) {
          await link.request('attachment/reset', { threadId }).catch(() => {});
          throw error;
        } finally { chatAttachmentUploads.delete(agent); }
      } else result = await link.request(method, request);
      const turnId = result?.turn?.id;
      if (turnId) {
        chatTurns.set(turnId, {
          agent,
          threadId: request.threadId,
          readOnly,
          desktopTools: new Set(desktopSpecs.map(({ name }) => name)),
        });
        if (desktopSpecs.length && desktop.enabled) desktop.active.set(turnId, request.threadId);
        if (mapping) {
          if (request.sandboxPolicy) mapping.sandboxPolicy = request.sandboxPolicy;
          if (request.approvalPolicy) mapping.approvalPolicy = request.approvalPolicy;
        }
      }
      return { ok: true, result };
    }

    if (method === 'turn/interrupt' && typeof request.threadId === 'string' && typeof request.turnId === 'string') {
      if (chatTurns.get(request.turnId)?.threadId === request.threadId) finishChatTurn(request.turnId);
      commandRuns.cancelTurn(commandScope(agent, request.threadId), request.turnId);
    }

    if (method === 'thread/archive') {
      const result = await link.request(method, request);
      if (request.threadId) forgetChatThread(request.threadId);
      return { ok: true, result };
    }

    return { ok: true, result: await link.request(method, request) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('chat:respond', (event, agent, id, result, error) => {
  if (!fromMainWindow(event)) return false;
  if (answerNativeQuestion(id, result, error)) return true;
  try {
    const link = chatLink(agent);
    if (!link.respond(id, result, error)) return false;
    const outcome = ['accept', 'acceptForSession', 'approve', 'approved', 'approved_for_session'].includes(result?.decision)
      ? 'approved' : result?.decision ? 'declined' : 'answered';
    logger?.audit('chat_approval', { status: outcome, projectId: appConfig?.active?.id, agent });
    return true;
  } catch { return false; }
});

// 桌宠（Clawd on Desk）状态推送
ipcMain.handle('clawd:status', () => clawd.status());
ipcMain.handle('clawd:send', (_e, evt) => clawd.send(evt));

const macBridgeState = path.join(require('node:os').homedir(), 'Library', 'Application Support', 'AgentDesk', 'bridge', 'state');
let stopMacDesktop;
function startMacDesktop() {
  if (!mac || !fs.existsSync(macBridgeState)) return;
  const { Lines } = require('./orchestrator/transport');
  const { createServer } = require('node:net');
  const socketPath = path.join(macBridgeState, 'desktop.sock');
  try {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error('desktop_socket_path_occupied');
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(error.message);
      return;
    }
  }
  const server = createServer((socket) => {
    const wire = new Lines(socket, socket, 28 * 1024 * 1024);
    wire.once('frame', async (params) => {
      try {
        if (!desktop.enabled) throw new Error('mac_desktop_disabled');
        await desktop.specs();
        desktop.active.set(params.turnId, params.threadId);
        const value = await desktop.call(params);
        wire.send({ ok: true, value });
      } catch (error) {
        if (!socket.destroyed) wire.send({ ok: false, error: error.message });
      } finally {
        desktop.active.delete(params.turnId);
        socket.end();
      }
    });
  });
  server.on('error', (error) => console.error('Mac desktop bridge:', error.message));
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  stopMacDesktop = () => server.close();
}

const orchestrationOperations = new Set([
  'routes', 'select_route', 'submit', 'start_plan', 'plan_reply', 'plan_approve', 'status', 'cancel', 'stop_step', 'steer_step', 'revise_plan', 'approve_addition', 'handover_choose', 'permission_answer',
  'apply', 'reconcile', 'quota_status', 'resource_status', 'broadcast', 'compact_project', 'project_tasks',
  'task_diff', 'task_log', 'task_artifacts', 'task_activity', 'stop_command', 'onboarding_check', 'diagnostics', 'maintenance',
  'status_snapshot', 'cli_upgrade', 'cli_upgrade_status', 'patch_download', 'env_fix_revert', 'outside_restore',
  'client_update', 'client_update_read', 'open_tasks', 'project_delete',
]);
const auditedTasks = new Set(['submit', 'start_plan', 'plan_approve', 'broadcast', 'apply', 'cancel', 'compact_project']);

async function orchestratorControl(frame) {
  if ((!mac && !enrollment && !bridgeControlSocket) || !frame || !orchestrationOperations.has(frame.operation)) {
    return { ok: false, error: '无权操作主控线路' };
  }
  const { request } = require('./orchestrator/mcp');
  if (!hostConfirmed() || (enrollment && !enrolledSession)) return { ok: false, error: 'sign_in_required' };
  const socket = enrolledSession?.controlSocket || bridgeControlSocket || path.join(macBridgeState, 'control.sock');
  const { projectId, ...operation } = frame;
  const project = projectId === undefined ? appConfig?.active : appConfig?.value.projects.find(({ id }) => id === projectId);
  if (projectId !== undefined && !project) return { ok: false, error: 'project_not_found' };
  const audit = (status, result) => {
    if (auditedTasks.has(frame.operation)) logger?.audit('orchestrator_task', {
      operation: frame.operation, projectId: project?.id, taskId: result?.id || frame.taskId, status,
    });
  };
  try {
    const workspace = project?.orchestratorWorkspace;
    if (localBridgeSettings && frame.operation === 'submit' && frame.mode === 'edit' && frame.tags?.includes('direct')) {
      const name = workspace || localBridgeSettings.controlWorkspace;
      const bridgeRoot = localBridgeSettings.workspaces?.[name]?.root;
      if (!bridgeRoot || !project?.localRoot ||
          fs.realpathSync(bridgeRoot) !== fs.realpathSync(project.localRoot)) {
        audit('failed');
        return { ok: false, error: 'direct_workspace_not_bound' };
      }
    }
    const attachments = frame.attachments;
    if (attachments !== undefined) {
      if (!['submit', 'start_plan'].includes(frame.operation) || !project || !validAttachments(attachments) ||
          attachments.some(item => {
            const record = chatAttachments.get(item.id);
            return !record || record.projectId !== project.id || record.item.sha256 !== item.sha256 ||
              record.item.name !== item.name || record.item.size !== item.size;
          })) return { ok: false, error: 'invalid_attachment' };
      const stateDir = await request(socket, { operation: 'attachment_state' }, 3000);
      if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) return { ok: false, error: 'bridge_offline' };
      const folder = attachmentRoot(stateDir, frame.taskId);
      await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
      for (const item of attachments) await fs.promises.writeFile(path.join(folder, item.id), chatAttachments.get(item.id).bytes,
        { flag: 'wx', mode: 0o600 });
    }
    // project_delete only ever comes from the main process (the IPC refuses it); a group project names its own workspace.
    const target = frame.operation === 'project_delete' && typeof operation.workspace === 'string' ? operation.workspace : workspace;
    const value = await request(socket, { ...operation, workspace: target }, frame.operation === 'apply' ? 310000 : frame.operation === 'project_delete' ? 120000 : 16000);
    for (const item of attachments || []) chatAttachments.delete(item.id);
    audit('ok', value);
    return { ok: true, value };
  } catch (error) {
    audit('failed');
    return { ok: false, error: error.message };
  }
}

ipcMain.handle('orchestrator:control', (event, frame) => {
  if (frame?.operation === 'project_delete') return { ok: false, error: '请使用项目菜单中的删除项目。' };
  if (!fromMainWindow(event)) return { ok: false };
  if (updateLocked() && ['submit', 'start_plan', 'plan_approve', 'broadcast', 'apply', 'approve_addition'].includes(frame?.operation)) {
    return { ok: false, error: UPDATE_LOCKED };
  }
  return orchestratorControl(frame);
});
ipcMain.handle('orchestrator:save-build', async (event, frame) => {
  if (!fromMainWindow(event) || !/^build:[0-9a-f-]{36}$/.test(frame?.artifact || '')) return { ok: false };
  const request = { taskId: frame.taskId, projectId: frame.projectId, operation: 'task_artifacts', artifact: frame.artifact };
  try {
    const metadata = await orchestratorControl(request);
    if (!metadata.ok) return metadata;
    const { name, size, sha256 } = metadata.value;
    if (typeof name !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(size) || size < 0 || size > 20 * 1024 * 1024) throw new Error('invalid_artifact');
    const safeName = path.win32.basename(name).replace(/[^\p{L}\p{N} ._()-]/gu, '_');
    const picked = await dialog.showSaveDialog(win, { title: '保存构建产物', defaultPath: safeName || 'build-artifact' });
    if (picked.canceled || !picked.filePath) return { ok: true, cancelled: true };
    const buffer = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const reply = await orchestratorControl({ ...request, offset });
      if (!reply.ok) return reply;
      const chunk = Buffer.from(reply.value.data || '', 'base64');
      if (!chunk.length || chunk.length > 64 * 1024 || reply.value.offset !== offset ||
          reply.value.size !== size || offset + chunk.length > size) throw new Error('invalid_artifact_chunk');
      chunk.copy(buffer, offset);
      offset += chunk.length;
    }
    if (createHash('sha256').update(buffer).digest('hex') !== sha256) throw new Error('artifact_checksum_mismatch');
    await fs.promises.writeFile(picked.filePath, buffer);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('orchestrator:available', (event) => fromMainWindow(event) && Boolean(mac || enrollment || bridgeControlSocket));

const localChanges = new Map();
ipcMain.handle('localChange:pick', async (event, kind) => {
  if (!fromMainWindow(event) || process.platform !== 'win32' || !['directory', 'file'].includes(kind)) return { cancelled: true };
  try {
    const picked = await dialog.showOpenDialog(win, {
      title: kind === 'directory' ? '选择允许新建文件或文件夹的位置' : '选择要读取并修改的文本文件',
      defaultPath: app.getPath('desktop'),
      properties: [kind === 'directory' ? 'openDirectory' : 'openFile'],
    });
    if (picked.canceled) return { cancelled: true };
    const scope = await require('./local-change').capture(picked.filePaths[0], kind);
    const token = randomUUID();
    if (localChanges.size >= 20) localChanges.delete(localChanges.keys().next().value);
    localChanges.set(token, scope);
    return { token, ...scope };
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle('localChange:apply', async (event, { token, proposal } = {}) => {
  if (!fromMainWindow(event) || process.platform !== 'win32') return { error: '本机文件操作不可用。' };
  if (updateLocked()) return { error: UPDATE_LOCKED };
  const scope = localChanges.get(token);
  if (!scope || scope.pending) return { error: '请选择本机文件或目录，再生成变更。' };
  scope.pending = true;
  try {
    const local = require('./local-change');
    const change = local.prepare(scope, proposal);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: '确认本机文件操作', message: change.target,
      detail: change.action === 'mkdir' ? '在此路径新建文件夹。'
        : (scope.kind === 'file' ? '原内容\n' + scope.before + '\n\n' : '') + '新内容\n' + change.content,
      buttons: ['取消', '确认应用'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { cancelled: true };
    await local.apply(scope, change);
    localChanges.delete(token);
    return { ok: true, path: change.target };
  } catch (error) { return { error: error.message }; }
  finally { scope.pending = false; }
});

function diagnosticSnapshot() {
  return collectDiagnostics({
    version: app.getVersion(), config: appConfig.value, logger, remote: remote.state,
    request: (operation) => process.env.AGENTDESK_OFFLINE ? { ok: false } : orchestratorControl({ operation }),
  });
}

// Updates (updates.js). Every action is decided in this process from its own state; the window only asks.
const updatesDisabled = () => ({ status: 'disabled' });
ipcMain.handle('updates:state', (event) => fromMainWindow(event) ? (updates?.state || updatesDisabled()) : null);
ipcMain.handle('updates:check', async (event) => fromMainWindow(event) ? (updates ? updates.check({ reason: 'manual' }) : updatesDisabled()) : null);
ipcMain.handle('updates:download', async (event) => fromMainWindow(event) && updates ? updates.download() : { ok: false });
ipcMain.handle('updates:retry', async (event) => fromMainWindow(event) && updates ? updates.retry() : { ok: false });
ipcMain.handle('updates:later', (event) => fromMainWindow(event) && updates ? updates.later() : { ok: false });
ipcMain.handle('updates:install', async (event) => fromMainWindow(event) && updates ? updates.install() : { ok: false });
ipcMain.handle('updates:watch', (event) => fromMainWindow(event) && updates ? updates.watchUntilIdle() : { ok: false });
ipcMain.handle('updates:reveal', (event) => fromMainWindow(event) && updates ? updates.revealDownload() : { ok: false });
ipcMain.handle('updates:autoDownload', async (event, value) => {
  if (!fromMainWindow(event) || !updates) return { ok: false };
  const result = updates.setAutoDownload(value === true);
  if (result.ok) {
    await appConfig.mutate((draft) => { draft.update = { ...(draft.update || {}), autoDownload: result.autoDownload }; }).catch(() => {});
  }
  return result;
});
// This version's section of the bundled CHANGELOG.md, shown in the update dialog ("本版更新内容").
ipcMain.handle('updates:changelog', (event) => {
  if (!fromMainWindow(event)) return null;
  try {
    const { changelogNotes } = require('./scripts/changelog-notes');
    const version = app.getVersion();
    return { version, notes: changelogNotes(fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'), version) };
  } catch { return { version: app.getVersion(), notes: null }; }
});
ipcMain.handle('updates:online', (event) => { if (fromMainWindow(event)) updates?.networkRestored(); return true; });

ipcMain.handle('diagnostics:preview', async (event) => {
  if (!fromMainWindow(event)) return { ok: false };
  try {
    const { report, log, audit } = await diagnosticSnapshot();
    return { ok: true, report, logCount: log.length, auditCount: audit.length };
  } catch { return { ok: false, error: '无法生成诊断预览。' }; }
});
ipcMain.handle('diagnostics:export', async (event) => {
  if (!fromMainWindow(event)) return { ok: false };
  const picked = await dialog.showSaveDialog(win, {
    title: '导出诊断包', defaultPath: 'agentdesk-diagnostics.tar.gz',
  });
  if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
  try {
    const filename = picked.filePath.endsWith('.tar.gz') ? picked.filePath : picked.filePath + '.tar.gz';
    await exportDiagnostics(filename, await diagnosticSnapshot());
    logger?.audit('diagnostics_export', { status: 'ok' });
    return { ok: true, filename };
  } catch { return { ok: false, error: '无法写入诊断包。' }; }
});

let enrolledSession;
let enrolling = false;
let enrollmentExpiry;
ipcMain.handle('enrollment:required', () => Boolean(enrollment));
ipcMain.handle('enrollment:ready', () => Boolean(enrolledSession));
ipcMain.handle('enrollment:login', async (event, password) => {
  if (!enrollment || !hostConfirmed() || event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      enrolling || enrolledSession || typeof password !== 'string' || !password || password.length > 256) {
    return { ok: false, error: 'invalid_request' };
  }
  enrolling = true;
  let session;
  try {
    const { createSession } = require('./orchestrator/enrollment-client');
    const knownHosts = skipOnboarding ? enrollment.knownHosts : trustedHost.records.get(appConfig.value.confirmedHost.fingerprint);
    session = await createSession({ ...enrollment, knownHosts }, password, ws.root || preferredRoot);
    Object.assign(remote.cfg, session.remote);
    remote.resetRoute();
    for (const link of chatLinks.values()) {
      link.route = remote.route;
      if (remote.cfg.jump === undefined) delete link.cfg.jump;
      else link.cfg.jump = remote.cfg.jump;
    }
    const { startBridge } = require('./orchestrator/service');
    stopBridge = startBridge({
      config: session.bridge, desktop, recycle: shell.trashItem,
      spawnSsh: (ssh) => remote.openBridge(ssh),
    });
    enrolledSession = session;
    if (!ws.root) ws.setRoot(session.bridge.workspaces[session.bridge.controlWorkspace].root);
    await remote.start();
    enrollmentExpiry = setTimeout(async () => {
      stopBridge?.();
      stopBridge = undefined;
      await remote.stop();
      enrolledSession = undefined;
      await session.close();
      toUi('enrollment:expired');
    }, Math.max(0, session.expires * 1000 - Date.now()));
    logger?.audit('enrollment', { status: 'ok', projectId: appConfig.active?.id });
    return { ok: true };
  } catch (error) {
    logger?.audit('enrollment', { status: 'failed', projectId: appConfig.active?.id });
    if (session) await session.close();
    return { ok: false, error: error.message };
  } finally {
    enrolling = false;
  }
});

let stopBridge;
let bridgeControlSocket;
let localBridgeSettings;
function startOrchestratorBridge() {
  const config = remote.cfg.orchestratorBridge;
  if (!config) return;
  try {
    const { startBridge } = require('./orchestrator/service');
    const settings = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (!skipOnboarding && settings.ssh?.host === trustedHost.host &&
        Number(settings.ssh.port || 22) === Number(remote.cfg.port || 22)) settings.ssh.knownHosts = remote.cfg.knownHosts;
    stopBridge = startBridge({
      config: settings,
      desktop,
      recycle: (target) => shell.trashItem(target),
      spawnSsh: (ssh) => remote.openBridge(ssh),
    });
    bridgeControlSocket = settings.controlSocket;
    localBridgeSettings = settings;
  } catch (error) {
    console.error('AgentDesk Orchestrator Bridge:', error.message);
  }
}

// ---- Updates: probes of the safe-restart gate (update-gate.js), the channel to VPS2, and the quit for installing ----
const hasControlChannel = () => Boolean(mac || enrollment || bridgeControlSocket);
function registerUpdateProbes() {
  updateGate.register('Codex 单聊', countProbe(() => codexTurns.size + remote.pendingReqs.size, 'Codex 单聊正在执行或等待审批'));
  updateGate.register('单聊', () => {
    let count = chatTurns.size;
    for (const link of chatLinks.values()) count += link.activeTurns.size + link.serverIds.size + link.pending.size;
    return count ? gateBusy('Claude / Grok / Antigravity 单聊正在执行、等待审批或等待回复') : gateIdle();
  });
  updateGate.register('原生单聊', countProbe(() => nativeTurns.size, '本机原生单聊正在执行'));
  updateGate.register('本机后台进程', async () => {
    const native = nativeDesktop();
    return native ? native.idleProbe() : gateIdle();
  });
  updateGate.register('本机命令', countProbe(() => commandRuns.listAllScopes().filter((run) => !run.finishedAt).length, '本机命令仍在运行'));
  updateGate.register('Bridge', () => {
    if (!stopBridge) return gateIdle();
    if (typeof stopBridge.activity !== 'function') return gateUnknown('无法确认 Bridge 状态');
    const { runningCommands } = stopBridge.activity();
    return runningCommands ? gateBusy(`Bridge 仍有 ${runningCommands} 个命令在运行`) : gateIdle();
  });
  updateGate.register('群聊', groupTasksProbe(async () => hasControlChannel() ? orchestratorControl({ operation: 'open_tasks' }) : null));
  updateGate.register('审批与文件', countProbe(() => fileTurns.size + desktop.active.size +
    [...localChanges.values()].filter((scope) => scope.pending).length, '有待审批的操作、桌面操作或尚未完成的文件写入'));
}

function readJsonQuiet(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const updateStateFile = () => path.join(app.getPath('userData'), 'update-state.json');
const updateStateStore = {
  async read() { return readJsonQuiet(updateStateFile()) || {}; },
  async write(value) {
    const file = updateStateFile();
    const temporary = file + '.' + randomUUID();
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(temporary, file);
    } finally { await fs.promises.rm(temporary, { force: true }); }
  },
};
// Files an update must leave unchanged; only their hashes are kept (connection-config.js#snapshot).
function updateDataSnapshot() {
  const userData = app.getPath('userData');
  const local = path.join(userData, connectionConfig.FOLDER);
  return connectionConfig.snapshot({
    'config.json': path.join(userData, 'config.json'),
    'bundled-connection/agentdesk-server.json': path.join(local, 'agentdesk-server.json'),
    'bundled-connection/agentdesk-enrollment.json': path.join(local, 'agentdesk-enrollment.json'),
    'remote.json': path.join(os.homedir(), '.agentdesk', mac ? 'mac-remote.json' : 'remote.json'),
    'bridge-config': typeof remote.cfg.orchestratorBridge === 'string' ? remote.cfg.orchestratorBridge : null,
  });
}

// The last step before quitting into the installer: the native-chat Worker ends itself only if idle at that moment;
// nothing else is stopped here (before-quit does the usual shutdown, with nothing left to cancel).
async function prepareForUpdateQuit() {
  const native = nativeDesktop();
  if (native) {
    const result = await native.shutdownIfIdle();
    if (!(result.shutdown === true || result.absent === true)) throw new Error('worker_not_idle');
  }
  updateQuit = true;
}

function startUpdates() {
  const { createLoopbackFeed, controlChannelReader } = require('./update-transport');
  registerUpdateProbes();
  const buildInfo = readJsonQuiet(path.join(__dirname, 'build-info.json')) || {};
  updates = createUpdateManager({
    app, buildInfo: { signed: buildInfo.signed === true }, settings: appConfig.value.update || {}, logger,
    transport: {
      manifest: (request) => orchestratorControl({ operation: 'client_update', update: request }),
      async openFeed(manifest) {
        const read = controlChannelReader(orchestratorControl, { version: manifest.version, platform: manifest.platform, arch: process.arch });
        const feed = createLoopbackFeed({ manifest, read });
        const { url, headers } = await feed.listen();
        return { url, headers, stats: feed.stats, close: () => feed.close() };
      },
    },
    createUpdater: (options, { manualInstall = false } = {}) => {
      const { NsisUpdater, MacUpdater } = require('electron-updater');
      if (process.platform !== 'darwin') return new NsisUpdater(options);
      // An update the user installs by hand never goes to Squirrel.Mac (mac-manual-updater.js).
      if (manualInstall) return new (require('./mac-manual-updater').manualMacUpdater(MacUpdater))(options);
      return new MacUpdater(options);
    },
    newCancellationToken: () => new (require('electron-updater').CancellationToken)(),
    gate: updateGate, prepareForQuit: prepareForUpdateQuit,
    abortPrepare: async () => {
      updateQuit = false;
      // macOS: electron-updater waits for Squirrel's "update-downloaded" to quit and install. After a failed or
      // timed-out installation that must not happen later on its own, with the gate open again.
      if (process.platform === 'darwin') require('electron').autoUpdater.removeAllListeners('update-downloaded');
    },
    stateStore: updateStateStore, snapshotData: async () => updateDataSnapshot(),
    reveal: (file) => shell.showItemInFolder(file),
    onState: (state) => toUi('updates:state', state),
  });
  updates.verifyPreviousInstall().catch(() => {});
  updates.start();
}

// An installer carrying connection settings that differ from the ones kept on this computer: ask, keep by default.
async function askConnectionConflict(names) {
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: '连接配置',
      message: '安装包内的连接配置与本机保存的不同，是否改用安装包内的配置？',
      detail: '默认保留本机配置。改用前会先备份本机配置，重新启动 AgentDesk 后生效。',
      buttons: ['保留本机配置', '改用安装包内的配置'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) { logger?.audit('connection_settings', { status: 'kept' }); return; }
    for (const name of names) connectionConfig.adopt(name, connectionConfig.electronDirs());
    logger?.audit('connection_settings', { status: 'adopted', count: names.length });
  } catch {
    logger?.audit('connection_settings', { status: 'failed' });
  }
}

let ending = false;
function stopServices() {
  clearTimeout(enrollmentExpiry);
  updates?.stop();
  stopBridge?.();
  windowsNative?.disconnect();
  stopMacDesktop?.();
  commandRuns.close();
  clearLocalTools();
  for (const link of chatLinks.values()) link.stop();
  return Promise.all([clawd.endAll(), remote.stop(), enrolledSession?.close(), logger?.log('application_stop')]);
}
app.on('before-quit', (e) => {
  if (ending) return;
  ending = true;
  // Quitting to install an update: the gate has confirmed twice that nothing runs, so the same shutdown has nothing
  // to cancel. The quit is not held back (the installer waits for this process to end); the shutdown is started, not
  // awaited.
  if (updateQuit) { stopServices().catch(() => {}); return; }
  e.preventDefault();
  Promise.race([stopServices(), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.quit());
});

app.whenReady().then(async () => {
  // The app never needs the camera, microphone, location or similar browser permissions, and Electron grants
  // them by default, so refuse everything except writing to the clipboard (the "copy" buttons).
  const allowed = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
  logger = createLogger(path.join(app.getPath('userData'), 'logs'), { onError: () => console.error('AgentDesk 日志写入失败') });
  await loadAppConfig();
  logger.log('application_start', { status: configError ? 'config_error' : 'ok' });
  trustedHost = await configuredHost(enrollment, remote.cfg);
  createWindow();
  if (!process.env.AGENTDESK_OFFLINE && !process.env.AGENTDESK_SHOT) startUpdates();
  if (!process.env.AGENTDESK_SHOT && !process.env.AGENTDESK_OFFLINE) {
    startConnectivity();
    powerMonitor.on('resume', () => { if (!ending && hostConfirmed() && (!enrollment || enrolledSession)) remote.reconnect(); });
    powerMonitor.on('resume', () => { if (!ending) updates?.networkRestored(); });
  }
  if (connectionMigration.conflicts.length) askConnectionConflict(connectionMigration.conflicts);
});
app.on('window-all-closed', () => app.quit());
