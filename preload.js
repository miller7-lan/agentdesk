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
  // Client updates: every action is decided in the main process (updates.js, update-gate.js).
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    retry: () => ipcRenderer.invoke('updates:retry'),
    later: () => ipcRenderer.invoke('updates:later'),
    install: () => ipcRenderer.invoke('updates:install'),
    watch: () => ipcRenderer.invoke('updates:watch'),
    reveal: () => ipcRenderer.invoke('updates:reveal'),
    setAutoDownload: (value) => ipcRenderer.invoke('updates:autoDownload', value === true),
    online: () => ipcRenderer.invoke('updates:online'),
    changelog: () => ipcRenderer.invoke('updates:changelog'),
    onState: on('updates:state'),
  },
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
  device: { info: () => ipcRenderer.invoke('device:info') },
  sessions: { remove: (request) => ipcRenderer.invoke('sessions:remove', request) },
  groupProjects: { remove: (request) => ipcRenderer.invoke('groupProjects:remove', request) },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: (project) => ipcRenderer.invoke('projects:add', project),
    pickFolder: () => ipcRenderer.invoke('projects:pickFolder'),
    update: (project) => ipcRenderer.invoke('projects:update', project),
    remove: (id) => ipcRenderer.invoke('projects:remove', { id }),
    select: (id) => ipcRenderer.invoke('projects:select', { id }),
    initialCommit: (id) => ipcRenderer.invoke('projects:initialCommit', { id }),
    onChanged: on('projects:changed'),
  },
  orchestrator: {
    available: () => ipcRenderer.invoke('orchestrator:available'),
    control: (frame) => ipcRenderer.invoke('orchestrator:control', frame),
    saveBuild: (frame) => ipcRenderer.invoke('orchestrator:save-build', frame),
    // Q4: a downloaded group patch, checked against its sha256 before it is kept.
    savePatch: (frame) => ipcRenderer.invoke('orchestrator:save-patch', frame),
  },
  localChange: {
    pick: (kind) => ipcRenderer.invoke('localChange:pick', kind),
    apply: (request) => ipcRenderer.invoke('localChange:apply', request),
  },
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
    upload: (skill, projectId, threadId) => ipcRenderer.invoke('skills:upload', skill, projectId, threadId),
  },
  files: {
    pick: (folders = false, projectId) => ipcRenderer.invoke('files:pick', folders, projectId),
    onUploadProgress: on('files:uploadProgress'),
    pickChat: (projectId, folders = false) => ipcRenderer.invoke('files:pickChat', projectId, folders),
    // Direct chat v2: upload staged attachments to their conversation now; states arrive through chat.onAttachment.
    uploadChat: (agent, threadId, ids) => ipcRenderer.invoke('files:uploadChat', agent, threadId, ids),
    // Any dropped file or folder (a folder becomes one .zip), for Claude / Grok / Antigravity chats and group tasks.
    dropChat: (projectId, files) => ipcRenderer.invoke('files:dropChat', projectId,
      [...files].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean)),
    pasteChat: (projectId, name, b64) => ipcRenderer.invoke('files:pasteChat', projectId, name, b64),
    forgetChat: (id) => ipcRenderer.invoke('files:forgetChat', id),
    uploadData: (name, b64, projectId) => ipcRenderer.invoke('files:uploadData', name, b64, projectId),
    // 从资源管理器拖进来的文件：在预加载脚本里取真实路径，交给主进程处理
    drop: (files, projectId) => ipcRenderer.invoke('files:drop', [...files].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean), projectId),
  },
  // A single chat in its own Git worktree (session-worktrees.js).
  worktrees: {
    create: (projectId, sessionId) => ipcRenderer.invoke('worktrees:create', projectId, sessionId),
    diff: (sessionId) => ipcRenderer.invoke('worktrees:diff', sessionId),
    merge: (sessionId) => ipcRenderer.invoke('worktrees:merge', sessionId),
    discard: (sessionId) => ipcRenderer.invoke('worktrees:discard', sessionId),
    forThread: (threadId) => ipcRenderer.invoke('worktrees:forThread', threadId),
    bind: (sessionId, threadId) => ipcRenderer.invoke('worktrees:bind', sessionId, threadId),
  },
  // Undo the files a turn changed on this computer (checkpoints.js).
  checkpoints: {
    undo: (turnId, force = false) => ipcRenderer.invoke('checkpoints:undo', turnId, force),
    list: (threadId) => ipcRenderer.invoke('checkpoints:list', threadId),
    onReady: on('checkpoint:ready'),
  },
  terminal: {
    call: (agent, threadId, op, fields) => ipcRenderer.invoke('terminal:call', agent, threadId, op, fields),
    onEvent: on('terminal:event'),
  },
  localCommands: {
    list: (agent, threadId) => ipcRenderer.invoke('local-command:list', agent, threadId),
    cancel: (agent, threadId, id) => ipcRenderer.invoke('local-command:cancel', agent, threadId, id),
    onUpdate: on('local-command:update'),
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
  chat: {
    request: (agent, method, params) => ipcRenderer.invoke('chat:request', agent, method, params),
    respond: (agent, id, result, error) => ipcRenderer.invoke('chat:respond', agent, id, result, error),
    status: (agent) => ipcRenderer.invoke('chat:status', agent),
    wake: (agent) => ipcRenderer.invoke('chat:wake', agent),
    reconnect: (agent) => ipcRenderer.invoke('chat:reconnect', agent),
    onEvent: on('chat:event'),
    onAttachment: on('chat:attachment'),
    onServerRequest: on('chat:server-request'),
    onStatus: on('chat:status-event'),
    onDown: on('chat:down'),
    onSleep: on('chat:sleep'),
  },
});
