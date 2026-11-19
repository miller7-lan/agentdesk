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
  const { $, esc, store, D } = A;
  const api = window.desk.orchestrator;
  const ROLES = new Set(['codex', 'claude', 'grok', 'gemini', 'antigravity']);
  const capabilities = { plan: '规划', triage: '诊断', scout: '侦察', implement: '改代码', review: '审查', research: '查资料', accept: '验收' };
  const stepStates = { queued: '排队', waiting: '等待', running: '执行中', completed: '完成', failed: '失败', cancelled: '已停止', skipped: '跳过' };
  const taskTerminal = new Set(['completed', 'failed', 'cancelled']);
  const stepDone = new Set(['completed', 'failed', 'cancelled', 'skipped']);
  const MAX_THREADS = 40;

  // A record belongs to one group chat (s.group) and is listed under that group's project (s.project).
  // One conversation per task and member, so two tasks the same AI works on in parallel stay apart; when one
  // task splits into parallel steps for the same member, each of those steps gets its own conversation too.
  const threadId = (group, role) => 'A:' + group + ':' + role;
  const taskThreadId = (group, role, taskId) => threadId(group, role) + ':' + taskId;
  const stepThreadId = (group, role, taskId, stepId) => taskThreadId(group, role, taskId) + ':' + stepId;
  const projectOf = (group) => G.projectOf ? G.projectOf(group) : group;
  const threads = () => D.sessions.filter((s) => s.agentThread);
  const short = (text, n = 18) => {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    return line.length > n ? line.slice(0, n) + '…' : line;
  };
  function titleOf(role, task, step) {
    const name = P.names[role] || role;
    // Put the step first: two parallel branches of the same AI must stay distinguishable in the sidebar.
    if (step) return `${step.id} · ${name}`;
    const prompt = short(task?.prompt);
    return prompt ? `${name} · ${prompt}` : `${name} · 组长派遣`;
  }
  function newThread(id, group, role, task, step, items = []) {
    const at = Date.parse(task?.createdAt || '') || items.reduce((last, it) => Math.max(last, it.at || 0), 0) || Date.now();
    const s = { id, project: projectOf(group), group, provider: role, agentThread: true, title: titleOf(role, task, step),
      shortTitle: titleOf(role, task, step), status: 'idle', time: '刚刚', order: at, items, live: true, diffs: [], term: [] };
    // Newer assignments sit above older ones under the group.
    const index = D.sessions.findIndex((other) => other.agentThread && (other.order || 0) < at);
    if (index === -1) D.sessions.push(s); else D.sessions.splice(index, 0, s);
    return s;
  }

  let migrated = false;
  for (const saved of (Array.isArray(store.get('agentThreads', [])) ? store.get('agentThreads', []) : []).slice(0, MAX_THREADS)) {
    if (!saved || typeof saved.project !== 'string' || !ROLES.has(saved.provider) || !A.proj(saved.project) ||
        D.sessions.some((s) => s.id === saved.id) || !Array.isArray(saved.items)) continue;
    const items = saved.items.filter((it) => it && ['user', 'provider-task', 'dispatch-step'].includes(it.t) &&
      !P.ownsTask({ id: it.taskId || it.task?.id }));
    if (!items.length) continue;
    // Older versions kept one conversation per member for the whole group. Split those records by task, so a
    // conversation still matches the work it belongs to after the upgrade.
    if (/^A:[^:]+:[^:]+$/.test(saved.id)) {
      const group = saved.group || saved.project;
      const byTask = new Map();
      for (const it of items) {
        if (it.t !== 'dispatch-step' || !it.taskId) continue;
        if (!byTask.has(it.taskId)) byTask.set(it.taskId, []);
        byTask.get(it.taskId).push(it);
      }
      for (const [taskId, taskItems] of byTask) {
        const id = taskThreadId(group, saved.provider, taskId);
        let s = D.sessions.find((session) => session.id === id);
        if (!s) s = newThread(id, group, saved.provider, { id: taskId, createdAt: new Date(taskItems[0].at || Date.now()).toISOString() }, null, taskItems);
        else for (const it of taskItems) {
          if (!s.items.some((other) => other.t === 'dispatch-step' && other.taskId === it.taskId && other.stepId === it.stepId)) s.items.push(it);
        }
      }
      if (byTask.size) { migrated = true; continue; }
    }
    D.sessions.push({ ...saved, group: saved.group || saved.project, agentThread: true, live: true, diffs: [], term: [], busy: false, items });
  }

  function persist() {
    store.set('agentThreads', threads().slice(0, MAX_THREADS).map(({ id, project, group, provider, title, shortTitle, order, items, taskId, status, time }) =>
      ({ id, project, group, provider, title, shortTitle, order, taskId, status, time,
        items: items.slice(-80).map(({ preview, log, activity, ...item }) => item) })));
  }
  if (migrated) persist();

  // Steps of one task worked by the same member that do not depend on each other are parallel branches:
  // each gets its own conversation so their logs never mix.
  function parallelSteps(task) {
    const steps = (task.steps || []).filter((step) => ROLES.has(step.role) && step.id && step.capability !== 'triage' &&
      !String(step.id).startsWith('reassign-'));
    const byId = new Map(steps.map((step) => [step.id, step]));
    const memo = new Map();
    const ancestors = (step) => {
      if (memo.has(step.id)) return memo.get(step.id);
      const found = new Set();
      memo.set(step.id, found);   // a cycle still terminates
      for (const id of step.dependsOn || []) {
        const parent = byId.get(id);
        if (!parent) continue;
        found.add(id);
        for (const up of ancestors(parent)) found.add(up);
      }
      return found;
    };
    const parallel = new Set();
    for (let i = 0; i < steps.length; i += 1) {
      for (let j = i + 1; j < steps.length; j += 1) {
        const a = steps[i], b = steps[j];
        if (a.role !== b.role || ancestors(a).has(b.id) || ancestors(b).has(a.id)) continue;
        parallel.add(a.id); parallel.add(b.id);
      }
    }
    return parallel;
  }

  function ensureThread(group, role, task, step, parallel) {
    const id = parallel ? stepThreadId(group, role, task.id, step.id) : taskThreadId(group, role, task.id);
    let s = D.sessions.find((session) => session.id === id);
    // A record saved before this split stays the task's conversation, but a parallel branch must never attach
    // to another branch's conversation just because both carry the same task id.
    if (!s && !parallel) s = D.sessions.find((session) => session.agentThread && /^A:[^:]+:[^:]+$/.test(session.id) &&
      session.provider === role && (session.group || session.project) === group &&
      session.items.some((it) => it.t === 'dispatch-step' && it.taskId === task.id));
    if (!s) s = newThread(id, group, role, task, parallel ? step : null);
    const title = titleOf(role, task, parallel ? step : null);
    if (s.title !== title) { s.title = title; s.shortTitle = title; }
    s.order = Date.parse(task.createdAt || '') || s.order || Date.now();
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
    const parallel = parallelSteps(task);
    for (const step of task.steps || []) {
      if (!ROLES.has(step.role)) continue;
      const s = ensureThread(project, step.role, task, step, parallel.has(step.id));
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
      // Every step in this conversation shows its own execution log, like a conversation the person started
      // themselves: running steps refresh, finished steps are loaded once if they have no record yet.
      const wanted = [...steps.filter((it) => it.snap.state === 'running' || it.activityState === 'running'),
        ...steps.filter((it) => !it.activity)];
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

  async function open(project, role, taskId, stepId) {
    if (!ROLES.has(role)) return;
    // Where this exact step lives: its own conversation when it is a parallel branch, otherwise the task's.
    let s = taskId && stepId
      ? D.sessions.find((session) => session.agentThread && session.items.some((it) => it.t === 'dispatch-step' && it.taskId === taskId && it.stepId === stepId))
      : null;
    if (!s && taskId) {
      s = D.sessions.find((session) => session.agentThread && session.provider === role && (session.group || session.project) === project &&
        session.items.some((it) => it.t === 'dispatch-step' && it.taskId === taskId));
    }
    if (!s && taskId) s = ensureThread(project, role, { id: taskId, createdAt: new Date().toISOString() },
      { id: stepId || '任务' }, Boolean(stepId));
    if (!s) s = D.sessions.find((session) => session.agentThread && session.provider === role && (session.group || session.project) === project);
    if (!s) return;
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

  function itemHtml(it, index) {
    if (it.t !== 'dispatch-step') return null;
    const s = D.sessions.find((session) => session.id === A.state.active);
    const snap = it.snap || {};
    const name = P.names[s?.provider] || '';
    const what = [capabilities[snap.capability] || (snap.write ? '修改' : ''), snap.model].filter(Boolean).join(' · ');
    const state = stepStates[snap.state] || snap.state || '排队';
    const patches = snap.write && snap.detail === 'patches_ready' && !it.applied;
    const running = snap.state === 'running';
    const work = window.__activity?.html(it.activity, { key: it.taskId + ':' + it.stepId, open: s?.actOpen, running }) || '';
    // The lead's assignment stays visible; the long details (tool activity, output, verdict, files, logs) fold
    // behind one button. Every member's conversation uses this same renderer, so the fold behaves the same for
    // Codex, Grok, Antigravity and the rest.
    const details = [work,
      snap.error ? `<p class="err-note">${esc(P.errors[snap.error] || snap.error)}</p>` : '',
      snap.output && !window.__activity?.hasReply(it.activity) ? `<pre class="dispatch-output">${esc(snap.output)}</pre>` : '',
      snap.verdict ? `<p class="dispatch-verdict">结论：${esc(snap.verdict)}</p>` : '',
      snap.files ? `<p class="dispatch-files">涉及 ${snap.files} 个文件</p>` : '',
      it.applied ? '<p class="dispatch-files">已写入本机。</p>' : '',
      it.preview !== undefined ? `<pre class="dispatch-output">${esc(it.preview || '没有改动')}</pre>` : '',
      it.log !== undefined ? `<pre class="dispatch-output">${esc(it.log || '暂无日志')}</pre>` : ''].join('');
    // A running step shows its live log by default, like the person's own conversations; the button folds it.
    const open = it.open === true || (it.open !== false && running);
    const hasDetails = Boolean(details);
    return `<div class="dispatch-step${open ? ' open' : ''}" data-state="${esc(snap.state || 'queued')}" data-dispatch="${esc(it.taskId + ':' + (s?.provider || ''))}">
      <header><span class="dispatch-from">组长派遣</span><span class="mono">#${esc(snap.label || it.taskId.slice(0, 8))}</span>
        ${what ? `<span>${esc(what)}</span>` : ''}<span class="dispatch-state">${esc(state)}</span>
        ${hasDetails ? `<button class="btn dispatch-toggle" type="button" data-dispatch-toggle="${index}" aria-expanded="${open}">${open ? '收起详情' : '展开详情'}</button>` : ''}</header>
      ${snap.brief ? `<div class="dispatch-brief"><strong>任务</strong><p>${esc(snap.brief)}</p></div>` : ''}
      ${!open && running ? `<p class="dispatch-wait">${esc(name)} 正在处理…</p>` : ''}
      ${open ? `<div class="dispatch-detail">${details}</div>` : ''}
      <div class="task-actions">
        <button class="btn" type="button" data-dispatch-action="log" data-dispatch-index="${index}">原始日志</button>
        ${patches ? `<button class="btn" type="button" data-dispatch-action="diff" data-dispatch-index="${index}">查看补丁</button>` : ''}
        ${patches && it.preview !== undefined ? `<button class="btn primary" type="button" data-dispatch-action="apply" data-dispatch-index="${index}">确认并应用到本机</button>` : ''}
        <button class="btn" type="button" data-dispatch-action="group" data-dispatch-index="${index}">回到群聊任务</button>
      </div>
    </div>`;
  }

  $('#timeline').addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-dispatch-toggle]');
    if (toggle) {
      const s = D.sessions.find((session) => session.id === A.state.active);
      const item = s?.items[Number(toggle.dataset.dispatchToggle)];
      if (!s?.agentThread || item?.t !== 'dispatch-step') return;
      item.open = !item.open;
      persist();
      A.renderAll();
      return;
    }
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
    $('#input').disabled = dispatched;
    $('#sendBtn').disabled = dispatched;
    $('.composer[data-direct]')?.classList.toggle('composer-locked', dispatched);
    if (dispatched) {
      $('#threadBannerText').textContent = `组长在群聊派给 ${P.names[s.provider]} 的工作记录，只读。`;
      $('#threadBannerNew').textContent = `新建 ${P.names[s.provider]} 单聊`;
      $('#input').placeholder = `这里不能直接发消息。要追加要求，回群聊 @${P.names[s.provider]}，或新建单聊。`;
    }
  };
  const previousSend = P.send;
  P.send = (s, fromButton) => s?.agentThread ? A.toast('组长派遣的记录是只读的；请回群聊或新建单聊。') : previousSend(s, fromButton);
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
