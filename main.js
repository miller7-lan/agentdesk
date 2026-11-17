const { app, BrowserWindow, ipcMain, nativeTheme, dialog, Notification, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
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
const { detectOs, parseBuild, materialFor, isWindows11 } = require('./src/platform');
const mac = process.platform === 'darwin';
const platformName = detectOs({ platform: process.platform });
const systemVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
const windowsBuild = platformName === 'win' ? parseBuild(systemVersion) : 0;
const windowMaterial = materialFor({ os: platformName, build: windowsBuild });
const translucentWindow = windowMaterial === 'vibrancy' || windowMaterial === 'acrylic';
const fileTurns = new Map();
const fullAccessThreads = new Set();

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

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'AgentDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    // macOS vibrancy and Windows 11 acrylic only show through a transparent window background.
    backgroundColor: translucentWindow ? '#00000000' : OVERLAY.dark.color,
    ...(platformName === 'mac' ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    ...(windowMaterial === 'acrylic' ? { backgroundMaterial: 'acrylic' } : {}),
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: mac ? false : OVERLAY.dark,
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
      if (process.env.AGENTDESK_THEME) await win.webContents.executeJavaScript(`document.getElementById('themeToggle').click()`);
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

// 远程 Codex：状态、事件、审批请求转发给界面
const toUi = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
remote.on('status', (s) => toUi('remote:status', s));
remote.on('notification', (m) => toUi('codex:event', m));
remote.on('server-request', (m) => {
  if (m.method === 'item/tool/call') {
    const connection = remote.codexProc;
    const params = m.params || {};
    const isFile = !mac && !enrollment && typeof params.tool === 'string' && params.tool.startsWith('windows_file_');
    const task = isFile
      ? !params.namespace && fileTurns.has(params.turnId) && fileTurns.get(params.turnId) === params.threadId
        ? windowsFiles.call(params.tool, params.arguments, (target) => shell.trashItem(target))
        : Promise.resolve(windowsFiles.result(false, { error: 'Windows file tools require an active AgentDesk Full Access turn' }))
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
ipcMain.handle('remote:reconnect', () => { if (enrollment && !enrolledSession) return false; remote.reconnect(); return true; });
ipcMain.handle('remote:wake', () => enrollment && !enrolledSession ? false : remote.wake());
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
    const pack = await ws.packSkill(skill.dir);
    const dest = path.posix.join(remote.cfg.workspace, '.agentdesk-skills', skill.folder.replace(/[^\w.-]/g, '_'));
    if (skillCache.get(dest) !== pack.sig) { await remote.upload(dest, pack.files); skillCache.set(dest, pack.sig); }
    return { ok: true, path: path.posix.join(dest, 'SKILL.md') };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
remote.on('codex-down', () => skillCache.clear());

// 附件：选择或粘贴的文件上传到 VPS 的 .agentdesk-uploads（VPS 端 7 天后自动清理）
async function uploadOne(name, b64) {
  const safe = Date.now() + '-' + String(name).replace(/[^\w.\-一-龥]/g, '_').slice(-80);
  const dir = path.posix.join(remote.cfg.workspace, '.agentdesk-uploads');
  const [full] = await remote.upload(dir, [{ rel: safe, b64 }]);
  return { name, path: full, image: /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) };
}
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: '选择要发给 Codex 的文件（每个不超过 10 MB）' });
  if (r.canceled) return { ok: true, files: [] };
  const out = [];
  try { for (const f of r.filePaths) { const d = await ws.readUpload(f); out.push(await uploadOne(d.name, d.b64)); } }
  catch (e) { return { ok: false, error: String(e.message || e), files: out }; }
  return { ok: true, files: out };
});
// 拖入的文件：测试目录内的文件/文件夹直接引用路径（Codex 能通过 ssh_exec 访问）；
// 其他文件上传到 VPS；外部文件夹不上传（体积不可控），提示用户
ipcMain.handle('files:drop', async (_e, paths) => {
  const files = [], mentions = [], errors = [];
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, 20)) {
    try {
      const rel = ws.relIfInside(p);
      if (rel !== null) { mentions.push(rel); continue; }
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) { errors.push(`${path.basename(p)}：文件夹不能直接上传，请拖入其中的文件，或先放到测试目录`); continue; }
      const d = await ws.readUpload(p);
      files.push(await uploadOne(d.name, d.b64));
    } catch (e) { errors.push(`${path.basename(p)}：${e.message || e}`); }
  }
  return { files, mentions, errors };
});
ipcMain.handle('files:uploadData', async (_e, name, b64) => {
  try { if (b64.length > 14 * 1024 * 1024) throw new Error('图片超过 10 MB'); return { ok: true, file: await uploadOne(name, b64) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('remote:config', () => ({ workspace: remote.cfg.workspace, host: remote.cfg.host, localWorkspace: ws.root }));
ipcMain.handle('codex:request', async (_e, method, params) => {
  try {
    if (enrollment && !enrolledSession) throw new Error('sign_in_required');
    if (method === 'thread/start' || method === 'thread/resume') {
      const desktopSpecs = desktop.enabled ? await desktop.specs() : [];
      params = { ...params, dynamicTools: [...desktopSpecs, ...(mac || enrollment ? [] : windowsFiles.specs)] };
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
ipcMain.handle('codex:respond', (_e, id, result, error) => {
  try { remote.respond(id, result, error); return true; } catch { return false; }
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

ipcMain.handle('orchestrator:control', async (event, frame) => {
  if ((!mac && !enrollment) || event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      !frame || !['routes', 'select_route', 'submit', 'start_plan', 'plan_reply', 'plan_approve', 'status', 'cancel', 'apply', 'reconcile', 'quota_status'].includes(frame.operation)) {
    return { ok: false, error: '无权操作主控线路' };
  }
  const { request } = require('./orchestrator/mcp');
  if (enrollment && !enrolledSession) return { ok: false, error: 'sign_in_required' };
  const socket = enrolledSession?.controlSocket || path.join(macBridgeState, 'control.sock');
  try {
    const value = await request(socket, frame, frame.operation === 'apply' ? 310000 : 16000);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

let enrolledSession;
let enrolling = false;
let enrollmentExpiry;
ipcMain.handle('enrollment:required', () => Boolean(enrollment));
ipcMain.handle('enrollment:login', async (event, password) => {
  if (!enrollment || event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame ||
      enrolling || enrolledSession || typeof password !== 'string' || !password || password.length > 256) {
    return { ok: false, error: 'invalid_request' };
  }
  enrolling = true;
  let session;
  try {
    const { createSession } = require('./orchestrator/enrollment-client');
    session = await createSession(enrollment, password, ws.root);
    Object.assign(remote.cfg, session.remote);
    const { startBridge } = require('./orchestrator/service');
    stopBridge = startBridge({
      config: session.bridge, desktop, recycle: shell.trashItem,
      spawnSsh: (ssh) => remote.openBridge(ssh),
    });
    enrolledSession = session;
    await remote.start();
    enrollmentExpiry = setTimeout(async () => {
      stopBridge?.();
      stopBridge = undefined;
      await remote.stop();
      enrolledSession = undefined;
      await session.close();
      toUi('enrollment:expired');
    }, Math.max(0, session.expires * 1000 - Date.now()));
    return { ok: true };
  } catch (error) {
    if (session) await session.close();
    return { ok: false, error: error.message };
  } finally {
    enrolling = false;
  }
});

let stopBridge;
function startOrchestratorBridge() {
  const config = remote.cfg.orchestratorBridge;
  if (!config) return;
  try {
    const { startBridge } = require('./orchestrator/service');
    stopBridge = startBridge({
      config: JSON.parse(fs.readFileSync(config, 'utf8')),
      desktop,
      recycle: (target) => shell.trashItem(target),
      spawnSsh: (ssh) => remote.openBridge(ssh),
    });
  } catch (error) {
    console.error('AgentDesk Orchestrator Bridge:', error.message);
  }
}

let ending = false;
app.on('before-quit', (e) => {
  if (ending) return;
  ending = true; e.preventDefault();
  clearTimeout(enrollmentExpiry);
  stopBridge?.();
  stopMacDesktop?.();
  clearLocalTools();
  Promise.race([Promise.all([clawd.endAll(), remote.stop(), enrolledSession?.close()]), new Promise((r) => setTimeout(r, 2500))]).finally(() => app.quit());
});

app.whenReady().then(() => {
  createWindow();
  if (!process.env.AGENTDESK_SHOT && !process.env.AGENTDESK_OFFLINE) {
    if (!enrollment) {
      remote.start();
      startOrchestratorBridge();
      startMacDesktop();
    }
    powerMonitor.on('resume', () => { if (!ending && (!enrollment || enrolledSession)) remote.reconnect(); });
  }
});
app.on('window-all-closed', () => app.quit());
