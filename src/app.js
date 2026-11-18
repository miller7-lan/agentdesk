(() => {
  const D = window.MOCK;
  const avatars = window.AgentDeskAvatars;
  // 真实连接：VPS 上的 Codex（通过 SSH 操作 Windows 开发机）
  const LIVE = !!(window.desk && window.desk.codex);
  const navigatorOs = /Mac/i.test(navigator.platform) ? 'mac' : /Win/i.test(navigator.platform) ? 'win' : 'linux';
  if (window.AgentDeskPlatform) {
    window.__agentdeskSystem = window.AgentDeskPlatform.applyPlatform(document, window.desk?.system || { os: navigatorOs });
  }
  document.documentElement.classList.toggle('native-mac', window.desk?.platform === 'darwin');
  if (LIVE) {
    D.projects.forEach((p) => { p.name += '（示例）'; });
    D.projects.unshift({ id: 'live', name: window.desk.platform === 'darwin' ? 'Mac 工作区' : 'Windows 开发机', branch: window.desk.platform === 'darwin' ? 'main' : 'windows-dev', live: true });
    D.sessions.unshift({ id: 'L1', project: 'live', title: '新会话', status: 'idle', time: '刚刚', items: [], live: true, diffs: [], term: [] });
  }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const store = {
    get(k, d) { try { const v = localStorage.getItem('agentdesk.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('agentdesk.' + k, JSON.stringify(v)); } catch {} },
  };

  const lookApi = window.AgentDeskAppearance;
  const appearanceApi = window.desk && window.desk.appearance;
  let look = lookApi ? lookApi.load(localStorage) : null;
  let wallpaperName = '';
  if (look) {
    lookApi.applySettings(document, look);
    window.AgentDeskFluid?.setOptions(look);
  }

  const ICON = {
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    term: '<path d="M4 6l6 6-6 6M12 18h8"/>',
    folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    spark: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M12 8v5M12 16v.5"/>',
    send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  };
  const svg = (n) => `<svg viewBox="0 0 24 24">${ICON[n] || ''}</svg>`;

  const state = {
    theme: store.get('theme', 'light'),
    active: LIVE ? 'L1' : 's1',
    previousConversation: null,
    panel: 'diff',
    group: null,
    groupPanel: 'members',
    directPanel: 'diff',
    panelOpen: store.get('panelOpen', true),
    sideOpen: true,
    collapsed: new Set(store.get('collapsed', LIVE ? ['p1', 'p2', 'p3'] : [])),
    attachments: [],
    busy: false,
    timer: null,
    termLines: D.terminal.slice(),
    selFile: 'src/webhooks/retry.ts',
    diffCollapsed: new Set(),
  };

  const statusLabels = { idle: '空闲', running: '运行中', waiting: '待批准', done: '已完成' };
  const sess = (id) => D.sessions.find((s) => s.id === id);
  const proj = (id) => D.projects.find((p) => p.id === id);

  /* ---------- 桌宠（Clawd on Desk）---------- */
  const petApi = window.desk && window.desk.clawd;
  function pet(s, st, event, extra = {}) {
    if (!petApi || !s) return;
    petApi.send({ session_id: 'agentdesk-' + s.id, state: st, event, cwd: '~/' + proj(s.project).name, ...extra })
      .then((r) => renderPet(r)).catch(() => {});
  }
  function renderPet(r) {
    const el = $('#sbPet');
    if (!r) { el.innerHTML = '<span class="dot"></span>桌宠：不可用'; el.title = ''; return; }
    if (!r.online) { el.innerHTML = '<span class="dot"></span>桌宠：未运行'; el.title = '未检测到 Clawd on Desk（~/.clawd/runtime.json）'; }
    else if (!r.registered) { el.innerHTML = '<span class="dot wait"></span>桌宠：待注册'; el.title = '在 Clawd 设置 → AI Coding Tools 中扫描并注册 AgentDesk.exe'; }
    else { el.innerHTML = '<span class="dot ok"></span>桌宠：已连接'; el.title = `${r.agentId} · 端口 ${r.port}`; }
  }
  function refreshPet(notify) {
    if (!petApi) return renderPet(null);
    petApi.status().then((r) => {
      renderPet(r);
      if (notify) toast(r.online ? (r.registered ? `桌宠已连接（端口 ${r.port}）` : 'Clawd 在运行，但还没注册 AgentDesk') : '没有检测到 Clawd on Desk');
    });
  }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    const themeButton = $('#themeToggle');
    themeButton.querySelector('span').textContent = state.theme === 'dark' ? '浅色模式' : '深色模式';
    window.desk && window.desk.setTheme(state.theme);
    appearanceApi?.apply({ theme: state.theme, skin: look?.skin || 'aqua' }).catch(() => {});
    store.set('theme', state.theme);
  }
  function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); }

  /* ---------- 外观 ---------- */
  function setWallpaper(url, name) {
    const wall = $('#wall');
    if (wall) wall.style.backgroundImage = url ? 'url(' + url + ')' : '';
    wallpaperName = name || '';
    const label = $('#lookWallName');
    if (label) label.textContent = wallpaperName || '未选择';
  }
  function refreshLookForm() {
    if (!look) return;
    $('#lookSkin').value = look.skin;
    $('#lookLayout').value = look.layout;
    $('#lookBlur').value = look.blur;
    $('#lookFrost').value = look.frost;
    $('#lookHue').value = look.hue;
    $('#lookBright').value = look.bright;
    $('#lookWallBlur').value = look.wallpaperBlur;
    $('#lookBoot').value = look.boot;
    $('#lookBlurOut').textContent = look.blur + 'px';
    $('#lookFrostOut').textContent = look.frost + '%';
    $('#lookHueOut').textContent = String(look.hue);
    $('#lookBrightOut').textContent = Math.round(look.bright * 100) + '%';
    $('#lookWallBlurOut').textContent = look.wallpaperBlur + 'px';
    $('#lookWallName').textContent = look.wallpaper === 'custom' ? (wallpaperName || '自定义壁纸') : '未选择';
  }
  function applyAppearance(patch = {}) {
    if (!lookApi || !look) return;
    const previous = look;
    look = lookApi.normalizeSettings({ ...look, ...patch });
    lookApi.applySettings(document, look);
    lookApi.save(localStorage, look);
    refreshLookForm();
    if (look.wallpaper === 'none' && previous.wallpaper === 'custom') setWallpaper('', '');
    appearanceApi?.apply({ theme: state.theme, skin: look.skin }).catch(() => {});
    window.AgentDeskFluid?.setOptions(look);
    if (look.boot !== previous.boot) window.__boot?.setEnabled?.(look.boot !== 'off');
  }
  async function restoreWallpaper() {
    if (!appearanceApi || !look || look.wallpaper !== 'custom') return;
    try {
      const file = await appearanceApi.wallpaper();
      if (file?.url) setWallpaper(file.url, file.name);
      else applyAppearance({ wallpaper: 'none' });
    } catch { /* a missing wallpaper is not fatal */ }
  }

  /* ---------- 提示 ---------- */
  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }

  const G = () => window.__group;
  function directAvatarState(session) {
    return L()?.avatarState(session) || (session.status === 'running' ? 'tool' : session.status === 'waiting' ? 'asking' : 'idle');
  }

  /* ---------- 侧栏 ---------- */
  function renderSidebar() {
    const q = $('#sessionSearch').value.trim().toLowerCase();
    const list = $('#sessionList');
    let html = '';
    for (const p of D.projects) {
      const items = D.sessions.filter((s) => s.project === p.id && (!q || s.title.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)));
      const hasGroup = G()?.hasGroup(p.id);
      const showGroup = hasGroup && (!q || p.name.toLowerCase().includes(q) || '群聊'.includes(q));
      if (q && !items.length && !showGroup && !p.name.toLowerCase().includes(q)) continue;
      // Work the lead handed out in the group sits under the group; the person's own conversations come after.
      const dispatched = items.filter((s) => s.agentThread);
      const own = items.filter((s) => !s.agentThread);
      const row = (s) => `
          <div class="sess ${s.agentThread ? 'sess-dispatched ' : ''}${!state.group && s.id === state.active ? 'active' : ''}" data-id="${s.id}" title="${esc(s.agentThread ? s.title + '（只读记录）' : s.title)}" role="button" tabindex="0">
            ${avatars.html(s.provider || 'codex', { size: s.agentThread ? 20 : 24, key: 'direct:' + s.id, state: directAvatarState(s) })}<span class="status-dot ${s.status}"></span><span class="s-title">${esc(s.agentThread ? (window.__providerDirect?.names[s.provider] || s.provider) : s.title)}</span>${s.agentThread ? '<span class="s-badge">派遣</span>' : `<span class="s-time">${esc(s.time)}</span>`}
          </div>`;
      const col = state.collapsed.has(p.id) && !q;
      html += `<div class="group ${col ? 'collapsed' : ''}" data-proj="${p.id}">
        <button class="group-head" type="button" aria-expanded="${!col}">${svg('chevDown').replace('<svg', '<svg class="chev"')}${svg('folder')}<span class="group-name">${esc(p.name)}</span><span class="count">${hasGroup ? G().taskCount(p.id) || '' : items.length}</span></button>
        <div class="group-items">
          <div class="project-conversation-actions">
            <button type="button" data-new-direct="${esc(p.id)}" aria-label="${esc(p.name)}：新建单聊">＋ 新建单聊</button>
            ${G() && !hasGroup ? `<button type="button" data-new-group="${esc(p.id)}" aria-label="${esc(p.name)}：新建群聊">＋ 新建群聊</button>` : ''}
          </div>
          ${showGroup ? `<button class="sess group-link ${state.group === p.id ? 'active' : ''}" type="button" data-open-group="${p.id}" aria-pressed="${state.group === p.id}">
          <span class="channel-mark">#</span><span class="s-title">群聊</span>${G()?.unreadCount(p.id) ? `<span class="group-unread">${G().unreadCount(p.id)}</span>` : ''}
        </button>` : ''}${dispatched.length ? `<div class="sess-section dispatched" aria-label="组长派遣">${dispatched.map(row).join('')}</div>` : ''}${
          own.length && dispatched.length ? '<div class="sess-label">我的单聊</div>' : ''}${own.map(row).join('')}
        </div></div>`;
    }
    list.innerHTML = html || '<div class="empty-note">没有匹配的会话</div>';
  }
  $('#sessionList').addEventListener('click', (e) => {
    const direct = e.target.closest('[data-new-direct]');
    if (direct) return window.__providerDirect ? window.__providerDirect.choose(direct.dataset.newDirect) : newDirect(direct.dataset.newDirect);
    const create = e.target.closest('[data-new-group]');
    if (create) {
      const project = create.dataset.newGroup;
      if (G()?.createGroup(project)) {
        openGroup(project);
        $('#groupInput').focus();
      }
      return;
    }
    const group = e.target.closest('[data-open-group]');
    if (group) return openGroup(group.dataset.openGroup);
    const s = e.target.closest('.sess');
    if (s && !e.target.closest('input')) return openSession(s.dataset.id);
    const g = e.target.closest('.group-head');
    if (g) {
      const id = g.parentElement.dataset.proj;
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      store.set('collapsed', [...state.collapsed]);
      renderSidebar();
    }
  });
  $('#sessionSearch').addEventListener('input', renderSidebar);
  $('#sessionList').addEventListener('keydown', (event) => {
    if (!event.target.matches('.sess[data-id]') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    openSession(event.target.dataset.id);
    $('#sessionList').querySelector('.sess.active')?.focus();
  });

  function newDirect(project = state.group || sess(state.active)?.project || (LIVE ? 'live' : 'p1'), provider) {
    if (provider && provider !== 'codex' && window.__providerDirect) return window.__providerDirect.create(project, provider);
    const p = proj(project);
    if (!p) return;
    const id = (p.live ? 'L' : 's') + crypto.randomUUID();
    D.sessions.unshift(p.live
      ? { id, project, title: '新会话', status: 'idle', time: '刚刚', items: [], live: true, diffs: [], term: [] }
      : { id, project, title: '新会话', status: 'idle', time: '刚刚', items: [] });
    state.collapsed.delete(project);
    openSession(id);
    $('#input').focus();
  }

  function rememberConversation() {
    state.previousConversation = state.group ? { group: state.group } : { direct: state.active };
  }

  function openGroup(project) {
    if (!G()?.hasGroup(project)) return;
    if (state.group !== project) {
      rememberConversation();
      if (!state.group) state.directPanel = state.panel;
      G().switchGroup(project);
      state.group = project;
      state.panel = state.groupPanel;
    }
    state.collapsed.delete(project);
    renderAll();
    Promise.resolve(window.AgentDeskProjects?.select(project)).finally(() => G().refresh());
  }

  function openSession(id) {
    if (state.group || id !== state.active) rememberConversation();
    if (state.group) {
      state.groupPanel = state.panel;
      G().switchGroup(null);
      state.group = null;
      state.panel = state.directPanel;
    }
    const prev = state.active;
    state.active = id;
    window.AgentDeskProjects?.select(sess(id)?.project);
    L()?.onOpen?.(prev, id);
    renderAll();
  }

  /* ---------- 时间线 ---------- */
  function itemHtml(it, idx) {
    if (L()?.itemHtml) { const h = L().itemHtml(it, idx); if (h != null) return h; }
    if (it.t === 'user') return `<div class="msg-user">${esc(it.text)}</div>`;
    if (it.t === 'assist' || it.t === 'thinking') {
      const thinking = it.t === 'thinking';
      const content = thinking ? `<i></i><i></i><i></i>${esc(it.text || '思考中')}` : it.html;
      return `<div class="msg-assist"><span class="direct-avatar">${avatars.html(sess(state.active)?.provider || 'codex', { size: 32, still: true })}</span>
        <div class="msg-body${thinking ? ' thinking' : ''}">${content}</div></div>`;
    }
    if (it.t === 'tool') return `<div class="tool ${it.open ? 'open' : ''} ${it.err ? 'err' : ''}" data-idx="${idx}">
        <div class="tool-head">${svg('chev').replace('<svg', '<svg class="chev"')}<span class="tool-ic">${svg(it.icon)}</span>
          <span class="tool-kind">${esc(it.kind)}</span><span class="tool-arg mono">${esc(it.arg)}</span><span class="tool-meta">${esc(it.meta || '')}</span></div>
        <div class="tool-body"><div class="io-label">输入</div><pre class="io">${esc(it.input)}</pre><div class="io-label">输出</div><pre class="io">${esc(it.output)}</pre>
        ${it.link ? `<a class="tool-link" data-goto="${it.link}">在 Diff 面板中查看 →</a>` : ''}</div></div>`;
    if (it.t === 'approval') {
      const done = it.state !== 'pending';
      return `<div class="approval ${done ? 'resolved' : ''}" data-idx="${idx}">
        <div class="approval-title">${svg('shield')}${esc(it.title)}${done ? `<span class="grow"></span><span class="verdict ${it.state === 'approved' ? 'ok' : 'no'}">${it.state === 'approved' ? '已批准' : '已拒绝'}</span>` : ''}</div>
        <div class="approval-desc">${esc(it.desc)}</div><pre class="mono">${esc(it.cmd)}</pre>
        ${done ? '' : `<div class="approval-actions"><button class="btn primary" data-act="approve">批准</button><button class="btn danger" data-act="reject">拒绝</button>
          ${it.sessionable === false ? '' : '<label class="remember"><input type="checkbox" data-act="remember" /> 本会话内不再询问此类操作</label>'}</div>`}</div>`;
    }
    return '';
  }

  function toolRepeatKey(it) {
    if (!it || it.t !== 'tool') return null;
    return (it.kind || '') + '\n' + (it.arg || it.input || '');
  }

  function timelineHtml(s) {
    if (!s.items.length) return '<div class="empty-note">新的会话。在下方描述你的任务吧。</div>';
    if (!s.repeatExpand) s.repeatExpand = new Set();
    const parts = [];
    for (let i = 0; i < s.items.length;) {
      const key = toolRepeatKey(s.items[i]);
      if (!key) { parts.push(itemHtml(s.items[i], i)); i += 1; continue; }
      let j = i + 1;
      while (j < s.items.length && toolRepeatKey(s.items[j]) === key) j += 1;
      const count = j - i;
      const shown = Math.min(3, count);
      for (let k = 0; k < shown; k++) parts.push(itemHtml(s.items[i + k], i + k));
      if (count > 3) {
        const id = i + '-' + j;
        const open = s.repeatExpand.has(id);
        if (open) for (let k = 3; k < count; k++) parts.push(itemHtml(s.items[i + k], i + k));
        const n = count - 3;
        parts.push(`<button type="button" class="repeat-toggle ${open ? 'open' : ''}" data-repeat="${id}">${
          open ? `收起后面 ${n} 条重复指令` : `已隐藏 ${n} 条相同指令 · 点击展开`
        }</button>`);
      }
      i = j;
    }
    return parts.join('');
  }

  function renderTimeline() {
    const tl = $('#timeline');
    const s = sess(state.active);
    if (!s || (!s.items.length && !s.loading)) {
      tl.innerHTML = `<div class="welcome">
        <div class="welcome-icon">${svg('term')}</div>
        <h2>${s ? '今天要做什么？' : '打开一个会话'}</h2>
        <p>${s ? '选择一个起点，或在下方输入你的任务。' : '从侧栏选择会话，或新建一个。'}</p>
        ${s ? `<div class="starter-list">
          <button type="button" data-draft="先阅读项目文档和目录，说明项目结构与本地运行方式。">${svg('folder')}了解项目</button>
          <button type="button" data-draft="检查当前 Git 改动，指出可能的回归和缺少的测试。">${svg('search')}检查改动</button>
          <button type="button" data-draft="根据项目已有说明运行测试，并汇总结果。">${svg('term')}验证项目</button>
        </div>` : '<button type="button" class="btn primary" data-new-session>新建会话</button>'}
      </div>`;
      tl.scrollTop = 0;
      return;
    }
    const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80 || tl.dataset.sid !== s.id;
    tl.dataset.sid = s.id;
    tl.dataset.member = s.provider === 'claude' ? 'lead' : s.provider || 'codex';   // tints this AI's replies
    tl.innerHTML = `<div class="tl-inner">${s.loading ? '<div class="empty-note">正在载入历史记录…</div>' : ''}${timelineHtml(s)}</div>`;
    if (atBottom) tl.scrollTop = tl.scrollHeight;
  }

  $('#timeline').addEventListener('click', (e) => {
    const s = sess(state.active);
    if (e.target.closest('[data-new-session]')) { newDirect(); return; }
    const starter = e.target.closest('[data-draft]');
    if (starter) {
      const input = $('#input');
      if (!input.value.trim()) input.value = starter.dataset.draft;
      autosize();
      input.focus();
      return;
    }
    const go = e.target.closest('[data-goto]');
    if (go) { showPanel(go.dataset.goto); return; }
    const rep = e.target.closest('[data-repeat]');
    if (rep && s) {
      if (!s.repeatExpand) s.repeatExpand = new Set();
      const id = rep.dataset.repeat;
      if (s.repeatExpand.has(id)) s.repeatExpand.delete(id); else s.repeatExpand.add(id);
      renderTimeline();
      return;
    }
    const head = e.target.closest('.tool-head');
    if (head) { const card = head.parentElement; const it = s.items[+card.dataset.idx]; it.open = !it.open; card.classList.toggle('open', it.open); return; }
    const btn = e.target.closest('.approval [data-act]');
    if (btn && btn.tagName === 'BUTTON') {
      const card = btn.closest('.approval');
      const remember = !!card.querySelector('[data-act="remember"]')?.checked;
      resolveApproval(s, +card.dataset.idx, btn.dataset.act === 'approve', remember);
    }
  });

  function resolveApproval(s, idx, ok, remember) {
    const it = s.items[idx];
    if (it.reqId != null) return L()?.resolve(s, it, ok, remember);
    it.state = ok ? 'approved' : 'rejected';
    if (!ok) {
      s.items.push({ t: 'assist', html: '<p>好的，我不会运行测试。改动已保留在工作区，你可以在 Diff 面板中检查后自行运行。</p>' });
      s.status = 'idle'; renderAll(); pet(s, 'idle', 'Stop'); return;
    }
    s.status = 'running'; setBusy(true);
    pet(s, 'working', 'PreToolUse', { tool_name: 'Bash' });
    s.items.push({ t: 'thinking', text: '正在运行 ' + it.cmd });
    renderAll();
    pushTerm('p', `~/${proj(s.project).name} $ ${it.cmd}`);
    const out = [' ✓ test/retry.test.ts (3 tests) 18ms', ' ✓ test/handler.test.ts (5 tests) 41ms', '', ' Test Files  2 passed (2)', '      Tests  8 passed (8)'];
    out.forEach((l, i) => setTimeout(() => pushTerm(l.includes('✓') || l.includes('passed') ? 'g' : '', l), 300 + i * 220));
    state.timer = setTimeout(() => {
      s.items = s.items.filter((x) => x.t !== 'thinking');
      s.items.push({ t: 'tool', kind: '运行命令', icon: 'term', arg: it.cmd, meta: '1.6s · 退出码 0', input: it.cmd, output: out.join('\n') });
      s.items.push({ t: 'assist', html: '<p>8 个测试全部通过。重试队列已生效：失败的回调会按 1s、2s、4s、8s、16s（带 20% 抖动）重新投递，5 次后记录错误并放弃。</p>' });
      s.status = 'done'; setBusy(false); renderAll();
      pet(s, 'attention', 'Stop');
    }, 1700);
  }

  /* ---------- 发送（mock 回复） ---------- */
  function setBusy(b) {
    state.busy = b;
    const btn = $('#sendBtn');
    btn.classList.toggle('stop', b);
    btn.innerHTML = svg(b ? 'stop' : 'send');
    btn.title = b ? '停止' : '发送';
    btn.setAttribute('aria-label', btn.title);
    renderSessionStatus();
  }

  function renderSessionStatus() {
    const status = state.busy ? 'running' : sess(state.active)?.status;
    const label = statusLabels[status];
    const markup = label ? `<span class="status-dot ${status}"></span>${label}` : '';
    $('#sbState').innerHTML = markup;
    $('#conversationState').innerHTML = markup;
  }

  function send(ev) {
    // Enter 与发送按钮走同一路径：运行中空输入 = 停止；有输入 = 插话/发送
    const fromButton = !ev || ev.type === 'click' || ev.type === 'keydown';
    if (sess(state.active)?.live) return L()?.send(sess(state.active), fromButton);
    if (state.busy) { // 停止
      clearTimeout(state.timer);
      const s = sess(state.active);
      if (s) { s.items = s.items.filter((x) => x.t !== 'thinking'); s.items.push({ t: 'assist', html: '<p><em>已停止。</em></p>' }); s.status = 'idle'; pet(s, 'idle', 'Stop'); }
      setBusy(false); renderAll(); return;
    }
    const ta = $('#input');
    const text = ta.value.trim();
    if (!text) return;
    let s = sess(state.active);
    if (!s) { newDirect(); s = sess(state.active); }
    if (s.title === '新会话') s.title = text.slice(0, 18);
    const att = state.attachments.length ? `\n📎 ${state.attachments.join(', ')}` : '';
    s.items.push({ t: 'user', text: text + att });
    ta.value = ''; autosize(); state.attachments = []; renderAttach();
    s.status = 'running'; s.time = '刚刚'; setBusy(true);
    s.items.push({ t: 'thinking', text: '思考中' });
    renderAll();
    pet(s, 'thinking', 'UserPromptSubmit');
    const mode = $('#modeSelect').value;
    setTimeout(() => { if (state.busy) pet(s, 'working', 'PreToolUse', { tool_name: 'Grep' }); }, 600);
    state.timer = setTimeout(() => {
      s.items = s.items.filter((x) => x.t !== 'thinking');
      s.items.push({ t: 'tool', kind: '搜索', icon: 'search', arg: `"${text.slice(0, 16)}"`, meta: '2 处匹配', input: 'pattern: ' + text.slice(0, 30), output: 'src/webhooks/handler.ts:4\nsrc/queue/index.ts:12' });
      if (mode === 'plan') {
        s.items.push({ t: 'assist', html: '<p>（只读规划模式）我整理了一个方案，不会修改任何文件：</p><ul><li>定位相关模块</li><li>列出需要改动的接口</li><li>补充测试用例</li></ul>' });
        s.status = 'done';
      } else if (mode === 'ask') {
        s.items.push({ t: 'assist', html: `<p>我理解你的需求是：「${esc(text)}」。这是本地 mock 回复，下一步需要写入文件。</p>` });
        s.items.push({ t: 'approval', id: 'a' + Date.now(), title: '请求写入文件', desc: '助手想修改以下文件：', cmd: 'src/webhooks/handler.ts  (+3 −1)', state: 'pending' });
        s.status = 'waiting';
      } else {
        s.items.push({ t: 'tool', kind: '编辑文件', icon: 'edit', arg: 'src/webhooks/handler.ts', meta: '+3 −1', link: 'diff', input: '自动编辑模式，无需审批', output: '已修改 1 处' });
        s.items.push({ t: 'assist', html: `<p>已按「${esc(text)}」完成修改（mock）。可在右侧 Diff 面板查看。</p>` });
        s.status = 'done';
      }
      setBusy(false); renderAll();
      if (s.status === 'waiting') pet(s, 'notification', 'Notification');
      else pet(s, 'attention', 'Stop');
      const pct = Math.min(95, (parseInt($('#ctxHint').textContent.replace(/\D/g, '')) || 18) + 4);
      $('#ctxHint').textContent = `上下文 ${pct}%`;
    }, 1300);
  }
  $('#sendBtn').addEventListener('click', send);
  const ta = $('#input');
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; }
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    send(e); // 与发送键相同：发送 / 插话 / 停止
  });

  $('#modeSelect').addEventListener('change', (e) => { $('#sbMode').textContent = e.target.selectedOptions[0].text; toast('权限模式：' + e.target.selectedOptions[0].text); });
  $('#modelSelect').addEventListener('change', (e) => toast('模型已切换为 ' + e.target.selectedOptions[0].text + (e.target.dataset.live ? '' : '（mock）')));

  function renderAttach() {
    $('#attachList').innerHTML = state.attachments.map((a, i) => `<span class="attach-pill" data-i="${i}" title="点击移除">${esc(a)} ×</span>`).join('');
  }
  $('#attachBtn').addEventListener('click', () => {
    if (sess(state.active)?.live && L()) return L().attach();
    const pool = ['handler.ts', 'retry.ts', 'README.md', 'screenshot.png'];
    const next = pool.find((p) => !state.attachments.includes(p));
    if (next) { state.attachments.push(next); renderAttach(); } else toast('mock 附件已全部添加');
  });
  $('#attachList').addEventListener('click', (e) => { const p = e.target.closest('.attach-pill'); if (p) { state.attachments.splice(+p.dataset.i, 1); renderAttach(); } });

  /* ---------- 右侧面板 ---------- */
  function showPanel(name) {
    state.panel = name; state.panelOpen = true; store.set('panelOpen', true);
    applyLayout(); renderPanel();
  }
  $$('.ptab').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));
  $('#closePanel').addEventListener('click', togglePanel);
  $('#sbPanel').addEventListener('click', togglePanel);
  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    store.set('panelOpen', state.panelOpen);
    applyLayout();
    if (state.panelOpen) renderPanel();
  }

  let panelSession;
  function renderPanel() {
    panelSession = state.group || state.active;
    $('#panelTitle').textContent = state.group ? '群聊详情' : '检查工作区';
    $$('[data-group-panel]').forEach((tab) => { tab.hidden = !state.group; });
    $$('.ptab').forEach((b) => {
      const active = b.dataset.panel === state.panel;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    const body = $('#panelBody');
    if (state.group) {
      $('#diffBadge').textContent = '';
      if (G().renderPanel(state.panel, body)) return;
      if (proj(state.group)?.live && L()) { L().renderPanel('files', body); return; }
      body.innerHTML = '<div class="empty-note">示例群聊不访问本机工作区。</div>';
      return;
    }
    delete body.renderedHtml;
    const cur = sess(state.active);
    if (cur?.live && L()) { L().renderPanel(state.panel, body); return; }
    if (!cur || cur.live) {
      $('#diffBadge').textContent = '';
      body.innerHTML = '<div class="empty-note">选择会话以查看工作区。</div>';
      return;
    }
    $('#diffBadge').textContent = D.diffs.length;
    if (state.panel === 'diff') {
      body.innerHTML = `<div class="chg-head"><span class="chg-branch">${svg('folder')}${esc(proj(cur.project).branch)}</span><span>${D.diffs.length} 个文件</span></div>` + D.diffs.map((f, fi) => {
        let o = 0, n = 0;
        const rows = f.lines.map(([k, l]) => {
          if (k === 'hunk') { const m = /-(\d+).*\+(\d+)/.exec(l); o = +m[1] - 1; n = +m[2] - 1; return `<tr class="hunk"><td colspan="4">${esc(l)}</td></tr>`; }
          if (k === 'add') n++; else if (k === 'del') o++; else { o++; n++; }
          return `<tr class="${k}"><td class="ln">${k === 'add' ? '' : o}</td><td class="ln">${k === 'del' ? '' : n}</td><td class="sign">${k === 'add' ? '+' : k === 'del' ? '−' : ' '}</td><td>${esc(l)}</td></tr>`;
        }).join('');
        return `<div class="diff-file ${state.diffCollapsed.has(fi) ? 'collapsed' : ''}" data-fi="${fi}"><button type="button" class="diff-head" aria-expanded="${!state.diffCollapsed.has(fi)}">${svg('file')}<span class="path">${esc(f.path)}</span><span class="stat"><span class="a">+${f.add}</span><span class="d">−${f.del}</span></span></button><table>${rows}</table></div>`;
      }).join('') + '<div class="diff-actions"><button class="btn primary" data-diff="accept">接受全部</button><button class="btn" data-diff="revert">撤销全部</button></div>';
    } else if (state.panel === 'terminal') {
      body.innerHTML = `<div class="term"><div class="term-out" id="termOut"></div><div class="term-in"><span>$</span><input id="termIn" spellcheck="false" placeholder="输入命令（mock）" /></div></div>`;
      renderTerm();
      $('#termIn').focus();
    } else {
      body.innerHTML = `<div class="files"><div class="tree">${D.tree.map((nd) => `<div class="node ${nd.path === state.selFile ? 'sel' : ''}" style="padding-left:${10 + nd.depth * 14}px" data-path="${nd.path || ''}">${svg(nd.dir ? 'folder' : 'file')}<span>${esc(nd.name)}</span>${nd.mod ? `<span class="mod ${nd.mod}">${nd.mod}</span>` : ''}</div>`).join('')}</div><div class="preview" id="preview"></div></div>`;
      renderPreview();
    }
  }

  function fileText(p) {
    if (D.fileContents[p]) return D.fileContents[p];
    const d = D.diffs.find((f) => f.path === p);
    return d ? d.lines.filter(([k]) => k !== 'hunk' && k !== 'del').map(([, l]) => l).join('\n') : '（空文件）';
  }
  function renderPreview() {
    const pv = $('#preview'); if (!pv) return;
    pv.innerHTML = `<div class="preview-head mono">${esc(state.selFile)}</div><pre class="mono">${fileText(state.selFile).split('\n').map((l) => `<span>${esc(l) || ' '}</span>`).join('')}</pre>`;
  }

  $('#panelBody').addEventListener('click', (e) => {
    const dh = e.target.closest('.diff-head');
    if (dh) {
      const fi = +dh.parentElement.dataset.fi;
      const collapsed = dh.parentElement.classList.toggle('collapsed');
      if (collapsed) state.diffCollapsed.add(fi); else state.diffCollapsed.delete(fi);
      dh.setAttribute('aria-expanded', String(!collapsed));
      return;
    }
    const da = e.target.closest('[data-diff]');
    if (da) { toast(da.dataset.diff === 'accept' ? '已接受全部改动（mock）' : '已撤销全部改动（mock）'); return; }
    const nd = e.target.closest('.node');
    if (nd && nd.dataset.path) { state.selFile = nd.dataset.path; $$('.node').forEach((x) => x.classList.toggle('sel', x === nd)); renderPreview(); }
  });

  function renderTerm() {
    const o = $('#termOut'); if (!o) return;
    const cur = sess(state.active);
    const lines = cur?.live ? cur.term : state.termLines;
    o.innerHTML = (lines.length ? lines : cur?.live ? [['', 'Codex 执行的命令和输出会显示在这里（只读）。']] : []).map(([c, l]) => `<div class="${c}">${esc(l)}</div>`).join('');
    o.parentElement.parentElement.scrollTop = 1e9;
  }
  function pushTerm(c, l) { state.termLines.push([c, l]); renderTerm(); }
  $('#panelBody').addEventListener('keydown', (e) => {
    if (e.target.id !== 'termIn' || e.key !== 'Enter') return;
    const cmd = e.target.value.trim(); e.target.value = '';
    if (!cmd) return;
    if (sess(state.active)?.live) { toast('这个终端只显示 Codex 的命令输出；请在对话中让 Codex 执行命令'); return; }
    if (cmd === 'clear' || cmd === 'cls') { state.termLines = []; renderTerm(); return; }
    pushTerm('p', `~/billing-service $ ${cmd}`);
    const out = {
      'git status': ' M src/webhooks/handler.ts\n?? src/webhooks/retry.ts',
      'ls': 'package.json  README.md  src/  test/',
      'pwd': '/home/dev/billing-service',
      'help': '可用的 mock 命令：git status, ls, pwd, echo <文本>, clear',
    }[cmd] ?? (cmd.startsWith('echo ') ? cmd.slice(5) : `mock: 未知命令 "${cmd}"（输入 help 查看）`);
    pushTerm(out.startsWith('mock:') ? 'e' : '', out);
  });

  /* ---------- 布局与拖拽 ---------- */
  const defaultWidths = { sideW: 254, panelW: 360 };
  const sideW = store.get('sideW', defaultWidths.sideW), panelW = store.get('panelW', defaultWidths.panelW);
  $('#sidebar').style.width = sideW + 'px';
  $('#panel').style.width = panelW + 'px';

  function applyLayout() {
    $('#sidebar').classList.toggle('hidden', !state.sideOpen);
    $('#leftSplit').classList.toggle('hidden', !state.sideOpen);
    $('#panel').classList.toggle('hidden', !state.panelOpen);
    $('#rightSplit').classList.toggle('hidden', !state.panelOpen);
    $('#sbPanel').setAttribute('aria-expanded', String(state.panelOpen));
    $('#toggleSidebar').setAttribute('aria-expanded', String(state.sideOpen));
  }

  function drag(handle, el, key, dir, min, max) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const x0 = e.clientX, w0 = el.offsetWidth;
      handle.classList.add('drag'); document.body.classList.add('dragging');
      const mv = (ev) => { el.style.width = Math.max(min, Math.min(max, w0 + dir * (ev.clientX - x0))) + 'px'; };
      const up = () => {
        handle.classList.remove('drag'); document.body.classList.remove('dragging');
        store.set(key, el.offsetWidth);
        window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
    handle.addEventListener('dblclick', () => { el.style.width = defaultWidths[key] + 'px'; store.set(key, el.offsetWidth); });
  }
  drag($('#leftSplit'), $('#sidebar'), 'sideW', 1, 180, 460);
  drag($('#rightSplit'), $('#panel'), 'panelW', -1, 280, 900);

  function toggleSidebar() { state.sideOpen = !state.sideOpen; applyLayout(); }
  $('#toggleSidebar').addEventListener('click', toggleSidebar);
  $('#railProjects').addEventListener('click', toggleSidebar);
  function focusSearch() {
    state.sideOpen = true;
    applyLayout();
    $('#sessionSearch').focus();
  }
  $('#railSearch').addEventListener('click', focusSearch);
  $('#themeToggle').addEventListener('click', toggleTheme);

  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'tab') {
      const previous = state.previousConversation;
      if (!previous) return;
      e.preventDefault();
      if (previous.group) openGroup(previous.group);
      else if (sess(previous.direct)) openSession(previous.direct);
    } else if (k === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (k === 'j') { e.preventDefault(); togglePanel(); }
    else if (k === 'n') { e.preventDefault(); newDirect(); }
    else if (k === 'k') { e.preventDefault(); focusSearch(); }
    else if (e.shiftKey && k === 'l') { e.preventDefault(); toggleTheme(); }
  });

  /* ---------- 对外接口（live.js 使用） ---------- */
  window.__desk = { D, state, LIVE, $, $$, esc, svg, store, sess, proj, toast, pet, setBusy, renderAll: () => renderAll(), renderPanel: () => renderPanel(),
    renderTerm: () => renderTerm(), showPanel, openSession, openGroup, newDirect, renderSidebar, autosize, renderAttach, applyLayout: () => applyLayout() };
  const L = () => window.__live;

  /* ---------- 汇总渲染 ---------- */
  function renderAll() {
    const s = sess(state.active);
    const project = proj(state.group || s?.project);
    $('#titleProject').textContent = project?.name || 'AgentDesk';
    $('#sbBranch').textContent = project?.branch || '—';
    renderSidebar();
    for (const selector of ['#directBreadcrumb', '#timeline', '[data-direct].composer', '#sbMode', '#sbState']) {
      $(selector).hidden = !!state.group;
    }
    $('#projectGroup').hidden = $('#groupBreadcrumb').hidden = !state.group;
    $$('[data-group-panel]').forEach((tab) => { tab.hidden = !state.group; });
    $('#conversationHead').hidden = !!state.group || !s;

    if (state.group) {
      $('#groupBreadcrumb').textContent = project.name + ' / 群聊';
      G().render();
      if (state.panelOpen && panelSession !== state.group) renderPanel();
      return;
    }
    $('#sbGroupRoute').hidden = $('#sbGroupMembers').hidden = $('#sbQuota').hidden = $('#sbResources').hidden = true;
    const provider = s?.provider || 'codex';
    const providerName = window.__providerDirect?.names[provider] || 'Codex';
    $('#directBreadcrumb').textContent = (project?.name ? project.name + ' / ' : '') + '@ ' + providerName;
    renderTimeline();
    $('#conversationTitle').textContent = s?.title || '';
    if (s) {
      const avatar = $('#directAvatar');
      const status = directAvatarState(s);
      const key = s.id + ':' + status;
      if (avatar.dataset.rendered !== key) {
        avatar.dataset.rendered = key;
        avatar.innerHTML = avatars.html(provider, { size: 36, key: 'direct-header:' + s.id, state: status });
      }
    }
    if (s?.live) setBusy(!!s.busy);
    else renderSessionStatus();
    window.__providerDirect?.render(s);
    if (state.panelOpen && (state.panel === 'diff' || panelSession !== state.active)) renderPanel();
    else if (state.panelOpen && state.panel === 'terminal') renderTerm();
  }

  if (!LIVE) {
    for (const id of ['sbDesktop', 'sbReconnect', 'sbPet']) $('#' + id).hidden = true;
    const connection = $('#sbConn');
    connection.disabled = true;
    connection.classList.remove('clickable');
    connection.removeAttribute('title');
    connection.textContent = '本地演示';
    $('#ctxHint').textContent = '上下文 18%';
    $('#sbTokens').textContent = '12.4k tokens';
  }
  /* ---------- 外观面板 ---------- */
  function setupAppearance() {
    const dialog = $('#appearanceDialog');
    if (!dialog || !look) return;
    refreshLookForm();
    $('#appearanceBtn').addEventListener('click', () => { refreshLookForm(); dialog.showModal(); });
    const bindings = {
      lookSkin: 'skin', lookLayout: 'layout', lookBlur: 'blur', lookFrost: 'frost', lookHue: 'hue',
      lookBright: 'bright', lookWallBlur: 'wallpaperBlur', lookBoot: 'boot',
    };
    for (const [id, key] of Object.entries(bindings)) {
      const el = $('#' + id);
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => applyAppearance({ [key]: el.value }));
    }
    $('#lookWallPick').addEventListener('click', async () => {
      if (!appearanceApi) { toast('当前环境不支持自定义壁纸'); return; }
      try {
        const file = await appearanceApi.pickWallpaper();
        if (!file) return;
        setWallpaper(file.url, file.name);
        applyAppearance({ wallpaper: 'custom' });
        toast('壁纸已更新');
      } catch (error) {
        toast(String(error && error.message).includes('too_large') ? '壁纸不能超过 8 MB' : '壁纸选择失败');
      }
    });
    $('#lookWallClear').addEventListener('click', () => {
      setWallpaper('', '');
      applyAppearance({ wallpaper: 'none' });
    });
    $('#lookReplay').addEventListener('click', () => {
      dialog.close();
      if (window.__boot && window.__boot.replay) window.__boot.replay();
      else toast('开机动画尚未加载');
    });
    $('#lookReset').addEventListener('click', () => {
      look = lookApi.normalizeSettings(lookApi.DEFAULTS);
      lookApi.applySettings(document, look);
      lookApi.save(localStorage, look);
      setWallpaper('', '');
      refreshLookForm();
      appearanceApi?.apply({ theme: state.theme, skin: look.skin }).catch(() => {});
      window.AgentDeskFluid?.setOptions(look);
      window.__boot?.setEnabled?.(look.boot !== 'off');
      toast('已恢复默认外观');
    });
  }
  setupAppearance();
  restoreWallpaper();
  window.__appearance = { get: () => ({ ...look }), apply: applyAppearance };

  $('#sbPet').addEventListener('click', () => refreshPet(true));
  applyTheme(); applyLayout(); renderAll(); setBusy(false); autosize();
  refreshPet(false); setInterval(() => refreshPet(false), 5000);
})();
