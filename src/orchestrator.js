(async () => {
  const A = window.__desk;
  const { $, $$, esc, svg, state, store, LIVE } = A;
  const avatars = window.AgentDeskAvatars;
  const graph = window.AgentDeskTaskGraph;
  const selectedFlowNodes = new Map();
  const api = window.desk?.orchestrator;
  const enrollment = window.desk?.enrollment;
  const temporary = await enrollment?.required();
  const supported = api && (window.desk.platform === 'darwin' || temporary);
  const liveProject = 'live';
  const isExample = (id) => !A.proj(id)?.live;
  const isLiveGroup = () => state.group === liveProject;
  const members = {
    you: { name: '你', initials: '你', role: '项目成员' },
    lead: { name: '组长', initials: '组', role: '自动规划与协作' },
    codex: { name: 'Codex', initials: 'CX', role: '实现与验证' },
    claude: { name: 'Claude Code', initials: 'CL', role: '审查与执行' },
    grok: { name: 'Grok Build', initials: 'GK', role: '分析与执行' },
    gemini: { name: 'Gemini', initials: 'GM', role: '分析与审查' },
    antigravity: { name: 'Antigravity', initials: 'AG', role: '侦察与简报' },
    local: { name: '本机', role: '工作区与桌面工具' },
  };
  const statuses = {
    queued: '排队中', planning: '规划中', running: '执行中', applying: '应用补丁',
    awaiting_details: '待补充细节', awaiting_approval: '待确认方案', awaiting_acceptance: '待验收', triaging: '升级诊断',
    testing: '验证中', needs_review: '待处理', completed: '已完成', failed: '失败', cancelled: '已取消',
  };
  const terminal = new Set(['needs_review', 'completed', 'failed', 'cancelled']);
  const stages = { executing: '执行', awaiting_acceptance: '待验收', triaging: '升级诊断', reworking: '返工', accepted: '已验收' };
  const acceptanceNames = {
    accept: '通过', pass: '通过', accept_with_risk: '有风险接受', rework: '返工',
    reject: '拒绝', blocked: '受阻', unknown: '无法判断', limit: '达到上限',
  };
  const triageNames = { retry: '重试', rework: '返工', accept_with_risk: '有风险接受', fail: '终止', unknown: '无法判断' };
  const details = {
    patches_ready: '补丁已准备好，等待应用到本机工作区。',
    planning_started: '开始制定计划',
    plan_questions: '组长正在等待你的回答。',
    plan_reply_received: '组长正在根据你的回复调整方案。',
    plan_proposed: '确认方案后开始执行。',
    plan_approved: '方案已确认，等待分派。',
    plan_workspace_changed: '工作区版本已变化，请基于当前版本重新规划。',
    plan_ready: '执行计划已就绪',
    submitted: '任务已进入队列',
    cancelled: '任务已取消',
    cancel_requested: '已请求取消',
    owner_quota_cap: '今日额度上限已到，任务将在本地零点后继续。',
    triage_started: '任务遇到问题，已交给组长诊断。',
    triage_unavailable: '组长暂时不可用，稍后自动继续诊断。',
    triage_retry: '组长要求重试，任务重新排队。',
    triage_rework: '组长要求返工，任务重新排队。',
    triage_limit: '诊断次数已达上限，请人工处理。',
    triage_retry_required: '重试没有可执行的步骤，请人工处理。',
    triage_retry_failed: '重试后的测试仍然失败，等待组长诊断。',
    triage_unparseable: '诊断结果无法解析，请人工处理。',
    triage_pending: '补丁已应用但测试失败，等待组长诊断。',
    rework_after_apply: '补丁已应用，返工不会自动改写已应用的文件。',
    review_conflict: '审查意见冲突，已交给组长判断。',
    acceptance_started: '组长开始验收。',
    acceptance_skipped: '本任务无需额外验收。',
    acceptance_rework: '组长要求返工，任务重新排队。',
    acceptance_unparseable: '验收结论无法解析，等待组长重新判断。',
    acceptance_limit: '验收返工次数已达上限，请人工处理。',
    accepted_with_risk: '组长按风险接受本次结果，补丁仍可人工应用。',
    windows_test_started: '正在本机运行测试。',
    windows_test_failed: '本机测试失败。',
  };
  const routeNames = { ssh: 'SSH 主用', relay: 'VPS 1 Relay 备用' };
  const timeline = $('#groupTimeline');
  const form = $('#groupForm');
  const input = $('#groupInput');
  const provider = $('#groupRecipient');
  const model = $('#groupModel');
  const entry = $('#sbOrchestrator');
  const routeStatus = $('#sbGroupRoute');
  const dialog = $('#orchestratorDialog');
  const routeMessage = $('#orchestratorMessage');
  const composerMessage = $('#groupSendStatus');
  const routeButtons = $$('[data-route]', dialog);
  const filterSelect = $('#groupMemberFilter');
  const suggestions = $('#groupSuggestions');
  const recipients = ['lead', 'codex', 'claude', 'grok', 'gemini', 'antigravity'];
  const mentions = { lead: '组长', codex: 'Codex', claude: 'Claude', grok: 'Grok', gemini: 'Gemini', antigravity: 'Antigravity' };
  // Members that only take work when the orchestrator has them configured.
  const optional = ['gemini', 'antigravity'];
  const availableCommands = { ls: '查看项目任务', stop: '取消指定任务', routes: '查看主控线路', avatars: '查看状态图鉴' };
  let suggestionItems = [];
  let suggestionIndex = 0;
  let filter = 'all';
  let busy = false;
  let connected = false;
  let checking = null;
  let knownRoutes = false;
  let routeState = {};
  let quotas = [];
  let quotaCheck = null;
  let nextQuotaAt = 0;
  let cursor = 0;
  let generation = 0;
  const displayedCounts = new Map();
  let focusMember;
  let previewMember = 'codex';

  const groups = new Map();
  function addGroup(id, tasks = []) {
    if (!A.proj(id) || groups.has(id)) return;
    groups.set(id, {
      id, records: new Map(tasks.map((task) => [task.id, task])), selected: tasks.at(-1)?.id,
      draft: '', provider: '', model: '', taskError: '', statusError: '', pending: null, planReply: null,
    });
  }

  const legacy = store.get('macTask', null) || localStorage.getItem('agentdesk.macTask');
  const saved = LIVE && !temporary ? store.get('groupTasks', legacy ? [{ id: legacy }] : []) : [];
  for (const id of store.get('projectGroups', [])) addGroup(id, id === liveProject ? saved : []);
  if (saved.length) addGroup(liveProject, saved);

  function createGroup(id) {
    addGroup(id);
    if (!groups.has(id)) return false;
    store.set('projectGroups', [...groups.keys()]);
    return true;
  }

  const currentGroup = () => groups.get(state.group);
  const hasGroup = (id) => groups.has(id);
  const getSelected = (group = currentGroup()) => group?.records.get(group.selected);
  const taskCount = (id = state.group) => {
    const records = groups.get(id)?.records;
    return records ? [...records.values()].filter((task) => !terminal.has(task.state) || task.state === 'needs_review').length : 0;
  };

  function switchGroup(id) {
    if (state.group === id) return;
    const previous = currentGroup();
    if (previous) {
      previous.draft = input.value;
      previous.provider = provider.value;
      previous.model = model.value;
    }
    const next = groups.get(id);
    input.value = next?.draft || '';
    provider.value = next?.provider || '';
    model.value = next?.model || '';
    filter = 'all';
    filterSelect.value = '';
    focusMember = null;
    timeline.scrollTop = 0;
    setRecipient(next);
    hideSuggestions();
    updateFilters();
  }

  function persist(group) {
    if (isExample(group.id) || temporary) return;
    store.set('groupTasks', [...group.records.values()].map(({ id, prompt, provider, model, time, state }) =>
      ({ id, prompt, provider, model, time, state })));
  }

  function updateTask(group, id, summary, complete = false) {
    const previous = group.records.get(id) || {};
    const local = complete ? { prompt: previous.prompt, time: previous.time } : previous;
    group.records.set(id, { ...local, ...summary, id });
    persist(group);
  }

  const taskLabel = (task) => '#' + esc(task.id.slice(0, 8));
  const selectedRoute = () => routeState.route?.split(':')[0];
  const hasRoute = () => Boolean(routeState[selectedRoute()]);
  const canUse = (id) => !optional.includes(id) || isExample(state.group) || routeState.providers?.includes(id);
  const canUseGemini = () => canUse('gemini');
  function availability(id) {
    if (canUse(id)) return isExample(state.group) ? '本地示例' : '可派活';
    if (!knownRoutes && supported) return '正在检测';
    return knownRoutes && !connected ? '主控离线' : '主控未配置';
  }
  const memberName = (id) => members[id]?.name || id || members.lead.name;
  const owner = (task) => task.provider || 'lead';
  const waitingForPlan = (task) => ['awaiting_details', 'awaiting_approval'].includes(task.state);
  const statusName = (status) => statuses[status] || '待同步';
  const pill = (status) => `<span class="group-pill" data-status="${statuses[status] ? status : 'unknown'}">${statusName(status)}</span>`;
  function textOf(detail) {
    if (details[detail]) return details[detail];
    const waiting = /:waiting:(\w+)$/.exec(detail || '');
    if (waiting) return `等待 ${memberName(waiting[1])} 空闲：同一时间每个 AI 只跑一个任务，可能有其他成员正在使用。`;
    const executor = /^executor_waiting:(\w+)$/.exec(detail || '');
    if (executor) return `等待 ${memberName(executor[1])} 可用：额度或登录状态恢复后自动继续，不会改派给其他成员。`;
    const moved = /:reassigned:(\w+)->(\w+):(quota|auth)$/.exec(detail || '');
    if (moved) return `${memberName(moved[1])} ${moved[3] === 'quota' ? '额度用尽' : '需要重新登录'}，改由 ${memberName(moved[2])} 接手。`;
    const escalated = /^escalated:(\w+)$/.exec(detail || '');
    if (escalated) return '任务遇到问题，已升级给组长处理。';
    const decision = /^triage_decision:(\w+)$/.exec(detail || '');
    if (decision) return `组长诊断结论：${triageNames[decision[1]] || decision[1]}。`;
    const verdict = /^acceptance_verdict:(\w+)$/.exec(detail || '');
    if (verdict) return `验收结论：${acceptanceNames[verdict[1]] || verdict[1]}。`;
    const fix = /^(fix-\d+):(started|completed|failed)$/.exec(detail || '');
    if (fix) return fix[2] === 'started' ? '返工步骤开始执行。' : fix[2] === 'completed' ? '返工步骤完成，等待重新验收。' : '返工步骤失败。';
    return detail;
  }
  const pathsOf = (task) => [...new Set((task?.steps || []).flatMap((step) => step.paths || []))];
  function elapsed(task) {
    const start = task.events?.find((event) => ['planning', 'running'].includes(event.state));
    if (!start) return '';
    const end = task.events.findLast((event) => terminal.has(event.state));
    const seconds = Math.floor((new Date(end?.time || Date.now()) - new Date(start.time)) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const minutes = Math.floor(seconds / 60);
    return (minutes ? minutes + ' 分 ' : '') + (seconds % 60) + ' 秒';
  }

  const statusAnimation = { planning: 'thinking', awaiting_details: 'asking', awaiting_approval: 'asking',
    awaiting_acceptance: 'asking', triaging: 'thinking',
    applying: 'tool', testing: 'long', needs_review: 'asking', completed: 'done', failed: 'failed' };

  function memberActivity(id) {
    if (id === 'you') return {};
    const tasks = [...currentGroup().records.values()].reverse();
    for (const task of tasks) {
      const step = task.steps?.find((step) => step.role === id && step.state === 'running');
      if (step) return { task, state: task.state === 'testing' ? 'long' : 'tool' };
      if (id === 'local' && ['applying', 'testing', 'needs_review'].includes(task.state)) {
        return { task, state: statusAnimation[task.state] };
      }
      if (id !== (task.plan && !task.plan.approved ? 'lead' : owner(task))) continue;
      if (task.state === 'running') {
        const balls = (task.steps || []).filter((step) => step.state === 'running').map((step) => step.role);
        return { task, state: id === 'lead' ? 'juggling' : 'tool', balls };
      }
      if (task.state !== 'completed' && task.state !== 'failed' && statusAnimation[task.state]) return { task, state: statusAnimation[task.state] };
    }
    const result = tasks.find((task) => owner(task) === id && ['completed', 'failed'].includes(task.state));
    return result ? { task: result, state: statusAnimation[result.state] } : {};
  }

  function memberAvatar(id, size, surface) {
    const { state, balls } = memberActivity(id);
    return avatars.html(id, { size, state, balls, key: surface ? surface + ':' + id : '' });
  }

  function drawRoutes() {
    const selected = selectedRoute();
    for (const button of routeButtons) {
      const route = button.dataset.route;
      button.disabled = busy || !routeState[route] || route === selected;
      button.setAttribute('aria-pressed', String(route === selected));
      button.querySelector('span').textContent = (knownRoutes ? (routeState[route] ? '在线' : '离线') : '检测中') + (route === selected ? ' · 当前' : '');
    }
    entry.querySelector('span').textContent = selected === 'relay' ? '主控线路 · Relay' : '主控线路';
    $('#sbGroupMembers').hidden = $('#sbQuota').hidden = !state.group;
    routeStatus.hidden = !isLiveGroup() || !supported;
    routeStatus.textContent = !knownRoutes ? '主控检测中' : hasRoute() ? routeNames[selected] : '主控离线';
    routeStatus.classList.toggle('route-online', hasRoute());
    routeStatus.title = '查看 SSH 和 Relay 线路';
  }

  function setHtml(element, html) {
    if (element.renderedHtml === html) return;
    const openSteps = $$('details[open][data-step]', element).map((step) => step.dataset.step);
    const oldFlow = $('.flow-viewport', element);
    const oldTask = oldFlow?.closest('[data-flow-task]')?.dataset.flowTask;
    const scrollLeft = oldFlow?.scrollLeft || 0;
    const scrollTop = oldFlow?.scrollTop || 0;
    const oldFocus = oldFlow?.contains(document.activeElement) ? document.activeElement : null;
    element.innerHTML = html;
    const flow = $('.flow-viewport', element);
    if (flow) {
      if (oldTask === flow.closest('[data-flow-task]').dataset.flowTask) {
        flow.scrollLeft = scrollLeft;
        flow.scrollTop = scrollTop;
        if (oldFocus) {
          const replacement = oldFocus === oldFlow ? flow : $$('[data-flow-node]', flow).find((node) => node.dataset.flowNode === oldFocus.dataset.flowNode);
          replacement?.focus({ preventScroll: true });
        }
      } else flow.scrollLeft = (flow.scrollWidth - flow.clientWidth) / 2;
    }
    element.renderedHtml = html;
    for (const step of $$('details[data-step]', element)) step.open = openSteps.includes(step.dataset.step);
  }

  function messageRow(id, metadata, body) {
    return `<article class="group-message">${avatars.html(id, { still: true })}<div class="group-message-content">
      <header><strong>${memberName(id)}</strong>${metadata ? `<span>${esc(metadata)}</span>` : ''}</header>${body}
    </div></article>`;
  }

  function planMessages(task) {
    const show = (id) => (!filterSelect.value || filterSelect.value === id) && (filter !== 'mine' || id === 'you');
    const disabled = busy || (!isExample(state.group) && !connected) ? 'disabled' : '';
    return (task.plan?.rounds || []).flatMap((round, index, rounds) => {
      const active = index === rounds.length - 1 && waitingForPlan(task);
      const steps = round.steps?.map((step) => `<li><strong>${esc(memberName(step.role))}</strong>${typeof step.write === 'boolean' ? (step.write ? '（可生成补丁）' : '（只读）') : ''} ${esc(step.prompt)}</li>`).join('');
      const review = active ? `<div class="task-actions">
        <button type="button" class="btn" data-plan-action="reply" data-plan-task="${esc(task.id)}" ${disabled}>${round.questions ? '回答组长' : '要求调整'}</button>
        ${steps ? `<button type="button" class="btn primary" data-plan-action="approve" data-plan-task="${esc(task.id)}" ${disabled}>确认方案并开始</button>` : ''}
      </div>` : '';
      const messages = [];
      if (show('lead')) messages.push(messageRow('lead', round.questions ? '待确认的细节' : '方案', `<div class="group-plan">
        ${round.questions ? `<ol>${round.questions.map((question) => `<li>${esc(question)}</li>`).join('')}</ol>`
          : `<p>${esc(round.summary)}</p>${steps ? `<ol>${steps}</ol>` : ''}`}
        ${steps ? `<button type="button" class="task-text-link" data-task-id="${esc(task.id)}" data-task-view="graph">查看方案调度图 ${svg('chev')}</button>` : ''}
        ${review}
      </div>`));
      if (round.reply && show('you')) messages.push(messageRow('you', '回复组长', `<p class="group-user-text">${esc(round.reply)}</p>`));
      return messages;
    });
  }

  function renderTimeline() {
    const { records } = currentGroup();
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 70;
    const html = [...records.values()].filter((task) => filter !== 'attention' || task.state === 'needs_review' || waitingForPlan(task)).map((task) => {
      const sender = task.plan && !task.plan.approved ? 'lead' : owner(task);
      const steps = task.steps || [];
      const acceptance = acceptanceLabel(task);
      const cardDetail = task.detail === 'patches_ready' ? textOf(task.detail)
        : [steps.length ? steps.length + ' 个步骤' : '', pathsOf(task).length ? pathsOf(task).length + ' 个文件' : '', elapsed(task)].filter(Boolean).join(' · ') || '查看调度图';
      const card = `<button class="dispatch-card" type="button" data-task-id="${esc(task.id)}" data-task-view="graph">
        <span class="dispatch-top"><span class="dispatch-icon">${svg('term')}</span><strong>任务 <span class="mono">${taskLabel(task)}</span></strong>${pill(task.state)}</span>
        <span class="dispatch-detail">${esc([
          task.stage ? '阶段 ' + stageLabel(task.stage) : '',
          acceptance ? '验收 ' + acceptance : '',
          cardDetail,
        ].filter(Boolean).join(' · '))}</span>
        ${quotaCharge(task, { compact: true })}
      </button>`;
      const messages = [];
      const requiresReview = task.detail === 'patches_ready' || task.pendingRequest;
      if (task.prompt && (!filterSelect.value || filterSelect.value === 'you')) {
        const time = task.time ? new Date(task.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        messages.push(messageRow('you', [memberName(sender), time].filter(Boolean).join(' · '), `<p class="group-user-text">${esc(task.prompt)}</p>`));
      }
      if (filter !== 'mine' && (!filterSelect.value || filterSelect.value === sender)) {
        messages.push(messageRow(sender, task.model || members[sender].role, card));
      }
      messages.push(...planMessages(task));
      if (filter !== 'mine' && !filterSelect.value) {
        for (const note of reassignments(task)) messages.push(`<p class="group-system">${esc(note)}</p>`);
        for (const note of systemNotes(task)) messages.push(`<p class="group-system" data-system-kind="state">${esc(note)}</p>`);
      }
      if (requiresReview && (!filterSelect.value || filterSelect.value === 'local')) {
        const title = task.detail === 'patches_ready' ? '待审核的本机补丁' : '待核对的本机操作';
        messages.push(messageRow('local', '工作区', `<div class="group-review">
          <strong>${svg('shield')}${title}</strong>
          <button type="button" class="btn" data-task-id="${esc(task.id)}">查看任务 ${taskLabel(task)}</button>
        </div>`));
      }
      for (const step of steps) {
        if (filter === 'mine' || !members[step.role] || !(step.output || step.error) || (filterSelect.value && filterSelect.value !== step.role)) continue;
        const text = step.error || step.output;
        const lines = text.trim().split('\n');
        const excerpt = lines[0].slice(0, 200);
        messages.push(messageRow(step.role, step.model || members[step.role].role, `<div class="step-excerpt">
          <p>${esc(excerpt)}${excerpt.length < text.trim().length ? '…' : ''}</p>
          <button type="button" class="task-text-link" data-task-id="${esc(task.id)}">查看步骤输出 ${svg('chev')}</button>
        </div>`));
      }
      return messages.length ? `<div class="dispatch-thread">${messages.join('')}</div>` : '';
    }).join('');

    setHtml(timeline, html || `<div class="group-empty">
      <span class="group-empty-icon">#</span>
      <h2>${records.size ? '没有符合筛选条件的消息' : '项目群聊'}</h2>
      ${records.size ? '' : '<p>组长先确认需求和方案，确认后开始执行。</p>'}
    </div>`);
    if (atBottom && records.size) timeline.scrollTop = timeline.scrollHeight;
  }

  function render() {
    drawRoutes();
    if (!state.group) return;
    const count = taskCount();
    $('#groupSubtitle').textContent = Object.keys(members).length + ' 位成员' + (count ? ' · ' + count + ' 项未结任务' : '');
    $('#taskBadge').textContent = count || '';
    for (const id of optional) {
      const option = provider.querySelector(`[value="${id}"]`);
      option.disabled = !canUse(id);
      option.textContent = canUse(id) ? members[id].name : members[id].name + '（' + availability(id) + '）';
    }
    const recipientReady = canUse(provider.value);
    setHtml($('#groupRoster'), Object.keys(members).filter((id) => id !== 'you' && canUse(id)).map((id) =>
      `<button type="button" data-roster="${id}" title="${memberName(id)} · ${members[id].role}">${memberAvatar(id, 34, 'roster')}<span>${memberName(id)}</span></button>`).join(''));
    setHtml($('#sbGroupMembers'), recipients.slice(1).flatMap((id) => {
      const { state: activity, task } = memberActivity(id);
      if (!activity) return [];
      const stats = [taskStats(task, id), usageText(task, id)].flat().filter(Boolean).join(' · ');
      return `<button type="button" class="sb-item clickable" data-status-member="${id}" title="${esc(memberName(id) + (stats ? ' · ' + stats : ''))}"><span class="status-dot ${{ asking: 'waiting', done: 'done', failed: 'failed' }[activity] || 'running'}"></span>${avatars.members[id].short} ${avatars.states[activity].label}${stats ? `<small class="sb-stats">${esc(stats)}</small>` : ''}</button>`;
    }).join(''));
    refreshQuotas();
    setHtml($('#sbQuota'), quotaStatusBar());
    const canSend = isExample(state.group) || (supported && (currentGroup().planReply ? connected : hasRoute()));
    $('#groupSend').disabled = busy || !canSend || !recipientReady;
    $('#groupPlanReplyCancel').disabled = busy;
    const connectionHint = !recipientReady ? `当前主控尚未启用 ${members[provider.value].name}。` : isExample(state.group) ? '本地示例'
      : !supported ? '此客户端尚未配置群聊主控。' : hasRoute() ? '' : knownRoutes ? '主控离线，请检查线路。' : '正在检查主控线路…';
    composerMessage.textContent = busy ? '正在处理…' : currentGroup().taskError || connectionHint;
    renderTimeline();
  }

  /* ---------- Quota (subscriptions: what runs out is quota, not tokens) ---------- */
  // Example projects show sample numbers so the layout can be checked without a server.
  const exampleQuotas = [
    { provider: 'claude', used: 64, level: 'reserved', policy: { soft: 60, hard: 95, keepFor: ['plan', 'accept'] }, usedSource: 'snapshot',
      buckets: [{ id: 'claude', fiveHour: { usedPercent: 38 }, weekly: { usedPercent: 64 } }] },
    { provider: 'codex', used: 41, level: 'ok', policy: { soft: 70, hard: 95, keepFor: ['implement'] },
      buckets: [{ id: 'codex', fiveHour: { usedPercent: 41 }, weekly: { usedPercent: 22 } }] },
    { provider: 'grok', used: 97, level: 'stopped', policy: { soft: 95, hard: 95, keepFor: [] },
      buckets: [{ id: 'grok', fiveHour: { usedPercent: 97 }, weekly: { usedPercent: 51 } }] },
    { provider: 'gemini', used: 18, level: 'ok', policy: { soft: 95, hard: 95, keepFor: [] },
      buckets: [{ id: 'gemini', fiveHour: { usedPercent: 18 }, weekly: { usedPercent: 9 } }] },
  ];
  const capabilityNames = { plan: '规划', scout: '侦察', implement: '改代码', review: '审查', research: '查资料', accept: '验收' };
  const quotaList = () => isExample(state.group) ? exampleQuotas : connected ? quotas : [];
  const quotaOf = (id) => quotaList().find((quota) => quota.provider === id);
  const pct = (value) => Math.round(value) + '%';
  function levelText(quota) {
    if (quota.level === 'stopped') return '额度将尽，暂停派活';
    if (quota.level === 'reserved') return '让位中，只做' + quota.policy.keepFor.map((name) => capabilityNames[name] || name).join('、');
    return '';
  }

  // Status bar: Claude and Codex always (they are the scarce ones); others only when they are stepping back.
  function quotaStatusBar() {
    const shown = quotaList().filter((quota) => Number.isFinite(quota.used) &&
      (['claude', 'codex'].includes(quota.provider) || quota.level === 'reserved' || quota.level === 'stopped'));
    return shown.map((quota) => {
      const left = Math.max(0, 100 - quota.used);
      const note = levelText(quota);
      return `<button type="button" class="sb-item clickable sb-quota" data-level="${quota.level}" data-status-member="${quota.provider}"
        title="${esc(memberName(quota.provider))} 剩余 ${pct(left)}（取 5 小时和每周窗口中较紧的一个）${note ? ' · ' + note : ''}">
        <span class="quota-mini" aria-hidden="true"><i style="width:${left}%"></i></span>${esc(avatars.members[quota.provider]?.short || quota.provider)} 剩 ${pct(left)}</button>`;
    }).join('');
  }

  // Member panel: one meter per window, remaining quota, and what routing is doing with this member.
  function quotaMarkup(provider) {
    const quota = quotaOf(provider);
    const bucket = quota?.buckets?.[0];
    if (!quota || (!bucket && !Number.isFinite(quota.used))) return '<small class="quota-none">额度未取得</small>';
    const meter = (label, window) => {
      const left = window ? Math.max(0, 100 - window.usedPercent) : null;
      return `<span class="quota-label">${label}</span><span class="quota-bar" aria-hidden="true">${left === null ? '' : `<i style="width:${left}%"></i>`}</span>
        <span class="quota-value">${left === null ? '—' : '剩 ' + pct(left)}</span>`;
    };
    const rows = bucket ? meter('5 小时', bucket.fiveHour) + meter('每周', bucket.weekly)
      : meter(quota.usedSource === 'snapshot' ? '快照' : '较紧窗口', { usedPercent: quota.used });
    const note = levelText(quota);
    return `<div class="quota-meters" data-level="${quota.level}">${rows}</div>${note ? `<small class="quota-note" data-level="${quota.level}">${note}</small>` : ''}`;
  }

  // What a task cost: the change in each member's quota between the task's start and end.
  function quotaCharge(task, { compact = false } = {}) {
    const entries = Object.entries(task.quota || {}).filter(([, windows]) => (windows.fiveHour || 0) + (windows.weekly || 0) > 0);
    if (!entries.length) return '';
    if (compact) {
      return `<span class="dispatch-quota"><em>额度</em>${entries.slice(0, 3).map(([id, windows]) =>
        `<span title="${esc(memberName(id))}：5 小时 +${windows.fiveHour ?? 0}% · 每周 +${windows.weekly ?? 0}%">${esc(avatars.members[id]?.short || id)} +${windows.fiveHour ?? windows.weekly}%</span>`).join('')}</span>`;
    }
    return `<table class="quota-table"><thead><tr><th>消耗额度</th><th>5 小时</th><th>每周</th></tr></thead><tbody>
      ${entries.map(([id, windows]) => `<tr><td>${esc(memberName(id))}</td><td>+${windows.fiveHour ?? 0}%</td><td>+${windows.weekly ?? 0}%</td></tr>`).join('')}
    </tbody></table><p class="panel-note">任务开始和结束时各读一次已用额度的差值，包含同一账号在这段时间里的其他使用。</p>`;
  }

  // "review:reassigned:grok->gemini:quota" → a one-line note in the thread.
  function reassignments(task) {
    return (task.events || []).map((event) => /^([\w-]+):reassigned:(\w+)->(\w+):(quota|auth)$/.exec(event.detail || ''))
      .filter(Boolean).map(([, , from, to, reason]) =>
        `${memberName(from)} ${reason === 'quota' ? '额度用尽' : '需要重新登录'}，改由 ${memberName(to)} 接手`);
  }

  // Only the events a person needs to understand a stuck task; ordinary step start/finish stays in
  // the task panel. Repeats of the same notice collapse into one line.
  function systemNotes(task) {
    const notes = [];
    const seen = new Set();
    const add = (note) => {
      if (note && !seen.has(note)) {
        seen.add(note);
        notes.push(note);
      }
    };
    for (const event of task.events || []) {
      const detail = event.detail || '';
      const waiting = /^executor_waiting:(\w+)$/.exec(detail);
      if (waiting) add(`等待 ${memberName(waiting[1])} 可用，任务保持排队。`);
      else if (detail === 'owner_quota_cap') add('今日额度上限已到，任务将在本地零点后继续。');
      else if (detail === 'triage_started') add('任务遇到问题，已交给组长诊断。');
      else if (detail === 'triage_unavailable') add('组长暂时不可用，稍后自动继续诊断。');
      else if (detail === 'triage_rework' || detail === 'triage_retry') add('组长已给出处理意见，任务重新排队。');
      else if (detail === 'triage_limit' || detail === 'acceptance_limit') add('自动处理次数已达上限，请人工查看。');
      else if (detail === 'review_conflict') add('审查意见冲突，已交给组长判断。');
      else if (detail === 'acceptance_started') add('组长开始验收。');
      else if (detail === 'rework_after_apply') add('补丁已应用，返工不会自动改写已应用的文件。');
      else if (/^triage_decision:(\w+)$/.test(detail)) add(textOf(detail));
      else if (/^acceptance_verdict:(\w+)$/.test(detail)) add(textOf(detail));
      else if (/^fix-\d+:started$/.test(detail)) add('返工步骤开始执行。');
      else if (/^fix-\d+:completed$/.test(detail)) add('返工步骤完成，等待重新验收。');
      else if (/^fix-\d+:failed$/.test(detail)) add('返工步骤失败。');
      else if (/^escalated:(\w+)$/.test(detail)) add('任务遇到问题，已升级给组长处理。');
    }
    return notes;
  }

  const stageLabel = (stage) => stages[stage] || stage;
  function acceptanceLabel(task) {
    const verdict = task?.acceptance?.verdict;
    return verdict ? acceptanceNames[verdict] || verdict : '';
  }

  // Counts from the task record: calls, reassignments and escalations for one member.
  function taskStats(task, id) {
    const metrics = task?.metrics;
    if (!metrics) return [];
    const role = id === 'lead' ? 'claude' : id;
    return [
      metrics.roleCalls?.[role] ? `调用 ${metrics.roleCalls[role]}` : '',
      metrics.reassignments ? `改派 ${metrics.reassignments}` : '',
      metrics.triageRounds ? `升级 ${metrics.triageRounds}` : '',
    ].filter(Boolean);
  }

  function usageText(task, id) {
    const role = id === 'lead' ? 'claude' : id;
    const total = Object.values(task?.usage?.[role] || {})
      .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    return total ? `用量 ${Math.round(total / 1000)}k token` : '';
  }

  function panelMembers() {
    refreshQuotas();
    return `<div class="project-panel-body"><div class="member-panel-heading"><h3>项目成员</h3>
      <button type="button" class="task-text-link" data-avatar-sheet>状态图鉴 ${svg('chev')}</button></div>
      ${Object.entries(members).map(([id, member]) => {
        const { task, state: activity } = memberActivity(id);
        return `<div class="member-row ${focusMember === id ? 'member-focused' : ''}">${memberAvatar(id, 48, 'members')}<div>
          <span class="member-caption"><strong>${member.name}</strong>${activity ? `<small>${avatars.states[activity].label}</small>` : ''}</span><small>${member.role}${!canUse(id) ? ' · ' + availability(id) : ''}</small>
          ${recipients.includes(id) && id !== 'lead' && (isLiveGroup() || isExample(state.group)) ? quotaMarkup(id) : ''}
          ${task && [...taskStats(task, id), usageText(task, id)].filter(Boolean).length
            ? `<small class="member-task-stats">${esc([...taskStats(task, id), usageText(task, id)].filter(Boolean).join(' · '))}</small>` : ''}
          ${task ? `<button type="button" data-task-id="${esc(task.id)}" class="task-text-link">${taskLabel(task)} · ${statusName(task.state)}</button>` : ''}
        </div>${id === 'codex' ? '<button type="button" class="btn member-direct" data-direct-codex>单聊</button>' : ''}</div>`;
      }).join('')}</div>`;
  }

  function refreshQuotas() {
    if (!supported || !isLiveGroup() || !connected || quotaCheck || Date.now() < nextQuotaAt) return;
    const current = generation;
    nextQuotaAt = Date.now() + 60000;
    quotaCheck = control('quota_status').then((result) => {
      if (current === generation) quotas = result;
    }).catch(() => {
      if (current === generation) quotas = [];
    }).finally(() => {
      quotaCheck = null;
      if (current === generation && isLiveGroup()) repaint();
    });
  }

  function panelAvatars() {
    const choices = Object.entries(avatars.members).filter(([id]) => id !== 'you');
    return `<div class="project-panel-body"><div class="member-panel-heading"><h3>状态图鉴</h3>
      <button type="button" class="task-text-link" data-avatar-sheet>返回成员</button></div>
      <p class="panel-note">悬停时睁眼跟随鼠标，点一下会眯眼跳起，连点四下会扭头。</p>
      <div class="avatar-picker">${choices.map(([id, member]) => `<button type="button" class="btn" data-preview-member="${id}" aria-pressed="${id === previewMember}">${member.name}</button>`).join('')}</div>
      <div class="avatar-sheet">${avatars.previewStates.map((name) => `<div>
        ${avatars.html(previewMember, { state: name, preview: true, size: 58 })}<span>${avatars.states[name].label}</span>
      </div>`).join('')}</div>
    </div>`;
  }

  function panelTasks() {
    const { records, selected, statusError } = currentGroup();
    const task = getSelected();
    if (!records.size) return '<div class="empty-note">发送任务后，这里会显示进度和结果。</div>';
    const online = isExample(state.group) || connected;
    const steps = task?.steps || [];
    const logs = steps.map((step) => `<details class="task-step" data-step="${esc(task.id + ':' + step.id)}"><summary><strong>${esc(memberName(step.role))}</strong>${pill(step.state)}</summary>
      ${step.output || step.error ? `<pre>${esc(step.error || step.output)}</pre>` : '<div class="empty-note">暂无步骤输出</div>'}
    </details>`).join('');
    const events = (task?.events || []).filter((event, i, all) => i === 0 || event.state !== all[i - 1].state);
    return `<div class="project-panel-body"><h3>项目任务</h3>
      <div class="task-queue">${[...records.values()].reverse().map((item) => `<button type="button" class="task-list-item" data-task-id="${esc(item.id)}" aria-pressed="${item.id === selected}">
        <span><strong class="mono">${taskLabel(item)}</strong>${pill(item.state)}</span><small>${esc(item.prompt || memberName(owner(item)))}</small>
      </button>`).join('')}</div>
      ${task ? `<section class="selected-task"><h3>任务 ${taskLabel(task)}</h3>
        ${elapsed(task) ? `<p>耗时 ${elapsed(task)}</p>` : ''}
        ${task.detail ? `<p>${esc(textOf(task.detail))}</p>` : ''}
        ${task.stage || acceptanceLabel(task) ? `<p class="task-stage">${esc([
          task.stage ? '阶段：' + stageLabel(task.stage) : '',
          acceptanceLabel(task) ? '验收：' + acceptanceLabel(task) : '',
        ].filter(Boolean).join(' · '))}</p>` : ''}
        ${statusError ? `<p class="task-status-error" role="status">${esc(statusError)}</p>` : ''}
        <div class="task-actions">
          <button class="btn" type="button" data-task-id="${esc(task.id)}" data-task-view="graph">查看调度图</button>
          <button class="btn" type="button" data-task-operation="status" ${busy || !online ? 'disabled' : ''}>刷新</button>
          ${task.detail === 'patches_ready' ? `<button class="btn primary" type="button" data-task-operation="apply" ${busy || !online ? 'disabled' : ''}>应用补丁</button>` : ''}
          ${task.pendingRequest ? `<button class="btn" type="button" data-task-operation="reconcile" ${busy || !online ? 'disabled' : ''}>核对操作</button>` : ''}
          ${task.state && !terminal.has(task.state) ? `<button class="btn danger" type="button" data-task-operation="cancel" ${busy || !online ? 'disabled' : ''}>取消任务</button>` : ''}
          ${task.prompt && terminal.has(task.state) ? '<button class="btn" type="button" data-task-operation="draft">重跑…</button>' : ''}
        </div>
        ${events.length ? `<ol class="task-events">${events.map((event) => `<li>${statusName(event.state)}</li>`).join('')}</ol>` : ''}
        ${reassignments(task).map((note) => `<p class="task-reassigned">${esc(note)}</p>`).join('')}
        ${quotaCharge(task)}
        ${logs ? `<h3>步骤输出</h3>${logs}` : ''}
      </section>` : ''}
    </div>`;
  }

  function panelGraph() {
    const { records, statusError } = currentGroup();
    const task = getSelected();
    if (!task) return '<div class="empty-note">发送或选择一项任务后，这里会显示组长的派活线路。</div>';
    const options = [...records.values()].reverse().map((item) => `<option value="${esc(item.id)}" ${item.id === task.id ? 'selected' : ''}>
      ${taskLabel(item)} · ${esc(item.prompt?.slice(0, 60) || statusName(item.state))}
    </option>`).join('');
    return `<div class="project-panel-body flow-panel" data-flow-task="${esc(task.id)}">
      <div class="member-panel-heading"><h3>任务调度图</h3>
        <button type="button" class="task-text-link" data-flow-return>任务详情 ${svg('chev')}</button></div>
      <label class="flow-select"><span class="visually-hidden">选择任务</span><select id="flowTask">${options}</select></label>
      ${statusError ? `<p class="task-status-error" role="status">${esc(statusError)}</p>` : ''}
      ${graph.render(task, { selected: selectedFlowNodes.get(task.id), esc, memberName, avatar: (role) => avatars.html(role, { size: 20, still: true }) })}
    </div>`;
  }

  function renderPanel(panel, body) {
    const task = getSelected();
    if (panel === 'avatars') setHtml(body, panelAvatars());
    else if (panel === 'members') setHtml(body, panelMembers());
    else if (panel === 'tasks') setHtml(body, panelTasks());
    else if (panel === 'graph') setHtml(body, panelGraph());
    else if (panel === 'diff') {
      const paths = pathsOf(task);
      $('#diffBadge').textContent = paths.length || '';
      setHtml(body, task ? `<div class="project-panel-body"><h3>任务 ${taskLabel(task)} · 改动文件</h3>
        ${paths.length ? `<ul class="task-paths">${paths.map((path) => `<li>${svg('file')}<span class="mono">${esc(path)}</span></li>`).join('')}</ul>` : '<p class="panel-note">当前任务暂无改动文件。</p>'}
      </div>` : '<div class="empty-note">选择任务以查看改动文件。</div>');
    } else if (panel === 'terminal') {
      const output = task?.steps?.filter((step) => step.output || step.error) || [];
      setHtml(body, output.length ? `<div class="project-panel-body"><h3>任务 ${taskLabel(task)} · 输出摘要</h3>
        ${output.map((step) => `<div class="group-output"><strong>${esc(memberName(step.role))}</strong><pre>${esc(step.error || step.output)}</pre></div>`).join('')}
      </div>` : '<div class="empty-note">任务的步骤输出会显示在这里。</div>');
    } else {
      delete body.renderedHtml;
      return false;
    }
    return true;
  }

  function repaint() {
    render();
    if (!state.group) return;
    for (const id of groups.keys()) {
      const count = taskCount(id);
      if (count === displayedCounts.get(id)) continue;
      displayedCounts.set(id, count);
      A.renderSidebar();
      break;
    }
    if (state.panelOpen && state.panel !== 'files') A.renderPanel();
  }

  async function control(operation, extra) {
    const answer = await api.control({ operation, ...extra });
    if (answer.ok) return answer.value;
    const explanations = {
      bridge_offline: '没有可用线路，请检查 SSH 或 Relay。',
      operations_in_progress: '有任务在执行，结束后可以切换线路。',
      unknown_task: '主控上找不到这项任务。',
      invalid_model_selection: '请输入该 CLI 支持的模型 ID。',
      gemini_not_configured: 'VPS 2 尚未配置 Gemini 执行服务。',
      antigravity_not_configured: 'VPS 2 尚未配置 Antigravity。',
      unsupported_operation: '群聊规划需要更新主控和本机连接组件。',
      invalid_plan_reply: '请输入 1 至 2000 字的回复。',
      plan_changed: '方案已更新，请按最新一轮的问题或方案操作。',
      invalid_plan: '组长未能生成可用的方案，请从任务详情重试。',
      sign_in_required: '请先登录 AgentDesk。',
    };
    throw new Error(explanations[answer.error] || answer.error);
  }

  async function syncTask(group, id) {
    if (!id) return;
    const current = generation;
    const summary = await control('status', { taskId: id });
    if (current === generation) updateTask(group, id, summary, true);
  }

  function refresh() {
    if (!supported || busy || (!isLiveGroup() && !dialog.open)) return;
    if (checking) return checking;
    const current = generation;
    checking = (async () => {
      let routes;
      try {
        routes = await control('routes');
      } catch (error) {
        if (dialog.open && current === generation) routeMessage.textContent = error.message;
      }
      if (current !== generation) return;
      routeState = routes || {};
      knownRoutes = true;
      connected = Boolean(routeState.ssh || routeState.relay);
      if (connected && isLiveGroup() && !busy) {
        const group = currentGroup();
        const { records, selected } = group;
        const pending = [...records.values()].filter((task) => task.id !== selected && (!task.state || !terminal.has(task.state)));
        const ids = new Set([selected, pending.length ? pending[cursor++ % pending.length].id : null]);
        for (const id of ids) {
          if (current !== generation) return;
          try {
            await syncTask(group, id);
            if (current === generation && id === group.selected) group.statusError = '';
          } catch (error) {
            if (current === generation && id === group.selected) group.statusError = error.message;
          }
        }
      }
      repaint();
    })().finally(() => { checking = null; });
    return checking;
  }

  async function run(action, group) {
    if (busy) return false;
    busy = true;
    await checking;
    if (group) group.taskError = '';
    routeMessage.textContent = '';
    repaint();
    try {
      await action();
      return true;
    } catch (error) {
      if (group) group.taskError = error.message;
      else routeMessage.textContent = error.message;
      return false;
    } finally {
      busy = false;
      repaint();
    }
  }

  function selectTask(id, panel = 'tasks') {
    const group = currentGroup();
    if (!group.records.has(id)) return;
    if (group.selected !== id) group.statusError = '';
    group.selected = id;
    A.showPanel(panel);
    if (isLiveGroup() && connected) refresh();
  }

  async function sendPlanAction(group, taskId, revision, operation, reply) {
    const current = generation;
    const sent = await run(async () => {
      if (current !== generation) return;
      if (!isExample(group.id)) {
        const answer = await control(operation, { taskId, revision, reply });
        if (current === generation) updateTask(group, taskId, answer, true);
        return;
      }
      const task = group.records.get(taskId);
      const round = task?.plan?.rounds.at(-1);
      if (round?.revision !== revision || !waitingForPlan(task)) throw new Error('方案已更新，请查看最新方案。');
      if (operation === 'plan_approve') {
        const now = Date.now();
        const at = (seconds) => new Date(now - seconds * 1000).toISOString();
        updateTask(group, taskId, {
          state: 'completed', detail: '示例方案已确认。', plan: { ...task.plan, approved: revision },
          steps: [
            { id: 'edit', role: task.provider || 'codex', state: 'completed', output: '示例：已按确认的范围完成修改。', paths: ['src/example.js'] },
            { id: 'review', role: 'gemini', state: 'completed', output: '示例：审查通过，没有阻塞问题。' },
          ],
          events: [{ state: 'planning', time: at(160) }, { state: 'running', time: at(150) },
            { state: 'running', detail: 'review:reassigned:grok->gemini:quota', time: at(60) }, { state: 'completed', time: at(5) }],
          quota: { claude: { fiveHour: 3, weekly: 1 }, codex: { fiveHour: 2, weekly: 0.5 }, gemini: { fiveHour: 1, weekly: 0 } },
        });
      } else {
        const steps = [{ role: task.provider || 'codex',
          prompt: task.provider === 'gemini' ? '分析确认后的范围，核对验收条件并提出建议。' : '根据已确认的范围完成任务并核对验收条件。' }];
        const rounds = [...task.plan.rounds.slice(0, -1), { ...round, reply },
          { revision: revision + 1, summary: '按你补充的细节推进。', steps }];
        updateTask(group, taskId, { state: 'awaiting_approval', detail: 'plan_proposed', plan: { rounds } });
      }
    }, group);
    return sent && current === generation;
  }

  function cancelPlanReply(group) {
    input.value = group.planReply.previousDraft;
    group.planReply = null;
    setRecipient();
    repaint();
  }

  $('#groupPlanReplyCancel').addEventListener('click', () => {
    const group = currentGroup();
    if (!busy && group?.planReply) cancelPlanReply(group);
  });

  async function taskAction(operation) {
    const group = currentGroup();
    const task = getSelected(group);
    const id = task?.id;
    if (!task) return;
    if (operation === 'draft') {
      if (group.planReply) { A.toast('请先结束当前规划回复'); return; }
      if (input.value.trim()) { A.toast('请先处理当前草稿'); return; }
      input.value = task.prompt;
      provider.value = task.provider || '';
      model.value = task.model || '';
      setRecipient();
      input.focus();
      return;
    }
    const current = generation;
    await run(async () => {
      if (current !== generation) return;
      if (isExample(group.id)) {
        if (operation === 'cancel') updateTask(group, id, { state: 'cancelled', detail: 'cancelled' });
        if (operation === 'apply') updateTask(group, id, { state: 'completed', detail: '演示补丁已应用。' });
      } else {
        if (operation !== 'status') {
          const answer = await control(operation, { taskId: id });
          if (current !== generation) return;
          updateTask(group, id, answer);
        }
        await syncTask(group, id);
        group.statusError = '';
      }
    }, group);
  }

  function setRecipient(group = currentGroup()) {
    const reply = group?.planReply;
    provider.disabled = Boolean(reply);
    $('#groupMention').disabled = Boolean(reply);
    model.hidden = model.disabled = Boolean(reply) || !provider.value;
    input.maxLength = reply ? 2000 : 12000;
    input.placeholder = reply ? '回复组长…' : '向组长描述任务…';
    $('#groupPlanReply').hidden = !reply;
    if (reply) $('#groupPlanReplyText').textContent = '回复组长 · #' + reply.id.slice(0, 8);
  }

  function hideSuggestions() {
    suggestions.hidden = true;
    suggestionIndex = 0;
  }

  function suggestionToken() {
    const prefix = input.value.slice(0, input.selectionStart);
    const match = /(?:^|\s)(@[^\s@]*|\/[^\s/]*)$/.exec(prefix);
    if (!match || (match[1].startsWith('/') && match.index !== 0)) return null;
    return { query: match[1].slice(1).toLowerCase(), kind: match[1][0], index: prefix.length - match[1].length };
  }

  function showSuggestions() {
    if (currentGroup()?.planReply) { hideSuggestions(); return; }
    const token = suggestionToken();
    if (!token) { hideSuggestions(); return; }
    const { query, kind } = token;
    suggestionItems = kind === '@' ? recipients.filter((id) => canUse(id) && memberName(id).toLowerCase().includes(query))
      : Object.keys(availableCommands).filter((name) => name.startsWith(query));
    if (!suggestionItems.length) { hideSuggestions(); return; }
    suggestionIndex = Math.min(suggestionIndex, suggestionItems.length - 1);
    setHtml(suggestions, suggestionItems.map((item, index) => `<button type="button" data-suggestion="${index}" aria-selected="${index === suggestionIndex}">
      ${kind === '@' ? `${memberAvatar(item, 25)} ${memberName(item)} <small>${avatars.states[memberActivity(item).state || 'idle'].label}</small>`
        : `<span class="mono">/${item}</span><small>${availableCommands[item]}</small>`}
    </button>`).join(''));
    suggestions.hidden = false;
  }

  function pickSuggestion(index) {
    const token = suggestionToken();
    const item = suggestionItems[index];
    if (!token || !item) return;
    if (token.kind === '@') {
      provider.value = item === 'lead' ? '' : item;
      model.value = '';
      setRecipient();
    }
    const value = token.kind === '@' && token.index > 0 ? '' : token.kind + (token.kind === '@' ? mentions[item] : item) + ' ';
    input.setRangeText(value, token.index, input.selectionStart, 'end');
    hideSuggestions();
    input.focus();
  }

  $('#groupMention').addEventListener('click', () => {
    input.focus();
    input.setRangeText((input.selectionStart && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' ' : '') + '@', input.selectionStart, input.selectionEnd, 'end');
    showSuggestions();
  });
  suggestions.addEventListener('pointerdown', (event) => event.preventDefault());
  suggestions.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-suggestion]');
    if (choice) pickSuggestion(+choice.dataset.suggestion);
  });
  input.addEventListener('input', showSuggestions);
  input.addEventListener('blur', hideSuggestions);
  provider.addEventListener('change', () => { model.value = ''; setRecipient(); });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (!suggestions.hidden && ['Escape', 'ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) && !event.shiftKey) {
      event.preventDefault();
      if (event.key === 'Escape') hideSuggestions();
      else if (event.key === 'Enter') pickSuggestion(suggestionIndex);
      else {
        suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestionItems.length) % suggestionItems.length;
        showSuggestions();
        suggestions.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    form.requestSubmit();
  });

  function handleCommand(draft) {
    const match = /^\/(ls|stop|routes|avatars)(?:\s+(.+))?$/.exec(draft);
    if (!match) return false;
    const [, command, argument] = match;
    if (command === 'ls') A.showPanel('tasks');
    if (command === 'avatars') A.showPanel('avatars');
    if (command === 'routes') {
      if (!isLiveGroup() || !supported) A.toast('当前项目未连接主控');
      else openRoutes();
    }
    if (command === 'stop') {
      const prefix = argument?.replace(/^#/, '');
      const matches = prefix ? [...currentGroup().records.keys()].filter((id) => id.startsWith(prefix)) : [];
      if (matches.length !== 1) { A.toast('请用 /stop #任务编号 指定一项任务'); return true; }
      selectTask(matches[0]);
      const task = getSelected();
      if (!task.state || terminal.has(task.state)) { A.toast('这项任务当前不可取消'); return true; }
      taskAction('cancel');
    }
    input.value = '';
    hideSuggestions();
    return true;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const group = currentGroup();
    const draft = input.value.trim();
    if (!group || !draft || busy) return;
    if (group.planReply) {
      const { id, revision } = group.planReply;
      if (!isExample(group.id) && !connected) return;
      if (await sendPlanAction(group, id, revision, 'plan_reply', draft)) {
        if (group === currentGroup()) cancelPlanReply(group);
        else {
          group.draft = group.planReply.previousDraft;
          group.planReply = null;
        }
      }
      return;
    }
    if (handleCommand(draft) || (!isExample(group.id) && (!supported || !hasRoute()))) return;
    hideSuggestions();
    const aliases = { '组长': '', codex: 'codex', claude: 'claude', 'claude code': 'claude', grok: 'grok', 'grok build': 'grok', gemini: 'gemini', antigravity: 'antigravity' };
    const mention = /^@(组长|codex|claude(?: code)?|grok(?: build)?|gemini|antigravity)(?:\s+|$)/i.exec(draft);
    const recipient = mention ? aliases[mention[1].toLowerCase()] : provider.value;
    const prompt = mention ? draft.slice(mention[0].length).trim() : draft;
    if (recipient && !canUse(recipient)) {
      group.taskError = `当前主控尚未启用 ${members[recipient].name}。`;
      render();
      return;
    }
    if (!prompt) {
      group.taskError = '请输入任务内容。';
      render();
      return;
    }
    const request = { prompt, provider: recipient || undefined,
      model: recipient && recipient === provider.value && model.value.trim() || undefined };
    const key = JSON.stringify(request);
    if (group.pending?.key !== key) group.pending = { key, id: crypto.randomUUID() };
    const id = group.pending.id;
    const current = generation;
    const sent = await run(async () => {
      if (current !== generation) return;
      const summary = isExample(group.id) ? {
        state: 'awaiting_details', detail: 'plan_questions',
        plan: { rounds: [{ revision: 1, questions: ['这项任务的交付物是什么？', '你会根据哪些条件验收？'] }] },
      } : await control('start_plan', { taskId: id, ...request });
      if (current !== generation) return;
      updateTask(group, id, { ...request, ...summary, time: Date.now() });
      group.selected = id;
      group.statusError = '';
      if (group === currentGroup()) {
        filter = 'all';
        filterSelect.value = '';
        updateFilters();
      }
    }, group);
    if (!sent || current !== generation) return;
    group.pending = null;
    if (group === currentGroup()) {
      if (input.value.trim() === draft) input.value = '';
      timeline.scrollTop = timeline.scrollHeight;
    } else if (group.draft.trim() === draft) group.draft = '';
  });

  function updateFilters() {
    $$('[data-group-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.groupFilter === filter)));
  }
  filterSelect.insertAdjacentHTML('beforeend', Object.entries(members).map(([id, m]) => `<option value="${id}">${m.name}</option>`).join(''));
  filterSelect.addEventListener('change', renderTimeline);
  $('#groupFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-group-filter]');
    if (!button) return;
    filter = button.dataset.groupFilter;
    updateFilters();
    renderTimeline();
  });
  function showMember(id) {
    if (!id) return;
    focusMember = id;
    A.showPanel('members');
    $('#panelBody').querySelector('.member-focused')?.scrollIntoView({ block: 'nearest' });
  }
  $('#groupRoster').addEventListener('click', (event) => showMember(event.target.closest('[data-roster]')?.dataset.roster));
  $('#sbGroupMembers').addEventListener('click', (event) => showMember(event.target.closest('[data-status-member]')?.dataset.statusMember));
  $('#sbQuota').addEventListener('click', (event) => showMember(event.target.closest('[data-status-member]')?.dataset.statusMember));
  $('#panelBody').addEventListener('change', (event) => {
    if (state.group && event.target.id === 'flowTask') selectTask(event.target.value, 'graph');
  });
  for (const surface of [timeline, $('#panelBody')]) {
    surface.addEventListener('click', (event) => {
      if (!state.group) return;
      const planButton = event.target.closest('[data-plan-action]');
      if (planButton) {
        const group = currentGroup();
        const id = planButton.dataset.planTask;
        const round = group.records.get(id)?.plan?.rounds.at(-1);
        if (!round || busy) return;
        if (planButton.dataset.planAction === 'approve') {
          sendPlanAction(group, id, round.revision, 'plan_approve');
        } else {
          if (group.planReply?.id === id && group.planReply.revision === round.revision) { input.focus(); return; }
          if (group.planReply) cancelPlanReply(group);
          group.planReply = { id, revision: round.revision, previousDraft: input.value };
          input.value = '';
          group.taskError = '';
          hideSuggestions();
          setRecipient();
          repaint();
          input.focus();
        }
        return;
      }
      const flowNode = event.target.closest('[data-flow-node]');
      if (flowNode) {
        const task = getSelected();
        if (!task) return;
        selectedFlowNodes.set(task.id, flowNode.dataset.flowNode);
        A.renderPanel();
        return;
      }
      if (event.target.closest('[data-flow-return]')) { A.showPanel('tasks'); return; }
      const sheet = event.target.closest('[data-avatar-sheet]');
      if (sheet) { A.showPanel(state.panel === 'avatars' ? 'members' : 'avatars'); return; }
      const preview = event.target.closest('[data-preview-member]');
      if (preview) { previewMember = preview.dataset.previewMember; A.renderPanel(); return; }
      const task = event.target.closest('[data-task-id]');
      const action = event.target.closest('[data-task-operation]');
      if (task) selectTask(task.dataset.taskId, task.dataset.taskView);
      if (action) taskAction(action.dataset.taskOperation);
      if (event.target.closest('[data-direct-codex]')) {
        const direct = A.D.sessions.find((session) => session.project === state.group);
        if (direct) A.openSession(direct.id);
        else A.newDirect(state.group);
      }
    });
  }

  function openRoutes() {
    if (dialog.open) return;
    routeMessage.textContent = '';
    dialog.showModal();
    drawRoutes();
    refresh();
  }
  entry.hidden = !supported;
  entry.addEventListener('click', openRoutes);
  routeStatus.addEventListener('click', openRoutes);
  for (const button of routeButtons) {
    button.addEventListener('click', async () => {
      const changed = await run(() => control('select_route', { route: button.dataset.route }));
      if (changed) refresh();
    });
  }

  if (temporary) {
    enrollment.onExpired(() => {
      generation++;
      const group = groups.get(liveProject);
      if (group) {
        group.records.clear();
        group.selected = group.pending = group.planReply = null;
        group.draft = group.provider = group.model = group.taskError = group.statusError = '';
      }
      connected = knownRoutes = false;
      routeState = {};
      quotas = [];
      nextQuotaAt = 0;
      if (isLiveGroup()) {
        input.value = provider.value = model.value = '';
        setRecipient();
      }
      if (dialog.open) dialog.close();
      repaint();
    });
  }

  window.__group = { createGroup, hasGroup, switchGroup, taskCount, refresh, render, renderPanel };
  A.renderSidebar();
  if (supported) setInterval(refresh, 5000);
})();
