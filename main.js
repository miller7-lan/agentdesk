const { app, BrowserWindow, ipcMain, nativeTheme, dialog, Notification, shell, powerMonitor, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID, createHash } = require('crypto');
const os = require('node:os');
const { createUpdateChecks } = require('./updates');
const { createLogger } = require('./logger');
const { collectDiagnostics, exportDiagnostics } = require('./diagnostics');
const { AppConfig, migrate } = require('./app-config');
const { normalizeSettings } = require('./src/appearance');
const { steps: onboardingSteps, configuredHost, verified } = require('./onboarding');
const bootstrapPath = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'agentdesk-enrollment.json');
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
// Where the person's authorized commands are defined: the Bridge configuration (Windows runs its Bridge in the
// app), or on a Mac the file named by agentCommandsFile in mac-remote.json (normally the Mac Bridge's config).
const commandsFile = () => remote.cfg.agentCommandsFile || remote.cfg.orchestratorBridge || null;
const chatToolSpecs = () => [...localFiles.specs, ...localCommands.specs];
const { ChatLink, AGENTS: CHAT_AGENTS } = require('./chat-link');
const { detectOs, parseBuild, materialFor, isWindows11 } = require('./src/platform');
const mac = process.platform === 'darwin';
const platformName = detectOs({ platform: process.platform });
const systemVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
const windowsBuild = platformName === 'win' ? parseBuild(systemVersion) : 0;
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
const checkpoints = () => checkpointStore ||= new Checkpoints(path.join(app.getPath('userData'), 'checkpoints'),
  { trash: (target) => shell.trashItem(target), allowed: (target) => {
    try { localFiles.allowedPath(target, true); } catch (error) { if (mac) throw error; windowsFiles.allowedPath(target, true); }
  } });
function finishCheckpoint(turnId) {
  if (!turnId) return;
  checkpoints().finish(turnId).then((summary) => { if (summary) toUi('checkpoint:ready', summary); })
    .catch((error) => logger?.log('checkpoint_failed', { status: 'failed', error: error.message }));
}
const fullAccessThreads = new Set();
// Claude / Grok / Antigravity 单聊：线程在 VPS 上，工具调用回到本机执行
const chatLinks = new Map([...CHAT_AGENTS].map((agent) => [agent, new ChatLink({ agent })]));
const chatThreads = new Map();
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
let updateChecks;
let updateTimer;
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
      if (project.localRoot) await require('./app-config').validateGitRoot(project.localRoot);
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
  return project?.remoteCwd || enrolledSession?.remote.workspace;
}

