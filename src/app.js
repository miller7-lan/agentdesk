(() => {
  const D = window.MOCK;
  // 真实连接：VPS 上的 Codex（通过 SSH 操作 Windows 开发机）
  const LIVE = !!(window.desk && window.desk.codex);
  if (LIVE) {
    D.projects.forEach((p) => { p.name += '（示例）'; });
    D.projects.unshift({ id: 'live', name: window.desk.platform === 'darwin' ? 'Mac 工作区 · Codex' : 'Windows 开发机 · Codex', branch: window.desk.platform === 'darwin' ? 'main' : 'windows-dev', live: true });
    D.sessions.unshift({ id: 'L1', project: 'live', title: '新会话', status: 'idle', time: '刚刚', items: [], live: true, diffs: [], term: [] });
  }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const store = {
    get(k, d) { try { const v = localStorage.getItem('agentdesk.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('agentdesk.' + k, JSON.stringify(v)); } catch {} },
  };

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
    send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  };
  const svg = (n) => `<svg viewBox="0 0 24 24">${ICON[n] || ''}</svg>`;

  const state = {
    theme: store.get('theme', 'dark'),
    active: LIVE ? 'L1' : 's1',
    tabs: LIVE ? ['L1'] : ['s1', 's3'],
    panel: 'diff',
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
    $('#sbTheme').textContent = state.theme === 'dark' ? '深色' : '浅色';
    window.desk && window.desk.setTheme(state.theme);
    store.set('theme', state.theme);
  }
  function toggleTheme() { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); }

  /* ---------- 提示 ---------- */
  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }

  /* ---------- 侧栏 ---------- */
  function renderSidebar() {
    const q = $('#sessionSearch').value.trim().toLowerCase();
    const list = $('#sessionList');
    let html = '';
    for (const p of D.projects) {
      const items = D.sessions.filter((s) => s.project === p.id && (!q || s.title.toLowerCase().includes(q) || p.name.includes(q)));
      if (q && !items.length) continue;
      const col = state.collapsed.has(p.id) && !q;
      html += `<div class="group ${col ? 'collapsed' : ''}" data-proj="${p.id}">
        <div class="group-head">${svg('chevDown').replace('<svg', '<svg class="chev"')}${esc(p.name)}<span class="count">${items.length}</span></div>
        <div class="group-items">${items.map((s) => `
          <div class="sess ${s.id === state.active ? 'active' : ''}" data-id="${s.id}" title="${esc(s.title)}">
            <span class="status-dot ${s.status}"></span><span class="s-title">${esc(s.title)}</span><span class="s-time">${s.time}</span>
          </div>`).join('')}</div></div>`;
    }
    list.innerHTML = html || '<div class="empty-note">没有匹配的会话</div>';
  }
  $('#sessionList').addEventListener('click', (e) => {
    const s = e.target.closest('.sess');
    if (s) return openSession(s.dataset.id);
    const g = e.target.closest('.group-head');
    if (g) {
      const id = g.parentElement.dataset.proj;
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      store.set('collapsed', [...state.collapsed]);
      renderSidebar();
    }
  });
  $('#sessionSearch').addEventListener('input', renderSidebar);

  $('#newSession').addEventListener('click', () => {
    const p = sess(state.active)?.project || (LIVE ? 'live' : 'p1');
    const id = (p === 'live' ? 'L' : 's') + Date.now();
    D.sessions.unshift(p === 'live'
      ? { id, project: p, title: '新会话', status: 'idle', time: '刚刚', items: [], live: true, diffs: [], term: [] }
      : { id, project: p, title: '新会话', status: 'idle', time: '刚刚', items: [] });
    state.collapsed.delete(p);
    openSession(id);
    $('#input').focus();
  });

  /* ---------- 标签 ---------- */
  function renderTabs() {
    $('#tabs').innerHTML = state.tabs.map((id) => {
      const s = sess(id);
      return `<div class="tab ${id === state.active ? 'active' : ''}" data-id="${id}"><span class="status-dot ${s.status}"></span><span>${esc(s.title)}</span><button class="x" title="关闭">${svg('x')}</button></div>`;
    }).join('');
  }
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab'); if (!tab) return;
    const id = tab.dataset.id;
    if (e.target.closest('.x')) {
      const i = state.tabs.indexOf(id);
      state.tabs.splice(i, 1);
      if (state.active === id) {
        const next = state.tabs[Math.max(0, i - 1)];
        if (next) return openSession(next);
        state.active = null; renderAll(); return;
      }
      return renderTabs();
    }
    openSession(id);
  });
  $('#tabs').addEventListener('auxclick', (e) => { if (e.button === 1) { const x = e.target.closest('.tab')?.querySelector('.x'); x && x.click(); } });

  function openSession(id) {
    if (!state.tabs.includes(id)) state.tabs.push(id);
    const prev = state.active;
    state.active = id;
    L()?.onOpen?.(prev, id);
    renderAll();
  }

  /* ---------- 时间线 ---------- */
  function itemHtml(it, idx) {
    if (L()?.itemHtml) { const h = L().itemHtml(it, idx); if (h != null) return h; }
    if (it.t === 'user') return `<div class="msg-user">${esc(it.text)}</div>`;
    if (it.t === 'assist') return `<div class="msg-assist"><div class="avatar">${svg('spark')}</div><div class="msg-body">${it.html}</div></div>`;
    if (it.t === 'thinking') return `<div class="msg-assist"><div class="avatar">${svg('spark')}</div><div class="msg-body thinking"><i></i><i></i><i></i>${esc(it.text || '思考中')}</div></div>`;
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

  function renderTimeline() {
    const tl = $('#timeline');
    const s = sess(state.active);
    if (!s) { tl.innerHTML = '<div class="tl-inner"><div class="empty-note">没有打开的会话。从左侧选择或新建一个。</div></div>'; return; }
    const atBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80 || tl.dataset.sid !== s.id;
    tl.dataset.sid = s.id;
    tl.innerHTML = `<div class="tl-inner">${s.loading ? '<div class="empty-note">正在载入历史记录…</div>' : ''}${s.items.length ? s.items.map(itemHtml).join('') : '<div class="empty-note">新的会话。在下方描述你的任务吧。</div>'}</div>`;
    if (atBottom) tl.scrollTop = tl.scrollHeight;
  }

  $('#timeline').addEventListener('click', (e) => {
    const s = sess(state.active);
    const go = e.target.closest('[data-goto]');
    if (go) { showPanel(go.dataset.goto); return; }
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
    $('#sbState').innerHTML = b ? '<span class="dot run"></span>运行中' : '<span class="dot ok"></span>空闲';
  }

  function send(ev) {
    if (sess(state.active)?.live) return L()?.send(sess(state.active), !!(ev && ev.type === 'click'));
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
    if (!s) { $('#newSession').click(); s = sess(state.active); }
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
      const pct = Math.min(95, parseInt($('#ctxHint').textContent.replace(/\D/g, '')) + 4);
      $('#ctxHint').textContent = `上下文 ${pct}%`;
    }, 1300);
  }
  $('#sendBtn').addEventListener('click', send);
  const ta = $('#input');
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; }
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
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
  function togglePanel() { state.panelOpen = !state.panelOpen; store.set('panelOpen', state.panelOpen); applyLayout(); }

  function renderPanel() {
    $$('.ptab').forEach((b) => b.classList.toggle('active', b.dataset.panel === state.panel));
    const body = $('#panelBody');
    const cur = sess(state.active);
    if (cur?.live && L()) { L().renderPanel(state.panel, body); return; }
    $('#diffBadge').textContent = D.diffs.length;
    if (state.panel === 'diff') {
      body.innerHTML = D.diffs.map((f, fi) => {
        let o = 0, n = 0;
        const rows = f.lines.map(([k, l]) => {
          if (k === 'hunk') { const m = /-(\d+).*\+(\d+)/.exec(l); o = +m[1] - 1; n = +m[2] - 1; return `<tr class="hunk"><td colspan="4">${esc(l)}</td></tr>`; }
          if (k === 'add') n++; else if (k === 'del') o++; else { o++; n++; }
          return `<tr class="${k}"><td class="ln">${k === 'add' ? '' : o}</td><td class="ln">${k === 'del' ? '' : n}</td><td class="sign">${k === 'add' ? '+' : k === 'del' ? '−' : ' '}</td><td>${esc(l)}</td></tr>`;
        }).join('');
        return `<div class="diff-file ${state.diffCollapsed.has(fi) ? 'collapsed' : ''}" data-fi="${fi}"><div class="diff-head">${svg('file')}<span class="path">${esc(f.path)}</span><span class="stat"><span class="a">+${f.add}</span><span class="d">−${f.del}</span></span></div><table>${rows}</table></div>`;
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
    if (dh) { const fi = +dh.parentElement.dataset.fi; state.diffCollapsed.has(fi) ? state.diffCollapsed.delete(fi) : state.diffCollapsed.add(fi); dh.parentElement.classList.toggle('collapsed'); return; }
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
  const sideW = store.get('sideW', 268), panelW = store.get('panelW', 440);
  $('#sidebar').style.width = sideW + 'px';
  $('#panel').style.width = panelW + 'px';

  function applyLayout() {
    $('#sidebar').classList.toggle('hidden', !state.sideOpen);
    $('#leftSplit').classList.toggle('hidden', !state.sideOpen);
    $('#panel').classList.toggle('hidden', !state.panelOpen);
    $('#rightSplit').classList.toggle('hidden', !state.panelOpen);
    $('#sbPanel').textContent = state.panelOpen ? '收起面板' : '展开面板';
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
    handle.addEventListener('dblclick', () => { el.style.width = (key === 'sideW' ? 268 : 440) + 'px'; store.set(key, el.offsetWidth); });
  }
  drag($('#leftSplit'), $('#sidebar'), 'sideW', 1, 180, 460);
  drag($('#rightSplit'), $('#panel'), 'panelW', -1, 280, 900);

  /* ---------- 活动栏 / 快捷键 ---------- */
  $$('.act[data-view]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.view;
    if (v === 'sessions' || v === 'search') {
      const wasActive = b.classList.contains('active');
      $$('.act[data-view]').forEach((x) => x.classList.toggle('active', x === b));
      state.sideOpen = !(wasActive && state.sideOpen && v === 'sessions') || v === 'search';
      applyLayout();
      if (v === 'search') $('#sessionSearch').focus();
    } else toast(v === 'tasks' ? '任务视图：原型中暂未实现' : '设置：原型中暂未实现');
  }));
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#sbTheme').addEventListener('click', toggleTheme);

  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); state.sideOpen = !state.sideOpen; applyLayout(); }
    else if (k === 'j') { e.preventDefault(); togglePanel(); }
    else if (k === 'n') { e.preventDefault(); $('#newSession').click(); }
    else if (k === 'k') { e.preventDefault(); state.sideOpen = true; applyLayout(); $('#sessionSearch').focus(); }
    else if (e.shiftKey && k === 'l') { e.preventDefault(); toggleTheme(); }
  });

  /* ---------- 对外接口（live.js 使用） ---------- */
  window.__desk = { D, state, LIVE, $, $$, esc, svg, store, sess, proj, toast, pet, setBusy, renderAll: () => renderAll(), renderPanel: () => renderPanel(),
    renderTerm: () => renderTerm(), showPanel, openSession, autosize, renderAttach, applyLayout: () => applyLayout() };
  const L = () => window.__live;

  /* ---------- 汇总渲染 ---------- */
  function renderAll() {
    const s = sess(state.active);
    $('#titleProject').textContent = s ? proj(s.project).name : 'AgentDesk';
    $('#titleSession').textContent = s ? s.title : '无会话';
    $('#sbBranch').textContent = s ? proj(s.project).branch : '—';
    renderSidebar(); renderTabs(); renderTimeline();
    $('.ptab[data-panel="diff"]').firstChild.textContent = s?.live ? '改动' : 'Diff';
    if (s?.live) setBusy(!!s.busy);
    if (state.panelOpen && state.panel === 'diff') renderPanel();
    else if (state.panelOpen && state.panel === 'terminal') renderTerm();
  }

  $('#sbPet').addEventListener('click', () => refreshPet(true));
  applyTheme(); applyLayout(); renderAll(); renderPanel(); setBusy(false); autosize();
  refreshPet(false); setInterval(() => refreshPet(false), 5000);
})();
