// Project lanes, after Lancer's "工作树 · 泳道" (raylee-ai/lancer, MIT; lancer-process/process-glyph.tsx for the
// event glyphs). Each task line is a vertical lane: a group task with its members one after another, or a single
// chat with its turns. Events of every lane are interleaved by time; one row each, so a node's height tells when
// it happened relative to the other lanes. A lane still running ends in a dashed "waiting" tail.
//
// model(...) turns AgentDesk records into lanes and events; tree(...) draws the lane tree; list(...) draws the
// interleaved event list; pipeline(...) draws each lane's chain of members. Plain HTML and one SVG for the lines.
(() => {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const time = (value) => (typeof value === 'number' ? value : Date.parse(value || '')) || 0;
  const PALETTE = ['#3f7be0', '#8b5cf6', '#1f9d6b', '#e0526a', '#d08a1f', '#2a9bb5'];
  const short = (text, n = 6) => { const t = String(text || '').replace(/\s+/g, ''); return t.length > n ? t.slice(0, n) : t; };
  const capability = { plan: '规划', triage: '诊断', scout: '侦察', implement: '改代码', review: '审查', research: '查资料', accept: '验收' };

  // Event kinds and their legend text (Lancer's vocabulary).
  const KINDS = {
    start: '开始', commit: '提交/保存', handoff: '交接', checkpoint: '检查点', test: '测试', review: '审查通过',
    fork: '分叉', merge: '合并', artifact: '产物', switch: '改派/换模型', wait: '等你', error: '错误', retry: '重排/重试',
  };

  function glyph(event) {
    switch (event.kind) {
      case 'test': return `<span class="lg lg-test${event.fail ? ' fail' : ''}">${event.fail ? '✕' : '✓'}</span>`;
      case 'review': return `<span class="lg lg-review${event.fail ? ' fail' : ''}"><svg viewBox="0 0 13 14"><path d="M6.5 1 L12 3 V7 C12 10 9.5 12.3 6.5 13 C3.5 12.3 1 10 1 7 V3 Z"/><path class="tick" d="M4 7 L6 9 L9.3 5.2"/></svg></span>`;
      case 'error': return '<span class="lg lg-error">!</span>';
      case 'retry': return '<span class="lg lg-retry">↻</span>';
      case 'wait': return `<span class="lg lg-wait${event.done ? ' ok' : ''}">${event.done ? '✓' : ''}</span>`;
      case 'merge': return '<span class="lg lg-merge"></span>';
      case 'handoff': return '<span class="lg lg-handoff"></span>';
      case 'artifact': return '<span class="lg lg-artifact"></span>';
      case 'checkpoint': return '<span class="lg lg-checkpoint"></span>';
      case 'switch': return '<span class="lg lg-switch">⇄</span>';
      case 'start': return '<span class="lg lg-start"></span>';
      default: return '<span class="lg lg-commit"></span>';
    }
  }

  // ---------- model ----------
  // tasks: [{ task, groupName }]; sessions: single chats; memberName(role); colour(role).
  function model({ tasks = [], sessions = [], memberName, colour, limit = 6 }) {
    const lanes = [];
    for (const { task, groupName } of tasks) lanes.push(taskLane(task, groupName, memberName, colour));
    for (const s of sessions) lanes.push(chatLane(s, memberName, colour));
    const active = (lane) => lane.running ? 2 : lane.waiting ? 1 : 0;
    lanes.sort((a, b) => active(b) - active(a) || b.last - a.last);
    // Like Lancer, every task line has its own colour (blue, purple, green, red…), so the lanes, the list tags and
    // the lights stay apart even when the same member works on several lines.
    const shown = lanes.filter((lane) => lane.events.length).slice(0, limit);
    shown.forEach((lane, i) => { lane.colour = PALETTE[i % PALETTE.length]; });
    return shown;
  }

  function taskLane(task, groupName, memberName, colour) {
    const steps = task.steps || [];
    // Diagnosis steps are the lead's internal triage, not work in the plan; their outcome already appears on the
    // failed step and in the group chat, so counting them here makes the lane look far longer than the work.
    const workSteps = steps.filter((step) => step.state !== 'skipped' && step.capability !== 'triage');
    const role = (step) => step?.role || 'lead';
    const events = [];
    const add = (event) => events.push({ lane: task.id, ...event });
    let previousRole = 'claude';
    const t0 = time(task.createdAt) || time(task.time) || 0;
    (task.events || []).forEach((event, index) => {
      const detail = String(event.detail || '');
      const at = time(event.time) || t0 + index;
      const step = steps.find((s) => s.id === event.stepId) || steps.find((s) => detail.startsWith(s.id + ':'));
      if (step?.capability === 'triage') return;
      const who = event.role || step?.role || 'claude';
      const what = capability[step?.capability] || '';
      let m;
      if (detail === 'planning_started') add({ at, kind: 'start', role: 'claude', label: '组长规划' });
      else if (detail === 'plan_ready') add({ at, kind: 'checkpoint', role: 'claude', label: '方案确定', sub: steps.length + ' 步' });
      else if (step && detail === step.id + ':started') {
        if (who !== previousRole) add({ at, kind: 'handoff', role: who, label: '交接 → ' + memberName(who), sub: [what, step.model].filter(Boolean).join(' · '), step: step.id });
        previousRole = who;
      } else if (step && detail === step.id + ':completed') {
        add({ at, kind: step.capability === 'review' ? 'review' : 'commit', role: who, label: (step.capability === 'review' ? '审查 · ' : '完成 · ') + (what || '步骤'), sub: memberName(who), step: step.id, flight: true, fail: step.verdict?.verdict && !['pass', 'accept'].includes(step.verdict.verdict) });
        if (step.paths?.length) add({ at: at + 0.1, kind: 'artifact', role: who, label: '产物 · ' + step.paths.length + ' 个文件', sub: step.paths[0] });
      } else if (step && detail === step.id + ':failed') add({ at, kind: 'error', role: who, label: (what || '步骤') + '失败', sub: String(step.error || '').slice(0, 40), fail: true });
      else if (step && (m = /^[\w-]+:continuing:(\d+)\/(\d+)$/.exec(detail))) add({ at, kind: 'retry', role: who, label: `续跑 ${m[1]}/${m[2]}`, sub: (what || '步骤') + ' · CLI 输出时限', step: step.id });
      else if ((m = /^test_failed:(\d+)$/.exec(detail))) add({ at, kind: 'test', role: 'local', label: '测试失败 #' + m[1], fail: true });
      else if ((m = /^reassign_started:([\w-]+):(\d+)\/(\d+)$/.exec(detail))) add({ at, kind: 'retry', role: 'claude', label: `组长诊断 ${m[2]}/${m[3]}`, sub: m[1] });
      else if (detail === 'triage_started') add({ at, kind: 'retry', role: 'claude', label: '交给组长诊断' });
      else if ((m = /:reassigned(?:_by_lead)?:(\w+)(?:\/[^>]*)?->(\w+)/.exec(detail))) add({ at, kind: 'switch', role: m[2], label: '改派 → ' + memberName(m[2]), sub: memberName(m[1]) + ' 让出' });
      else if ((m = /^acceptance_verdict:(\w+)$/.exec(detail))) add({ at, kind: 'checkpoint', role: 'claude', label: ['accept', 'pass'].includes(m[1]) ? '验收通过' : m[1] === 'accept_with_risk' ? '带风险通过' : '验收要求返工', fail: !['accept', 'pass', 'accept_with_risk'].includes(m[1]) });
      else if (detail === 'patch_started') add({ at, kind: 'merge', role: 'local', label: '应用到本机' });
      else if (detail.startsWith('budget_exceeded')) add({ at, kind: 'error', role: 'claude', label: '预算用完', fail: true });
    });
    // Steps the event log does not cover (older orchestrators, example data): one node per step.
    for (const step of steps) {
      if (events.some((e) => e.step === step.id)) continue;
      const who = role(step);
      if (who !== previousRole && step.state !== 'queued') { add({ at: t0 + events.length + 1, kind: 'handoff', role: who, label: '交接 → ' + memberName(who), sub: capability[step.capability] || '', step: step.id }); previousRole = who; }
      if (step.state === 'completed') add({ at: t0 + events.length + 2, kind: step.capability === 'review' ? 'review' : 'commit', role: who, label: '完成 · ' + (capability[step.capability] || '步骤'), sub: memberName(who), step: step.id, flight: true });
      if (step.state === 'failed') add({ at: t0 + events.length + 2, kind: 'error', role: who, label: '失败', fail: true });
    }
    if (task.testResult && task.testResult.code === 0) add({ at: (events.at(-1)?.at || t0) + 0.2, kind: 'test', role: 'local', label: '本机测试通过' });
    const waiting = ['awaiting_details', 'awaiting_approval', 'needs_review'].includes(task.state);
    if (waiting) add({ at: (events.at(-1)?.at || t0) + 0.3, kind: 'wait', role: 'you', label: task.state === 'needs_review' ? '等你审核' : '等你确认', sub: task.detail || '' });
    if (task.state === 'completed' && !events.some((e) => e.kind === 'merge')) add({ at: (events.at(-1)?.at || t0) + 0.4, kind: 'checkpoint', role: 'claude', label: '完成' });
    if (!events.length) add({ at: t0, kind: 'start', role: 'claude', label: '已提交' });
    const running = ['planning', 'running', 'applying', 'testing', 'triaging', 'awaiting_acceptance', 'queued'].includes(task.state);
    // While the lead diagnoses, the active member is the lead, not the member whose step failed.
    const triaging = task.state === 'triaging';
    const waitingTriage = triaging && String(task.detail || '').startsWith('triage_unavailable');
    const shown = (state) => endedState(task.state, state);
    const current = triaging ? { role: 'claude', state: 'running' }
      : [...workSteps].reverse().find((s) => shown(s.state) === 'running') || [...workSteps].reverse().find((s) => !['queued', 'skipped'].includes(shown(s.state)));
    const done = workSteps.filter((s) => s.state === 'completed').length;
    const chain = [];
    for (const step of workSteps) {
      const r = role(step);
      const state = shown(step.state);
      if (chain.at(-1)?.role === r) { chain.at(-1).state = state === 'running' ? 'running' : chain.at(-1).state === 'running' ? 'running' : state; continue; }
      chain.push({ role: r, state });
    }
    if (triaging && chain.at(-1)?.role !== 'claude') chain.push({ role: 'claude', state: 'running' });
    if (waiting) chain.push({ role: 'you', state: 'running' });
    return {
      id: task.id, kind: 'task', name: groupName, title: String(task.prompt || '任务').slice(0, 40), tag: short(task.prompt || groupName),
      colour: colour(role(current) === 'claude' ? 'lead' : role(current)), current: role(current) === 'claude' ? 'lead' : role(current),
      progress: workSteps.length ? done / workSteps.length : 0, progressText: workSteps.length ? `${done}/${workSteps.length}` : '',
      status: triaging ? '诊断中' : running ? '进行中' : waiting ? '等你' : task.state === 'completed' ? '完成' : task.state === 'failed' ? '失败' : task.state || '',
      running, waiting, chain, events, last: events.at(-1)?.at || t0,
      tail: triaging ? (waitingTriage ? '等组长诊断' : '组长诊断中') : running ? '等待 ' + memberName(role(current)) : waiting ? '等你' : '',
    };
  }

  function chatLane(s, memberName, colour) {
    const role = s.provider || s.agent || 'codex';
    const events = [];
    const base = time(s.updatedAt) || 0;
    let turn = 0;
    (s.items || []).forEach((item, i) => {
      const at = base - 1000 + i;
      if (item.t === 'user') { turn += 1; events.push({ lane: s.id, at, kind: turn === 1 ? 'start' : 'commit', role: 'you', label: String(item.text || '').split('\n')[0].slice(0, 22) || '第 ' + turn + ' 轮', sub: '第 ' + turn + ' 轮' }); }
      else if (item.t === 'checkpoint') events.push({ lane: s.id, at, kind: item.state === 'undone' ? 'retry' : 'artifact', role, label: item.state === 'undone' ? '已撤销改动' : '改动 ' + item.files.length + ' 个文件', sub: memberName(role) });
    });
    if (s.worktree) {
      events.unshift({ lane: s.id, at: base - 2000, kind: 'fork', role, label: '分叉 ' + s.worktree.branch, sub: '自 ' + s.worktree.baseBranch });
      if (s.worktree.mergedAt) events.push({ lane: s.id, at: base + 1, kind: 'merge', role, label: '合并 → ' + s.worktree.baseBranch });
    }
    return {
      id: s.id, kind: 'chat', name: '单聊', title: s.title || '单聊', tag: short(s.title || '单聊'), colour: colour(role), current: role,
      progress: s.busy ? 0.5 : 1, progressText: turn ? turn + ' 轮' : '', status: s.busy ? '进行中' : '空闲',
      running: !!s.busy, waiting: false, chain: [{ role, state: s.busy ? 'running' : 'completed' }], events, last: base,
      tail: s.busy ? '等待 ' + memberName(role) : '',
    };
  }

  // ---------- one group chat: lanes are its members/models ----------
  // The swimlane belongs to the group chat that is open. Instead of one column per task (which reads like
  // several conversations), each member that took part in the selected task gets a lane, and every node is a
  // detailed card: step id, capability, exact model, state, duration, files and attempt count. The graph is
  // drawn top-down in execution order; a dashed edge marks a handoff between members.
  const ROLE_ORDER = ['claude', 'codex', 'grok', 'gemini', 'antigravity', 'local', 'you'];
  const STEP_STATE = {
    queued: '排队中', pending: '待开始', proposed: '拟执行', planning: '规划中', running: '运行中',
    applying: '应用中', testing: '验证中', completed: '完成', accepted: '已验收', failed: '失败',
    cancelled: '已取消', replaced: '已改派', awaiting_approval: '待确认', awaiting_details: '待补充',
    awaiting_acceptance: '待验收', needs_review: '待处理', triaging: '诊断中', waiting: '等待',
    stopped: '已中止', skipped: '未执行',
  };
  STEP_STATE.proposed = '待你确认';
  STEP_STATE.waiting_choice = '等你选接手';
  STEP_STATE.waiting_permission = '等你批权限';
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  // A failed step stays on the graph even after the lead handed it to someone else: its error is the record of
  // what went wrong, and the node must stay red instead of fading into a neutral "已改派".
  const failedRecord = (step, state) => state === 'failed' || (state === 'replaced' && Boolean(step.error || step.history?.length));
  // A step still running or queued when the task itself ended was cut off; never draw it as live beside
  // the task's end state.
  const endedState = (taskState, state) => {
    if (!TERMINAL.has(taskState)) return state;
    if (state === 'running') return 'stopped';
    if (['queued', 'pending', 'proposed', 'waiting'].includes(state)) return 'skipped';
    return state;
  };
  const VERDICT = {
    accept: '通过', pass: '通过', accept_with_risk: '带风险通过', rework: '要求返工', reject: '拒绝',
    blocked: '受阻', unknown: '无法判断', limit: '达到上限',
  };
  const span = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  };
  function modelShort(model) {
    const text = String(model || '');
    if (!text) return '';
    let m = /^claude-(sonnet|opus|haiku)-(\d+)-(\d+)$/.exec(text);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3];
    m = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)(?:-(high|xhigh|medium|low))?$/.exec(text);
    if (m) return 'Gemini ' + m[1] + ' ' + m[2][0].toUpperCase() + m[2].slice(1) + (m[3]
      ? ' ' + ({ high: 'H', xhigh: 'XH', medium: 'M', low: 'L' })[m[3]] : '');
    return text.replace(/^gpt-/i, 'GPT-').replace(/-/g, ' ');
  }

  function groupModel(task, { memberName, colour } = {}) {
    if (!task) return null;
    const events = task.events || [];
    const eventTime = (detail) => {
      const found = [...events].reverse().find((event) => String(event.detail || '') === detail);
      return found ? time(found.time) : 0;
    };
    const startOf = (step) => time(step.startedAt) || eventTime(step.id + ':started');
    const endOf = (step) => time(step.endedAt) || eventTime(step.id + ':completed') || eventTime(step.id + ':failed');
    const plan = task.plan?.rounds?.at(-1);
    // A step stopped by a direction change never ran. It stays in the task record, but the lane shows only the
    // work that is actually part of the plan; otherwise the replacement steps look duplicated beside it.
    const allSteps = task.steps || [];
    const runtime = allSteps.filter((step) => step.state !== 'skipped' && step.capability !== 'triage');
    const planned = plan?.steps || [];
    const steps = allSteps.length ? runtime : planned.map((step) => ({ ...step, state: step.state || 'proposed' }));
    const nodes = [];
    const checks = [];
    const add = (node) => nodes.push({ model: '', meta: '', summary: '', fail: false, ...node });
    const planAt = eventTime('plan_ready') || time(task.createdAt) || 0;

    // Plan milestones stay in the lead's lane and always start the graph.
    if (plan || ['planning', 'awaiting_details', 'awaiting_approval'].includes(task.state)) {
      add({ role: 'claude', kind: 'checkpoint', label: '组长规划', at: planAt, model: task.leadModel || '最新 Opus',
        detail: plan ? '第 ' + (plan.revision || task.plan?.approved || 1) + ' 版方案' : '制定方案',
        meta: [plan?.steps?.length ? plan.steps.length + ' 步' : '', task.leadEffort ? '思考 ' + task.leadEffort : ''].filter(Boolean).join(' · '),
        state: task.state === 'planning' ? 'running' : 'completed', summary: String(plan?.summary || '').replace(/\s+/g, ' ') });
    } else {
      add({ role: 'claude', kind: 'start', label: '任务指派', detail: task.provider ? '直接交给 ' + (memberName?.(task.provider) || task.provider) : '直接派给成员',
        state: 'completed', at: planAt });
    }
    if (task.plan?.approved) add({ role: 'claude', kind: 'checkpoint', label: '方案确认',
      detail: '你确认了第 ' + task.plan.approved + ' 版', meta: steps.length + ' 步', state: 'completed', at: planAt + 1 });

    // Steps in execution order: started steps first by start time, queued steps keep the plan's order.
    const ordered = steps.map((step, index) => ({ step, index, at: startOf(step) }))
      .sort((a, b) => (a.at && b.at ? a.at - b.at : a.at ? -1 : b.at ? 1 : a.index - b.index));
    for (const { step } of ordered) {
      const state = endedState(task.state, step.state || 'proposed');
      const cap = capability[step.capability] || '步骤';
      const started = startOf(step), ended = endOf(step);
      const took = started && ended && ended >= started ? span(ended - started) : '';
      const files = Array.isArray(step.paths) ? step.paths.length : 0;
      const tries = step.history?.length || step.reassigns || 0;
      const verdict = step.verdict?.verdict ? VERDICT[step.verdict.verdict] : '';
      const failed = failedRecord(step, state);
      const meta = [state === 'replaced' && failed ? '失败记录' : '', took, files ? files + ' 个文件' : '', tries ? '第 ' + (tries + 1) + ' 次' : '', verdict].filter(Boolean).join(' · ');
      const summary = String(step.error || step.output || step.brief || '').replace(/\s+/g, ' ').trim();
      add({ role: step.role || 'claude', label: cap, stepId: step.id, state, model: step.model || '',
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
        kind: failed ? 'error' : step.capability === 'review' || step.capability === 'accept' ? 'review'
          : step.capability === 'triage' ? 'retry' : state === 'completed' ? 'commit' : 'start',
        meta, summary: summary.slice(0, 220), at: started || ended || 0, fail: failed,
        flight: ['completed', 'accepted'].includes(state) });
    }

    if (task.acceptance && !steps.some((step) => step.capability === 'accept' && step.state === 'completed')) {
      const verdict = task.acceptance.verdict;
      const ok = ['accept', 'pass', 'accept_with_risk'].includes(verdict);
      add({ role: 'claude', kind: 'review', label: '验收', stepId: 'accept', model: steps.find((step) => step.capability === 'accept')?.model || '',
        state: ok ? 'completed' : 'failed', fail: !ok, meta: VERDICT[verdict] || '', at: 0,
        summary: String(task.acceptance.summary || '').replace(/\s+/g, ' ').slice(0, 220) });
    }
    if (task.testResult) {
      // A local test is not one of the models in the group; keep it out of the model lanes and show it as a
      // check under the graph instead of taking a whole column.
      const ok = task.testResult.code === 0;
      checks.push({ kind: 'test', label: '本机测试', detail: ok ? '自动验证通过' : '自动验证失败', state: ok ? 'completed' : 'failed',
        fail: !ok, summary: String(task.testResult.output || '').replace(/\s+/g, ' ').slice(0, 220) });
    }
    const waiting = {
      awaiting_details: ['you', '等你补充'],
      awaiting_approval: ['you', '等你确认方案'],
      needs_review: ['you', '等你审核'],
      awaiting_acceptance: ['claude', '等待验收'],
    }[task.state];
    if (waiting) add({ role: waiting[0], kind: 'wait', label: waiting[1], detail: task.detail || '', state: 'waiting' });
    if (task.state === 'triaging' && !nodes.some((node) => node.role === 'claude' && node.state === 'running')) {
      add({ role: 'claude', kind: 'retry', label: '组长诊断', detail: task.detail || '正在诊断失败原因', state: 'running' });
    }

    const rank = (role) => { const index = ROLE_ORDER.indexOf(role); return index < 0 ? ROLE_ORDER.length : index; };
    const roles = [...new Set(nodes.map((node) => node.role))].sort((a, b) => rank(a) - rank(b));
    const lanes = roles.map((role) => {
      const mine = nodes.filter((node) => node.role === role);
      const models = [...new Set(mine.map((node) => node.model).filter(Boolean))];
      const done = mine.filter((node) => ['completed', 'accepted'].includes(node.state)).length;
      const failed = mine.some((node) => node.fail);
      const running = mine.some((node) => node.state === 'running' || node.state === 'waiting');
      return {
        id: role, role, name: memberName?.(role) || role, colour: colour?.(role) || 'var(--accent)',
        models, model: models[0] || '', done, count: mine.length, running, failed,
        status: failed ? '有失败' : running ? (role === 'you' ? '等你' : '执行中')
          : done === mine.length ? '完成' : TERMINAL.has(task.state) ? '已结束' : '排队',
      };
    });
    return { task, lanes, nodes, checks };
  }

  // ---------- drawing ----------
  const ROW = 34;
  function tree(lanes, { memberName, avatar, focus } = {}) {
    if (!lanes.length) return '<div class="empty-note">还没有可显示的任务线。</div>';
    // One row per event across all lanes, in time order.
    const all = lanes.flatMap((lane, column) => lane.events.map((event) => ({ ...event, column })))
      .sort((a, b) => a.at - b.at);
    all.forEach((event, row) => { event.row = row; });
    const columns = lanes.length;
    const height = (all.length + 1) * ROW + (lanes.some((l) => l.tail) ? ROW : 0);
    const x = (column) => `calc(${(column + 0.5) * 100 / columns}% )`;
    const lines = lanes.map((lane, column) => {
      const mine = all.filter((e) => e.column === column);
      if (!mine.length) return '';
      const top = mine[0].row * ROW + ROW / 2 + 10;
      const bottom = mine.at(-1).row * ROW + ROW / 2 + 10;
      const left = (column + 0.5) * 100 / columns;
      return `<div class="lt-line" style="left:${left}%;top:${top}px;height:${Math.max(0, bottom - top)}px;--lane:${lane.colour}"></div>` +
        (lane.tail ? `<div class="lt-line tail" style="left:${left}%;top:${bottom}px;height:${height - bottom - 10}px;--lane:${lane.colour}"></div>
          <div class="lt-node" style="left:${left}%;top:${height - 22}px;--lane:${lane.colour}"><span class="lg lg-wait pending"></span><span class="lt-text"><b>${esc(lane.tail)}</b></span></div>` : '');
    }).join('');
    const nodes = all.map((event) => {
      const lane = lanes[event.column];
      const left = (event.column + 0.5) * 100 / columns;
      const flight = event.flight && event.step ? ` data-flight-to="${esc(event.lane + ':' + event.step)}"` : '';
      return `<div class="lt-node${event.fail ? ' fail' : ''}${focus && focus === event.lane ? ' focus' : ''}" data-lane-event="${esc(event.lane + ':' + event.row)}"${flight}
        style="left:${left}%;top:${event.row * ROW + 10}px;--lane:${lane.colour}" title="${esc(event.label + (event.sub ? ' · ' + event.sub : ''))}">
        ${glyph(event)}<span class="lt-text"><b>${esc(event.label)}</b><small>${esc(event.sub || memberName?.(event.role) || '')}</small></span></div>`;
    }).join('');
    const heads = lanes.map((lane) => `<button type="button" class="lt-head" data-lane-open="${esc(lane.id)}" data-lane-kind="${lane.kind}" style="--lane:${lane.colour}" title="${esc(lane.title)}">
      <span class="lt-name"><i></i>${esc(lane.tag)}</span>
      <span class="lt-who">${avatar ? avatar(lane.current) : ''}${esc(memberName?.(lane.current) || '')}</span>
      <span class="lt-bar"><i style="width:${Math.round(lane.progress * 100)}%"></i></span>
      <small>${esc([lane.progressText, lane.status].filter(Boolean).join(' · '))}</small></button>`).join('');
    const used = new Set(all.map((e) => e.kind));
    const legend = Object.entries(KINDS).filter(([kind]) => used.has(kind) || ['commit', 'handoff', 'test', 'merge', 'wait', 'error'].includes(kind))
      .map(([kind, text]) => `<span>${glyph({ kind })}${text}</span>`).join('');
    return `<div class="lane-tree" style="--columns:${columns}">
      <div class="lt-heads">${heads}</div>
      <div class="lt-body" style="height:${height}px">${lines}${nodes}</div>
      <div class="lt-legend"><b>图例 · 轨迹事件</b>${legend}</div></div>`;
  }

  function groupTree(model, { avatar, focus, width = 420 } = {}) {
    if (!model) return '<div class="empty-note">这个群聊还没有任务；发出任务后，这里会按成员和模型显示节点。</div>';
    const { task, lanes, nodes, checks = [] } = model;
    if (!lanes.length || !nodes.length) return '<div class="empty-note">这个任务还没有可显示的步骤。</div>';
    const columns = lanes.length;
    const inner = Math.max(280, Math.floor(width) - 22);
    // Fit the members side by side in the panel instead of cutting the last one off; very many members still
    // scroll horizontally, but four (lead plus three models) fit at the usual panel width.
    const col = Math.max(84, Math.floor(inner / columns));
    const content = col * columns;
    const ROW = 114, NODE_H = 94, PAD = 10;
    const height = PAD * 2 + nodes.length * ROW - (ROW - NODE_H);
    const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
    const laneOf = (role) => lanes[laneIndex.get(role) ?? 0];
    // Each lane has a spine near its left edge, like a branch line in Lancer's lane tree; a node's dot sits on
    // the spine at the card's middle, and the card hangs to the right of it.
    const SPINE = 13, CARD = 24;
    const spine = (role) => (laneIndex.get(role) ?? 0) * col + SPINE;
    const middle = (index) => PAD + index * ROW + NODE_H / 2;

    const bands = lanes.map((lane, index) =>
      `<i class="sg-band" style="left:${index * col}px;width:${col}px;--lane:${lane.colour}"></i>`).join('');
    const active = (node) => ['running', 'waiting'].includes(node.state);
    const pending = (node) => ['queued', 'proposed', 'running', 'waiting'].includes(node.state);
    // Spines: a solid segment joins the steps that have already started; a segment leading to a step that has
    // not started yet (queued/proposed) stays dashed, like the planned part of a lane. While the lane still has
    // work to do, a dashed tail runs on past its last node.
    const notStarted = (node) => ['queued', 'proposed', 'pending'].includes(node.state);
    const spines = lanes.map((lane) => {
      const mine = nodes.map((node, index) => ({ node, index })).filter(({ node }) => laneOf(node.role) === lane);
      if (!mine.length) return '';
      const x = spine(mine[0].node.role);
      let out = '';
      for (let i = 0; i < mine.length - 1; i += 1) {
        const top = middle(mine[i].index), bottom = middle(mine[i + 1].index);
        out += `<line class="sg-spine${notStarted(mine[i + 1].node) ? ' later' : ''}" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" style="--lane:${lane.colour}"/>`;
      }
      const bottom = middle(mine.at(-1).index);
      const tail = mine.some(({ node }) => pending(node));
      return out + (tail ? `<line class="sg-spine tail" x1="${x}" y1="${bottom}" x2="${x}" y2="${height - 4}" style="--lane:${lane.colour}"/>` : '');
    }).join('');
    // Handoffs between members: a curve from the previous node's dot to the next one's; it flows while the
    // receiving step is at work, and is solid once that step has finished.
    // Lines follow the plan's dependencies, so steps that run in parallel fan out from what they share and are
    // never joined to each other. A step with no dependency starts from the lead's last planning node; a node
    // that is not a planned step (acceptance, waiting for you) follows the node before it.
    const byStep = new Map(nodes.map((node, index) => [node.stepId, index]).filter(([id]) => id));
    const lastLead = (before) => { for (let i = before - 1; i >= 0; i -= 1) if (!nodes[i].stepId) return i; return before - 1; };
    const parents = (node, index) => {
      if (!node.stepId || !node.dependsOn) return index ? [index - 1] : [];
      const found = node.dependsOn.map((id) => byStep.get(id)).filter((at) => at !== undefined && at < index);
      if (found.length) return found;
      return node.dependsOn.length ? [] : [lastLead(index)].filter((at) => at >= 0);
    };
    const edges = nodes.map((node, index) => parents(node, index).map((from) => {
      const previous = nodes[from];
      if (laneOf(previous.role) === laneOf(node.role)) return '';
      const x1 = spine(previous.role), y1 = middle(from);
      const x2 = spine(node.role), y2 = middle(index);
      const lane = laneOf(node.role);
      const bend = Math.max(30, Math.abs(y2 - y1) * 0.55);
      return `<path class="sg-edge handoff${active(node) ? ' live' : ''}${pending(node) && !active(node) ? ' later' : ''}"
        d="M${x1} ${y1} C${x1} ${y1 + bend},${x2} ${y2 - bend},${x2} ${y2}" style="--lane:${lane.colour}"/>`;
    }).join('')).join('');
    // The node dots on the spines.
    const dots = nodes.map((node, index) => {
      const lane = laneOf(node.role);
      return `<circle class="sg-dot" data-state="${esc(node.state || '')}" data-fail="${node.fail ? 'true' : 'false'}" cx="${spine(node.role)}" cy="${middle(index)}" r="5" style="--lane:${lane.colour}"/>`;
    }).join('');
    const heads = lanes.map((lane, index) => {
      const modelText = lane.models.length > 1 ? lane.models.length + ' 个模型' : modelShort(lane.model) || '—';
      return `<div class="sg-head" style="left:${index * col + 4}px;width:${col - 8}px;--lane:${lane.colour}"
        title="${esc([lane.name, ...lane.models].join('\n'))}">
        <span class="sg-head-name">${avatar ? avatar(lane.role) : ''}<b>${esc(lane.name)}</b></span>
        <span class="sg-head-model" title="${esc(lane.models.join(', '))}">${esc(modelText)}</span>
        <span class="sg-head-meta"><i>${lane.done}/${lane.count}</i>${esc(lane.status)}</span></div>`;
    }).join('');
    const cards = nodes.map((node, index) => {
      const lane = laneOf(node.role);
      const detail = node.stepId
        ? [node.label, node.model ? modelShort(node.model) : ''].filter(Boolean).join(' · ')
        : node.detail || '';
      const meta = [STEP_STATE[node.state] || '', node.meta || ''].filter(Boolean).join(' · ');
      // Do not repeat the short detail; the note is the part that makes a node worth opening.
      const note = node.summary && node.summary !== detail ? node.summary : '';
      const title = [
        node.stepId ? node.stepId + ' · ' + node.label : node.label,
        node.model, '状态：' + (STEP_STATE[node.state] || node.state || ''), node.meta, node.summary,
      ].filter(Boolean).join('\n');
      const flight = node.stepId && ['completed', 'accepted'].includes(node.state)
        ? ` data-flight-to="${esc(task.id + ':' + node.stepId)}"` : '';
      // The step key lets a click on this node land on that step's own message in the group chat, not just
      // on the task as a whole.
      const stepKey = node.stepId ? ` data-lane-step="${esc(task.id + ':' + node.stepId)}"` : '';
      return `<button type="button" class="sg-node${node.fail ? ' fail' : ''}${focus === task.id ? ' focus' : ''}"
        data-lane-event="${esc(task.id + ':' + index)}"${stepKey} data-state="${esc(node.state || '')}"${flight}
        style="left:${(laneIndex.get(node.role) ?? 0) * col + CARD}px;top:${PAD + index * ROW}px;width:${col - CARD - 5}px;--lane:${lane.colour}"
        title="${esc(title)}">
        <span class="sg-node-top">${glyph({ kind: node.kind, fail: node.fail, done: node.state === 'completed' })}
          <b>${esc(node.stepId || node.label)}</b><i class="sg-state"></i></span>
        <span class="sg-node-detail">${esc(detail)}</span>
        <span class="sg-node-meta">${esc(meta)}</span>
        ${note ? `<span class="sg-node-note">${esc(note)}</span>` : ''}
        ${node.stepId && node.role !== 'claude' && ['queued', 'proposed', 'waiting_choice'].includes(node.state) ? `<span class="sg-adjust" role="button" tabindex="0" data-step-adjust="${esc(task.id + ':' + node.stepId)}" title="换成别的成员、模型或思考程度">换模型</span>` : ''}</button>`;
    }).join('');
    const prompt = String(task.prompt || '任务').replace(/\s+/g, ' ');
    const taskHead = `<div class="sg-task" data-flight-task="${esc(task.id)}">
      <span class="sg-task-state" data-state="${esc(task.state || '')}">${esc(STEP_STATE[task.state] || task.state || '')}</span>
      <p class="sg-task-prompt" title="${esc(prompt)}">${esc(prompt)}</p>
      <small>${esc(task.id.slice(0, 8))} · ${lanes.length} 个成员/模型 · ${nodes.length} 个节点 · 点节点定位对话</small></div>`;
    const checkRow = checks.length ? `<div class="sg-checks">${checks.map((check) =>
      `<span class="sg-check${check.fail ? ' fail' : ''}" title="${esc([check.label, check.detail, check.summary].filter(Boolean).join('\n'))}">
        <i class="sg-state" data-state="${esc(check.state || '')}"></i><b>${esc(check.label)}</b>
        <span>${esc(check.detail || '')}${check.summary ? ' · ' + esc(check.summary.slice(0, 60)) : ''}</span></span>`).join('')}</div>` : '';
    const legend = `<div class="sg-legend"><b>节点状态</b>
      <span><i class="sg-state" data-state="completed"></i>完成</span>
      <span><i class="sg-state" data-state="running"></i>运行中</span>
      <span><i class="sg-state" data-state="failed"></i>失败</span>
      <span><i class="sg-state" data-state="queued"></i>排队</span>
      <span><i class="sg-edge-sample"></i>交接</span><span><i class="sg-edge-sample live"></i>正在交接</span></div>`;
    return `<div class="sg">${taskHead}
      <div class="sg-scroll"><div class="sg-canvas" style="width:${content}px">
        <div class="sg-heads" style="width:${content}px;height:64px">${heads}</div>
        <div class="sg-body" style="width:${content}px;height:${height}px">
          ${bands}
          <svg class="sg-edges" width="${content}" height="${height}" style="width:${content}px;height:${height}px" viewBox="0 0 ${content} ${height}" aria-hidden="true">${spines}${edges}${dots}</svg>
          ${cards}
        </div>
      </div></div>${checkRow}${legend}</div>`;
  }

  function list(lanes, { memberName, open } = {}) {
    const all = lanes.flatMap((lane, column) => lane.events.map((event, index) => ({ ...event, laneObj: lane, column, index })))
      .sort((a, b) => a.at - b.at);
    all.forEach((event, row) => { event.row = row; });
    if (!all.length) return '<div class="empty-note">还没有事件。</div>';
    return `<div class="lane-list">${all.map((event) => {
      const key = event.lane + ':' + event.row;
      const from = event.flight && event.step ? ` data-flight-from="${esc(event.lane + ':' + event.step)}"` : '';
      return `<div class="ll-row${open === key ? ' open' : ''}${event.fail ? ' fail' : ''}" data-lane-row="${esc(key)}"${from} style="--lane:${event.laneObj.colour}" role="button" tabindex="0">
        <span class="ll-caret">${open === key ? '▾' : '▸'}</span>${glyph(event)}
        <span class="ll-tag">${esc(event.laneObj.tag)}</span>
        <span class="ll-label">${esc(event.label)}</span><span class="ll-meta">${esc(memberName?.(event.role) || '')}</span></div>
        ${open === key ? `<div class="ll-detail" style="--lane:${event.laneObj.colour}"><p><b>${esc(event.laneObj.title)}</b></p>${event.sub ? `<p>${esc(event.sub)}</p>` : ''}<p class="ll-hint">点击右侧节点也可以定位这一行</p></div>` : ''}`;
    }).join('')}</div>`;
  }

  function pipeline(lanes, { memberName, avatar } = {}) {
    return `<div class="lane-pipeline">${lanes.map((lane) => `<div class="lp-row" data-lane-pipeline="${esc(lane.id)}" style="--lane:${lane.colour}" title="在右侧泳道中聚焦这条任务线"><span class="lp-name" title="${esc(lane.title)}"><i></i>${esc(lane.kind === 'chat' ? '单聊 · ' : '')}${esc(lane.title)}</span>
      ${lane.chain.map((link) => `<span class="lp-chip ${link.state === 'running' ? 'current' : link.state === 'completed' ? 'done' : ''}">${avatar ? avatar(link.role) : ''}${esc(link.role === 'you' ? '你' : memberName?.(link.role) || link.role)}${link.state === 'completed' ? '<em>✓</em>' : ''}</span>`).join('<span class="lp-arrow">→</span>')}</div>`).join('')}</div>`;
  }

  window.AgentDeskLanes = { model, groupModel, tree, groupTree, list, pipeline, KINDS, modelShort };
})();
