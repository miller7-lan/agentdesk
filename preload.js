const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (ch) => (cb) => { const h = (_e, v) => cb(v); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('desk', {
  setTheme: (theme) => ipcRenderer.send('theme:set', theme),
  platform: process.platform,
  enrollment: {
    required: () => ipcRenderer.invoke('enrollment:required'),
    login: (password) => ipcRenderer.invoke('enrollment:login', password),
    onExpired: on('enrollment:expired'),
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
