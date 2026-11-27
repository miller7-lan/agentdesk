// Interactive terminals of a native single chat (D4): the workspace panel’s Terminal tab, one tab per terminal.
// The terminals run in the local Worker on this computer; the AI drives them with its `terminal` tool and the
// person sees the same terminal here, can type into it, take it over (the AI's input is then refused) and hand
// it back. Switching chats or closing the window only detaches this view; the processes keep running and the
// panel reattaches from the Worker's buffer when the chat is opened again.
(() => {
  const A = window.__desk;
  const api = window.desk?.terminal;
  if (!A?.LIVE || !api) return;
  const { $, esc } = A;
  const CHAT_AGENTS = ['claude', 'grok', 'antigravity'];
  const agentOf = (s) => (CHAT_AGENTS.includes(s?.agent) ? s.agent : 'codex');
  const mac = (window.desk?.system?.os || navigator.platform || '').toLowerCase().includes('mac');
  const shells = mac ? [['zsh', 'zsh'], ['bash', 'bash']] : [['powershell', 'PowerShell'], ['cmd', 'CMD'], ['pwsh', 'PowerShell 7']];

  const panel = $('#terminalPanel');
  const tabs = $('#terminalTabs');
  const body = $('#terminalBody');
  const note = $('#terminalNote');
  const button = $('#terminalBtn');
  if (!panel || !tabs || !body || !button) return;
  $('#terminalShell').innerHTML = shells.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('');

  const views = new Map();        // terminalId -> { term, fit, el, cursor, info }
  let current = null;             // { key, agent, threadId }
  let active = null;              // terminalId shown
  let open = false;
  let loading = null;

  const call = async (op, fields = {}) => {
    if (!current) throw new Error('no_conversation');
    const answer = await api.call(current.agent, current.threadId, op, fields);
    if (!answer?.ok) throw new Error(answer?.error || 'terminal_failed');
    return answer.value;
  };
  const explain = (error) => ({
    terminal_needs_native_chat: '终端只在“完全访问”的原生单聊里可用（本机项目，VPS2 原生服务在线）。旧会话或 MCP 回退会话请新建完全访问单聊。',
    terminal_unavailable: '这台电脑上没有本机 Worker，终端不可用。',
    pty_unavailable: '这台电脑缺少终端组件（node-pty），请安装包含终端的 AgentDesk 版本。',
    no_conversation: '先在这个单聊里发送第一条消息，再打开终端。',
    too_many_terminals: '每个会话最多同时开 4 个终端，请先关闭一个。',
  }[String(error?.message || error).split(':')[0]] || String(error?.message || error));
  const say = (text) => { note.textContent = text || ''; note.hidden = !text; };

  function conversation() {
    const s = A.sess(A.state.active);
    // Native CLI single chats: the terminal `pc` runs in, on this computer (orchestrator/pc-bridge.js).
    if (s?.live && s.surface === 'cli' && !A.state.group) return { key: agentOf(s) + ':cli:' + s.id, agent: agentOf(s), threadId: 'cli:' + s.id, cli: true };
    if (!s?.live || !s.threadId || A.state.group) return null;
    return { key: agentOf(s) + ':' + s.threadId, agent: agentOf(s), threadId: s.threadId };
  }

  function label(info, index) {
    const name = info.shell ? { powershell: 'PowerShell', pwsh: 'PowerShell 7', cmd: 'CMD', zsh: 'zsh', bash: 'bash' }[info.shell] || info.shell : (mac ? 'zsh' : 'PowerShell');
    const who = info.state === 'exited' ? '已退出' : info.takenOver ? '你在操作' : 'AI 可用';
    return `${name} ${index + 1} · ${who}`;
  }

  function renderTabs() {
    const list = [...views.values()];
    tabs.innerHTML = list.map(({ info }, index) =>
      `<button type="button" class="terminal-tab${info.terminalId === active ? ' active' : ''}${info.state === 'exited' ? ' exited' : ''}" data-terminal-tab="${esc(info.terminalId)}">${esc(label(info, index))}</button>`).join('');
    const view = views.get(active);
    $('#terminalTakeover').textContent = view?.info.takenOver ? '交还给 AI' : '接管';
    $('#terminalTakeover').title = view?.info.takenOver ? '让 AI 重新可以在这个终端里输入' : '你来操作这个终端；期间 AI 的输入会被拒绝';
    for (const id of ['terminalTakeover', 'terminalInterrupt', 'terminalClose']) $('#' + id).disabled = !view;
    for (const [id, item] of views) item.el.hidden = id !== active;
    if (view) requestAnimationFrame(() => fit(view));
  }

  function terminalTheme() {
    const css = getComputedStyle(panel);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const light = document.documentElement.dataset.theme !== 'dark';
    return { background: color('--panel', '#eef3f6'), foreground: color('--text', '#222b32'),
      cursor: color('--accent', '#167565'), cursorAccent: color('--panel', '#eef3f6'),
      selectionBackground: light ? '#1675a533' : '#67d4be44',
      black: light ? '#34434e' : '#697885', brightBlack: light ? '#586b78' : '#acb4c0',
      red: light ? '#ad354b' : '#f291a5', brightRed: light ? '#ad354b' : '#f291a5',
      green: light ? '#26734c' : '#7bceaa', brightGreen: light ? '#26734c' : '#7bceaa',
      yellow: light ? '#85620c' : '#edbf72', brightYellow: light ? '#85620c' : '#edbf72',
      blue: light ? '#226ea4' : '#78b8ed', brightBlue: light ? '#226ea4' : '#78b8ed',
      magenta: light ? '#8052a3' : '#c8a1ef', brightMagenta: light ? '#8052a3' : '#c8a1ef',
      cyan: light ? '#167987' : '#78cad6', brightCyan: light ? '#167987' : '#78cad6',
      white: light ? '#485863' : '#dce3e6', brightWhite: light ? '#222b32' : '#ffffff' };
  }

  function updateTheme() {
    for (const view of views.values()) view.term.options.theme = terminalTheme();
  }

  function fit(view) {
    if (!open || view.el.hidden || !view.fit) return;
    try { view.fit.fit(); } catch {}
  }

  function createView(info) {
    if (!window.Terminal) throw new Error('xterm_missing');
    const el = document.createElement('div');
    el.className = 'terminal-screen';
    body.appendChild(el);
    const term = new window.Terminal({ convertEol: false, cursorBlink: true, fontSize: 12, scrollback: 5000,
      fontFamily: mac ? 'Menlo, monospace' : 'Cascadia Mono, Consolas, monospace', theme: terminalTheme() });
    const FitAddon = window.FitAddon?.FitAddon;
    const fitAddon = FitAddon ? new FitAddon() : null;
    if (fitAddon) term.loadAddon(fitAddon);
    term.open(el);
    const view = { term, fit: fitAddon, el, cursor: 0, info, key: current.key };
    // Every keystroke, including Ctrl+C (\x03), goes to the same terminal the AI uses.
    term.onData((data) => {
      if (view.info.state === 'exited') return;
      call('input', { terminalId: info.terminalId, data }).catch((error) => say(explain(error)));
    });
    term.onResize(({ cols, rows }) => {
      if (view.info.state === 'exited') return;
      call('resize', { terminalId: info.terminalId, cols, rows }).catch(() => {});
    });
    views.set(info.terminalId, view);
    return view;
  }

  async function catchUp(view) {
    const answer = await call('read', { terminalId: view.info.terminalId, cursor: view.cursor });
    if (answer.truncated && view.cursor) view.term.write('\r\n\x1b[2m… 中间输出过多，已省略 …\x1b[0m\r\n');
    if (answer.data) view.term.write(answer.data);
    view.cursor = answer.cursor;
    view.info = { ...view.info, ...answer };
  }

  function detach() {
    for (const view of views.values()) { try { view.term.dispose(); } catch {} view.el.remove(); }
    views.clear();
    active = null;
    renderTabs();
  }

  async function refresh() {
    const next = conversation();
    if (!next) { current = null; detach(); say(explain(new Error('no_conversation'))); return; }
    if (current?.key !== next.key) { detach(); current = next; }
    if (loading) return loading;
    loading = (async () => {
      try {
        const caps = await call('capabilities');
        if (!caps?.pty) { say(explain(new Error('pty_unavailable'))); return; }
        const { terminals = [] } = await call('list');
        say(terminals.length ? '' : current.cli ? '还没有终端。CLI 用 pc 命令在你电脑上执行时会自动打开；也可以点“新建”。'
          : '还没有终端。点“新建”打开一个，或让 AI 用 terminal 工具开一个。');
        for (const info of terminals) {
          if (!views.has(info.terminalId)) await catchUp(createView(info));
          else views.get(info.terminalId).info = { ...views.get(info.terminalId).info, ...info };
        }
        for (const id of [...views.keys()]) {
          if (!terminals.some((item) => item.terminalId === id)) { views.get(id).term.dispose(); views.get(id).el.remove(); views.delete(id); }
        }
        if (!views.has(active)) active = terminals.find((item) => item.state !== 'exited')?.terminalId || terminals[0]?.terminalId || null;
      } catch (error) { say(explain(error)); }
      renderTabs();
    })().finally(() => { loading = null; });
    return loading;
  }

  function sync() {
    const wasOpen = !panel.hidden;
    open = A.state.panelOpen && A.state.panel === 'terminal' && !A.state.group;
    const interactive = open && Boolean(A.sess(A.state.active)?.live);
    panel.hidden = !interactive;
    $('#panelBody').hidden = interactive;
    button.classList.toggle('on', interactive);
    button.hidden = Boolean(A.state.group);
    if (interactive) {
      if (!wasOpen || conversation()?.key !== current?.key) refresh();
      const view = views.get(active);
      if (view) requestAnimationFrame(() => fit(view));
    }
    return interactive;
  }

  function show(on) {
    if (on) A.showPanel('terminal');
    else { A.state.panelOpen = false; A.store.set('panelOpen', false); A.applyLayout(); sync(); }
  }

  // Keys typed into a terminal are the terminal's: AgentDesk's own Ctrl shortcuts must not also fire (Ctrl+Tab still switches).
  body.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey && event.key === 'Tab')) event.stopPropagation();
  });
  button.addEventListener('click', () => show(true));
  $('#terminalHide').addEventListener('click', () => show(false));
  $('#terminalNew').addEventListener('click', async () => {
    try {
      if (!current) await refresh();
      const view = [...views.values()][0];
      const size = view ? { cols: view.term.cols, rows: view.term.rows } : { cols: 120, rows: 24 };
      const info = await call('open', { shell: $('#terminalShell').value, ...size });
      say('');
      const created = createView(info);
      active = info.terminalId;
      renderTabs();
      await catchUp(created);
      created.term.focus();
    } catch (error) { say(explain(error)); }
  });
  tabs.addEventListener('click', (event) => {
    const id = event.target.closest('[data-terminal-tab]')?.dataset.terminalTab;
    if (!id) return;
    active = id;
    renderTabs();
    views.get(id)?.term.focus();
  });
  $('#terminalTakeover').addEventListener('click', async () => {
    const view = views.get(active);
    if (!view) return;
    try { view.info = { ...view.info, ...await call('takeover', { terminalId: active, on: !view.info.takenOver }) }; renderTabs(); view.term.focus(); }
    catch (error) { say(explain(error)); }
  });
  $('#terminalInterrupt').addEventListener('click', () => {
    if (active) call('signal', { terminalId: active, signal: 'SIGINT' }).catch((error) => say(explain(error)));
  });
  $('#terminalClose').addEventListener('click', async () => {
    const view = views.get(active);
    if (!view || !window.confirm('关闭这个终端？其中正在运行的程序会被结束。')) return;
    try {
      await call('close', { terminalId: active });
      view.term.dispose(); view.el.remove(); views.delete(active);
      active = views.keys().next().value || null;
      renderTabs();
    } catch (error) { say(explain(error)); }
  });

  // Live output and state changes from the Worker. A chunk that does not continue where this view stopped
  // (a missed event, or one that arrived during a reattach) is replaced by a read from the view's own cursor.
  api.onEvent((event) => {
    if (!current || event.provider !== current.agent || event.threadId !== current.threadId) return;
    const view = views.get(event.terminalId);
    if (event.type === 'opened' && !view) { if (open) refresh(); return; }
    // The AI asks the person to take over (pc --ask): the terminal is already theirs; show why.
    if (event.type === 'askTakeover') {
      show(true);
      active = event.terminalId;
      refresh().then(() => {
        const asked = views.get(event.terminalId);
        if (asked) asked.info = { ...asked.info, takenOver: true };
        renderTabs();
        say(`AI 请你接管：${event.message || '请在终端里操作'}。操作完点“交还给 AI”，AI 会接着做。`);
        views.get(event.terminalId)?.term.focus();
      });
      A.toast?.('AI 请你接管终端');
      return;
    }
    if (!view) return;
    if (event.type === 'output') {
      if (typeof event.data === 'string' && event.cursor - event.data.length === view.cursor) {
        view.term.write(event.data);
        view.cursor = event.cursor;
      } else if (event.cursor > view.cursor) catchUp(view).catch(() => {});
      return;
    }
    if (event.type === 'exited') { view.info = { ...view.info, state: 'exited', exitCode: event.exitCode }; view.term.write(`\r\n\x1b[2m[进程已退出，退出码 ${event.exitCode}]\x1b[0m\r\n`); }
    if (event.type === 'takenOver') view.info = { ...view.info, takenOver: true };
    if (event.type === 'handedBack') { view.info = { ...view.info, takenOver: false }; say(''); }
    if (event.type === 'closed') { view.term.dispose(); view.el.remove(); views.delete(event.terminalId); if (active === event.terminalId) active = null; }
    renderTabs();
  });

  // The panel follows the conversation that is open: switching chats detaches the views (not the processes).
  setInterval(() => {
    // Group chat has no terminal panel; the panel comes back with the single chat.
    sync();
    const next = conversation();
    if ((next?.key || null) !== (current?.key || null)) {
      if (!next) { current = null; detach(); return; }
      if (open) refresh(); else { detach(); current = next; }
    }
  }, 500);
  new ResizeObserver(() => { const view = views.get(active); if (view) fit(view); }).observe(body);
  new MutationObserver(updateTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin', 'style'] });
  window.AgentDeskTerminal = { show, refresh, sync };
  sync();
})();
