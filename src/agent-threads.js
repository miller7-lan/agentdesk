// Members' own conversations for group work.
// The lead plans in the group chat and hands steps to members. Each step then appears in the member's own
// conversation for that project ("@Codex", "@Grok Build"…): what the lead asked, live progress, the full output,
// and for a step that changed files, the patch to review and apply to this computer. The person can carry on
// there with follow-up requests, which run as that member's direct tasks. The group chat only shows a progress
// board per task, so it stays short.
window.__agentThreadsReady = (async () => {
  await window.__groupReady;
  const A = window.__desk;
  const G = window.__group;
  const P = window.__providerDirect;
  if (!A?.LIVE || !G || !P) return;
  const { $, esc, svg, store, D } = A;
  const avatars = window.AgentDeskAvatars;
  const api = window.desk.orchestrator;
  // Members only: the lead (Claude) plans, diagnoses and accepts in the group itself, so it gets no conversation
  // of its own under the group.
  const ROLES = new Set(['codex', 'grok', 'gemini', 'antigravity']);
  const capabilities = { plan: '规划', triage: '诊断', scout: '侦察', implement: '改代码', review: '审查', research: '查资料', accept: '验收' };
  const stepStates = { queued: '排队', waiting: '等待', running: '执行中', completed: '完成', failed: '失败', cancelled: '已停止', skipped: '跳过' };
  const taskTerminal = new Set(['completed', 'failed', 'cancelled']);
  const stepDone = new Set(['completed', 'failed', 'cancelled', 'skipped']);
  const MAX_THREADS = 40;

  // A record belongs to one group chat (s.group) and is listed under that group's project (s.project).
  const threadId = (group, role) => 'A:' + group + ':' + role;
  const projectOf = (group) => G.projectOf ? G.projectOf(group) : group;
  const threads = () => D.sessions.filter((s) => s.agentThread);

  for (const saved of (Array.isArray(store.get('agentThreads', [])) ? store.get('agentThreads', []) : []).slice(0, MAX_THREADS)) {
    if (!saved || typeof saved.project !== 'string' || !ROLES.has(saved.provider) || !A.proj(saved.project) ||
        D.sessions.some((s) => s.id === saved.id) || !Array.isArray(saved.items) || !ROLES.has(saved.provider)) continue;   // old lead threads are dropped
    const items = saved.items.filter((it) => it && ['user', 'provider-task', 'dispatch-step'].includes(it.t) &&
      !P.ownsTask({ id: it.taskId || it.task?.id }));
    if (items.length) D.sessions.push({ ...saved, group: saved.group || saved.project, agentThread: true, live: true, diffs: [], term: [], busy: false, items });
  }

  function persist() {
    store.set('agentThreads', threads().slice(0, MAX_THREADS).map(({ id, project, group, provider, title, items, taskId, status, time }) =>
      ({ id, project, group, provider, title, taskId, status, time,
        items: items.slice(-80).map(({ preview, log, activity, ...item }) => item) })));
  }

  function ensureThread(group, role) {
    const id = threadId(group, role);
    let s = D.sessions.find((session) => session.id === id);
    if (!s) {
      s = { id, project: projectOf(group), group, provider: role, agentThread: true, title: P.names[role] + ' · 组长派遣', status: 'idle', time: '刚刚',
        items: [], live: true, diffs: [], term: [] };
      D.sessions.unshift(s);
    }
    return s;
  }

  async function control(project, operation, params = {}) {
    const configured = A.proj(project)?.configured;
    const result = await api.control({ operation, ...(configured && { projectId: projectOf(project) }), ...params });
    if (!result?.ok) throw Error(result?.error || '主控请求失败');
    return result.value;
  }

  function threadStatus(s) {
    const steps = s.items.filter((it) => it.t === 'dispatch-step' && it.snap);
    if (steps.some((it) => it.snap.write && it.snap.detail === 'patches_ready' && !it.applied)) return 'waiting';
    if (steps.some((it) => !stepDone.has(it.snap.state) && !taskTerminal.has(it.snap.taskState))) return 'running';
    return s.busy ? 'running' : steps.length || s.items.length ? 'done' : 'idle';
  }

  // Copies the latest state of a task into the conversations of the members who work on it.
  function apply(project, task) {
    if (P.ownsTask(task)) return false;
    const touched = new Set();
    for (const step of task.steps || []) {
      if (!ROLES.has(step.role)) continue;
      const s = ensureThread(project, step.role);
      let item = s.items.find((it) => it.t === 'dispatch-step' && it.taskId === task.id && it.stepId === step.id);
      if (!item) {
        item = { t: 'dispatch-step', taskId: task.id, stepId: step.id, at: Date.parse(task.createdAt || '') || Date.now() };
        // Keep the conversation in the order the work was handed out, also when older tasks arrive later.
        const after = s.items.findIndex((it) => it.t === 'dispatch-step' && it.at > item.at);
        if (after === -1) s.items.push(item); else s.items.splice(after, 0, item);
      }
      const snap = {
        label: task.id.slice(0, 8), state: step.state, capability: step.capability, model: step.model, write: Boolean(step.write),
        brief: step.brief, output: step.output, error: step.error, files: step.paths?.length || 0,
        verdict: step.verdict?.summary, taskState: task.state, detail: String(task.detail || '').split(':')[0],
        guidance: step.guidance || [],
      };
      if (JSON.stringify(snap) !== JSON.stringify(item.snap)) {
        item.snap = snap;
        touched.add(s);
      }
    }
    for (const s of touched) {
      s.status = threadStatus(s);
      s.time = '刚刚';
    }
    return touched.size > 0;
  }

  const fetched = new Map();   // taskId -> updatedAt last copied
  let syncing = false;
  async function sync() {
    if (syncing) return;
    syncing = true;
    let changed = false;
    try {
      let budget = 4;
      for (const project of G.projects()) {
        if (G.isExample(project)) continue;
        for (const task of G.tasks(project)) {
          if (budget <= 0) break;
          if (task.redacted || !task.steps?.length) continue;
          const finished = taskTerminal.has(task.state);
          if (finished && fetched.get(task.id) === task.updatedAt) continue;
          budget -= 1;
          try {
            const full = await control(project, 'status', { taskId: task.id });
            fetched.set(task.id, full.updatedAt);
            if (apply(project, full)) {
              changed = true;
              G.merge(project, full);
            }
          } catch { /* the group view keeps showing the summary; try again on the next round */ }
        }
      }
    } finally {
      syncing = false;
    }
    if (changed) {
      persist();
      const active = D.sessions.find((s) => s.id === A.state.active);
      if (active?.agentThread && !A.state.group) A.renderAll(); else A.renderSidebar();
    }
  }
  setInterval(sync, 3000);
  setTimeout(sync, 800);

  // How each step was worked on: refreshed while it runs, fetched once when it has finished.
  let loadingActivity = false;
  async function refreshActivity() {
    const s = D.sessions.find((session) => session.id === A.state.active);
    if (loadingActivity || !s?.agentThread || A.state.group || !window.__activity) return;
    loadingActivity = true;
    let changed = false;
    try {
      const steps = s.items.filter((it) => it.t === 'dispatch-step' && it.snap && it.snap.state !== 'queued');
      const wanted = [...steps.filter((it) => it.snap.state === 'running' || it.activityState === 'running'),
        ...steps.filter((it) => !it.activity).slice(-3)];
      for (const it of new Set(wanted)) {
        try {
          const activity = await window.__activity.load(s.project, it.taskId, it.stepId, { configuredOnly: true });
          if (JSON.stringify(activity) !== JSON.stringify(it.activity)) { it.activity = activity; changed = true; }
          it.activityState = activity.state;
        } catch { it.activity ||= { items: [] }; }
      }
    } finally {
      loadingActivity = false;
    }
    if (changed && A.state.active === s.id && !A.state.group) A.renderAll();
  }
  setInterval(refreshActivity, 2500);

  async function open(project, role, taskId) {
    if (!ROLES.has(role)) return;
    const s = ensureThread(project, role);
    persist();
    A.openSession(s.id);
    if (!taskId) { await sync(); return; }
    try {
      const task = await control(project, 'status', { taskId });
      if (apply(project, task)) persist();
      G.merge(project, task);
    } catch {
      if (!s.items.some(it => it.taskId === taskId)) A.toast('原派遣记录暂时无法读取。');
    }
    if (A.state.active !== s.id || A.state.group) return;
    A.renderAll();
    requestAnimationFrame(() => document.querySelector(`[data-dispatch="${CSS.escape(taskId + ':' + role)}"]`)
      ?.scrollIntoView({ block: 'start' }));
  }

  // The member's work in the look of a single chat (like a Grok Bot teammate's own thread): the lead's brief
  // and the person's guidance as messages, then thinking blocks, command and file rows, and the member's replies.
  const md = (text) => window.__live?.md ? window.__live.md(text) : `<p>${esc(text)}</p>`;
  function chatWork(activity, key, s, running) {
    const role = s?.provider || 'codex';
    const opened = (id, fallback) => s?.actOpen?.has(id) ? s.actOpen.get(id) : fallback;
    const row = (id, kind, icon, arg, meta, body, open, failed) => `<div class="tool ${open ? 'open' : ''} ${failed ? 'err' : ''}" data-act-toggle="${esc(id)}">
      <div class="tool-head">${svg('chev').replace('<svg', '<svg class="chev"')}<span class="tool-ic">${svg(icon)}</span>
        <span class="tool-kind">${esc(kind)}</span><span class="tool-arg mono">${esc(arg)}</span><span class="tool-meta">${esc(meta || '')}</span></div>
      <div class="tool-body">${body}</div></div>`;
    const items = activity?.items || [];
    const html = items.map((item, index) => {
      const id = key + ':' + index;
      const last = index === items.length - 1;
      switch (item.kind) {
        case 'thinking': {
          const first = String(item.text || '').split('\n').find((line) => line.trim()) || '';
          return `<div class="tool reason ${opened(id, false) ? 'open' : ''}" data-act-toggle="${esc(id)}">
            <div class="tool-head">${svg('chev').replace('<svg', '<svg class="chev"')}<span class="tool-ic">${svg('spark')}</span>
            <span class="tool-kind">已思考</span><span class="tool-arg">${esc(first.replace(/\*\*/g, '').slice(0, 90))}</span></div>
            <div class="tool-body reason-body">${md(item.text)}</div></div>`;
        }
        case 'message':
          return `<div class="msg-assist"><span class="direct-avatar">${avatars.html(role, { size: 32, still: true })}</span><div class="msg-body">${md(item.text)}</div></div>`;
        case 'command': {
          const failed = item.status === 'failed' || (Number.isFinite(item.exitCode) && item.exitCode !== 0);
          const meta = item.status === 'in_progress' || item.status === 'running' ? (running ? '运行中' : '')
            : Number.isFinite(item.exitCode) ? '退出码 ' + item.exitCode : '';
          return row(id, '运行命令', 'term', item.command, meta, `<div class="io-label">输出</div><pre class="io">${esc(item.output || '（没有输出）')}</pre>`,
            opened(id, failed || (running && last)), failed);
        }
        case 'edit':
          return (item.files || []).map((file, n) => row(id + ':' + n, file.change === 'add' || file.change === 'create' ? '新建文件' : file.change === 'delete' ? '删除文件' : '编辑文件',
            'edit', file.path, '', item.error ? `<pre class="io">${esc(item.error)}</pre>` : '<p class="act-empty">已修改</p>', false, Boolean(item.error))).join('');
        case 'tool':
          return row(id, '工具', 'shield', `${item.name} ${item.input || ''}`.trim(), item.status === 'failed' ? '失败' : '',
            `<div class="io-label">返回</div><pre class="io">${esc(item.output || '（没有返回内容）')}</pre>`, opened(id, false), item.status === 'failed');
        case 'search':
          return row(id, '搜索', 'file', item.text, '', '', false, false);
        case 'plan':
          return `<div class="plan-card"><div class="plan-title">${svg('term')}<span>计划</span><span class="grow"></span><span class="plan-count">${(item.steps || []).filter((x) => x.done).length}/${(item.steps || []).length}</span></div>
            <ol class="plan-steps">${(item.steps || []).map((x) => `<li class="${x.done ? 'completed' : ''}"><span class="ps-dot"></span><span>${esc(x.text)}</span></li>`).join('')}</ol></div>`;
        case 'error':
          return `<div class="msg-assist"><span class="direct-avatar">${avatars.html(role, { size: 32, still: true })}</span><div class="msg-body"><p class="err-note">${esc(item.text)}</p></div></div>`;
        default:
          return '';
      }
    }).join('');
    const live = running ? `<div class="msg-assist"><span class="direct-avatar">${avatars.html(role, { size: 32, still: true })}</span>
      <div class="msg-body thinking">${window.AgentDeskLight?.border(role) || ''}<i></i><i></i><i></i>正在工作…</div></div>` : '';
    return html + live;
  }

  function itemHtml(it, index) {
    if (it.t !== 'dispatch-step') return null;
    const s = D.sessions.find((session) => session.id === A.state.active);
    const snap = it.snap || {};
    const name = P.names[s?.provider] || '';
    const what = [capabilities[snap.capability] || (snap.write ? '修改' : ''), snap.model].filter(Boolean).join(' · ');
    const state = stepStates[snap.state] || snap.state || '排队';
    const patches = snap.write && snap.detail === 'patches_ready' && !it.applied;
    const running = snap.state === 'running';
    const work = chatWork(it.activity, it.taskId + ':' + it.stepId, s, running);
    const guidance = (snap.guidance || []).map((item) => `<div class="msg-user"><span class="steer-tag">你的指导</span>${esc(item.text)}</div>`).join('');
    const body = [work,
      snap.error ? `<p class="err-note">${esc(P.errors[snap.error] || snap.error)}</p>` : '',
      snap.output && !window.__activity?.hasReply(it.activity) ? `<pre class="dispatch-output">${esc(snap.output)}</pre>` : '',
      !work && running ? `<p class="dispatch-wait">${esc(name)} 正在处理…</p>` : ''].join('');
    return `<div class="dispatch-step" data-state="${esc(snap.state || 'queued')}" data-dispatch="${esc(it.taskId + ':' + (s?.provider || ''))}">
      <header><span class="dispatch-from">组长派遣</span><span class="mono">#${esc(snap.label || it.taskId.slice(0, 8))}</span>
        ${what ? `<span>${esc(what)}</span>` : ''}<span class="dispatch-state">${esc(state)}</span></header>
      ${snap.brief ? `<div class="dispatch-brief"><strong>组长派给 ${esc(name)} 的任务</strong><p>${esc(snap.brief)}</p></div>` : ''}
      ${guidance}
      ${body}
      ${snap.verdict ? `<p class="dispatch-verdict">结论：${esc(snap.verdict)}</p>` : ''}
      ${snap.files ? `<p class="dispatch-files">涉及 ${snap.files} 个文件</p>` : ''}
      ${it.applied ? '<p class="dispatch-files">已写入本机。</p>' : ''}
      <div class="task-actions">
        <button class="btn" type="button" data-dispatch-action="log" data-dispatch-index="${index}">原始日志</button>
        ${patches ? `<button class="btn" type="button" data-dispatch-action="diff" data-dispatch-index="${index}">查看补丁</button>` : ''}
        ${patches && it.preview !== undefined ? `<button class="btn primary" type="button" data-dispatch-action="apply" data-dispatch-index="${index}">确认并应用到本机</button>` : ''}
        <button class="btn" type="button" data-dispatch-action="group" data-dispatch-index="${index}">回到群聊任务</button>
      </div>
      ${it.preview !== undefined ? `<pre class="dispatch-output">${esc(it.preview || '没有改动')}</pre>` : ''}
      ${it.log !== undefined ? `<pre class="dispatch-output">${esc(it.log || '暂无日志')}</pre>` : ''}
    </div>`;
  }

  $('#timeline').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-dispatch-action]');
    if (!button) return;
    const s = D.sessions.find((session) => session.id === A.state.active);
    const item = s?.items[Number(button.dataset.dispatchIndex)];
    if (!s?.agentThread || item?.t !== 'dispatch-step') return;
    const action = button.dataset.dispatchAction;
    if (action === 'group') { G.showTask(s.group || s.project, item.taskId); return; }
    button.disabled = true;
    try {
      if (action === 'log') {
        const value = await control(s.project, 'task_log', { taskId: item.taskId, stepId: item.stepId });
        item.log = item.log === undefined ? value?.text ?? '' : undefined;
      } else if (action === 'diff') {
        item.preview = (await control(s.project, 'task_diff', { taskId: item.taskId }))?.patch ?? '';
      } else if (action === 'apply' && item.preview !== undefined) {
        await control(s.project, 'apply', { taskId: item.taskId });
        item.applied = true;
        delete item.preview;
        fetched.delete(item.taskId);
        s.status = threadStatus(s);
        persist();
        sync();
      }
      A.renderAll();
    } catch (error) {
      button.disabled = false;
      A.toast(P.errors[error.message] || error.message);
    }
  });

  const previousItem = window.__live.itemHtml;
  window.__live.itemHtml = (it, index) => itemHtml(it, index) ?? previousItem(it, index);
  const previousAvatar = P.avatarState;
  P.avatarState = (s) => s.agentThread && !s.busy
    ? { running: 'tool', waiting: 'asking', done: 'done' }[threadStatus(s)] || 'idle'
    : previousAvatar(s);

  // Lead-dispatched conversations are a record of group work, kept apart from the person's own conversations:
  // nothing is typed here. Extra requests go back to the group (@member) or into a separate conversation.
  const banner = $('#threadBanner');
  const previousRender = P.render;
  P.render = (s) => {
    previousRender(s);
    const dispatched = Boolean(s?.agentThread);
    banner.hidden = !dispatched;
    const target = dispatched && steerTarget(s);
    $('#input').disabled = dispatched && !target;
    $('#sendBtn').disabled = dispatched && !target;
    $('.composer[data-direct]')?.classList.toggle('composer-locked', dispatched && !target);
    if (dispatched) {
      $('#threadBannerText').textContent = target
        ? `组长在群聊派给 ${P.names[s.provider]} 的工作。可以在下面给它指导方向，它会按你的话接着做，完成后结果回到群聊。`
        : `组长在群聊派给 ${P.names[s.provider]} 的工作，目前没有进行中的步骤。`;
      $('#threadBannerNew').textContent = `新建 ${P.names[s.provider]} 单聊`;
      $('#input').placeholder = target ? `告诉 ${P.names[s.provider]} 该往哪个方向做（它会停下当前这一轮，带着你的话继续）…`
        : `这里的步骤都已结束。要追加要求，回群聊找组长，或新建单聊。`;
    }
  };
  // The step the person's guidance goes to: the newest step of this conversation that is still to do or at work.
  function steerTarget(s) {
    return [...(s?.items || [])].reverse().find((it) => it.t === 'dispatch-step' && it.snap &&
      ['queued', 'running'].includes(it.snap.state) && !taskTerminal.has(it.snap.taskState));
  }
  const previousSend = P.send;
  P.send = async (s, fromButton) => {
    if (!s?.agentThread) return previousSend(s, fromButton);
    const target = steerTarget(s);
    const text = $('#input').value.trim();
    if (!target) { A.toast('这里的步骤都已结束；要追加要求请回群聊找组长。'); return; }
    if (!text) return;
    try {
      const status = await control(s.project, 'steer_step', { taskId: target.taskId, stepId: target.stepId, reply: text });
      $('#input').value = '';
      if (apply(s.group || s.project, status)) { persist(); }
      G.merge?.(s.group || s.project, status);
      A.toast(`已告诉 ${P.names[s.provider]}，它会带着你的话继续`);
      A.renderAll();
    } catch (error) {
      A.toast(error.message === 'step_finished' ? '这一步已经结束；要追加要求请回群聊找组长。' : P.errors[error.message] || error.message);
    }
  };
  // Expanding and collapsing the rows of a dispatched conversation.
  $('#timeline').addEventListener('click', (event) => {
    const row = event.target.closest('[data-act-toggle]');
    if (!row || event.target.closest('.tool-body')) return;
    const s = D.sessions.find((session) => session.id === A.state.active);
    if (!s?.agentThread) return;
    (s.actOpen ||= new Map()).set(row.dataset.actToggle, !row.classList.contains('open'));
    row.classList.toggle('open');
  });
  $('#threadBannerGroup').addEventListener('click', () => {
    const s = D.sessions.find((session) => session.id === A.state.active);
    if (s?.agentThread) A.openGroup(s.group || s.project);
  });
  $('#threadBannerNew').addEventListener('click', () => {
    const s = D.sessions.find((session) => session.id === A.state.active);
    if (s?.agentThread) A.newDirect(s.project, s.provider);
  });

  // Deleting a group chat deletes the records of work its lead handed out.
  const threadsOf = (group) => threads().filter((s) => (s.group || s.project) === group);
  function removeGroup(group) {
    for (const s of threadsOf(group)) {
      const index = D.sessions.indexOf(s);
      if (index >= 0) D.sessions.splice(index, 1);
    }
    persist();
  }

  window.__agentThreads = { threadsOf, removeGroup, open, persist, onOpen: () => { sync(); refreshActivity(); } };
  A.renderSidebar();
})();