for (const operation of ['list', 'add', 'update', 'remove', 'select']) {
  ipcMain.handle('projects:' + operation, async (event, request = {}) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'invalid_request' };
    try {
      if (operation === 'list') return { ok: true, ...appConfig.list(), configError };
      if (configError) throw new Error('配置文件无法读取，请修复或移走后再修改。');
      const { id, name, kind, remoteCwd, orchestratorWorkspace, pickLocal } = request;
      if (operation === 'add' || operation === 'update') {
        let localRoot;
        if (kind === 'local' && (pickLocal || operation === 'add')) {
          const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择 Git 工作区' });
          if (picked.canceled) return { ok: false, cancelled: true };
          [localRoot] = picked.filePaths;
        }
        await appConfig.saveProject(operation === 'update' ? id : undefined, { name, kind, remoteCwd, orchestratorWorkspace }, localRoot);
      } else await appConfig[operation](id);
      activateProject();
      logger?.audit('project_change', { operation, projectId: id || appConfig.active?.id, status: 'ok' });
      return { ok: true, ...appConfig.list() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

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
  toUi('remote:status', s);
});
remote.on('notification', (m) => toUi('codex:event', m));
remote.on('server-request', (m) => {
  if (m.method === 'item/tool/call') {
    const connection = remote.codexProc;
    const params = m.params || {};
    const command = !enrollment && typeof params.tool === 'string' && localCommands.isCommandTool(params.tool);
    if (command) {
      const allowedTurn = !params.namespace && fileTurns.has(params.turnId) && fileTurns.get(params.turnId) === params.threadId;
      const connection = remote.codexProc;
      (allowedTurn
        ? localCommands.call(params.tool, params.arguments, { configFile: commandsFile(), localRoot: localRootFor(appConfig?.active?.id) })
        : Promise.resolve(localFiles.result(false, { error: '本机命令需要处于完全访问模式的活动轮次' })))
        .then((result) => { if (connection === remote.codexProc && remote.pendingReqs.has(m.id)) remote.respond(m.id, result); }).catch(() => {});
      return;
    }
    const winFile = !mac && !enrollment && typeof params.tool === 'string' && params.tool.startsWith('windows_file_');
    const macFile = mac && !enrollment && typeof params.tool === 'string' && params.tool.startsWith('agentdesk_file_');
    const allowed = !params.namespace && fileTurns.has(params.turnId) && fileTurns.get(params.turnId) === params.threadId;
    const task = winFile || macFile
      ? allowed
        ? winFile
          ? checkpoints().around(params.turnId, params.threadId, params.tool, params.arguments,
            () => windowsFiles.call(params.tool, params.arguments, (target) => shell.trashItem(target)))
          : checkpoints().around(params.turnId, params.threadId, params.tool, params.arguments,
            () => localFiles.call(params.tool, params.arguments, (target) => shell.trashItem(target)))
        : Promise.resolve((winFile ? windowsFiles : localFiles).result(false, { error: '本机文件工具需要处于完全访问模式的活动轮次' }))
      : desktop.call(params);
    task.then((result) => {
      if (connection === remote.codexProc && remote.pendingReqs.has(m.id)) remote.respond(m.id, result);
    }).catch(() => {});
    return;
  }
  toUi('codex:server-request', m);
  notifyIfAway('Codex 等待你的审批', approvalSummary(m));
});
remote.on('notification', ({ method, params }) => {
  if (method === 'turn/started' && desktopThreads.has(params.threadId)) {
    desktop.active.set(params.turn.id, params.threadId);
  }
  if (method === 'turn/started' && fullAccessThreads.has(params.threadId)) {
    fileTurns.set(params.turn.id, params.threadId);
  }
  if (method === 'turn/completed') {
    desktop.active.delete(params.turn.id);
    desktopThreads.delete(params.threadId);
    fileTurns.delete(params.turn.id);
    finishCheckpoint(params.turn.id);
    fullAccessThreads.delete(params.threadId);
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
  fullAccessThreads.clear();
  fileTurns.clear();
  desktop.stop();
}
remote.on('codex-down', clearLocalTools);
remote.on('codex-sleep', clearLocalTools);
ipcMain.handle('desktop:enabled', () => desktop.enabled);
ipcMain.handle('desktop:toggle', (event) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return desktop.enabled;
  return toggleDesktop(!desktop.enabled);
});
ipcMain.handle('remote:status', () => ({ ...remote.state }));
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
ipcMain.handle('skills:upload', async (_e, skill) => {
  try {
    const approved = (await ws.localSkills()).find(({ folder, name }) => folder === skill?.folder && name === skill?.name);
    if (!approved) throw new Error('找不到本机技能。');
    const pack = await ws.packSkill(approved.dir);
    const workspace = currentRemoteDirectory();
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
async function uploadOne(name, b64) {
  const safe = Date.now() + '-' + String(name).replace(/[^\w.\-一-龥]/g, '_').slice(-80);
  const workspace = currentRemoteDirectory();
  if (!workspace) throw new Error('请配置远程工作区目录。');
  const dir = path.posix.join(workspace, '.agentdesk-uploads');
  const [full] = await remote.upload(dir, [{ rel: safe, b64 }]);
  return { name, path: full, image: /\.(png|jpe?g|gif|webp)$/i.test(name) };
}
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: '选择要发给 Codex 的文件（任意类型，每个不超过 25 MB）' });
  if (r.canceled) return { ok: true, files: [] };
  const out = [];
  try { for (const f of r.filePaths) { const d = await readAttachment(f, attachmentLimit); out.push(await uploadOne(d.name, d.bytes.toString('base64'))); } }
  catch (e) { return { ok: false, error: String(e.message || e), files: out }; }
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
ipcMain.handle('files:drop', async (_e, paths) => {
  const files = [], mentions = [], errors = [];
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
    try {
      const rel = ws.relIfInside(p);
      if (rel !== null) { mentions.push(rel); continue; }
      // Any file; a folder outside the test folder is packed into one .zip.
      const d = await readAttachment(p, attachmentLimit);
      files.push(await uploadOne(d.name, d.bytes.toString('base64')));
    } catch (e) { errors.push(`${path.basename(p)}：${e.message || e}`); }
  }
  return { files, mentions, errors };
});
ipcMain.handle('files:uploadData', async (_e, name, b64) => {
  try { if (typeof b64 !== 'string' || b64.length > Math.ceil(attachmentLimit / 3) * 4) throw new Error('文件超过 25 MB'); return { ok: true, file: await uploadOne(name, b64) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('remote:config', () => ({ workspace: currentRemoteDirectory(), host: remote.cfg.host, localWorkspace: ws.root, projectId: appConfig?.active?.id }));
ipcMain.handle('codex:request', async (event, method, params) => {
  try {
    if (!fromMainWindow(event) || !hostConfirmed()) throw new Error('invalid_request');
    const { projectId, ...request } = params || {};
    params = request;
    const directory = currentRemoteDirectory(projectId);
    if (method === 'thread/start' || method === 'thread/list') params = { ...params, cwd: directory };
    if (method === 'skills/list') params = { ...params, cwds: directory ? [directory] : [] };
    if (enrollment && !enrolledSession) throw new Error('sign_in_required');
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
      if (params.approvalPolicy === 'never' && params.sandboxPolicy?.type === 'dangerFullAccess') {
        fullAccessThreads.add(params.threadId);
      } else {
        fullAccessThreads.delete(params.threadId);
      }
    }
    return { ok: true, result: await remote.request(method, params) };
  } catch (e) {
    if (method === 'turn/start') {
      desktopThreads.delete(params?.threadId);
      fullAccessThreads.delete(params?.threadId);
    }
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('codex:respond', (event, id, result, error) => {
  if (!fromMainWindow(event)) return false;
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
  return project?.localRoot || null;
}

function rememberChatThread(agent, threadId, { projectId, localRoot, tools, approvalPolicy, sandboxPolicy }) {
  chatThreads.set(threadId, {
    agent,
    threadId,
    projectId: projectId ?? null,
    localRoot: localRoot || '',
    tools: tools instanceof Set
      ? new Set(tools)
      : new Set((tools || chatToolSpecs()).map((tool) => tool.name)),
    approvalPolicy,
    sandboxPolicy,
  });
}

function forgetChatThread(threadId) {
  chatThreads.delete(threadId);
  for (const [turnId, turn] of chatTurns) if (turn.threadId === threadId) chatTurns.delete(turnId);
}

async function chatToolTask(agent, params) {
  const mapping = chatThreads.get(params.threadId);
  const invalid = (message) => localFiles.result(false, { error: message });
  if (!mapping || mapping.agent !== agent) return invalid('单聊线程不存在或已归档，请重新打开会话');
  if (typeof params.tool !== 'string' || !mapping.tools.has(params.tool)) return invalid('该工具在当前单聊中不可用');
  const turn = chatTurns.get(params.turnId);
  if (!turn || turn.agent !== agent || turn.threadId !== params.threadId) return invalid('单聊轮次已结束，请重试');
  if (localCommands.isCommandTool(params.tool)) {
    if (turn.readOnly && localCommands.isRunTool(params.tool)) return invalid('只读轮次不能在本机运行命令');
    return localCommands.call(params.tool, params.arguments, { configFile: commandsFile(), localRoot: mapping.localRoot });
  }
  if (turn.readOnly && localFiles.isWriteTool(params.tool)) return invalid('只读轮次不能修改本机文件');
  return checkpoints().around(params.turnId, params.threadId, params.tool, params.arguments,
    () => localFiles.call(params.tool, params.arguments, (target) => shell.trashItem(target)));
}

for (const [agent, link] of chatLinks) {
  link.on('status', (status) => toUi('chat:status-event', status));
  link.on('ready', () => logger?.log('chat_connection', {
    status: 'ready', projectId: appConfig?.active?.id, agent, route: link.status().route?.route,
  }));
  link.on('down', (info) => {
    for (const [turnId, turn] of chatTurns) if (turn.agent === agent) chatTurns.delete(turnId);
    logger?.log('chat_connection', { status: 'down', agent, route: link.status().route?.route });
    toUi('chat:down', info);
  });
  link.on('sleep', () => toUi('chat:sleep', { agent }));
  link.on('event', (message) => {
    if (message.method === 'turn/completed') {
      chatTurns.delete(message.params?.turn?.id);
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
      chatToolTask(agent, message.params || {}).then((result) => {
        try { link.respond(message.id, result); } catch {}
      }).catch(() => {});
      return;
    }
    toUi('chat:server-request', message);
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

ipcMain.handle('chat:request', async (event, agent, method, params) => {
  try {
    if (!fromMainWindow(event) || !hostConfirmed()) throw new Error('invalid_request');
    if (typeof method !== 'string') throw new Error('invalid_method');
    if (method.startsWith('attachment/')) throw new Error('invalid_method');
    const link = chatLink(agent);
    if (enrollment && !enrolledSession) throw new Error('sign_in_required');
    let request = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};

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
      logger?.audit('chat_thread', { status: 'started', projectId: request.projectId, agent });
      return { ok: true, result };
    }

    if (method === 'thread/resume') {
      const result = await link.request(method, request);
      const threadId = result?.thread?.id || request.threadId;
      if (threadId) {
        const previous = chatThreads.get(threadId);
        rememberChatThread(agent, threadId, {
          projectId: result?.projectId ?? previous?.projectId,
          localRoot: result?.localRoot || previous?.localRoot || localRootFor(result?.projectId ?? previous?.projectId),
          tools: Array.isArray(result?.dynamicTools) ? result.dynamicTools : previous?.tools || chatToolSpecs(),
          approvalPolicy: result?.approvalPolicy ?? previous?.approvalPolicy,
          sandboxPolicy: result?.sandboxPolicy ?? previous?.sandboxPolicy,
        });
      }
      return { ok: true, result };
    }

    if (method === 'turn/start') {
      const mapping = chatThreads.get(request.threadId);
      const attachments = request.attachments;
      let result;
      if (attachments !== undefined) {
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
        const policy = request.sandboxPolicy || mapping?.sandboxPolicy;
        chatTurns.set(turnId, {
          agent,
          threadId: request.threadId,
          readOnly: policy?.type === 'readOnly',
        });
        if (mapping) {
          if (request.sandboxPolicy) mapping.sandboxPolicy = request.sandboxPolicy;
          if (request.approvalPolicy) mapping.approvalPolicy = request.approvalPolicy;
        }
      }
      return { ok: true, result };
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
  'routes', 'select_route', 'submit', 'start_plan', 'plan_reply', 'plan_approve', 'status', 'cancel',
  'apply', 'reconcile', 'quota_status', 'resource_status', 'broadcast', 'compact_project', 'project_tasks',
  'task_diff', 'task_log', 'task_artifacts', 'task_activity', 'onboarding_check', 'diagnostics',
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
    const value = await request(socket, { ...operation, workspace }, frame.operation === 'apply' ? 310000 : 16000);
    for (const item of attachments || []) chatAttachments.delete(item.id);
    audit('ok', value);
    return { ok: true, value };
  } catch (error) {
    audit('failed');
    return { ok: false, error: error.message };
  }
}

ipcMain.handle('orchestrator:control', (event, frame) => fromMainWindow(event) ? orchestratorControl(frame) : { ok: false });
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

ipcMain.handle('updates:check', (event) => fromMainWindow(event) && updateChecks
  ? updateChecks.check() : { ok: true, status: 'disabled' });

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

let ending = false;
app.on('before-quit', (e) => {
  if (ending) return;
  ending = true; e.preventDefault();
  clearTimeout(enrollmentExpiry);
  clearTimeout(updateTimer);
  stopBridge?.();
  stopMacDesktop?.();
  clearLocalTools();
  for (const link of chatLinks.values()) link.stop();
  Promise.race([Promise.all([clawd.endAll(), remote.stop(), enrolledSession?.close(), logger?.log('application_stop')]), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.quit());
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
  if (!process.env.AGENTDESK_OFFLINE && !process.env.AGENTDESK_SHOT) {
    updateChecks = createUpdateChecks({ app, settings: appConfig.value.update, logger });
    if (updateChecks) {
      const schedule = (delay) => {
        updateTimer = setTimeout(async () => {
          await updateChecks.check();
          if (!ending) schedule(24 * 60 * 60_000);
        }, delay);
        updateTimer.unref();
      };
      schedule(30_000);
    }
  }
  if (!process.env.AGENTDESK_SHOT && !process.env.AGENTDESK_OFFLINE) {
    startConnectivity();
    powerMonitor.on('resume', () => { if (!ending && hostConfirmed() && (!enrollment || enrolledSession)) remote.reconnect(); });
  }
});
app.on('window-all-closed', () => app.quit());
