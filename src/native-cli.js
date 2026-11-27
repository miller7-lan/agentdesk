// Native CLI single chats: the official CLI (Claude Code, Codex, Grok Build, Antigravity) in its own TUI, running on
// VPS2 in this project and shown here exactly as it draws itself. AgentDesk adds around it: the connection and its
// state, the project, the edit / read-only choice, uploads (drag, paste, button), reconnect-and-continue, and
// keyboard behaviour that matches this computer (Windows Terminal on Windows, Terminal.app on a Mac).
(() => {
  const A = window.__desk;
  const api = window.desk?.tui;
  if (!A?.LIVE || !api || !window.Terminal) return;
  const { $, esc } = A;
  const mac = (window.desk?.system?.os || navigator.platform || '').toLowerCase().includes('mac');
  const CHAT_AGENTS = ['claude', 'grok', 'antigravity'];
  const agentOf = (s) => { const agent = s?.provider || s?.agent; return CHAT_AGENTS.includes(agent) ? agent : 'codex'; };
  const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', grok: 'Grok Build', antigravity: 'Antigravity CLI' };
  const STATES = {
    connecting: ['wait', '正在连接 VPS2…'], ready: ['ok', '已连接'], disconnected: ['err', '连接中断'],
    exited: ['idle', 'CLI 已退出'], closed: ['idle', '未启动'], failed: ['err', '启动失败'],
    reconnecting: ['wait', '断线，正在重连…（CLI 仍在 VPS2 上运行）'], not_enabled: ['err', '这台电脑未开通'],
  };
  const ERRORS = {
    tui_unavailable: '这台电脑上没有原生单聊服务（需要 Windows 或 Mac 版 AgentDesk 并已连上 VPS2）。',
    native_mount_timeout: '挂载项目超时：请检查 VPS2 连接后重试。',
    native_bridge_disconnected: '和 VPS2 的连接断开了。',
    native_session_requires_private_namespace: 'VPS2 的原生 CLI 服务版本不对，请联系管理员更新 VPS2。',
    native_codex_profile_unavailable: 'VPS2 上的 Codex 没有登录。',
    native_provider_profile_requires_service_account: 'VPS2 上这个 CLI 的账户没有配置好。',
  };
  const explain = (error) => {
    const text = String(error?.message || error || '');
    return ERRORS[text.split(':')[0]] || text;
  };

  // ---------- markup ----------
  const center = document.querySelector('main.center');
  if (!center) return;

  const view = document.createElement('section');
  view.className = 'native-cli';
  view.id = 'nativeCli';
  view.hidden = true;
  view.setAttribute('aria-label', '原生 CLI');
  view.innerHTML = `
    <header class="native-cli-bar">
      <span class="native-cli-avatar" id="nativeCliAvatar"></span>
      <div class="native-cli-title"><strong id="nativeCliName"></strong><span id="nativeCliWhere"></span></div>
      <span class="native-cli-state" id="nativeCliState"><span class="dot"></span><span></span></span>
      <div class="grow"></div>
      <button type="button" class="icon-btn" id="nativeCliUpload" title="上传文件给 CLI（也可以直接拖进来或粘贴图片）"><svg viewBox="0 0 24 24"><path d="M16 7l-7.5 7.5a2.5 2.5 0 0 0 3.5 3.5L19 11a4.5 4.5 0 0 0-6.4-6.4L5 12.2"/></svg></button>
      <button type="button" class="icon-btn" id="nativeCliHelp" title="帮助：原生 CLI 怎么用"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/></svg></button>
      <button type="button" class="btn" id="nativeCliRestart" title="重新连接并继续上次的对话">重新连接</button>
      <button type="button" class="btn" id="nativeCliStop" title="结束这个 CLI（对话记录保留，下次打开会继续）">结束</button>
    </header>
    <div class="native-cli-body">
      <div class="native-cli-screen" id="nativeCliScreen"></div>
      <div class="native-cli-cover" id="nativeCliCover" hidden>
        <div class="native-cli-card">
          <span class="native-cli-card-avatar" id="nativeCliCardAvatar"></span>
          <h2 id="nativeCliCardTitle"></h2>
          <p id="nativeCliCardText"></p>
          <button type="button" class="btn primary" id="nativeCliStart"></button>
        </div>
      </div>
      <div class="native-cli-drop" id="nativeCliDrop" hidden><span>松开上传到这个项目的 .uploads/</span></div>
    </div>
    <footer class="native-cli-tools" id="nativeCliTools">
      <button type="button" class="chip" data-cli-tool="upload" title="上传文件给 CLI（也可以直接拖进来或粘贴图片）"><svg viewBox="0 0 24 24"><path d="M16 7l-7.5 7.5a2.5 2.5 0 0 0 3.5 3.5L19 11a4.5 4.5 0 0 0-6.4-6.4L5 12.2"/></svg>附件</button>
      <button type="button" class="chip" data-cli-tool="model" title="在 CLI 里打开 /model（会先清空当前输入的那一行）"><svg viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>模型</button>
      <button type="button" class="chip" data-cli-tool="quota" title="额度与分工（每 1 分钟刷新）"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 8 8h-8z"/></svg>额度</button>
      <button type="button" class="chip" data-cli-tool="help" title="原生 CLI 帮助：按键、命令、断线、开通"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/></svg>帮助</button>
    </footer>
    <input type="file" id="nativeCliFile" multiple hidden>`;
  center.appendChild(view);


  // ---------- state ----------
  let shown = false;              // the open conversation is a CLI chat
  let current = null;             // { key, provider, projectId, chatId, state, mode, cwd, error }
  let wanted = 'write';
  let term = null;
  let fit = null;
  let busy = false;
  const autoStarted = new Set();  // CLI chats started on opening during this run (a stopped one is not restarted)

  // ---------- the CLI chats themselves (kept here; they have no thread on VPS2 the sidebar could list) ----------
  const saved = () => { try { return JSON.parse(localStorage.getItem('agentdesk.cliChats') || '[]'); } catch { return []; } };
  const save = () => {
    const list = A.D.sessions.filter((s) => s.surface === 'cli')
      .map(({ id, project, agent, title, created }) => ({ id, project, agent, title, created }));
    try { localStorage.setItem('agentdesk.cliChats', JSON.stringify(list.slice(0, 100))); } catch {}
  };
  const rel = (at) => {
    const minutes = Math.round((Date.now() - (at || Date.now())) / 60000);
    return minutes < 1 ? '刚刚' : minutes < 60 ? minutes + ' 分钟前' : minutes < 1440 ? Math.round(minutes / 60) + ' 小时前' : Math.round(minutes / 1440) + ' 天前';
  };
  const asSession = (chat) => ({ id: chat.id, project: chat.project, agent: chat.agent, surface: 'cli', title: chat.title || CLI_NAMES[chat.agent] || 'CLI',
    created: chat.created, status: 'idle', time: rel(chat.created), items: [], live: true, diffs: [], term: [] });
  // The sidebar list is rebuilt from VPS2 threads now and then; the CLI chats are put back after each rebuild.
  function restore() {
    let added = false;
    for (const chat of saved()) {
      if (A.D.sessions.some((s) => s.id === chat.id) || !A.proj(chat.project)) continue;
      A.D.sessions.push(asSession(chat));
      added = true;
    }
    if (added) A.renderSidebar?.();
  }
  function create(project, agent) {
    const chat = { id: 'C' + crypto.randomUUID(), project, agent, title: CLI_NAMES[agent] || 'CLI', created: Date.now() };
    A.D.sessions.unshift(asSession(chat));
    save();
    A.openSession(chat.id);
  }
  async function remove(s) {
    if (!window.confirm(`删除「${s.title}」？CLI 会结束，这个对话的记录也不再保留。`)) return;
    await call('forget', { provider: agentOf(s), projectId: A.proj(s.project)?.id, chatId: s.id }).catch(() => {});
    A.D.sessions.splice(A.D.sessions.indexOf(s), 1);
    save();
    if (A.state.active === s.id) {
      const next = A.D.sessions.find((x) => x.live && !x.agentThread);
      if (next) A.openSession(next.id); else A.newDirect(s.project, s.agent);
    } else A.renderAll();
    A.toast('已删除会话');
  }

  const call = async (op, fields) => {
    const answer = await api.call(op, fields);
    if (!answer?.ok) throw new Error(answer?.error || 'tui_failed');
    return answer.value;
  };

  function conversation() {
    const s = A.sess(A.state.active);
    if (!s?.live || s.surface !== 'cli' || A.state.group) return null;
    const project = A.proj(s.project);
    return { provider: agentOf(s), projectId: project?.id, name: project?.name || 'project', chatId: s.id, session: s };
  }

  function theme() {
    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const light = document.documentElement.dataset.theme !== 'dark' &&
      !(document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    // The screen is the conversation area itself (--main), so the TUI sits in AgentDesk rather than in a box.
    const background = color('--main', light ? '#ffffff' : '#15171b');
    const foreground = color('--text', light ? '#222b32' : '#e5e8ed');
    return light ? {
      background, foreground, cursor: color('--accent', '#167565'), cursorAccent: background,
      selectionBackground: '#1675a540', black: '#1f2a31', brightBlack: '#5b6b76', red: '#b4233c', brightRed: '#d0384f',
      green: '#1d7a46', brightGreen: '#26915a', yellow: '#8a6408', brightYellow: '#a7790b', blue: '#1f68a8', brightBlue: '#2f7fc4',
      magenta: '#7e4aa6', brightMagenta: '#9560bf', cyan: '#127a88', brightCyan: '#1a93a3', white: '#c9d2d8', brightWhite: '#ffffff',
    } : {
      background, foreground, cursor: color('--accent', '#67d4be'), cursorAccent: background,
      selectionBackground: '#67d4be44', black: '#232a30', brightBlack: '#6c7a85', red: '#f07c8f', brightRed: '#ff9aab',
      green: '#7bceaa', brightGreen: '#9be0c0', yellow: '#edbf72', brightYellow: '#f6d394', blue: '#78b8ed', brightBlue: '#9dccf5',
      magenta: '#c8a1ef', brightMagenta: '#dbbff7', cyan: '#78cad6', brightCyan: '#9cdbe4', white: '#dce3e6', brightWhite: '#ffffff',
    };
  }

  function copySelection() {
    const text = term?.getSelection();
    if (!text) return false;
    navigator.clipboard?.writeText(text).catch(() => {});
    term.clearSelection();
    return true;
  }

  function ensureTerm() {
    if (term) return term;
    term = new window.Terminal({
      cursorBlink: true, scrollback: 10000, allowProposedApi: true, convertEol: false,
      fontSize: mac ? 13 : 14, lineHeight: 1.1,
      fontFamily: mac ? '"SF Mono", Menlo, Monaco, "PingFang SC", monospace' : '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
      macOptionIsMeta: true, macOptionClickForcesSelection: true, rightClickSelectsWord: mac, altClickMovesCursor: false,
      theme: theme(), linkHandler: { activate: (event, uri) => { if (/^https?:\/\//i.test(uri)) window.open(uri); } },
    });
    const FitAddon = window.FitAddon?.FitAddon;
    if (FitAddon) { fit = new FitAddon(); term.loadAddon(fit); }
    term.open($('#nativeCliScreen'));
    // Keys as this computer's own terminal handles them.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      if (mac) {
        if (event.metaKey && key === 'c') { copySelection(); return false; }
        if (event.metaKey && key === 'v') return false;            // the browser pastes (text or image, below)
        if (event.metaKey && key === 'k') { term.clear(); return false; }
        if (event.metaKey) return false;                            // other ⌘ shortcuts belong to AgentDesk
      } else {
        if (event.ctrlKey && event.shiftKey && key === 'c') { copySelection(); return false; }
        if (event.ctrlKey && !event.shiftKey && key === 'c' && term.hasSelection()) { copySelection(); return false; }
        if (event.ctrlKey && key === 'v') return false;             // the browser pastes (text or image, below)
      }
      // Shift+Enter: a new line in the prompt (Ctrl+J), as the CLIs document for terminals without key reporting.
      if (key === 'enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        send('\n');
        return false;
      }
      return true;
    });
    term.onData((data) => send(data));
    term.onBinary((data) => send(data));
    term.onResize(({ cols, rows }) => { if (current?.state === 'ready') call('resize', { key: current.key, cols, rows }).catch(() => {}); });
    term.onTitleChange((title) => { $('#nativeCliWhere').title = title; });
    new ResizeObserver(() => refit()).observe($('#nativeCliScreen'));
    return term;
  }

  function send(data) {
    if (current?.state !== 'ready') return;
    call('input', { key: current.key, data }).catch(() => {});
  }

  function refit() {
    if (!shown || !fit) return;
    try { fit.fit(); } catch {}
  }

  // ---------- rendering ----------
  function render() {
    const conv = conversation();
    view.hidden = !shown;
    center.classList.toggle('cli-mode', shown);
    if (!shown || !conv) return;
    const name = CLI_NAMES[conv.provider];
    const avatar = window.AgentDeskAvatars?.html(conv.provider, { size: 26, still: true }) || '';
    $('#nativeCliAvatar').innerHTML = avatar;
    $('#nativeCliName').textContent = name;
    const project = A.proj(conv.session.project);
    $('#nativeCliWhere').textContent = project?.name ? `VPS2 · /work/${project.name}` : 'VPS2';
    const state = current?.state || 'closed';
    const [dot, label] = STATES[state] || STATES.closed;
    $('#nativeCliState').className = 'native-cli-state ' + dot;
    $('#nativeCliState span:last-child').textContent = state === 'ready' && current.mode === 'read' ? '已连接 · 只读' : label;
    const mode = current?.state === 'ready' || current?.state === 'connecting' ? current.mode : wanted;
    $('#nativeCliRestart').hidden = !['disconnected', 'exited', 'failed', 'not_enabled'].includes(state);
    $('#nativeCliStop').hidden = !['ready', 'connecting', 'reconnecting'].includes(state);
    $('#nativeCliUpload').disabled = state !== 'ready';
    const cover = $('#nativeCliCover');
    const card = {
      closed: [`启动 ${name}`, `在 VPS2 上打开官方的 ${name}，工作目录就是这个项目。界面、斜杠命令、模型切换和批准提示都和直接在终端里用一样。${current?.known ? '会接着上次的对话继续。' : ''}`, `启动 ${name}`],
      failed: ['没有启动成功', explain(current?.error), '重试'],
      disconnected: ['连接中断', `${explain(current?.error) || '和 VPS2 的连接断开了。'}重新连接后会继续上次的对话。`, '重新连接'],
      exited: [`${name} 已退出`, '对话记录保留在 VPS2 上，重新打开会继续。', '重新打开'],
      not_enabled: ['这台电脑还没开通原生 CLI', '需要管理员在 VPS2 上为这台电脑开通一把 CLI 钥匙（只能打开 CLI，不是 root）。点下面的按钮复制这台电脑的公钥发给管理员；开通后点「重新连接」。', '复制这台电脑的公钥'],
    }[state];
    cover.hidden = !card || busy;
    if (card) {
      $('#nativeCliCardAvatar').innerHTML = window.AgentDeskAvatars?.html(conv.provider, { size: 56, still: true }) || '';
      $('#nativeCliCardTitle').textContent = card[0];
      $('#nativeCliCardText').textContent = card[1] || '';
      $('#nativeCliStart').textContent = card[2];
    }
    if (state === 'ready') requestAnimationFrame(() => { refit(); if (document.activeElement?.closest?.('#nativeCli') == null) term?.focus(); });
  }

  // ---------- actions ----------
  async function attach() {
    const conv = conversation();
    if (!conv) { current = null; render(); return; }
    try {
      const status = await call('status', { provider: conv.provider, projectId: conv.projectId, name: conv.name, chatId: conv.chatId });
      if (status.state === 'no_project') { current = { state: 'failed', error: '原生 CLI 需要一个本机项目：请先为这个单聊选择项目文件夹（项目「···」→ 本机文件夹）。' }; render(); return; }
      const same = current?.key === status.key;
      current = { ...status, provider: conv.provider, projectId: conv.projectId, chatId: conv.chatId };
      ensureTerm();
      if (!same) {
        term.reset();
        if (status.replay?.length) term.write(status.replay instanceof Uint8Array ? status.replay : new Uint8Array(status.replay));
      }
      render();
      if (status.state === 'ready') nudge();
      // Opening a CLI chat starts its CLI (continuing its conversation), once per run: one the person ended stays ended.
      else if (['closed', 'disconnected'].includes(status.state) && !autoStarted.has(conv.chatId)) {
        autoStarted.add(conv.chatId);
        start();
      }
    } catch (error) { current = { state: 'failed', error: error.message }; render(); }
  }

  // Makes the CLI redraw for this window's size (after switching back, or after a replay).
  function nudge() {
    refit();
    if (!term || current?.state !== 'ready') return;
    const { cols, rows } = term;
    call('resize', { key: current.key, cols: Math.max(10, cols - 1), rows }).catch(() => {});
    setTimeout(() => call('resize', { key: current.key, cols, rows }).catch(() => {}), 80);
  }

  async function start() {
    const conv = conversation();
    if (!conv || busy) return;
    busy = true;
    ensureTerm();
    term.reset();
    refit();
    current = { ...(current || {}), state: 'connecting', mode: wanted, error: null };
    render();
    try {
      autoStarted.add(conv.chatId);
      const value = await call('open', { provider: conv.provider, projectId: conv.projectId, name: conv.name, chatId: conv.chatId, mode: wanted, cols: term.cols, rows: term.rows });
      current = { ...current, ...value };
      if (value.replay?.length) term.write(value.replay instanceof Uint8Array ? value.replay : new Uint8Array(value.replay));
    } catch (error) {
      current = { ...current, state: 'failed', error: error.message };
    } finally { busy = false; }
    render();
    if (current.state === 'ready') { term.focus(); nudge(); }
  }

  async function stop() {
    if (!current?.key) return;
    if (!window.confirm('结束这个 CLI？对话记录会保留，下次打开时继续。')) return;
    await call('close', { key: current.key }).catch(() => {});
    current = { ...current, state: 'closed' };
    render();
  }


  async function upload(files) {
    if (current?.state !== 'ready' || !files?.length) return;
    const paths = [];
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { A.toast(`${file.name} 超过 25 MB，没有上传`); continue; }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const name = file.name && file.name !== 'image.png' ? file.name : `paste-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
        paths.push(await call('upload', { projectId: current.projectId, name: A.proj(conversation()?.session.project)?.name || 'project', fileName: name, bytes }));
      } catch (error) { A.toast('上传失败：' + explain(error)); }
    }
    // Typed into the prompt like a dragged file in a terminal: the CLI picks the paths up (images are attached).
    if (paths.length) send(paths.map((item) => (/\s/.test(item) ? `"${item}"` : item)).join(' ') + ' ');
    term?.focus();
  }

  // ---------- events ----------
  // Keys typed into the CLI are the CLI's: AgentDesk's own Ctrl shortcuts (B, J, K, N, Shift+L…) must not also fire.
  // Ctrl+Tab still switches conversations.
  $('#nativeCliScreen').addEventListener('keydown', (event) => {
    if (!(event.ctrlKey && event.key === 'Tab')) event.stopPropagation();
  });
  $('#nativeCliStart').addEventListener('click', async () => {
    if (current?.state !== 'not_enabled') { start(); return; }
    try { await navigator.clipboard.writeText(await call('key')); A.toast('公钥已复制，发给管理员开通即可'); }
    catch (error) { A.toast('没能复制公钥：' + explain(error)); }
  });
  $('#nativeCliHelp').addEventListener('click', () => window.AgentDeskNativeCliHelp?.open());
  $('#nativeCliTools').addEventListener('click', (event) => {
    const tool = event.target.closest('[data-cli-tool]')?.dataset.cliTool;
    if (tool === 'upload') $('#nativeCliFile').click();
    else if (tool === 'help') window.AgentDeskNativeCliHelp?.open();
    else if (tool === 'quota') window.__quotaView?.open();
    else if (tool === 'model') {
      if (current?.state !== 'ready') { A.toast('CLI 还没连上'); return; }
      send('\x15');                                   // Ctrl+U: the line being typed goes first
      setTimeout(() => send('/model'), 60);
      setTimeout(() => send('\r'), 260);
      term?.focus();
    }
  });
  $('#nativeCliRestart').addEventListener('click', start);
  $('#nativeCliStop').addEventListener('click', stop);
  $('#nativeCliUpload').addEventListener('click', () => $('#nativeCliFile').click());
  $('#nativeCliFile').addEventListener('change', (event) => { upload([...event.target.files]); event.target.value = ''; });
  // Images pasted from the clipboard go up as files (the CLI on VPS2 cannot read this computer's clipboard).
  $('#nativeCliScreen').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    upload(files);
  }, true);
  const body = view.querySelector('.native-cli-body');
  let dragDepth = 0;
  body.addEventListener('dragenter', (event) => { if (event.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#nativeCliDrop').hidden = false; event.preventDefault(); } });
  body.addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); event.stopPropagation(); } });
  body.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#nativeCliDrop').hidden = true; } });
  body.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    $('#nativeCliDrop').hidden = true;
    upload([...event.dataTransfer.files]);
  });

  api.onEvent((event) => {
    if (!current || event.key !== current.key) return;
    if (event.type === 'data') {
      ensureTerm().write(event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data));
      return;
    }
    if (event.type === 'state') {
      const was = current.state;
      current = { ...current, ...event };
      if (event.state === 'exited' && was === 'ready') term?.write('\r\n\x1b[2m[CLI 已退出]\x1b[0m\r\n');
      render();
      if (event.state !== 'ready' && was === 'ready' && document.hidden) {
        window.desk?.notify?.(`${CLI_NAMES[current.provider] || 'CLI'} ${STATES[event.state]?.[1] || ''}`);
      }
    }
  });

  // Follow the open conversation: a CLI chat shows its CLI; any other chat shows the usual conversation.
  let lastKey;
  let lastTitles = '';
  setInterval(() => {
    restore();
    const titles = A.D.sessions.filter((s) => s.surface === 'cli').map((s) => s.id + s.title).join('|');
    if (titles !== lastTitles) { lastTitles = titles; save(); }
    const conv = conversation();
    const viewKey = conv ? conv.chatId : null;
    if (viewKey === lastKey) return;
    lastKey = viewKey;
    shown = Boolean(conv);
    current = null;
    render();
    if (shown) attach();
  }, 400);
  restore();
  new MutationObserver(() => { if (term) term.options.theme = theme(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin', 'style'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (term) term.options.theme = theme(); });
  window.AgentDeskNativeCli = { create, remove, start };
})();
