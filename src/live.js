// 真实连接：VPS 上的 Codex（app-server）+ 本机 Windows 工作区
(() => {
  const A = window.__desk;
  if (!A || !A.LIVE) return;
  const { D, state, $, esc, svg, store, sess, toast, pet, setBusy } = A;
  const cx = window.desk.codex, rm = window.desk.remote, wsApi = window.desk.ws, skApi = window.desk.skills, fileApi = window.desk.files;
  const isMac = window.desk.platform === 'darwin';
  let WIN_ROOT = 'C:\\CodexSSH\\windows-dev';

  let cfg = { workspace: undefined };
  let ready = false;
  let conn = {};
  const byThread = new Map();
  const W = { access: null, tree: [], treeTruncated: false, changes: null, diffCache: new Map(), open: new Set(), collapsedDirs: new Set(store.get('collapsedDirs', [])), sel: null, preview: null };
  let skills = { cloud: [], local: [] };
  let liveAtt = [];                       // 待发送附件 [{name, path, image}]
  let usage = null;

  /* ---------- 工具函数 ---------- */
  function md(text) {
    const parts = String(text || '').split(/```[^\n]*\n?/);
    return parts.map((p, i) => {
      if (i % 2) return `<pre class="mono">${esc(p.replace(/\n$/, ''))}</pre>`;
      return p.split(/\n{2,}/).map((blk) => {
        const lines = blk.split('\n').filter((l) => l.trim() !== '');
        if (!lines.length) return '';
        const inl = (l) => esc(l).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
        const h = /^(#{1,4})\s+(.*)$/.exec(lines[0]);
        if (h && lines.length === 1) return `<h${Math.min(6, h[1].length + 2)}>${inl(h[2])}</h${Math.min(6, h[1].length + 2)}>`;
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          const ol = /^\s*\d+\./.test(lines[0]);
          return `<${ol ? 'ol' : 'ul'}>${lines.map((l) => `<li>${inl(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</${ol ? 'ol' : 'ul'}>`;
        }
        return `<p>${lines.map(inl).join('<br>')}</p>`;
      }).join('');
    }).join('');
  }
  const rel = (ts) => {
    if (!ts) return '';
    const ms = ts < 1e12 ? ts * 1000 : ts; const d = (Date.now() - ms) / 1000;
    if (d < 90) return '刚刚'; if (d < 3600) return Math.round(d / 60) + ' 分钟';
    if (d < 86400) return Math.round(d / 3600) + ' 小时'; if (d < 172800) return '昨天';
    return Math.round(d / 86400) + ' 天前';
  };
  const winPath = (r) => isMac ? WIN_ROOT + '/' + r : WIN_ROOT + '\\' + String(r).replace(/\//g, '\\');
  let rafPending = false;
  function render() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; A.renderAll(); }); }
  const isActive = (s) => s && s.id === state.active;
  function sysNote(s, text, err) { s.items.push({ t: 'assist', html: `<p class="${err ? 'err-note' : 'sys-note'}">${esc(text)}</p>` }); }
  function newSession(extra = {}) {
    return { id: 'L' + Date.now() + Math.random().toString(36).slice(2, 6), project: 'live', title: '新会话', status: 'idle', time: '刚刚', items: [], live: true, term: [], diffs: [], ...extra };
  }

  /* ---------- 连接 ---------- */
  async function ensureReady() {
    const current = await rm.status();
    if (ready && current.codex === 'ready') return true;
    if (current.codex !== 'ready') ready = false;
    toast('正在连接 VPS 上的 Codex…');
    const ok = await rm.wake();
    for (let i = 0; i < 20 && ok && !ready; i++) await new Promise((r) => setTimeout(r, 100));
    if (!ready) toast('Codex 暂时连不上，请看状态栏的连接详情');
    return ready;
  }
  async function subscribe(s) {
    if (!s.threadId || s.subscribed) return true;
    const r = await cx.request('thread/resume', { threadId: s.threadId, excludeTurns: true });
    if (!r.ok) { toast('恢复会话失败：' + r.error); return false; }
    s.subscribed = true; byThread.set(s.threadId, s); return true;
  }

  function renderConn(st) {
    conn = st || conn;
    const el = $('#sbConn'); if (!el) return;
    const s = conn;
    const sleeping = s.codex === 'sleeping';
    const ok = s.codex === 'ready' && ['up', 'external'].includes(s.tunnel) && ['running', 'external'].includes(s.sshd);
    const bad = /denied|missing|failed|error/.test((s.sshd || '') + (s.codex || ''));
    const retrying = s.codex === 'retry' || s.tunnel === 'retry';
    const label = sleeping ? 'Codex 已休眠（输入时唤醒）'
      : ok ? (isMac ? 'Codex SSH 已连接' : 'Windows 开发机已连接')
      : s.codex === 'ready' ? 'Codex 已连接 · 隧道重连中'
      : retrying ? (s.detail || '连接已断开，正在自动重连')
      : bad ? (s.detail || '连接失败，点击重新连接') : '正在连接…';
    el.innerHTML = `<span class="dot ${ok ? 'ok' : sleeping ? '' : bad ? 'err' : 'wait'}"></span>${label}`;
    el.title = `sshd：${s.sshd}  ·  隧道：${s.tunnel}  ·  Codex：${s.codex}${s.detail ? '\n' + s.detail : ''}\n点击${sleeping ? '立即唤醒' : '重新连接'}`;
  }

  /* ---------- 时间线条目 ---------- */
  function chipsHtml(chips) {
    return chips && chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip-tag ${c.kind || ''}" title="${esc(c.title || '')}">${esc(c.label)}</span>`).join('')}</div>` : '';
  }
  function itemHtml(it, idx) {
    if (it.t === 'user' && (it.chips || it.steer)) {
      return `<div class="msg-user">${it.steer ? '<span class="steer-tag">插话</span>' : ''}${esc(it.text)}${chipsHtml(it.chips)}</div>`;
    }
    if (it.t === 'reason') {
      const head = it.done ? `已思考${it.secs ? ' ' + it.secs + ' 秒' : ''}` : '思考中…';
      const first = (it.text || '').split('\n').find((l) => l.trim()) || '';
      return `<div class="tool reason ${it.open ? 'open' : ''}" data-idx="${idx}">
        <div class="tool-head">${svg('chev').replace('<svg', '<svg class="chev"')}<span class="tool-ic">${svg('spark')}</span>
          <span class="tool-kind">${head}</span><span class="tool-arg">${esc(first.replace(/\*\*/g, '').slice(0, 90))}</span></div>
        <div class="tool-body reason-body">${md(it.text) || '<p class="sys-note">（没有思考摘要）</p>'}</div></div>`;
    }
    if (it.t === 'plan') {
      const done = it.steps.filter((x) => x.status === 'completed').length;
      return `<div class="plan-card"><div class="plan-title">${svg('term')}<span>计划</span><span class="grow"></span><span class="plan-count">${done}/${it.steps.length}</span></div>
        ${it.explanation ? `<div class="plan-exp">${esc(it.explanation)}</div>` : ''}
        <ol class="plan-steps">${it.steps.map((x) => `<li class="${x.status}"><span class="ps-dot"></span><span>${esc(x.step)}</span></li>`).join('')}</ol></div>`;
    }
    return null;
  }

  function toolFromItem(item) {
    if (item.type === 'commandExecution') {
      const cmd = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
      return { kind: '运行命令（VPS）', icon: 'term', arg: cmd, input: cmd };
    }
    if (item.type === 'mcpToolCall') {
      const a = item.arguments || {};
      const cmd = a.command || a.path || JSON.stringify(a);
      const win = item.server === 'ssh';
      return { kind: win ? (item.tool === 'ssh_exec' ? '在 Windows 上运行' : 'Windows · ' + item.tool) : `${item.server} · ${item.tool}`, icon: win ? 'term' : 'spark',
        arg: String(cmd).replace(/\s+/g, ' ').slice(0, 140), input: typeof cmd === 'string' ? cmd : JSON.stringify(a, null, 2) };
    }
    if (item.type === 'dynamicToolCall' && item.tool.startsWith('desktop_')) {
      return { kind: '本机桌面 · ' + item.tool, icon: 'spark', arg: '', input: '' };
    }
    if (item.type === 'dynamicToolCall' && item.tool.startsWith('windows_file_')) {
      return { kind: '本机文件 · ' + item.tool.slice('windows_file_'.length), icon: 'file', arg: item.arguments?.path || '', input: '' };
    }
    if (item.type === 'fileChange') {
      const ch = item.changes || [];
      return { kind: '编辑文件（VPS）', icon: 'edit', arg: ch.map((c) => c.path).join(', '), input: ch.map((c) => `${c.kind?.type || c.kind || ''} ${c.path}`).join('\n'), link: 'diff' };
    }
    if (item.type === 'webSearch') return { kind: '搜索网页', icon: 'search', arg: item.query || '', input: item.query || '' };
    if (item.type === 'imageView') return { kind: '查看图片', icon: 'file', arg: item.path || '', input: item.path || '' };
    if (item.type === 'contextCompaction') return { kind: '压缩上下文', icon: 'spark', arg: '已压缩较早的对话以节省上下文', input: '' };
    return null;
  }
  function mcpOutput(item) {
    const sc = item.result?.structuredContent;
    if (sc?.commands) return sc.commands.map((c) => `${c.stdout || ''}${c.stderr ? '\n[stderr]\n' + c.stderr : ''}\n[退出码 ${c.exit_code}]`).join('\n');
    const c = item.result?.content;
    if (Array.isArray(c)) return c.map((x) => x.text || '').join('\n');
    return item.error?.message || '';
  }
  const dropThinking = (s) => { s.items = s.items.filter((x) => x.t !== 'thinking'); };
  const thinking = (s, text) => { dropThinking(s); if (s.busy) s.items.push({ t: 'thinking', text }); };
  const findItem = (s, id) => s.items.find((x) => x.itemId === id);

  function userItemFrom(item) {
    const texts = []; const chips = [];
    for (const c of item.content || []) {
      if (c.type === 'text') texts.push(c.text);
      else if (c.type === 'skill') chips.push({ label: '$' + c.name, kind: 'skill', title: c.path });
      else if (c.type === 'localImage' || c.type === 'image') chips.push({ label: '图片 ' + String(c.path || c.url || '').split('/').pop(), kind: 'file', title: c.path || c.url });
      else if (c.type === 'mention') chips.push({ label: '@' + c.name, kind: 'file', title: c.path });
    }
    return { t: 'user', itemId: item.id, text: texts.join('\n'), chips };
  }

  function onItemStarted(s, item) {
    if (item.type === 'userMessage') return;                    // 本地已显示
    if (item.type === 'agentMessage') { if (!findItem(s, item.id)) { dropThinking(s); s.items.push({ t: 'assist', itemId: item.id, text: item.text || '', html: md(item.text || '') }); } return; }
    if (item.type === 'reasoning') { dropThinking(s); s.items.push({ t: 'reason', itemId: item.id, text: '', done: false, t0: Date.now(), part: 0 }); return; }
    const tool = toolFromItem(item);
    if (!tool) return;
    dropThinking(s);
    s.items.push({ t: 'tool', itemId: item.id, ...tool, meta: '运行中…', output: '' });
    pet(s, 'working', 'PreToolUse', { tool_name: item.type === 'mcpToolCall' ? item.tool : 'Bash' });
    if (item.type === 'commandExecution' || (item.type === 'mcpToolCall' && item.tool === 'ssh_exec')) s.term.push(['p', `${item.type === 'commandExecution' ? 'vps' : 'windows'} $ ${tool.input}`]);
  }

  function onItemCompleted(s, item, history) {
    if (item.type === 'userMessage') { if (history) s.items.push(userItemFrom(item)); return; }
    if (item.type === 'agentMessage') {
      const it = findItem(s, item.id);
      if (it) { it.text = item.text; it.html = md(item.text); } else s.items.push({ t: 'assist', itemId: item.id, text: item.text, html: md(item.text || '') });
      return;
    }
    if (item.type === 'plan') { s.items.push({ t: 'assist', itemId: item.id, html: md(item.text || '') }); return; }
    if (item.type === 'reasoning') {
      let it = findItem(s, item.id);
      const sum = (item.summary || []).join('\n\n');
      if (!it) { if (!sum) return; it = { t: 'reason', itemId: item.id }; s.items.push(it); }
      it.done = true; if (sum) it.text = sum;
      if (it.t0) it.secs = Math.max(1, Math.round((Date.now() - it.t0) / 1000));
      if (!it.text) s.items.splice(s.items.indexOf(it), 1);
      if (!history) thinking(s, '思考中');
      return;
    }
    let it = findItem(s, item.id);
    if (!it) { const tool = toolFromItem(item); if (!tool) return; it = { t: 'tool', itemId: item.id, ...tool, output: '' }; s.items.push(it); }
    if (item.type === 'commandExecution') {
      it.output = item.aggregatedOutput || it.output;
      it.meta = `${item.durationMs != null ? (item.durationMs / 1000).toFixed(1) + 's · ' : ''}退出码 ${item.exitCode ?? '—'}`;
      it.err = item.exitCode ? true : item.status === 'failed' || item.status === 'declined';
    } else if (item.type === 'mcpToolCall') {
      it.output = mcpOutput(item);
      const code = item.result?.structuredContent?.commands?.[0]?.exit_code;
      it.err = item.status === 'failed' || (code != null && code !== 0);
      it.meta = item.error?.message === 'user rejected MCP tool call' ? '已拒绝'
        : [item.durationMs != null ? (item.durationMs / 1000).toFixed(1) + 's' : '', code != null ? '退出码 ' + code : ''].filter(Boolean).join(' · ') || item.status;
      if (!history && item.tool === 'ssh_exec') it.output.split('\n').forEach((l) => s.term.push([it.err ? 'e' : '', l]));
      if (!history && item.server === 'ssh') refreshChanges();
    } else if (item.type === 'dynamicToolCall') {
      it.err = item.success === false || item.status === 'failed';
      it.meta = it.err ? '失败' : '完成';
      if (it.err) it.output = (item.contentItems || []).find((content) => content.type === 'inputText')?.text || '';
    } else if (item.type === 'fileChange') {
      it.output = (item.changes || []).map((c) => c.diff || '').join('\n');
      it.meta = item.status === 'completed' ? '已应用' : item.status;
      it.err = item.status === 'failed' || item.status === 'declined';
    } else { it.meta = '完成'; }
    if (!history) thinking(s, '思考中');
  }

  function updatePlan(s, p) {
    let it = s.items.find((x) => x.t === 'plan' && x.turnId === p.turnId);
    if (!it) { dropThinking(s); it = { t: 'plan', turnId: p.turnId, steps: [] }; s.items.push(it); if (s.busy) s.items.push({ t: 'thinking', text: '执行计划中' }); }
    it.steps = p.plan || []; it.explanation = p.explanation || '';
  }

  /* ---------- 事件 ---------- */
  function onEvent(m) {
    const p = m.params || {};
    if (m.method === 'account/rateLimits/updated') { usage = p.rateLimits || p; renderUsage(); return; }
    if (m.method === 'skills/changed') { loadSkills(); return; }
    const s = p.threadId && byThread.get(p.threadId);
    if (m.method === 'thread/tokenUsage/updated' && s) {
      s.tokens = p.tokenUsage; if (isActive(s)) renderTokens(s); return;
    }
    if (!s) return;
    switch (m.method) {
      case 'turn/started': s.turnId = p.turn?.id || s.turnId; break;
      case 'item/started': onItemStarted(s, p.item); break;
      case 'item/completed': onItemCompleted(s, p.item); break;
      case 'item/agentMessage/delta': {
        let it = findItem(s, p.itemId);
        if (!it) { dropThinking(s); it = { t: 'assist', itemId: p.itemId, text: '' }; s.items.push(it); }
        it.text += p.delta; it.html = md(it.text);
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        let it = findItem(s, p.itemId);
        if (!it) { it = { t: 'reason', itemId: p.itemId, text: '', t0: Date.now(), part: 0 }; s.items.push(it); }
        if (p.summaryIndex > (it.part || 0)) { it.text += '\n\n'; it.part = p.summaryIndex; }
        it.text += p.delta; break;
      }
      case 'item/commandExecution/outputDelta': {
        const it = findItem(s, p.itemId); if (it) it.output += p.delta;
        String(p.delta).split('\n').filter(Boolean).forEach((l) => s.term.push(['', l]));
        break;
      }
      case 'item/mcpToolCall/progress': { const it = findItem(s, p.itemId); if (it) it.meta = p.message; break; }
      case 'turn/plan/updated': updatePlan(s, p); break;
      case 'turn/diff/updated': s.diffs = p.diff ? [p.diff] : []; break;
      case 'thread/name/updated': if (p.threadName) s.title = p.threadName; break;
      case 'error': if (!p.willRetry) sysNote(s, 'Codex 错误：' + (p.error?.message || JSON.stringify(p.error)), true); break;
      case 'serverRequest/resolved': {
        const it = s.items.find((x) => x.reqId === p.requestId && x.state === 'pending');
        if (it) it.state = 'approved';
        break;
      }
      case 'turn/completed': {
        dropThinking(s);
        const st = p.turn?.status;
        if (st === 'interrupted') sysNote(s, '已停止。');
        if (st === 'failed') sysNote(s, '本轮失败：' + (p.turn?.error?.message || ''), true);
        s.items.forEach((x) => { if (x.t === 'approval' && x.state === 'pending') x.state = 'rejected'; if (x.t === 'reason' && !x.done) x.done = true; });
        s.busy = false; s.status = st === 'completed' ? 'done' : 'idle'; s.turnId = null; s.time = '刚刚';
        if (!isActive(s) && st === 'completed') toast(`「${s.title}」已完成`);
        pet(s, st === 'failed' ? 'error' : 'attention', 'Stop');
        refreshChanges();
        break;
      }
      default: return;
    }
    render();
  }

  /* ---------- 审批 ---------- */
  function onServerRequest(m) {
    const p = m.params || {};
    const s = (p.threadId && byThread.get(p.threadId)) || sess(state.active);
    if (!s || !s.live) return cx.respond(m.id, null, { code: -32603, message: 'no session' });
    const base = { t: 'approval', reqId: m.id, method: m.method, state: 'pending' };
    let card;
    if (m.method === 'mcpServer/elicitation/request') {
      const meta = p._meta || {}; const tp = meta.tool_params || {}; const win = p.serverName === 'ssh';
      card = { ...base, sessionable: false,
        title: win ? `请求在 Windows 上执行（${meta.tool_name || 'MCP 工具'}）` : `请求调用 ${p.serverName} · ${meta.tool_name || ''}`,
        desc: win ? `Codex 想通过 SSH 在 Windows 开发机（codexwin，${WIN_ROOT}）上执行：` : (p.message || ''),
        cmd: tp.command || tp.path || JSON.stringify(tp, null, 2) || p.message };
    } else if (m.method === 'item/commandExecution/requestApproval' || m.method === 'execCommandApproval') {
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.command || '');
      card = { ...base, title: '请求在 VPS 上运行命令', desc: p.reason || `工作目录：${p.cwd || ''}`, cmd };
    } else if (m.method === 'item/fileChange/requestApproval' || m.method === 'applyPatchApproval') {
      card = { ...base, title: '请求修改文件（VPS）', desc: p.reason || '助手想应用以下改动：', cmd: p.grantRoot || JSON.stringify(p.fileChanges || p.changes || {}, null, 2).slice(0, 2000) };
    } else if (m.method === 'item/tool/requestUserInput') {
      const qs = p.questions || []; s.lastQuestions = qs;
      card = { ...base, sessionable: false, title: 'Codex 有问题要问你', desc: qs.map((q) => q.question || q.header).join('\n'), cmd: '在输入框写好回答后点“批准”提交；点“拒绝”跳过。' };
    } else {
      card = { ...base, sessionable: false, title: '暂不支持的请求：' + m.method, desc: '只能拒绝。', cmd: JSON.stringify(p, null, 2).slice(0, 1500) };
    }
    dropThinking(s);
    // 审批卡放在对应的“运行中”工具卡之前：先请求批准，再显示执行结果（与官方顺序一致）
    let at = -1;
    for (let i = s.items.length - 1; i >= 0; i--) { const x = s.items[i]; if (x.t === 'tool' && x.meta === '运行中…') { at = i; break; } if (x.t === 'user') break; }
    if (at >= 0) s.items.splice(at, 0, card); else s.items.push(card);
    s.status = 'waiting';
    if (!isActive(s)) toast(`「${s.title}」等待审批`);
    render(); pet(s, 'notification', 'Notification');
  }

  function resolve(s, it, ok, remember) {
    let result, error;
    switch (it.method) {
      case 'mcpServer/elicitation/request': result = ok ? { action: 'accept', content: {} } : { action: 'decline', content: null }; break;
      case 'item/commandExecution/requestApproval': case 'item/fileChange/requestApproval':
        result = { decision: ok ? (remember ? 'acceptForSession' : 'accept') : 'decline' }; break;
      case 'execCommandApproval': case 'applyPatchApproval':
        result = { decision: ok ? (remember ? 'approved_for_session' : 'approved') : 'denied' }; break;
      case 'item/tool/requestUserInput': {
        const ans = $('#input').value.trim(); $('#input').value = ''; A.autosize();
        result = { answers: ok ? Object.fromEntries((s.lastQuestions || []).map((q) => [q.id, { answers: [ans] }])) : {} }; break;
      }
      default: error = { code: -32601, message: 'unsupported request' };
    }
    cx.respond(it.reqId, result, error);
    it.state = ok ? 'approved' : 'rejected';
    s.status = 'running'; thinking(s, ok ? '执行中' : '继续中');
    A.renderAll(); pet(s, 'working', 'PostToolUse');
  }

  /* ---------- 发送 / 插话 / 停止 ---------- */
  function modeToPolicy(mode) {
    if (mode === 'auto') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
    if (mode === 'plan') return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
    return {
      approvalPolicy: 'on-request', sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    };
  }

  async function buildInput(text) {
    const input = [{ type: 'text', text, text_elements: [] }];
    const chips = [];
    const names = [...new Set([...text.matchAll(/\$([\w:.\-]+)/g)].map((x) => x[1]))];
    for (const n of names) {
      const local = skills.local.find((k) => k.name === n || k.folder === n);
      const cloud = skills.cloud.find((k) => k.name === n);
      if (cloud && !local) { input.push({ type: 'skill', name: cloud.name, path: cloud.path }); chips.push({ label: '$' + n, kind: 'skill', title: '云端技能' }); }
      else if (local) {
        toast(`正在上传本地技能 ${n}…`);
        const r = await skApi.upload(local);
        if (!r.ok) { toast('本地技能上传失败：' + r.error); continue; }
        input.push({ type: 'skill', name: local.name, path: r.path }); chips.push({ label: '$' + n, kind: 'skill local', title: '本地技能（已上传到 VPS）' });
      }
    }
    const others = [];
    for (const f of liveAtt) {
      if (f.image) input.push({ type: 'localImage', path: f.path });
      else others.push(f);
      chips.push({ label: (f.image ? '图片 ' : '附件 ') + f.name, kind: 'file', title: f.path });
    }
    if (others.length) input[0].text += '\n\n[用户上传的附件，位于 VPS]\n' + others.map((f) => `- ${f.name}: ${f.path}`).join('\n');
    return { input, chips };
  }

  async function send(s, fromButton) {
    const ta = $('#input');
    const text = ta.value.trim();
    if (s.busy) { if (text) return steer(s, text); if (fromButton) return interrupt(s); return; }
    if (!text && !liveAtt.length) return;
    if (text.startsWith('/') && runCommand(text)) return;
    const { approvalPolicy, sandbox, sandboxPolicy } = modeToPolicy($('#modeSelect').value);
    if (!(await ensureReady())) return;
    ta.value = ''; A.autosize();
    const { input, chips } = await buildInput(text);
    liveAtt = []; renderAtt();
    if (s.title === '新会话') s.title = (text || '附件').slice(0, 24);
    s.items.push({ t: 'user', text, chips });
    s.busy = true; s.status = 'running'; s.time = '刚刚';
    s.items.push({ t: 'thinking', text: '思考中' });
    A.renderAll(); pet(s, 'thinking', 'UserPromptSubmit');
    if (sandbox === 'danger-full-access') {
      if (!isMac) input[0].text += '\n\n[AgentDesk：完全访问]\n访问这台 Windows 的文件，请用 windows_file_* 工具和本机绝对路径。VPS 上的命令只用于 VPS，本机桌面用 desktop_*。如果旧会话未注册 windows_file_*，请提示用户新建会话。';
    }
    const sel = $('#modelSelect'); const model = sel.dataset.live ? sel.value : undefined;
    if (!s.threadId) {
      const r = await cx.request('thread/start', { cwd: cfg.workspace, approvalPolicy, sandbox, approvalsReviewer: 'user', model });
      if (!r.ok) return fail(s, '新建会话失败：' + r.error);
      s.threadId = r.result.thread.id; s.subscribed = true; byThread.set(s.threadId, s);
    } else if (!(await subscribe(s))) return fail(s, '会话恢复失败');
    const r = await cx.request('turn/start', {
      threadId: s.threadId, input, approvalPolicy, sandboxPolicy, approvalsReviewer: 'user', model, summary: 'auto',
      effort: model && !$('#effortWrap').hidden ? $('#effortSelect').value : undefined,
      serviceTier: model && $('#tierSelect').value ? $('#tierSelect').value : undefined,
    });
    if (!r.ok) return fail(s, '发送失败：' + r.error);
    s.turnId = r.result.turn.id;
  }
  async function steer(s, text) {
    if (!s.turnId) return;
    const ta = $('#input'); ta.value = ''; A.autosize();
    const r = await cx.request('turn/steer', { threadId: s.threadId, expectedTurnId: s.turnId, input: [{ type: 'text', text, text_elements: [] }] });
    if (!r.ok) { toast('插话失败：' + r.error); ta.value = text; return; }
    dropThinking(s); s.items.push({ t: 'user', text, steer: true }); s.items.push({ t: 'thinking', text: '已收到补充说明' }); A.renderAll();
  }
  async function interrupt(s) {
    if (!s.threadId || !s.turnId) return;
    const r = await cx.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
    if (!r.ok) toast('停止失败：' + r.error);
  }
  function fail(s, msg) {
    dropThinking(s); sysNote(s, msg, true);
    s.busy = false; s.status = 'idle'; A.renderAll(); pet(s, 'error', 'Stop');
  }

  /* ---------- 斜杠命令 ---------- */
  const COMMANDS = [
    { cmd: '/new', desc: '新建会话' },
    { cmd: '/review', desc: '让 Codex 审查 Windows 测试目录里未提交的改动' },
    { cmd: '/compact', desc: '压缩当前会话的上下文' },
    { cmd: '/rename', desc: '重命名当前会话（/rename 新名称）' },
    { cmd: '/archive', desc: '归档当前会话' },
    { cmd: '/model', desc: '切换模型、推理强度和速度' },
    { cmd: '/skills', desc: '浏览云端和本地技能' },
    { cmd: '/status', desc: '查看连接、模型和用量' },
    { cmd: '/reconnect', desc: '重新连接 VPS 上的 Codex' },
  ];
  function runCommand(text) {
    const [c, ...rest] = text.split(/\s+/); const arg = rest.join(' ').trim();
    const s = sess(state.active);
    const ta = $('#input'); const clear = () => { ta.value = ''; A.autosize(); };
    switch (c) {
      case '/new': clear(); $('#newSession').click(); return true;
      case '/review': ta.value = `请审查 ${WIN_ROOT} 中尚未提交的改动：先用一次 ssh_exec 运行 git status --short 和 git diff，然后按严重程度列出问题、风险和建议。不要修改任何文件。`; A.autosize(); return false;
      case '/compact': clear(); if (!s?.threadId) { toast('当前会话还没有内容'); return true; }
        ensureReady().then((ok) => ok && subscribe(s)).then(() => cx.request('thread/compact/start', { threadId: s.threadId }))
          .then((r) => toast(r?.ok ? '已开始压缩上下文' : '压缩失败：' + (r?.error || ''))); return true;
      case '/rename': clear(); if (arg) renameSession(s, arg); else startRename(s); return true;
      case '/archive': clear(); archiveSession(s); return true;
      case '/model': clear(); $('#modelSelect').focus(); toast('在输入框下方切换模型、推理强度和速度'); return true;
      case '/skills': ta.value = '$'; A.autosize(); ta.focus(); openMenu(); return true;
      case '/status': clear(); showStatus(s); return true;
      case '/reconnect': clear(); rm.reconnect(); toast('正在重新连接…'); return true;
      default: return false;
    }
  }
  function showStatus(s) {
    if (!s) return;
    const m = $('#modelSelect');
    const u = usage ? usageText(usage) : '未知';
    sysNote(s, `连接：sshd ${conn.sshd} · 隧道 ${conn.tunnel} · Codex ${conn.codex}${conn.detail ? '（' + conn.detail + '）' : ''}`);
    sysNote(s, `模型：${m.selectedOptions[0]?.text || '默认'} · 推理 ${$('#effortSelect').selectedOptions[0]?.text?.replace('推理：', '') || '默认'} · ${$('#tierSelect').selectedOptions[0]?.text || '标准速度'}`);
    sysNote(s, `用量：${u}`);
    sysNote(s, 'Codex 空闲后会自动断开，再次输入时会重新连接。');
    A.renderAll();
  }

  /* ---------- 会话：历史、重命名、归档 ---------- */
  async function loadHistory() {
    const r = await cx.request('thread/list', { cwd: cfg.workspace, limit: 40, sortKey: 'updated_at' });
    if (!r.ok) return false;
    for (const t of r.result.data || []) {
      if ([...D.sessions].some((x) => x.threadId === t.id)) continue;
      const title = t.name || (t.preview || '').split('\n')[0].slice(0, 30) || '未命名会话';
      D.sessions.push(newSession({ id: 'T' + t.id, threadId: t.id, title, time: rel(t.updatedAt || t.recencyAt || t.createdAt), loaded: false, history: true, updatedAt: t.updatedAt }));
    }
    sortSessions(); A.renderAll();
    return true;
  }
  function sortSessions() {
    const live = D.sessions.filter((x) => x.live); const rest = D.sessions.filter((x) => !x.live);
    const fresh = live.filter((x) => !x.history); const hist = live.filter((x) => x.history).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    D.sessions.splice(0, D.sessions.length, ...fresh, ...hist, ...rest);
  }
  async function openHistory(s) {
    if (s.loaded || s.loading) return;
    s.loading = true; A.renderAll();
    if (!(await ensureReady())) { s.loading = false; A.renderAll(); return; }
    const r = await cx.request('thread/resume', { threadId: s.threadId });
    s.loading = false;
    if (!r.ok) { sysNote(s, '载入历史失败：' + r.error, true); A.renderAll(); return; }
    s.items = [];
    for (const turn of r.result.thread.turns || []) {
      for (const item of turn.items || []) onItemCompleted(s, item, true);
      if (turn.status === 'failed') sysNote(s, '这一轮失败了：' + (turn.error?.message || ''), true);
      if (turn.status === 'interrupted') sysNote(s, '已停止。');
    }
    s.loaded = true; s.subscribed = true; byThread.set(s.threadId, s);
    A.renderAll();
  }
  function onOpen(prevId, id) {
    const prev = sess(prevId);
    if (prev && prev.live && prev.threadId && prev.subscribed && !prev.busy && prevId !== id && ready) {
      cx.request('thread/unsubscribe', { threadId: prev.threadId });          // 让 VPS 释放不在前台的会话
      prev.subscribed = false;
    }
    const s = sess(id);
    if (s && s.live && s.history && !s.loaded) openHistory(s);
    if (s && s.live) renderTokens(s);
  }
  async function renameSession(s, name) {
    if (!s || !s.live || !name) return;
    s.title = name; A.renderAll();
    if (s.threadId && (await ensureReady())) { const r = await cx.request('thread/name/set', { threadId: s.threadId, name }); if (!r.ok) toast('重命名失败：' + r.error); }
  }
  function startRename(s) {
    const row = document.querySelector(`.sess[data-id="${s.id}"] .s-title`); if (!row) return;
    const inp = document.createElement('input'); inp.className = 'rename-input'; inp.value = s.title;
    row.replaceWith(inp); inp.focus(); inp.select();
    const done = (save) => { if (save && inp.value.trim()) renameSession(s, inp.value.trim()); else A.renderAll(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
    inp.addEventListener('blur', () => done(true));
  }
  async function archiveSession(s) {
    if (!s || !s.live) return;
    if (s.busy) { toast('会话还在运行，先停止再归档'); return; }
    if (s.threadId) {
      if (!(await ensureReady())) return;
      const r = await cx.request('thread/archive', { threadId: s.threadId });
      if (!r.ok) { toast('归档失败：' + r.error); return; }
      byThread.delete(s.threadId);
    }
    D.sessions.splice(D.sessions.indexOf(s), 1);
    state.tabs = state.tabs.filter((x) => x !== s.id);
    if (state.active === s.id) {
      const next = D.sessions.find((x) => x.live) || (D.sessions.unshift(newSession()), D.sessions[0]);
      A.openSession(next.id);
    } else A.renderAll();
    toast('已归档');
  }
  // 侧栏右键菜单
  const ctx = document.createElement('div'); ctx.className = 'ctx-menu'; ctx.hidden = true; document.body.appendChild(ctx);
  $('#sessionList').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.sess'); const s = row && sess(row.dataset.id);
    if (!s || !s.live) return;
    e.preventDefault();
    ctx.innerHTML = '<button data-c="rename">重命名</button><button data-c="archive">归档</button>' + (s.threadId ? '<button data-c="copy">复制会话 ID</button>' : '');
    ctx.style.left = e.clientX + 'px'; ctx.style.top = e.clientY + 'px'; ctx.hidden = false; ctx.dataset.id = s.id;
  });
  ctx.addEventListener('click', (e) => {
    const c = e.target.dataset.c; const s = sess(ctx.dataset.id); ctx.hidden = true; if (!s) return;
    if (c === 'rename') startRename(s); else if (c === 'archive') archiveSession(s);
    else if (c === 'copy') { navigator.clipboard.writeText(s.threadId); toast('已复制'); }
  });
  window.addEventListener('click', () => { ctx.hidden = true; });
  $('#sessionList').addEventListener('dblclick', (e) => { const row = e.target.closest('.sess'); const s = row && sess(row.dataset.id); if (s?.live) startRename(s); });

  /* ---------- 模型 / 推理强度 / 速度 ---------- */
  let models = [];
  const EFFORT_ZH = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: 'Ultra' };
  async function loadModels() {
    const all = []; let cursor;
    for (let i = 0; i < 10; i++) {
      const r = await cx.request('model/list', { limit: 100, cursor, includeHidden: false });
      if (!r.ok) break;
      all.push(...(r.result?.data || [])); cursor = r.result?.nextCursor; if (!cursor) break;
    }
    models = all.filter((m) => !m.hidden);
    if (!models.length) return false;
    const sel = $('#modelSelect'); const keep = store.get('model');
    sel.dataset.live = '1';
    sel.innerHTML = models.map((m) => `<option value="${esc(m.model)}" title="${esc(m.description || '')}">${esc(m.displayName || m.model)}</option>`).join('');
    sel.value = models.some((m) => m.model === keep) ? keep : (models.find((m) => m.isDefault) || models[0]).model;
    sel.disabled = false;
    applyModelOptions();
    return true;
  }
  // 联网模式下不显示示例模型：拿到 Codex 的真实列表之前只显示占位
  function modelPlaceholder(text) {
    const sel = $('#modelSelect'); if (sel.dataset.live) return;
    sel.innerHTML = `<option value="">${esc(text)}</option>`; sel.disabled = true; sel.title = '模型列表来自 VPS 上的 Codex';
  }
  modelPlaceholder('正在获取模型…');
  function applyModelOptions() {
    const m = models.find((x) => x.model === $('#modelSelect').value); if (!m) return;
    $('#modelSelect').title = m.description || '';
    const ef = $('#effortSelect'); const list = m.supportedReasoningEfforts || [];
    const keepE = store.get('effort');
    ef.innerHTML = list.map((e) => `<option value="${e.reasoningEffort}" title="${esc(e.description || '')}">推理：${EFFORT_ZH[e.reasoningEffort] || e.reasoningEffort}</option>`).join('');
    ef.value = list.some((e) => e.reasoningEffort === keepE) ? keepE : (m.defaultReasoningEffort || list[0]?.reasoningEffort);
    $('#effortWrap').hidden = !list.length;
    const tiers = m.serviceTiers || []; const ts = $('#tierSelect');
    ts.innerHTML = '<option value="">标准速度</option>' + tiers.map((t) => `<option value="${esc(t.id)}" title="${esc(t.description || '')}">${esc(t.name)}</option>`).join('');
    const keepT = store.get('tier', ''); ts.value = tiers.some((t) => t.id === keepT) ? keepT : '';
    $('#tierWrap').hidden = !tiers.length;
  }
  $('#modelSelect').addEventListener('change', () => { if ($('#modelSelect').dataset.live) { store.set('model', $('#modelSelect').value); applyModelOptions(); } });
  $('#effortSelect').addEventListener('change', (e) => store.set('effort', e.target.value));
  $('#tierSelect').addEventListener('change', (e) => store.set('tier', e.target.value));

  /* ---------- 用量 / 上下文 ---------- */
  function usageText(u) {
    const snap = u.rateLimits || u;
    const fmt = (w) => w ? `${w.windowDurationMins >= 10000 ? '本周' : w.windowDurationMins ? Math.round(w.windowDurationMins / 60) + ' 小时' : ''} ${w.usedPercent}%` : '';
    return [fmt(snap.primary), fmt(snap.secondary)].filter(Boolean).join(' · ') || '—';
  }
  function renderUsage() {
    let el = $('#sbUsage');
    if (!el) { el = document.createElement('span'); el.className = 'sb-item'; el.id = 'sbUsage'; $('#sbTokens').before(el); }
    if (!usage) { el.textContent = ''; return; }
    const snap = usage.rateLimits || usage;
    el.textContent = '用量 ' + usageText(usage);
    const reset = (w) => w?.resetsAt ? new Date((w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt)).toLocaleString() : '';
    el.title = `Codex 账户用量（ChatGPT 套餐）\n短周期重置：${reset(snap.primary)}\n长周期重置：${reset(snap.secondary)}`;
  }
  function renderTokens(s) {
    const t = s.tokens; if (!t) return;
    const tot = t.total?.totalTokens; if (tot != null) $('#sbTokens').textContent = (tot / 1000).toFixed(1) + 'k tokens';
    const win = t.modelContextWindow; const last = t.last?.totalTokens;
    if (win && last != null) $('#ctxHint').textContent = `上下文 ${Math.min(100, Math.round(last / win * 100))}%`;
  }

  /* ---------- 技能 ---------- */
  let skillsAt = 0;
  async function loadSkills(force) {
    skillsAt = Date.now();
    const r = await cx.request('skills/list', { cwds: [cfg.workspace], forceReload: !!force });
    if (r.ok) skills.cloud = (r.result.data || []).flatMap((e) => e.skills || []).filter((k) => k.enabled !== false)
      .map((k) => ({ name: k.name, description: k.interface?.shortDescription || k.shortDescription || k.description || '', path: k.path, scope: k.scope, display: k.interface?.displayName }));
    skills.local = await skApi.local();
  }

  /* ---------- 输入框菜单：/ 命令、$ 技能、@ 文件 ---------- */
  const ta = $('#input');
  const menu = document.createElement('div'); menu.className = 'cmd-menu'; menu.hidden = true;
  $('.composer-box').appendChild(menu);
  let menuItems = []; let menuSel = 0; let menuTok = null;

  function tokenAtCaret() {
    const pos = ta.selectionStart; const before = ta.value.slice(0, pos);
    const m = /(^|\s)([\/$@])([^\s]*)$/.exec(before);
    if (!m) return null;
    const start = pos - m[3].length - 1;
    if (m[2] === '/' && start !== 0) return null;
    return { kind: m[2], q: m[3].toLowerCase(), start, end: pos };
  }
  function skillRows(q) {
    const match = (k) => !q || k.name.toLowerCase().includes(q) || (k.description || '').toLowerCase().includes(q) || (k.display || '').toLowerCase().includes(q);
    const local = skills.local.filter(match).map((k) => ({ type: 'skill', label: '$' + k.name, desc: k.description, badge: '本地', group: '本地技能（用到时上传到 VPS）', value: '$' + k.name + ' ' }));
    const sys = skills.cloud.filter((k) => k.scope === 'system' && match(k)).map((k) => ({ type: 'skill', label: '$' + k.name, desc: k.description, badge: '内置', group: '云端 · Codex 内置', value: '$' + k.name + ' ' }));
    const other = skills.cloud.filter((k) => k.scope !== 'system' && match(k)).map((k) => ({ type: 'skill', label: '$' + k.name, desc: k.description, badge: k.scope === 'repo' ? '项目' : '云端',
      group: '云端 · ' + (k.name.includes(':') ? k.name.split(':')[0] : '用户技能'), value: '$' + k.name + ' ' }));
    return [...local, ...sys, ...other];
  }
  function buildMenu(tok) {
    if (tok.kind === '/') {
      const cmds = COMMANDS.filter((c) => c.cmd.slice(1).startsWith(tok.q)).map((c) => ({ type: 'cmd', label: c.cmd, desc: c.desc, group: '命令', value: c.cmd }));
      return [...cmds, ...skillRows(tok.q)].slice(0, 400);
    }
    if (tok.kind === '$') return skillRows(tok.q).slice(0, 400);
    const files = W.tree.filter((n) => !n.dir && (!tok.q || n.path.toLowerCase().includes(tok.q))).slice(0, 60)
      .map((n) => ({ type: 'file', label: n.path, desc: '', group: W.access?.ok ? `Windows 测试目录（${WIN_ROOT}）` : '没有读取权限', value: winPath(n.path) + ' ' }));
    return files;
  }
  function openMenu() {
    const tok = tokenAtCaret();
    if (!tok) return closeMenu();
    // 插件技能可能在连接后才陆续就绪：没拿到插件技能时，打开菜单顺手重新拉取（最多 30 秒一次）
    if (tok.kind !== '@' && ready && Date.now() - skillsAt > 4000 &&!skills.cloud.some((k) => k.scope !== 'system')) {
      loadSkills().then(() => { if (!menu.hidden) openMenu(); });
    }
    menuTok = tok; menuItems = buildMenu(tok); menuSel = 0;
    if (!menuItems.length) {
      menu.innerHTML = `<div class="cm-empty">${tok.kind === '@' ? (W.access?.ok ? '没有匹配的文件' : '没有读取测试目录的权限') : ready || skills.cloud.length ? '没有匹配项' : 'Codex 连接后会列出云端技能'}</div>`;
      menu.hidden = false; return;
    }
    renderMenu(); menu.hidden = false;
  }
  function renderMenu() {
    let g = null; let html = '';
    menuItems.forEach((it, i) => {
      if (it.group !== g) { g = it.group; html += `<div class="cm-group">${esc(g)}</div>`; }
      html += `<div class="cm-row ${i === menuSel ? 'sel' : ''}" data-i="${i}"><span class="cm-label mono">${esc(it.label)}</span>${it.badge ? `<span class="cm-badge">${esc(it.badge)}</span>` : ''}<span class="cm-desc">${esc(it.desc || '')}</span></div>`;
    });
    menu.innerHTML = html;
    menu.querySelector('.cm-row.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function closeMenu() { menu.hidden = true; menuTok = null; }
  function pick(i) {
    const it = menuItems[i]; if (!it || !menuTok) return;
    const v = ta.value;
    if (it.type === 'cmd') {
      ta.value = it.value; closeMenu();
      if (runCommand(it.value)) return;
      ta.focus(); return;
    }
    ta.value = v.slice(0, menuTok.start) + it.value + v.slice(menuTok.end);
    const pos = menuTok.start + it.value.length;
    ta.setSelectionRange(pos, pos); closeMenu(); A.autosize(); ta.focus();
  }
  ta.addEventListener('input', () => { if (sess(state.active)?.live) openMenu(); });
  ta.addEventListener('click', () => { if (sess(state.active)?.live) openMenu(); });
  ta.addEventListener('blur', () => setTimeout(closeMenu, 150));
  menu.addEventListener('mousedown', (e) => { const r = e.target.closest('.cm-row'); if (r) { e.preventDefault(); pick(+r.dataset.i); } });
  $('.composer-box').addEventListener('keydown', (e) => {               // 捕获阶段：先于“回车发送”
    if (menu.hidden && e.key === 'Escape') { const s = sess(state.active); if (s?.live && s.busy) { interrupt(s); e.preventDefault(); } return; }
    if (menu.hidden || !menuItems.length) { if (!menu.hidden && e.key === 'Escape') { closeMenu(); e.preventDefault(); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { menuSel = (menuSel + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length; renderMenu(); }
    else if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') pick(menuSel);
    else if (e.key === 'Escape') closeMenu();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  // 输入时：休眠中则提前唤醒，并刷新空闲计时
  let lastTouch = 0;
  ta.addEventListener('input', () => {
    if (!sess(state.active)?.live) return;
    if (conn.codex === 'sleeping') rm.wake();
    else if (Date.now() - lastTouch > 30000) { lastTouch = Date.now(); rm.touch(); }
  });

  /* ---------- 附件 ---------- */
  function renderAtt() {
    $('#attachList').innerHTML = liveAtt.map((a, i) => `<span class="attach-pill" data-li="${i}" title="${esc(a.path)}（点击移除）">${a.image ? '🖼 ' : ''}${esc(a.name)} ×</span>`).join('');
  }
  $('#attachList').addEventListener('click', (e) => {
    const p = e.target.closest('[data-li]'); if (!p) return;
    e.stopImmediatePropagation(); liveAtt.splice(+p.dataset.li, 1); renderAtt();
  }, true);
  async function attach() {
    if (!(await ensureReady())) return;
    const r = await fileApi.pick();
    liveAtt.push(...(r.files || [])); renderAtt();
    if (!r.ok) toast('上传失败：' + r.error); else if (r.files.length) toast(`已上传 ${r.files.length} 个文件到 VPS`);
  }
  ta.addEventListener('paste', async (e) => {
    if (!sess(state.active)?.live) return;
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    if (!(await ensureReady())) return;
    for (const f of imgs) {
      const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(f); });
      const name = f.name && f.name !== 'image.png' ? f.name : `粘贴图片-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`;
      const r = await fileApi.uploadData(name, b64);
      if (r.ok) { liveAtt.push(r.file); renderAtt(); } else toast('图片上传失败：' + r.error);
    }
  });

  /* ---------- 拖放：资源管理器文件 → 附件；右侧文件树 → @ 引用 ---------- */
  const DRAG_TYPE = 'application/x-agentdesk-path';
  const center = document.querySelector('main.center');
  const overlay = document.createElement('div');
  overlay.className = 'drop-overlay'; overlay.hidden = true;
  center.appendChild(overlay);
  const dragKind = (e) => {
    const types = [...(e.dataTransfer?.types || [])];
    return types.includes(DRAG_TYPE) ? 'tree' : types.includes('Files') ? 'files' : '';
  };
  // 不靠 dragenter/dragleave 计数（拖出窗口、按 Esc 取消、在窗口外松手时浏览器可能不发 leave，遮罩会卡住）；
  // 拖动期间 dragover 每几十毫秒触发一次，停了就收起遮罩
  let overlayKind = '', dragTimer = 0;
  const hideOverlay = () => { clearTimeout(dragTimer); overlayKind = ''; overlay.hidden = true; };
  const showOverlay = (k) => {
    clearTimeout(dragTimer); dragTimer = setTimeout(hideOverlay, 300);
    const live = !!sess(state.active)?.live;
    if (!overlay.hidden && overlayKind === k + live) return;
    overlayKind = k + live;
    overlay.innerHTML = `<div class="drop-card">${k === 'tree' ? svg('file') : '<svg viewBox="0 0 24 24"><path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8"/></svg>'}<div><b>${!live ? '示例会话不支持添加文件' : k === 'tree' ? '松开以引用这个路径' : '松开以添加为附件'}</b><span>${!live ? '请切换到“Windows 开发机 · Codex”会话' : k === 'tree' ? '插入到输入框，Codex 会通过 ssh_exec 访问' : '测试目录内的文件直接引用路径；其他文件上传到 VPS（每个 ≤10 MB）'}</span></div></div>`;
    overlay.classList.toggle('bad', !live);
    overlay.hidden = false;
  };
  // 整个窗口都拦住默认行为，避免把文件当网页打开；只有在对话区上方才显示遮罩
  window.addEventListener('dragover', (e) => {
    const k = dragKind(e); if (!k) return;
    e.preventDefault();
    if (center.contains(e.target)) { showOverlay(k); e.dataTransfer.dropEffect = sess(state.active)?.live ? (k === 'tree' ? 'link' : 'copy') : 'none'; }
    else { hideOverlay(); e.dataTransfer.dropEffect = 'none'; }
  });
  window.addEventListener('drop', (e) => { if (dragKind(e)) e.preventDefault(); hideOverlay(); });
  center.addEventListener('dragenter', (e) => { const k = dragKind(e); if (k) { e.preventDefault(); showOverlay(k); } });
  // 任何普通鼠标/键盘/失焦事件都说明拖动已结束
  ['dragend', 'mousemove', 'mousedown', 'blur'].forEach((t) => window.addEventListener(t, () => { if (!overlay.hidden) hideOverlay(); }, true));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) hideOverlay(); }, true);
  center.addEventListener('drop', async (e) => {
    const k = dragKind(e); if (!k) return;
    e.preventDefault(); e.stopPropagation(); hideOverlay();
    if (!sess(state.active)?.live) { toast('示例会话不支持添加文件'); return; }
    if (k === 'tree') { mention(e.dataTransfer.getData(DRAG_TYPE)); return; }
    const list = [...e.dataTransfer.files];
    if (!list.length) return;
    await addDropped(list);
  }, true);
  async function addDropped(list) {
    if (!(await ensureReady())) return;
    toast(`正在处理 ${list.length} 个文件…`);
    applyDropResult(await fileApi.drop(list));
  }
  function applyDropResult(r) {
    (r.mentions || []).forEach((p) => mention(p));
    if (r.files?.length) { liveAtt.push(...r.files); renderAtt(); }
    const parts = [];
    if (r.files?.length) parts.push(`已上传 ${r.files.length} 个附件到 VPS`);
    if (r.mentions?.length) parts.push(`已引用 ${r.mentions.length} 个测试目录内的路径`);
    if (r.errors?.length) parts.push(r.errors.join('；'));
    toast(parts.join('，') || '没有可添加的文件');
    ta.focus();
  }
  // 右侧文件树的节点可以拖到对话区
  $('#panelBody').addEventListener('dragstart', (e) => {
    const n = e.target.closest?.('.node[data-path]'); if (!n || !sess(state.active)?.live) return;
    e.dataTransfer.setData(DRAG_TYPE, n.dataset.path);
    e.dataTransfer.setData('text/plain', winPath(n.dataset.path));
    e.dataTransfer.effectAllowed = 'copyLink';
  });

  /* ---------- 右侧面板：改动 / 终端 / 文件 ---------- */
  function diffTable(text) {
    let o = 0, n = 0; const rows = [];
    for (const l of String(text).split('\n')) {
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(l)) continue;
      if (l.startsWith('@@')) { const m = /-(\d+)(?:,\d+)? \+(\d+)/.exec(l); if (m) { o = +m[1] - 1; n = +m[2] - 1; } rows.push(`<tr class="hunk"><td colspan="4">${esc(l)}</td></tr>`); continue; }
      if (l.startsWith('+')) { n++; rows.push(`<tr class="add"><td class="ln"></td><td class="ln">${n}</td><td class="sign">+</td><td>${esc(l.slice(1))}</td></tr>`); }
      else if (l.startsWith('-')) { o++; rows.push(`<tr class="del"><td class="ln">${o}</td><td class="ln"></td><td class="sign">−</td><td>${esc(l.slice(1))}</td></tr>`); }
      else if (l.startsWith(' ')) { o++; n++; rows.push(`<tr class="ctx"><td class="ln">${o}</td><td class="ln">${n}</td><td class="sign"> </td><td>${esc(l.slice(1))}</td></tr>`); }
    }
    return rows.length ? `<table>${rows.join('')}</table>` : '<div class="empty-note">（没有可显示的文本差异）</div>';
  }
  const STATUS = (f) => f.untracked ? ['U', '新文件'] : (f.index === 'D' || f.work === 'D') ? ['D', '已删除'] : (f.index === 'A') ? ['A', '新增'] : (f.index === 'R') ? ['R', '重命名'] : ['M', '已修改'];
  function noAccessHtml() {
    if (isMac) return `<div class="empty-note">无法打开 Mac 工作区。${esc(W.access?.error || '')}</div>`;
    return `<div class="empty-note">AgentDesk 还不能读取 <code>${esc(WIN_ROOT)}</code>（${esc(W.access?.error || '')}）。<br>
      需要给当前账户加只读权限：在管理员 PowerShell 运行<br><code>icacls ${esc(WIN_ROOT)} /grant "${esc('%USERNAME%')}:(OI)(CI)RX"</code></div>`;
  }
  function renderChanges(body) {
    const s = sess(state.active);
    if (!W.access?.ok) { body.innerHTML = noAccessHtml(); return; }
    const c = W.changes;
    if (!c) { body.innerHTML = '<div class="empty-note">正在读取改动…</div>'; return; }
    if (!c.repo) { body.innerHTML = `<div class="empty-note">${esc(WIN_ROOT)} 还不是 Git 仓库。<br>让 Codex 运行 <code>git init</code> 后，这里会列出每个改动文件。</div>`; return; }
    const tot = c.files.reduce((a, f) => [a[0] + f.add, a[1] + f.del], [0, 0]);
    let html = `<div class="chg-head"><span class="chg-branch">${svg('term')}${esc(c.branch || '')}</span><span>${c.files.length} 个文件</span>
      <span class="a">+${tot[0]}</span><span class="d">−${tot[1]}</span><span class="grow"></span><button class="icon-btn" data-ch="refresh" title="刷新">↻</button></div>`;
    if (!c.files.length) html += '<div class="empty-note">工作区没有未提交的改动。</div>';
    for (const f of c.files) {
      const [code, label] = STATUS(f); const open = W.open.has(f.path);
      html += `<div class="chg-file ${open ? 'open' : ''}" data-path="${esc(f.path)}">
        <div class="chg-row">${svg('chev').replace('<svg', '<svg class="chev"')}<span class="st st-${code}" title="${label}">${code}</span>
          <span class="path" title="${esc(winPath(f.path))}">${esc(f.path)}</span>
          <span class="stat">${f.binary ? '二进制' : `<span class="a">+${f.add}</span><span class="d">−${f.del}</span>`}</span>
          <span class="chg-act"><button data-ch="mention" title="在输入框引用这个文件">@</button><button data-ch="revert" title="让 Codex 撤销这个文件的改动">撤销…</button></span></div>
        ${open ? `<div class="chg-diff">${W.diffCache.has(f.path) ? diffTable(W.diffCache.get(f.path)) : '<div class="empty-note">载入中…</div>'}</div>` : ''}</div>`;
    }
    if (s?.diffs?.length) html += `<div class="chg-sub">VPS 工作区（本轮）</div><div class="chg-diff">${diffTable(s.diffs[0])}</div>`;
    body.innerHTML = `<div class="changes">${html}</div>`;
    for (const p of W.open) if (!W.diffCache.has(p) && c.files.some((f) => f.path === p)) loadDiff(p);
  }
  async function loadDiff(p) {
    W.diffCache.set(p, ''); const r = await wsApi.diff(p);
    W.diffCache.set(p, r.text || r.error || ''); if (state.panel === 'diff') A.renderPanel();
  }
  function renderTermPanel(body) {
    const s = sess(state.active);
    body.innerHTML = `<div class="term"><div class="term-out" id="termOut"></div><div class="term-in ro"><span>只读</span><input disabled placeholder="这里显示 Codex 在 VPS / Windows 上执行的命令和输出" /></div></div>`;
    const o = $('#termOut');
    o.innerHTML = (s.term.length ? s.term : [['', 'Codex 执行的命令和输出会显示在这里。']]).slice(-2000).map(([c, l]) => `<div class="${c}">${esc(l)}</div>`).join('');
    o.parentElement.parentElement.scrollTop = 1e9;
  }
  function renderFiles(body) {
    if (!W.access?.ok) { body.innerHTML = noAccessHtml(); return; }
    const mods = new Map((W.changes?.files || []).map((f) => [f.path, STATUS(f)[0]]));
    const hidden = (n) => { const parts = n.path.split('/'); for (let i = 1; i < parts.length; i++) if (W.collapsedDirs.has(parts.slice(0, i).join('/'))) return true; return false; };
    const tree = W.tree.filter((n) => !hidden(n)).map((n) => {
      const m = mods.get(n.path);
      return `<div class="node ${n.path === W.sel ? 'sel' : ''} ${n.dir ? 'dir' : ''}" draggable="true" title="拖到对话区可引用路径" style="padding-left:${10 + n.depth * 14}px" data-path="${esc(n.path)}" data-dir="${n.dir ? 1 : ''}">
        ${n.dir ? svg(W.collapsedDirs.has(n.path) ? 'chev' : 'chevDown').replace('<svg', '<svg class="tw"') : '<span class="tw"></span>'}${svg(n.dir ? 'folder' : 'file')}<span>${esc(n.name)}</span>${m ? `<span class="mod ${m}">${m}</span>` : ''}</div>`;
    }).join('');
    let pv = '<div class="empty-note">选择左侧文件查看内容</div>';
    if (W.sel && W.preview) {
      const r = W.preview;
      const content = r.error ? `<div class="empty-note">${esc(r.error)}</div>` : r.binary ? '<div class="empty-note">二进制文件，不显示内容</div>' : r.tooLarge ? `<div class="empty-note">文件较大（${(r.size / 1024).toFixed(0)} KB），不预览</div>`
        : `<pre class="mono">${String(r.text).split('\n').map((l) => `<span>${esc(l) || ' '}</span>`).join('')}</pre>`;
      pv = `<div class="preview-head mono"><span>${esc(W.sel)}</span><span class="grow"></span><button class="btn" data-fa="mention">@ 引用</button></div>${content}`;
    }
    body.innerHTML = `<div class="files"><div class="tree">${tree || '<div class="empty-note">目录是空的</div>'}${W.treeTruncated ? '<div class="empty-note">文件太多，只显示前 3000 个</div>' : ''}</div><div class="preview" id="preview">${pv}</div></div>`;
  }
  function renderPanel(panel, body) {
    $('#diffBadge').textContent = W.changes?.files?.length || '';
    if (panel === 'diff') renderChanges(body);
    else if (panel === 'terminal') renderTermPanel(body);
    else renderFiles(body);
  }
  function mention(p) {
    const v = ta.value; const ins = winPath(p) + ' ';
    ta.value = v && !/\s$/.test(v) ? v + ' ' + ins : v + ins; A.autosize(); ta.focus();
  }
  $('#panelBody').addEventListener('click', async (e) => {
    const s = sess(state.active); if (!s?.live) return;
    const ch = e.target.closest('[data-ch]');
    if (ch) {
      e.stopImmediatePropagation();
      const f = ch.closest('.chg-file')?.dataset.path;
      if (ch.dataset.ch === 'refresh') { refreshChanges(true); toast('已刷新'); }
      else if (ch.dataset.ch === 'mention') mention(f);
      else if (ch.dataset.ch === 'revert') { ta.value = `请撤销 ${winPath(f)} 的所有未提交改动（用 git restore / 删除新文件），完成后用 git status --short 确认。`; A.autosize(); ta.focus(); }
      return;
    }
    const row = e.target.closest('.chg-row');
    if (row) {
      e.stopImmediatePropagation();
      const p = row.parentElement.dataset.path;
      if (W.open.has(p)) W.open.delete(p); else { W.open.add(p); W.diffCache.delete(p); }
      A.renderPanel(); return;
    }
    if (e.target.closest('[data-fa="mention"]')) { e.stopImmediatePropagation(); mention(W.sel); return; }
    const nd = e.target.closest('.node');
    if (nd) {
      e.stopImmediatePropagation();
      const p = nd.dataset.path;
      if (nd.dataset.dir) { W.collapsedDirs.has(p) ? W.collapsedDirs.delete(p) : W.collapsedDirs.add(p); store.set('collapsedDirs', [...W.collapsedDirs]); A.renderPanel(); return; }
      W.sel = p; W.preview = { text: '载入中…' }; A.renderPanel();
      W.preview = await wsApi.read(p); if (W.sel === p) A.renderPanel();
    }
  }, true);

  // 工作区刷新（本地读取，不占 VPS）
  let chgTimer = null;
  function refreshChanges(now) {
    clearTimeout(chgTimer);
    chgTimer = setTimeout(async () => {
      if (!W.access?.ok) return;
      const [c, t] = await Promise.all([wsApi.changes(), wsApi.tree()]);
      W.changes = c; W.tree = t.items || []; W.treeTruncated = !!t.truncated;
      W.diffCache.clear();
      if (W.sel && state.panel === 'files' && W.tree.some((n) => n.path === W.sel)) W.preview = await wsApi.read(W.sel);
      if (sess(state.active)?.live && state.panelOpen) A.renderPanel();
      else $('#diffBadge').textContent = c.files?.length || '';
    }, now ? 0 : 400);
  }

  /* ---------- 初始化 ---------- */
  window.__live = { send, resolve, itemHtml, renderPanel, attach, onOpen, newSession, applyDropResult };
  rm.config().then((c) => { cfg = c; if (isMac) WIN_ROOT = c.localWorkspace || WIN_ROOT; });
  rm.onStatus(renderConn);
  rm.status().then(renderConn);
  $('#sbConn').addEventListener('click', () => { if (conn.codex === 'sleeping') { rm.wake(); toast('正在唤醒 Codex…'); } else { rm.reconnect(); toast('正在重新连接…'); } });
  $('#sbReconnect').addEventListener('click', () => { rm.reconnect(); toast('正在重新连接…'); });
  const desktopButton = $('#sbDesktop');
  const displayDesktop = (enabled) => {
    desktopButton.textContent = enabled ? '本机桌面：开启' : '本机桌面：关闭';
    desktopButton.setAttribute('aria-pressed', String(enabled));
  };
  window.desk.desktop.enabled().then(displayDesktop);
  window.desk.desktop.onEnabled(displayDesktop);
  desktopButton.addEventListener('click', () => window.desk.desktop.toggle().then(displayDesktop));
  cx.onEvent(onEvent);
  cx.onServerRequest(onServerRequest);
  let historyLoaded = false;
  // 每次连上都补齐还没拿到的数据（首次连接可能因网络抖动失败，之后的重连要能补上）
  async function onReady() {
    ready = true;
    if (!cfg.workspace) cfg = await rm.config();      // 先拿到工作区路径，技能与历史都按它查询
    const jobs = [loadSkills()];
    if (!models.length) jobs.push(loadModels().catch(() => false));
    if (!historyLoaded) jobs.push(loadHistory().then((ok) => { historyLoaded = !!ok; }).catch(() => {}));
    await Promise.all(jobs);
    if (!usage) { const u = await cx.request('account/rateLimits/read', {}); if (u.ok) { usage = u.result; renderUsage(); } }
    if (!models.length) {
      modelPlaceholder('模型获取失败，重试中…');
      [3000, 8000, 15000, 30000].forEach((ms) => setTimeout(() => { if (ready && !models.length) loadModels().catch(() => false); }, ms));
    }
    // app-server 启动后约 6–9 秒插件技能才就绪，且不会发通知：补拉几次直到拿到
    [5000, 10000, 20000, 40000].forEach((ms) => setTimeout(() => {
      if (ready && !skills.cloud.some((k) => k.scope !== 'system')) loadSkills().then(() => { if (!menu.hidden) openMenu(); });
    }, ms));
  }
  cx.onReady(onReady);
  const lost = (why) => {
    ready = false;
    for (const s of D.sessions) if (s.live) {
      s.subscribed = false;
      if (s.busy) fail(s, why);
    }
  };
  cx.onDown(() => lost('Codex 连接断开，本轮已中止。重连后可以继续对话。'));
  cx.onSleep(() => lost('Codex 已休眠。'));
  rm.status().then((st) => { if (st.codex === 'ready') onReady(); });
  wsApi.access().then((a) => { W.access = a; if (a.ok) refreshChanges(true); else if (sess(state.active)?.live) A.renderPanel(); });
  wsApi.onChanged(() => refreshChanges());
  ta.placeholder = isMac ? '向 VPS 上的 Codex 提问…  / 命令 · $ 技能 · @ 文件 · Enter 发送' : '让 Codex 在 Windows 开发机上做点什么…  / 命令 · $ 技能 · @ 文件 · Enter 发送';
  sortSessions(); A.renderAll();
})();
