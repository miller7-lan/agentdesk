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
  const stepStates = { switched: '已换模型', replaced: '已改派', queued: '排队', waiting: '等待', running: '执行中', completed: '完成', failed: '失败', cancelled: '已停止', skipped: '跳过' };
  const taskTerminal = new Set(['completed', 'failed', 'cancelled']);
  const stepDone = new Set(['completed', 'failed', 'cancelled', 'skipped', 'switched', 'replaced']);
  const MAX_THREADS = 400;   // a safety net; the real limit is ten per group chat (prune)

  // A record belongs to one group chat (s.group) and is listed under that group's project (s.project).
  // One conversation per task and member, so two tasks the same AI works on in parallel stay apart; when one
  // task splits into parallel steps for the same member, each of those steps gets its own conversation too.
  // The same member on a different model is a different conversation (Codex on GPT-5.5 and on GPT-5.4 are two
  // chats), so the model is part of the id.
  const modelKey = (model) => model ? '@' + String(model).replace(/[^\w.-]/g, '_') : '';
  const threadId = (group, role, model) => 'A:' + group + ':' + role + modelKey(model);
  const taskThreadId = (group, role, taskId, model) => threadId(group, role, model) + ':' + taskId;
  const stepThreadId = (group, role, taskId, stepId, model) => taskThreadId(group, role, taskId, model) + ':' + stepId;
  const modelName = (model) => model ? (window.AgentDeskLanes?.modelShort?.(model) || model) : '';
  const projectOf = (group) => G.projectOf ? G.projectOf(group) : group;
  const threads = () => D.sessions.filter((s) => s.agentThread);
  const short = (text, n = 18) => {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    return line.length > n ? line.slice(0, n) + '…' : line;
  };
  function titleOf(role, task, step, model) {
    const name = [P.names[role] || role, modelName(model)].filter(Boolean).join(' ');
    // Put the step first: two parallel branches of the same AI must stay distinguishable in the sidebar.
    if (step) return `${step.id} · ${name}`;
    const prompt = short(task?.prompt);
    return prompt ? `${name} · ${prompt}` : `${name} · 组长派遣`;
  }
  function newThread(id, group, role, task, step, items = [], model) {
    const at = Date.parse(task?.createdAt || '') || items.reduce((last, it) => Math.max(last, it.at || 0), 0) || Date.now();
    const s = { id, project: projectOf(group), group, provider: role, ...(model && { model }), agentThread: true, title: titleOf(role, task, step, model),
      shortTitle: titleOf(role, task, step, model), status: 'idle', time: '刚刚', order: at, openedAt: Date.now(), items, live: true, diffs: [], term: [] };
    // Newer assignments sit above older ones under the group.
    const index = D.sessions.findIndex((other) => other.agentThread && (other.order || 0) < at);
    if (index === -1) D.sessions.push(s); else D.sessions.splice(index, 0, s);
    return s;
  }

  let migrated = false;
  for (const saved of (Array.isArray(store.get('agentThreads', [])) ? store.get('agentThreads', []) : []).slice(0, MAX_THREADS)) {
    if (!saved || typeof saved.project !== 'string' || !ROLES.has(saved.provider) || !A.proj(saved.project) ||
        D.sessions.some((s) => s.id === saved.id) || !Array.isArray(saved.items) || !ROLES.has(saved.provider)) continue;   // old lead threads are dropped
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
    store.set('agentThreads', threads().slice(0, MAX_THREADS).map(({ id, project, group, provider, model, title, shortTitle, order, openedAt, items, taskId, status, time }) =>
      ({ id, project, group, provider, model, title, shortTitle, order, openedAt, taskId, status, time,
        items: items.slice(-80).map(({ preview, log, activity, ...item }) => item) })));
  }
  if (migrated) persist();

  // Steps of one task worked by the same member that do not depend on each other are parallel branches:
  // each gets its own conversation so their logs never mix.
  // Which steps of a task come before a step (its dependencies, transitively): those run one after another and
  // may share a conversation; steps with no such link run side by side and must not.
  function ancestry(task) {
    const byId = new Map((task.steps || []).map((step) => [step.id, step]));
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
    return (a, b) => ancestors(a).has(b.id) || ancestors(b).has(a.id);
  }

  // One conversation per member and exact model, reused for that member's later work in the group (the lead
  // hands Codex on GPT-5.5 another step: it goes into the same Codex GPT-5.5 chat). Only when that conversation
  // is busy with work running at the same time does a second one open (「Codex GPT 5.5 · 2」).
  const ACTIVE = new Set(['queued', 'running', 'proposed', 'waiting']);
  function threadTitle(role, model, n) {
    return [P.names[role] || role, modelName(model)].filter(Boolean).join(' ') + (n > 1 ? ' · ' + n : '');
  }
  function busyFor(s, task, step, related) {
    return s.items.some((it) => it.t === 'dispatch-step' && it.snap && ACTIVE.has(it.snap.state) && !taskTerminal.has(it.snap.taskState) &&
      !(it.taskId === task.id && it.stepId === step.id) &&
      !(it.taskId === task.id && related(step, (task.steps || []).find((other) => other.id === it.stepId) || { id: it.stepId })));
  }
  function ensureThread(group, role, task, step, related = () => false) {
    const model = step?.model || '';
    const mine = threads().filter((s) => (s.group || s.project) === group && s.provider === role && (s.model || '') === model);
    const holding = mine.find((s) => s.items.some((it) => it.t === 'dispatch-step' && it.taskId === task.id && it.stepId === step.id && it.snap?.state !== 'switched'));
    if (holding) return holding;
    const free = mine.filter((s) => !busyFor(s, task, step, related))
      .sort((a, b) => (b.openedAt || b.order || 0) - (a.openedAt || a.order || 0))[0];
    if (free) {
      free.order = Math.max(free.order || 0, Date.parse(task.createdAt || '') || 0);
      return free;
    }
    const base = threadId(group, role, model);
    let n = 1;
    while (D.sessions.some((s) => s.id === (n === 1 ? base : base + '#' + n))) n += 1;
    const s = newThread(n === 1 ? base : base + '#' + n, group, role, task, null, [], model || undefined);
    s.title = s.shortTitle = threadTitle(role, model, n);
    return s;
  }

  // At most ten member conversations per group chat. When there are more, the ones whose work is over and that
  // were opened longest ago go first; a conversation with work going on or waiting for the person, and the one
  // on screen, always stay. The tasks themselves stay on the orchestrator and can be opened again.
  const PER_GROUP = 10;
  function prune(group) {
    const mine = threads().filter((s) => (s.group || s.project) === group);
    if (mine.length <= PER_GROUP) return false;
    const removable = mine.filter((s) => s.id !== A.state.active && !['running', 'waiting'].includes(threadStatus(s)))
      .sort((a, b) => (a.openedAt || a.order || 0) - (b.openedAt || b.order || 0));
    // (a conversation counts as used when it is created or opened, so one made just now is never the first to go)
    let extra = mine.length - PER_GROUP;
    let removed = false;
    for (const s of removable) {
      if (extra <= 0) break;
      D.sessions.splice(D.sessions.indexOf(s), 1);
      extra -= 1;
      removed = true;
    }
    return removed;
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
    const related = ancestry(task);
    for (const step of task.steps || []) {
      if (!ROLES.has(step.role)) continue;
      const s = ensureThread(project, step.role, task, step, related);
      // The same step in another conversation: an earlier model of this member (it was switched, e.g. when stuck)
      // keeps its record with a note; a record from before conversations were split by model moves here.
      for (const other of threads()) {
        if (other === s) continue;
        const index = other.items.findIndex((it) => it.t === 'dispatch-step' && it.taskId === task.id && it.stepId === step.id);
        if (index < 0) continue;
        const old = other.items[index];
        if (other.model && other.model !== step.model) {
          if (old.snap?.state !== 'switched') {
            old.snap = { ...(old.snap || {}), state: 'switched', switchedTo: step.model ? modelName(step.model) : '默认模型', switchedRole: step.role };
            other.status = threadStatus(other);
            touched.add(other);
          }
        } else {
          // the same model under another id (a branch that stopped being parallel, or a record from before the split)
          other.items.splice(index, 1);
          if (!other.items.length) D.sessions.splice(D.sessions.indexOf(other), 1);
          touched.add(s);
        }
      }
      let item = s.items.find((it) => it.t === 'dispatch-step' && it.taskId === task.id && it.stepId === step.id);
      if (!item) {
        item = { t: 'dispatch-step', taskId: task.id, stepId: step.id, at: Date.parse(task.createdAt || '') || Date.now() };
        // Keep the conversation in the order the work was handed out, also when older tasks arrive later.
        const after = s.items.findIndex((it) => it.t === 'dispatch-step' && it.at > item.at);
        if (after === -1) s.items.push(item); else s.items.splice(after, 0, item);
      }
      // A step the lead retired after a failure: point its record at the step that took over, so the old
      // conversation says where the work continued instead of only showing the raw "replaced" state.
      const replacement = (task.steps || []).find((other) => other.id !== step.id && (other.replaces || []).includes(step.id) && other.state !== 'replaced');
      const snap = {
        label: task.id.slice(0, 8), state: step.state, capability: step.capability, model: step.model, write: Boolean(step.write),
        brief: step.brief, output: step.output, error: step.error, files: step.paths?.length || 0,
        verdict: step.verdict?.summary, taskState: task.state, detail: String(task.detail || '').split(':')[0],
        replacedByStep: replacement?.id, replacedByModel: replacement ? modelName(replacement.model) : '',
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
    const pruned = prune(project);
    return touched.size > 0 || pruned;
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
      // A step moved to another model is followed in that model's conversation.
      const steps = s.items.filter((it) => it.t === 'dispatch-step' && it.snap && !['queued', 'skipped', 'switched'].includes(it.snap.state));
      // Every step in this conversation shows its own execution log, like a conversation the person started
      // themselves: running steps refresh, finished steps are loaded once if they have no record yet. A record
      // built from the old 12 KB log fallback is replaced by the server's full one after an orchestrator upgrade.
      const wanted = [...steps.filter((it) => it.snap.state === 'running' || it.activityState === 'running'),
        ...steps.filter((it) => !it.activity || (it.activity.fallback && Date.now() - (it.fallbackChecked || 0) > 30000))];
      for (const it of wanted) if (it.activity?.fallback) it.fallbackChecked = Date.now();
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
    const find = () => (taskId && stepId
      ? D.sessions.find((session) => session.agentThread && session.items.some((it) => it.t === 'dispatch-step' && it.taskId === taskId && it.stepId === stepId && it.snap?.state !== 'switched'))
        || D.sessions.find((session) => session.agentThread && session.items.some((it) => it.t === 'dispatch-step' && it.taskId === taskId && it.stepId === stepId))
      : null) || (taskId ? D.sessions.find((session) => session.agentThread && session.provider === role && (session.group || session.project) === project &&
        session.items.some((it) => it.t === 'dispatch-step' && it.taskId === taskId)) : null);
    let s = find();
    // Not synced yet: read the task first, so the step opens in the conversation it really belongs to (a guess
    // made before reading would open an empty conversation next to the real one).
    let fresh = false;
    if (!s && taskId) {
      try {
        const task = await control(project, 'status', { taskId });
        if (apply(project, task)) persist();
        G.merge(project, task);
        fresh = true;
      } catch { /* fall back to an empty conversation that fills in on the next sync */ }
      s = find();
    }
    if (!s && taskId) s = ensureThread(project, role, { id: taskId, createdAt: new Date().toISOString() }, { id: stepId || '任务' });
    if (!s) s = D.sessions.find((session) => session.agentThread && session.provider === role && (session.group || session.project) === project);
    if (!s) return;
    s.openedAt = Date.now();
    persist();
    A.openSession(s.id);
    if (!taskId) { await sync(); return; }
    if (!fresh) try {
      const task = await control(project, 'status', { taskId });
      if (apply(project, task)) persist();
      G.merge(project, task);
    } catch {
      if (!s.items.some(it => it.taskId === taskId)) A.toast('原派遣记录暂时无法读取。');
    }
    if (A.state.active !== s.id || A.state.group) return;
    A.renderAll();
    // Open on the newest work, not the first step of the task: the person has already seen how it began.
    requestAnimationFrame(() => {
      const timeline = $('#timeline');
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
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
    // Steps still waiting for their turn, or retired before they ever ran, stay out of the conversation;
    // a queued one appears once the member starts. Failure records are kept.
    if (['queued', 'skipped'].includes(snap.state)) return '';
    const name = P.names[s?.provider] || '';
    const what = [capabilities[snap.capability] || (snap.write ? '修改' : ''), modelName(snap.model)].filter(Boolean).join(' · ');
    const state = stepStates[snap.state] || snap.state || '排队';
    // A failed step that was handed to another model keeps its failure visible in the old conversation too.
    const failedRecord = snap.state === 'failed' || (snap.state === 'replaced' && Boolean(snap.error || snap.output));
    const patches = snap.write && snap.detail === 'patches_ready' && !it.applied;
    const running = snap.state === 'running';
    const work = chatWork(it.activity, it.taskId + ':' + it.stepId, s, running);
    const guidance = (snap.guidance || []).map((item) => `<div class="msg-user"><span class="steer-tag">你的指导</span>${esc(item.text)}</div>`).join('');
    // Laid out like the person's own single chats: the lead's assignment and the person's guidance are messages on
    // the right, the member's thinking, commands, files and replies flow below on the left, nothing folded. When
    // the step ends, a note says its result went back to the group.
    const extra = [
      snap.error ? `<p class="err-note">${esc(P.errors[snap.error] || snap.error)}</p>` : '',
      snap.output && !window.__activity?.hasReply(it.activity) ? `<div class="msg-assist"><span class="direct-avatar">${avatars.html(s?.provider || 'codex', { size: 32, still: true })}</span><div class="msg-body">${md(snap.output)}</div></div>` : '',
      snap.verdict ? `<p class="dispatch-verdict">结论：${esc(snap.verdict)}</p>` : '',
      snap.files ? `<p class="dispatch-files">涉及 ${snap.files} 个文件</p>` : '',
      it.applied ? '<p class="dispatch-files">已写入本机。</p>' : '',
      it.preview !== undefined ? `<pre class="dispatch-output">${esc(it.preview || '没有改动')}</pre>` : '',
      it.log !== undefined ? `<pre class="dispatch-output">${esc(it.log || '暂无日志')}</pre>` : ''].join('');
    const handedBack = snap.state === 'completed' ? `${esc(name)} 完成了这一步，结果已交回群聊，组长接着安排。`
      : snap.state === 'failed' ? `这一步没有完成，已交回组长重新安排。`
      : snap.state === 'cancelled' ? '这一步已停止。'
      : snap.state === 'switched' ? `这一步在这个模型上卡住，已换成 ${esc(snap.switchedTo)} 继续，在那个模型的单聊里接着看。`
      : snap.state === 'replaced' ? `这一步没有完成，已改派给 ${esc(snap.replacedByModel || '新的模型')} 接替，在新的单聊里接着看。` : '';
    return `<div class="dispatch-step chat${failedRecord ? ' failed-record' : ''}" data-state="${esc(snap.state || 'queued')}" data-dispatch="${esc(it.taskId + ':' + (s?.provider || ''))}">
      <div class="dispatch-meta"><span class="dispatch-from">组长派遣</span><span class="mono">#${esc(snap.label || it.taskId.slice(0, 8))}</span>
        ${what ? `<span>${esc(what)}</span>` : ''}<span class="dispatch-state">${esc(state)}</span></div>
      ${snap.brief ? `<div class="msg-user dispatch-ask"><span class="steer-tag lead">组长</span>${esc(snap.brief)}</div>` : ''}
      ${guidance}
      ${work}
      ${extra}
      ${handedBack ? `<div class="dispatch-back" data-state="${esc(snap.state)}">${esc(handedBack)}</div>` : ''}
      <div class="task-actions dispatch-actions">
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

  window.__agentThreads = { threadsOf, removeGroup, open, persist, onOpen: (s) => { if (s?.agentThread) s.openedAt = Date.now(); sync(); refreshActivity(); } };
  A.renderSidebar();
})();
