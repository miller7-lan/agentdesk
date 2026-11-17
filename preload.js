const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (ch) => (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

// main.js appends these to the renderer argv, so the platform is known synchronously.
const flag = (name, fallback) => {
  const prefix = '--agentdesk-' + name + '=';
  const found = (process.argv || []).find((arg) => String(arg).startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

contextBridge.exposeInMainWorld('desk', {
  setTheme: (theme) => ipcRenderer.send('theme:set', theme),
  platform: process.platform,
  system: {
    os: flag('os', process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'),
    build: Number(flag('build', '0')) || 0,
    material: flag('material', 'drawn'),
    version: flag('version', ''),
  },
  launch: {
    id: flag('launch', ''),
    boot: flag('boot', 'on'),
  },
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  appearance: {
    pickWallpaper: () => ipcRenderer.invoke('appearance:pickWallpaper'),
    wallpaper: () => ipcRenderer.invoke('appearance:wallpaper'),
    apply: (settings) => ipcRenderer.invoke('appearance:set', settings),
  },
  enrollment: {
    required: () => ipcRenderer.invoke('enrollment:required'),
    ready: () => ipcRenderer.invoke('enrollment:ready'),
    login: (password) => ipcRenderer.invoke('enrollment:login', password),
    onExpired: on('enrollment:expired'),
  },
  updates: { check: () => ipcRenderer.invoke('updates:check') },
  diagnostics: {
    preview: () => ipcRenderer.invoke('diagnostics:preview'),
    export: () => ipcRenderer.invoke('diagnostics:export'),
  },
  onboarding: {
    status: () => ipcRenderer.invoke('onboarding:status'),
    advance: (request) => ipcRenderer.invoke('onboarding:advance', request),
    complete: () => ipcRenderer.invoke('onboarding:complete'),
    reset: () => ipcRenderer.invoke('onboarding:reset'),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: (project) => ipcRenderer.invoke('projects:add', project),
    update: (project) => ipcRenderer.invoke('projects:update', project),
    remove: (id) => ipcRenderer.invoke('projects:remove', { id }),
    select: (id) => ipcRenderer.invoke('projects:select', { id }),
    onChanged: on('projects:changed'),
  },
  orchestrator: { control: (frame) => ipcRenderer.invoke('orchestrator:control', frame) },
  desktop: {
    enabled: () => ipcRenderer.invoke('desktop:enabled'),
    toggle: () => ipcRenderer.invoke('desktop:toggle'),
    onEnabled: on('desktop:enabled'),
  },
  clawd: {
    status: () => ipcRenderer.invoke('clawd:status'),
    send: (evt) => ipcRenderer.invoke('clawd:send', evt),
  },
  test: process.env.AGENTDESK_LIVETEST ? {
    shot: (name) => ipcRenderer.invoke('test:shot', name),
    done: () => ipcRenderer.send('test:done'),
    dropPaths: (paths) => ipcRenderer.invoke('files:drop', paths),
  } : undefined,
  remote: {
    status: () => ipcRenderer.invoke('remote:status'),
    config: () => ipcRenderer.invoke('remote:config'),
    reconnect: () => ipcRenderer.invoke('remote:reconnect'),
    wake: () => ipcRenderer.invoke('remote:wake'),
    touch: () => ipcRenderer.invoke('remote:touch'),
    onStatus: on('remote:status'),
  },
  ws: {
    access: () => ipcRenderer.invoke('ws:access'),
    tree: () => ipcRenderer.invoke('ws:tree'),
    read: (rel) => ipcRenderer.invoke('ws:read', rel),
    changes: () => ipcRenderer.invoke('ws:changes'),
    diff: (rel) => ipcRenderer.invoke('ws:diff', rel),
    onChanged: on('ws:changed'),
  },
  skills: {
    local: () => ipcRenderer.invoke('skills:local'),
    upload: (skill) => ipcRenderer.invoke('skills:upload', skill),
  },
  files: {
    pick: () => ipcRenderer.invoke('files:pick'),
    uploadData: (name, b64) => ipcRenderer.invoke('files:uploadData', name, b64),
    // 从资源管理器拖进来的文件：在预加载脚本里取真实路径，交给主进程处理
    drop: (files) => ipcRenderer.invoke('files:drop', [...files].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean)),
  },
  codex: {
    request: (method, params) => ipcRenderer.invoke('codex:request', method, params),
    respond: (id, result, error) => ipcRenderer.invoke('codex:respond', id, result, error),
    onEvent: on('codex:event'),
    onServerRequest: on('codex:server-request'),
    onReady: on('codex:ready'),
    onDown: on('codex:down'),
    onSleep: on('codex:sleep'),
  },
});
