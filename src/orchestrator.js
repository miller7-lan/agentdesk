window.__groupReady = (async () => {
  const A = window.__desk;
  const { $, $$, esc, svg, state, store, LIVE } = A;
  const avatars = window.AgentDeskAvatars;
  const graph = window.AgentDeskTaskGraph;
  const approvals = window.AgentDeskApprovals;
  const selectedFlowNodes = new Map();
  const api = window.desk?.orchestrator;
  const enrollment = window.desk?.enrollment;
  const temporary = await enrollment?.required();
  const supported = Boolean(api && (await api.available()));
  const liveProject = 'live';
  const isExample = (id) => {
    const project = A.proj(id);
    return !project?.live || (project.id.startsWith('group-') && !project.serverProject);
  };
  const isLiveGroup = () => Boolean(state.group && A.proj(state.group)?.live);
  const projectOf = (group) => A.proj(group.id)?.serverProject;
  const members = {
    you: { name: '你', initials: '你', role: '项目成员' },
    lead: { name: '组长 · Claude', initials: '组', role: '规划、诊断、验收' },
    codex: { name: 'Codex', initials: 'CX', role: '实现与验证' },
    claude: { name: 'Claude Code', initials: 'CL', role: '规划、诊断与验收' },
    grok: { name: 'Grok Build', initials: 'GK', role: '分析与执行' },
    gemini: { name: 'Gemini', initials: 'GM', role: '分析与审查' },
    antigravity: { name: 'Antigravity', initials: 'AG', role: '侦察与简报' },
    local: { name: '本机', role: '工作区与桌面工具' },
  };
  const statuses = {
    queued: '排队中', planning: '规划中', running: '执行中', applying: '应用补丁',
    awaiting_details: '待补充细节', awaiting_approval: '待确认方案', awaiting_acceptance: '待验收', triaging: '组长诊断',
    testing: '验证中', needs_review: '待处理', completed: '已完成', failed: '失败', cancelled: '已取消',
  };
  const terminal = new Set(['needs_review', 'completed', 'failed', 'cancelled']);
  const stages = { executing: '执行', awaiting_acceptance: '待验收', triaging: '组长诊断', reworking: '返工', accepted: '已验收' };
  const acceptanceNames = {
    accept: '通过', pass: '通过', accept_with_risk: '有风险接受', rework: '返工',
    reject: '拒绝', blocked: '受阻', unknown: '无法判断', limit: '达到上限',
  };
  const triageNames = { retry: '重试', rework: '返工', accept_with_risk: '有风险接受', fail: '终止', unknown: '无法判断' };
  const details = {
    patches_ready: '补丁已准备好，等待应用到本机工作区。',
    planning_started: '开始制定计划',
    plan_questions: '组长正在等待你的回答。',
    plan_failed: '组长规划没成功，已说明原因；直接回复就会重新规划。',
    plan_failed_repeatedly: '组长连续多次没能规划出来，请换个说法重新描述任务。',
    invalid_plan: '组长给出的方案格式不对。',
    invalid_workspace_baseline: '读不到本机项目的 Git 版本（项目目录不是 Git 仓库，或 Bridge 没连上）。',
    windows_workspace_dirty: '本机项目有未提交的改动，主控不能在它上面开始。请先提交或暂存。',
    bridge_offline: '本机 Bridge 没有在线。',
    team_timeout: '任务超时。',
    plan_reply_received: '组长正在根据你的回复调整方案。',
    plan_revise_requested: '你改了方向：组长保留已完成的部分，按你的话重新规划剩下的，新方案出来后请确认。',
    revise_deciding: '组长正在判断你的话影响哪些步骤：不受影响的继续，需要的补一句指导接着做，方向变了的才停下。',
    handover_choice: '有一步换了几个模型都没完成，等你选择接手的模型。',
    permission_request: '组长申请给一步临时开权限，等你批准。',
    permission_answered: '你处理了权限申请，继续执行。',
    handover_chosen: '你选好了接手的模型，继续执行。',
    revise_decided: '组长已按你的话调整了正在做的步骤。',
    revise_needs_approval: '组长按你的话新增了步骤，请确认后开始。',
    revise_approved: '你确认了新增的步骤。',
    revise_fallback: '组长暂时没法判断，已把你的话作为指导发给正在做的成员，做到一半的内容不会丢。',
    plan_proposed: '确认方案后开始执行。',
    plan_approved: '方案已确认，等待分派。',
    plan_auto_approved: '方案较小，已自动开始执行；改动应用到本机前仍要你审核。',
    plan_workspace_changed: '工作区版本已变化，请基于当前版本重新规划。',
    project_snapshot_failed: '读取本机项目快照失败，请检查项目和 Bridge 后重试。',
    project_snapshot_too_large: '未提交的项目改动超过 8 MiB，请缩小任务范围或先同步项目提交。',
    mirror_missing_commit: 'VPS2 上的仓库还没有你本机当前的提交，而这台电脑的 Bridge 版本太旧，不能自动同步：请更新 Bridge，或手动推送一次。',
    project_sync_too_large: '要同步到 VPS2 的提交超过 20 MB（通常是第一次同步整个历史）：请手动推送一次，之后会自动增量同步。',
    project_snapshot_unmerged: '项目有未解决的 Git 合并冲突，请处理后再发起任务。',
    project_snapshot_submodule: '子模块有改动，请先同步子模块及主项目的提交。',
    project_snapshot_sensitive_path: '未提交改动包含受限文件，请检查项目中的凭据文件后重试。',
    project_snapshot_encoding: '未提交改动包含无法安全传输的文本编码，请先同步项目提交。',
    plan_ready: '执行计划已就绪',
    submitted: '任务已进入队列',
    cancelled: '任务已取消',
    cancel_requested: '已请求取消',
    owner_quota_cap: '今日额度上限已到，任务将在本地零点后继续。',
    triage_started: '任务遇到问题，已交给组长诊断。',
    triage_unavailable: '组长暂时不可用，稍后自动继续诊断；不会改派给其他成员。',
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
    isolated_test_not_authorized: '该项目未授权 Windows 隔离测试命令。',
    isolated_test_patch_mismatch: '补丁和已测试版本不一致，需要重新验收。',
    isolated_test_unchanged_failure: '修复后补丁没有变化，暂停重复测试。',
    local_operation_unknown: '本机操作的结果待核对。请检查已运行的命令和实际文件，避免重复执行。',
    dependency_failed: '前置步骤没有正常结束，后面的步骤无法开始，任务已停止。可以让组长重新安排。',
    budget_exceeded: '这项任务的预算（步骤数或 token）已用完，已暂停；确认后可重新发起或调高主控的 taskBudget。',
  };
  const routeNames = { ssh: 'SSH 主用', relay: 'VPS 1 Relay 备用' };
  const timeline = $('#groupTimeline');
  const form = $('#groupForm');
  const input = $('#groupInput');
  const provider = $('#groupRecipient');
  const model = $('#groupModel');
  function renderModelOptions() {
    const profiles = routeState.modelProfiles?.[provider.value];
    $('#groupModelOptions').replaceChildren(...Object.keys(profiles?.models || {}).map(id => new Option(id, id)));
    renderLeadModels();
  }
  // Every Claude model the server offers, for the lead; the group's own choice is kept.
  function renderLeadModels() {
    const select = document.querySelector('#groupLeadModel');
    if (!select) return;
    const models = routeState.modelProfiles?.claude?.models || {};
    const wanted = currentGroup?.()?.leadModel ?? select.value;
    select.replaceChildren(new Option('最新 Opus（默认）', ''),
      ...Object.entries(models).map(([id, profile]) => new Option(profile?.label || id, id)));
    select.value = Object.hasOwn(models, wanted) ? wanted : '';
    fitLeadEffort();
  }
  // The thinking levels the selected lead model accepts (Haiku has no 超高/最高, for example); the default is the
  // newest Opus, chosen the same way as on the server. A level the model does not accept moves to the nearest one.
  function leadModelId() {
    const models = Object.keys(routeState.modelProfiles?.claude?.models || {});
    const picked = document.querySelector('#groupLeadModel')?.value;
    if (picked && models.includes(picked)) return picked;
    const version = (id) => (/(\d+)[-.](\d+)/.exec(id) || [0, 0, 0]).slice(1).map(Number);
    return models.filter((id) => /opus/i.test(id)).sort((a, b) => { const [x1, y1] = version(a), [x2, y2] = version(b); return x2 - x1 || y2 - y1; })[0];
  }
  function fitLeadEffort() {
    const effort = document.querySelector('#groupLeadEffort');
    if (!effort) return;
    const profile = routeState.modelProfiles?.claude?.models?.[leadModelId()];
    const allowed = Array.isArray(profile?.efforts) && profile.efforts.length ? profile.efforts : null;
    const options = [...effort.options];
    for (const option of options) option.disabled = Boolean(allowed && !allowed.includes(option.value));
    if (allowed && !allowed.includes(effort.value)) {
      const order = options.map((option) => option.value);
      const below = order.slice(0, order.indexOf(effort.value) + 1).reverse().find((value) => allowed.includes(value));
      effort.value = below || profile.defaultEffort || allowed[0];
      const group = currentGroup();
      if (group) { group.leadEffort = effort.value; saveWorkbench(group); }
    }
  }
  const entry = $('#sbOrchestrator');
  const routeStatus = $('#sbGroupRoute');
  const dialog = $('#orchestratorDialog');
  const routeMessage = $('#orchestratorMessage');
  const projectDialog = $('#groupProjectDialog');
  const projectBinding = $('#groupProjectBinding');
  const composerMessage = $('#groupSendStatus');
  const routeButtons = $$('[data-route]', dialog);
  const filterSelect = $('#groupMemberFilter');
  const suggestions = $('#groupSuggestions');
  const recipients = ['lead', 'codex', 'grok', 'gemini', 'antigravity'];
  const mentions = { lead: '组长', codex: 'Codex', grok: 'Grok', gemini: 'Gemini', antigravity: 'Antigravity' };
  // Members that only take work when the orchestrator has them configured.
  const optional = ['gemini', 'antigravity'];
  const availableCommands = { edit: '指定成员修改，确认补丁后写入本机', ls: '查看项目任务', stop: '取消指定任务', routes: '查看主控线路', avatars: '查看状态图鉴',
    duo: '双人审查', team: '独占多步骤任务', compact: '生成项目简报', review: '审查改动',
    broadcast: '只读广播', chat: '自由发言' };
  const modeLabels = { chat: '只读发言', edit: '指定成员修改', duo: '双人审查', team: '组队', review_only: '只读审查' };
  let suggestionItems = [];
  let suggestionIndex = 0;
  let filter = 'all';
  let busy = false;
  let connected = false;
  let checking = null;
  let knownRoutes = false;
  let routeState = {};
  let quotas = [];
  let resources;
  let checkingResources;
  let quotaCheck = null;
  let nextQuotaAt = 0;
  let cursor = 0;
  let generation = 0;
  const displayedCounts = new Map();
  let focusMember;
  let previewMember = 'codex';

  const groups = new Map();
  // Several group chats per project: the first keeps the project's id, the others are "<project>~<suffix>".
  // A task belongs to the group it was sent from (task.group); tasks without one belong to the first group.
  const projectIdOf = (id) => String(id ?? '').split('~')[0];
  const endedGroups = new Set(temporary ? [] : store.get('endedGroups', []));
  function groupEnded(group) {
    if (!group) return false;
    if (!group.records.size) return endedGroups.has(group.id);
    const tasks = [...group.records.values()];
    if (tasks.some(task => !terminalTask.has(task.state))) return false;
    // A successful retry settles the failed/cancelled task it continued, including earlier attempts.
    const settled = new Set();
    for (const task of tasks) {
      if (task.state !== 'completed') continue;
      let id = task.id;
      while (id && !settled.has(id)) {
        settled.add(id);
        id = group.records.get(id)?.replyTo;
      }
    }
    return tasks.every(task => settled.has(task.id));
  }
  $('#groupStartNext').addEventListener('click', () => {
    const group = currentGroup();
    if (groupEnded(group)) A.openGroup(createGroup(group.project, { another: true }));
  });
  const groupNames = new Map(Object.entries(temporary ? {} : store.get('groupNames', {})));
  const belongs = (group, task) => task.group ? task.group === group.id : group.id === projectIdOf(group.id);
  function addGroup(id, tasks = []) {
    if (!A.proj(id) || groups.has(id)) return;
    groups.set(id, {
      id, project: projectIdOf(id), records: new Map(tasks.map((task) => [task.id, { ...task, group: task.group || id }])), selected: tasks.at(-1)?.id,
      approvals: new Map(), output: null, reference: null,
      draft: '', provider: '', model: '', taskError: '', statusError: '', pending: null, planReply: null,
    });
  }

  const savedProjects = temporary ? [] : store.get('groupProjectBindings', []);
  // A group project is only a folder for its group chats. Once its last group is deleted there is nothing
  // left to open in it, and neither the project menu nor a session menu can remove it, so drop the shell at
  // load instead of leaving a row in the sidebar that cannot be deleted.
  const storedGroupIds = temporary ? [] : store.get('projectGroups', []);
  const groupedProjects = new Set(storedGroupIds.map(projectIdOf));
  const keptProjects = savedProjects.filter((project) => groupedProjects.has(project.id));
  if (keptProjects.length !== savedProjects.length) {
    savedProjects.splice(0, savedProjects.length, ...keptProjects);
    if (!temporary) store.set('groupProjectBindings', savedProjects);
  }
  for (const project of savedProjects) {
    if (typeof project.id === 'string' && /^group-[a-f0-9-]+$/.test(project.id) && typeof project.name === 'string') {
      A.D.projects.push(project);
    }
  }

  // This computer's orchestrator workspaces no project is bound to yet. A workspace serves one project at a time:
  // its Bridge reads the active project's folder, so two projects on one workspace could snapshot the wrong one.
  function freeWorkspaces() {
    const bound = new Set(A.D.projects.map((project) => project.serverProject).filter(Boolean));
    return (routeState.projects || []).filter((id) => !bound.has(id));
  }
  // Who already uses this computer's workspace(s), for saying why a new project cannot connect.
  function workspaceUsers() {
    const own = new Set(routeState.projects || []);
    return A.D.projects.filter((project) => project.serverProject && own.has(project.serverProject)).map((project) => project.name);
  }
  // A new project connects to the orchestrator by default; the local example (nothing runs, replies are demo text)
  // has to be picked on purpose. It used to be the default, and projects made that way silently never worked.
  function syncProjectChoices() {
    if (!projectDialog.open) return;
    const chosen = projectBinding.value;
    const free = freeWorkspaces();
    // No local-example choice: a project made without a workspace never worked, so creating one is not offered.
    setHtml(projectBinding, free.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('') ||
      `<option value="">${!knownRoutes ? '正在读取主控工作区…' : '没有可用的主控工作区'}</option>`);
    if (projectBinding.dataset.touched && [...projectBinding.options].some((option) => option.value === chosen)) projectBinding.value = chosen;
    else projectBinding.value = free[0] || '';
    const hint = $('#groupProjectBindingHint');
    const users = workspaceUsers();
    hint.textContent = free.length ? '' : !knownRoutes ? '正在读取主控工作区…' : users.length
      ? `这台电脑的主控工作区已被项目「${users.join('」「')}」使用，一个工作区同一时间只能连一个项目。要连主控，请先删除或改用那个项目。`
      : '主控没有给这台电脑分配工作区，暂时不能新建项目。';
    hint.hidden = !hint.textContent;
  }
  projectBinding.addEventListener('change', () => { projectBinding.dataset.touched = '1'; });

  const legacy = store.get('macTask', null) || localStorage.getItem('agentdesk.macTask');
  const saved = LIVE && !temporary ? store.get('groupTasks', legacy ? [{ id: legacy }] : []) : [];
  const savedByGroup = temporary ? {} : store.get('groupTasksByProject', {});
  for (const id of store.get('projectGroups', [])) addGroup(id, id === liveProject ? saved : savedByGroup[id] || []);
  if (saved.length) addGroup(liveProject, saved);

  // Returns the new group's id. The first group of a project uses the project id; "another" adds one more.
  function createGroup(project, { another = false } = {}) {
    project = projectIdOf(project);
    let id = project;
    if (groups.has(project)) {
      if (!another) return project;
      id = project + '~' + crypto.randomUUID().slice(0, 8);
    }
    addGroup(id);
    if (!groups.has(id)) return false;
    const count = [...groups.keys()].filter((key) => projectIdOf(key) === project).length;
    groupNames.set(id, count === 1 ? '群聊' : '群聊 ' + count);
    store.set('groupNames', Object.fromEntries(groupNames));
    store.set('projectGroups', [...groups.keys()]);
    return id;
  }
  const nameOf = (id) => groupNames.get(id) || '群聊';
  const groupsOf = (project) => [...groups.keys()].filter((id) => projectIdOf(id) === project).map((id) => ({ id, name: nameOf(id) }));

  // A group project's folder comes from groupProjectBindings, not the workspace settings, so the project
  // menu cannot delete it. Once its last group is gone the folder has nothing to open and its local chats
  // have no home; remove both with the group instead of leaving an undeletable row in the sidebar.
  function dropGroupProject(projectId) {
    if (!/^group-[a-f0-9-]+$/.test(projectId)) return false;
    if ([...groups.keys()].some((id) => projectIdOf(id) === projectId)) return false;
    const index = savedProjects.findIndex((project) => project.id === projectId);
    if (index === -1 || A.proj(projectId)?.configured) return false;
    const dropped = A.D.sessions.filter((session) => session.project === projectId);
    const activeDropped = dropped.some((session) => session.id === state.active);
    savedProjects.splice(index, 1);
    if (!temporary) store.set('groupProjectBindings', savedProjects);
    const at = A.D.projects.findIndex((project) => project.id === projectId);
    if (at !== -1) A.D.projects.splice(at, 1);
    for (const session of dropped) A.D.sessions.splice(A.D.sessions.indexOf(session), 1);
    if (!state.group && activeDropped) {
      const next = A.D.sessions.find((session) => session.live) || A.D.sessions[0];
      if (next) A.openSession(next.id);
    }
    return true;
  }

  // Deleting a group removes it, its saved task list and the lead-dispatched records of its work from this
  // computer, after a warning. The tasks themselves stay on the orchestrator.
  function deleteGroup(id, { confirmed = false } = {}) {
    if (!groups.has(id)) return false;
    const records = window.__agentThreads?.threadsOf?.(id) || [];
    const projectId = projectIdOf(id);
    const lastInProject = ![...groups.keys()].some((key) => key !== id && projectIdOf(key) === projectId);
    const groupProject = !A.proj(projectId)?.configured && lastInProject && savedProjects.some((project) => project.id === projectId);
    const localChats = groupProject ? A.D.sessions.filter((session) => session.project === projectId).length : 0;
    const message = `删除「${nameOf(id)}」？\n\n将从本机一并删除：\n· 这个群聊的消息和任务列表\n· 组长派遣给成员的 ${records.length} 个只读记录（${records.map((s) => s.title).join('、') || '无'}）${groupProject ? `\n· 群聊项目「${A.proj(projectId)?.name || ''}」和它的 ${localChats} 个单聊会话` : ''}\n\n主控上的任务不会被删除；正在执行的任务会继续执行。此操作不能撤销。`;
    if (!confirmed && !window.confirm(message)) return false;
    groups.delete(id);
    endedGroups.delete(id);
    if (!temporary) store.set('endedGroups', [...endedGroups]);
    groupNames.delete(id);
    delete workbench[id];
    if (!temporary) store.set('groupWorkbench', workbench);
    delete savedByGroup[id];
    lastSeen.delete(id);
    store.set('groupNames', Object.fromEntries(groupNames));
    store.set('projectGroups', [...groups.keys()]);
    store.set('groupTasksByProject', savedByGroup);
    store.set('groupLastSeen', Object.fromEntries(lastSeen));
    if (id === liveProject) store.set('groupTasks', []);
    window.__agentThreads?.removeGroup?.(id);
    if (state.group === id) {
      const next = groupsOf(projectIdOf(id))[0]?.id || [...groups.keys()][0];
      if (next) A.openGroup(next);
      else A.openSession(A.D.sessions[0]?.id);
    }
    dropGroupProject(projectId);
    A.renderSidebar();
    A.toast(`已删除「${nameOf(id)}」及 ${records.length} 个派遣记录`);
    return true;
  }

  function removeProject(projectId) {
    const dropped = A.D.sessions.filter(session => session.project === projectId);
    const stages = store.get('sessionStages', {});
    for (const session of dropped) {
      delete stages[session.id];
      A.D.sessions.splice(A.D.sessions.indexOf(session), 1);
    }
    store.set('sessionStages', stages);
    for (const id of [...groups.keys()]) if (projectIdOf(id) === projectId) deleteGroup(id, { confirmed: true });
    const index = savedProjects.findIndex(project => project.id === projectId);
    if (index !== -1) savedProjects.splice(index, 1);
    if (!temporary) store.set('groupProjectBindings', savedProjects);
    const at = A.D.projects.findIndex(project => project.id === projectId);
    if (at !== -1 && !A.D.projects[at].configured) A.D.projects.splice(at, 1);
  }

  // Clearing keeps every group chat but drops its messages, task list and read-only dispatch records
  // from this computer. The orchestrator keeps its tasks, so a cutoff is written for each group to stop
  // the next project refresh from restoring the history. Work that updates later comes back on its own.
  function clearAllGroups() {
    if (!groups.size) return false;
    const taskTotal = [...groups.values()].reduce((sum, group) => sum + group.records.size, 0);
    const threadTotal = [...groups.keys()].reduce((sum, id) => sum + (window.__agentThreads?.threadsOf?.(id) || []).length, 0);
    const message = `清空全部 ${groups.size} 个群聊的消息记录？\n\n将从本机删除：\n· ${taskTotal} 条任务消息和任务列表\n· ${threadTotal} 个组长派遣的只读记录\n\n群聊本身保留；主控上的任务不会被删除，正在执行的任务下次更新时会重新出现。此操作不能撤销。`;
    if (!window.confirm(message)) return false;
    const now = Date.now();
    for (const [id, group] of groups) {
      if (groupEnded(group)) endedGroups.add(id);
      else endedGroups.delete(id);
      group.records.clear();
      group.expanded?.clear();
      group.summaryOpen?.clear();
      group.approvals.clear();
      group.selected = undefined;
      group.output = null;
      group.reference = null;
      group.planReply = null;
      group.taskError = '';
      group.statusError = '';
      clearedAt.set(id, now);
      lastSeen.delete(id);
      window.__agentThreads?.removeGroup?.(id);
      if (id === liveProject) store.set('groupTasks', []);
      else delete savedByGroup[id];
    }
    store.set('groupTasksByProject', savedByGroup);
    store.set('groupLastSeen', Object.fromEntries(lastSeen));
    store.set('groupClearedAt', Object.fromEntries(clearedAt));
    if (!temporary) store.set('endedGroups', [...endedGroups]);
    store.set('macTask', null);
    localStorage.removeItem('agentdesk.macTask');
    displayedCounts.clear();
    filter = 'all';
    filterSelect.value = '';
    updateFilters();
    A.renderSidebar();
    if (state.group) render();
    A.toast(`已清空 ${groups.size} 个群聊的记录`);
    return true;
  }

  const currentGroup = () => groups.get(state.group);

  // Attachments for the next group task: any file type, a folder as one .zip. The lead sees them while planning
  // and every member sees them in its step. They stay on this computer until the task is sent.
  const MAX_ATTACH = 10;
  const attachList = $('#groupAttachList');
  const fileApi = window.desk?.files;
  const appProjectOf = (group) => { const project = A.proj(group?.id); return project?.configured ? project.id : null; };
  function renderGroupAttachments() {
    const files = currentGroup()?.attachments || [];
    attachList.innerHTML = files.map((file) => `<button type="button" class="attach-pill" data-group-attachment="${esc(file.id)}" title="移除附件">${esc(file.name)}${file.folder ? `（文件夹 · ${file.folder.files} 个文件）` : ''} ×</button>`).join('');
    attachList.hidden = !files.length;
  }
  function addGroupFiles(group, { files = [], errors = [] }) {
    if (groupEnded(group)) { for (const file of files) fileApi.forgetChat(file.id); return; }
    group.attachments ||= [];
    const added = files.slice(0, Math.max(0, MAX_ATTACH - group.attachments.length));
    group.attachments.push(...added);
    for (const extra of files.slice(added.length)) fileApi.forgetChat(extra.id);
    const problem = errors.length || added.length < files.length ? errors.join('；') || `每个群聊任务最多附加 ${MAX_ATTACH} 个文件。` : '';
    // Success is announced too (it used to be silent): the files stay on this computer until the task is sent.
    const text = [problem, added.length && window.AgentDeskAttachNotice ? window.AgentDeskAttachNotice.added(added, 'group') : ''].filter(Boolean).join('；');
    if (text) A.toast(text);
    if (group === currentGroup()) renderGroupAttachments();
  }
  async function withGroupProject(work) {
    const group = currentGroup();
    if (groupEnded(group)) return;
    let project = appProjectOf(group);
    // A group project created from the orchestrator before projects were set up automatically: set it up now.
    if (!project && group && !isExample(group.id)) {
      const entry = A.proj(group.id);
      if (entry?.serverProject && await window.AgentDeskProjects?.ensureRegistered?.(entry)) project = appProjectOf(group);
    }
    if (!group || isExample(group.id) || !project || !fileApi?.pickChat) { A.toast('请先为这个项目连接主控，再添加附件。'); return; }
    try { addGroupFiles(group, await work(project)); } catch (error) { A.toast(error.message); }
  }
  const addFiles = (list) => withGroupProject((project) => fileApi.dropChat(project, list));
  $('#groupAttach').addEventListener('click', (event) => withGroupProject((project) => fileApi.pickChat(project, event.shiftKey)));
  attachList.addEventListener('click', (event) => {
    const id = event.target.closest('[data-group-attachment]')?.dataset.groupAttachment;
    const group = currentGroup();
    if (!id || !group) return;
    group.attachments = (group.attachments || []).filter((file) => file.id !== id);
    fileApi?.forgetChat(id);
    renderGroupAttachments();
  });
  input.addEventListener('paste', (event) => {
    const pasted = [...(event.clipboardData?.files || [])];
    if (!pasted.length) return;
    event.preventDefault();
    withGroupProject(async (project) => {
      const result = { files: [], errors: [] };
      for (const file of pasted) {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
        const name = file.name && file.name !== 'image.png' ? file.name : `粘贴文件-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace(/[^\w]/g, '') || 'bin'}`;
        const one = await fileApi.pasteChat(project, name, b64);
        result.files.push(...one.files);
        result.errors.push(...one.errors);
      }
      return result;
    });
  });
  const hasGroup = (id) => groups.has(id);
  const lastSeen = new Map(Object.entries(store.get('groupLastSeen', {})));
  const taskTime = (task) => Date.parse(task.updatedAt || task.createdAt || '') || task.time || 0;
  // Clearing a group hides the tasks that already existed. The cutoff is saved so the periodic project
  // refresh cannot bring the same history back; a task that updates after the cutoff shows up again.
  const clearedAt = new Map(Object.entries(store.get('groupClearedAt', {})));
  const isCleared = (id, task) => clearedAt.has(id) && taskTime(task) <= Number(clearedAt.get(id));
  function markSeen(group) {
    if (document.hidden) return;
    const time = Math.max(lastSeen.get(group.id) || 0, ...[...group.records.values()].map(taskTime));
    if (lastSeen.get(group.id) === time) return;
    lastSeen.set(group.id, time);
    store.set('groupLastSeen', Object.fromEntries(lastSeen));
  }
  function unreadCount(id) {
    const group = groups.get(id);
    if (!group) return 0;
    const seen = lastSeen.get(id) || 0;
    return [...group.records.values()].filter((task) => taskTime(task) > seen).length;
  }
  const getSelected = (group = currentGroup()) => group?.records.get(group.selected);
  const taskCount = (id = state.group) => {
    const records = groups.get(id)?.records;
    return records ? [...records.values()].filter((task) => !terminal.has(task.state) || task.state === 'needs_review').length : 0;
  };

  // A group chat is a workbench of its own: switching groups switches everything on the page — the draft,
  // the recipient and model, the attachments, the lead's effort, the right panel's tab and selected task, the
  // focused lane and where the conversation was scrolled to. Nothing carries over from one group to another.
  const workbench = temporary ? {} : store.get('groupWorkbench', {});
  function saveWorkbench(group) {
    if (!group || temporary || isExample(group.id)) return;
    workbench[group.id] = { panel: group.panel, leadEffort: group.leadEffort, leadModel: group.leadModel, approval: group.approval };
    store.set('groupWorkbench', workbench);
  }
  const leadEffortSelect = () => document.querySelector('#groupLeadEffort');
  function switchGroup(id) {
    if (state.group === id) return;
    const previous = currentGroup();
    if (previous) {
      markSeen(previous);
      previous.draft = input.value;
      previous.provider = provider.value;
      previous.model = model.value;
      previous.leadEffort = leadEffortSelect()?.value;
      previous.leadModel = document.querySelector('#groupLeadModel')?.value || '';
      previous.approval = document.querySelector('#groupApproval')?.value || 'small';
      previous.panel = state.panel;
      previous.scroll = timeline.scrollTop;
      previous.atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 70;
      previous.laneFocus = laneFocus;
      saveWorkbench(previous);
    }
    const next = groups.get(id);
    if (next) markSeen(next);
    input.value = next?.draft || '';
    provider.value = next?.provider || '';
    model.value = next?.model || '';
    const effort = next?.leadEffort || workbench[id]?.leadEffort || 'high';   // a new group starts at the default
    if (leadEffortSelect() && [...leadEffortSelect().options].some((option) => option.value === effort)) leadEffortSelect().value = effort;
    const leadModelSelect = document.querySelector('#groupLeadModel');
    if (leadModelSelect) {
      const wanted = next?.leadModel ?? workbench[id]?.leadModel ?? '';
      leadModelSelect.value = [...leadModelSelect.options].some((option) => option.value === wanted) ? wanted : '';
      if (next) next.leadModel = leadModelSelect.value;
    }
    fitLeadEffort();
    const approvalSelect = document.querySelector('#groupApproval');
    if (approvalSelect) approvalSelect.value = next?.approval || workbench[id]?.approval || 'small';
    laneFocus = next?.laneFocus || null;
    filter = 'all';
    filterSelect.value = '';
    focusMember = null;
    // Back where this group was left; a group opened for the first time starts at its latest message.
    timeline.scrollTop = 0;
    requestAnimationFrame(() => {
      if (state.group !== id) return;
      timeline.scrollTop = next?.scroll === undefined || next.atBottom ? timeline.scrollHeight : next.scroll;
    });
    setRecipient(next);
    hideSuggestions();
    updateFilters();
  }

  function persist(group) {
    if (isExample(group.id) || temporary) return;
    const records = [...group.records.values()].filter((task) => !task.redacted).map(({ id, prompt, provider, model, time, state, updatedAt, createdAt, replyTo, group }) =>
      ({ id, prompt, provider, model, time, state, updatedAt, createdAt, replyTo, group }));
    if (group.id === liveProject) store.set('groupTasks', records);
    else {
      savedByGroup[group.id] = records;
      store.set('groupTasksByProject', savedByGroup);
    }
  }

  function updateTask(group, id, summary, complete = false) {
    const previous = group.records.get(id) || {};
    const local = complete ? { prompt: previous.prompt, time: previous.time, replyTo: previous.replyTo, group: previous.group } : previous;
    const task = { ...local, ...summary, id };
    if (isCleared(group.id, task)) return;
    group.records.set(id, task);
    if (group === currentGroup()) markSeen(group);
    if (complete) persist(group);
  }

  const taskLabel = (task) => '#' + esc(task.id.slice(0, 8));
  const selectedRoute = () => routeState.route?.split(':')[0];
  const hasRoute = () => Boolean(routeState[selectedRoute()]);
  // Gemini CLI is retired: it only appears when an orchestrator still has it configured, never in the example.
  const canUse = (id) => !optional.includes(id) || (isExample(state.group) && id !== 'gemini') || routeState.providers?.includes(id);
  const canUseGemini = () => canUse('gemini');
  function availability(id) {
    if (canUse(id)) return isExample(state.group) ? '本地示例' : '可派活';
    if (!knownRoutes && supported) return '正在检测';
    return knownRoutes && !connected ? '主控离线' : '主控未配置';
  }
  const memberName = (id) => members[id]?.name || id || members.lead.name;
  const owner = (task) => task.provider || 'lead';
  const waitingForPlan = (task) => ['awaiting_details', 'awaiting_approval'].includes(task.state);
  // The group's most recent task (its conversation with the lead continues from there).
  const latestTask = (group) => [...(group?.records.values() || [])].filter((task) => belongs(group, task))
    .sort((a, b) => (Date.parse(b.createdAt || '') || b.time || 0) - (Date.parse(a.createdAt || '') || a.time || 0))[0];
  const statusName = (status) => statuses[status] || '待同步';
  const pill = (status) => `<span class="group-pill" data-status="${statuses[status] ? status : 'unknown'}">${statusName(status)}</span>`;
  function textOf(detail) {
    if (details[detail]) return details[detail];
    const waiting = /:waiting:(\w+)$/.exec(detail || '');
    if (waiting) return `等待 ${memberName(waiting[1])} 空闲：同一时间每个 AI 只跑一个任务，可能有其他成员正在使用。`;
    const executor = /^executor_waiting:(\w+)$/.exec(detail || '');
    if (executor) return `等待 ${memberName(executor[1])} 可用：额度或登录状态恢复后自动继续，不会改派给其他成员。`;
    const moved = /:reassigned:(\w+)->(\w+):(quota|auth|busy)$/.exec(detail || '');
    if (moved) return `${memberName(moved[1])} ${{ quota: '额度用尽', auth: '需要重新登录', busy: '正忙' }[moved[3]]}，改由 ${memberName(moved[2])} 接手。`;
    const switched = /^([\w-]+):model_switch:(\w+):([^>]+)->(.+):stalled$/.exec(detail || '');
    if (switched) return `${memberName(switched[2])} 卡住了，先换模型重试：${switched[3] === 'default' ? '默认模型' : switched[3]} → ${switched[4]}。`;
    const stalled = /^([\w-]+):stalled:(\w+):(\d+)$/.exec(detail || '');
    if (stalled) return `${memberName(stalled[2])} 超过 ${stalled[3]} 分钟没有任何输出，已自动停止；先换模型重试，再不行交给组长。`;
    if (/:stopped_by_person$/.test(detail || '')) return '你停止了这一步，交给组长重新安排。';
    if (/:steered$/.test(detail || '')) return '你在成员的单聊里给了指导，它正按你的话继续。';
    if (/:revised_out$/.test(detail || '')) return '有一步按你的新方向停下了。';
    if (/^mirror_synced:/.test(detail || '')) return '你本机有 VPS2 还没有的提交，已经自动同步过去（只传缺的部分），不用手动推送。';
    if (/^snapshot_skipped:\d+$/.test(detail || '')) return `项目快照没有带上 ${detail.split(':')[1]} 个敏感文件（如 .env、密钥）的改动，组长和成员看不到它们；其余未提交的改动和新文件都已带上。`;
    const handed = /^([\w-]+):(handover|chosen):([^/>]+)(?:\/([^>]*))?->([^/]+)(?:\/(.*))?$/.exec(detail || '');
    if (handed) return `${memberName(handed[3])}${handed[4] ? '（' + handed[4] + '）' : ''}没完成，${handed[2] === 'chosen' ? '按你的选择' : '已直接'}交给 ${memberName(handed[5])}${handed[6] ? '（' + handed[6] + '）' : ''} 接着它的改动做。`;
    if (/:needs_choice$/.test(detail || '')) return '这一步没人能完成，请选择接手的模型。';
    const asked = /^([\w-]+):permission_requested:(\w+)$/.exec(detail || '');
    if (asked) return `${asked[1]} 因为权限不够没做完，组长申请临时给它开「${ACCESS_NAMES[asked[2]] || asked[2]}」，等你批准。`;
    const access = /^([\w-]+):access_(granted|granted_task|denied|advised)$/.exec(detail || '');
    if (access) return { granted: `你允许了 ${access[1]} 这一步的临时权限，它接着原来的进度做。`, granted_task: `你允许了这项任务里同类的临时权限，${access[1]} 接着原来的进度做。`,
      denied: `你没有允许 ${access[1]} 的权限申请，它会不用这个权限把能做的做完。`, advised: `组长认为 ${access[1]} 不需要更多权限，给了它另一个做法，它接着做。` }[access[2]];
    const adjusted = /^([\w-]+):adjusted:([^/]+)(?:\/(.*))?$/.exec(detail || '');
    if (adjusted) return `你把 ${adjusted[1]} 改由 ${memberName(adjusted[2])}${adjusted[3] ? '（' + adjusted[3] + '）' : ''} 来做。`;
    const stepFailed = /^step_failed:([\w-]+):(\w+)$/.exec(detail || '');
    if (stepFailed) return `${memberName(stepFailed[2])} 的步骤失败，交给组长诊断后再决定重试还是改派。`;
    const round = /^reassign_started:([\w-]+):(\d+)\/(\d+)$/.exec(detail || '');
    if (round) return `组长正在诊断这个环节（第 ${round[2]}/${round[3]} 次），诊断后才决定重试还是改派。`;
    const unavailable = /^triage_unavailable(?::(\w+))?$/.exec(detail || '');
    if (unavailable) {
      const at = resetClock(quotaResetAt('claude'));
      if (unavailable[1] === 'quota') return `组长 Claude 的额度已到上限，暂时不能诊断${at ? `，预计 ${at} 恢复` : ''}；恢复后会自动继续，不会改派给其他成员。`;
      if (unavailable[1] === 'auth') return '组长 Claude 需要重新登录，登录后会自动继续诊断；不会改派给其他成员。';
      return '组长 Claude 正忙，稍后自动继续诊断；不会改派给其他成员。';
    }
    const byLead = /:reassigned_by_lead:(\w+)(?:\/([^>]+))?->(\w+)(?:\/(.+))?$/.exec(detail || '');
    if (byLead) {
      const who = (role, model) => memberName(role) + (model ? `（${model}）` : '');
      return `组长把这个环节从 ${who(byLead[1], byLead[2])} 改派给 ${who(byLead[3], byLead[4])}。`;
    }
    const limit = /^reassign_limit(?::([\w-]+))?$/.exec(detail || '');
    if (limit) return '这个环节已重新安排 3 次仍然失败，任务结束。';
    const escalated = /^escalated:(\w+)$/.exec(detail || '');
    if (escalated) return '任务遇到问题，已升级给组长处理。';
    const decision = /^triage_decision:(\w+)$/.exec(detail || '');
    if (decision) return `组长诊断结论：${triageNames[decision[1]] || decision[1]}。`;
    const verdict = /^acceptance_verdict:(\w+)$/.exec(detail || '');
    if (verdict) return `验收结论：${acceptanceNames[verdict[1]] || verdict[1]}。`;
    const fix = /^(fix-\d+):(started|completed|failed)$/.exec(detail || '');
    if (fix) return fix[2] === 'started' ? '返工步骤开始执行。' : fix[2] === 'completed' ? '返工步骤完成，等待重新验收。' : '返工步骤失败。';
    const continuing = /^([\w-]+):continuing:(\d+)\/(\d+)$/.exec(detail || '');
    if (continuing) return `${continuing[1]} 的 CLI 到达单次输出时限，正在同一会话续跑（第 ${continuing[2]}/${continuing[3]} 次），不会重复已确认的写入。`;
    return detail;
  }
  // A CLI's exit message in words a person can act on; the original sentence stays after the colon.
  function errorText(error) {
    const raw = String(error || '').trim();
    const model = /invalid model selection/i.test(raw) && /--model "([^"]+)"/.exec(raw);
    if (model) return `模型 ${model[1]} 不可用或与推理强度不匹配（CLI 拒绝执行）：${raw}`;
    if (/^cli_auth_required/i.test(raw)) return `成员的登录已过期，需要重新登录：${raw}`;
    if (/^cli_quota_exhausted/i.test(raw)) return `成员的额度已用完：${raw}`;
    if (/^cli_print_timeout/i.test(raw)) return `成员的 CLI 到达单次输出时限，会话已保留，将尝试有限续跑：${raw}`;
    if (/^write_failed:/i.test(raw)) return `本机文件写入未得到确认，步骤不能算完成：${raw}`;
    if (/^cli_exit_\d+/i.test(raw)) return `成员的命令行异常退出：${raw}`;
    return raw;
  }
  // What an unfinished task is doing or waiting for, in words, with how long it has been quiet. A running step
  // whose CLI has written nothing for a while is flagged, so a stall is visible instead of a silent spinner.
  const STALL_MINUTES = 8;
  const ago = (iso) => {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return seconds < 60 ? seconds + ' 秒' : seconds < 3600 ? Math.round(seconds / 60) + ' 分钟' : (seconds / 3600).toFixed(1) + ' 小时';
  };
  const whyNot = { auth: '需要登录', quota: '额度不够', cooling: '冷却中', busy: '正忙', unconfigured: '未配置' };
  function liveLine(task) {
    const live = task.live;
    if (!live || task.redacted) return '';
    const lines = [];
    for (const step of live.steps || []) {
      const who = memberName(step.role === 'claude' ? 'lead' : step.role);
      if (step.state === 'running') {
        const quiet = step.lastOutputAt ? (Date.now() - Date.parse(step.lastOutputAt)) / 60000 : null;
        const stalled = quiet !== null ? quiet >= STALL_MINUTES : step.startedAt && (Date.now() - Date.parse(step.startedAt)) / 60000 >= STALL_MINUTES;
        lines.push(`<li class="${stalled ? 'stalled' : ''}"><b>${esc(who)}</b> 正在执行${step.startedAt ? '，已 ' + ago(step.startedAt) : ''}；${step.lastOutputAt ? '最后一次输出在 ' + ago(step.lastOutputAt) + '前' : '还没有任何输出'}${stalled ? '。<em>超过 ' + STALL_MINUTES + ' 分钟没有动静，可能卡住了</em>；10 分钟没有任何输出时主控会自动停掉它，先换模型重试，再不行交给组长' : ''}
          <button type="button" class="task-text-link" data-stop-step="${esc(task.id)}" data-step="${esc(step.id)}" title="停掉这一步，交给组长换成员或换模型重新安排；任务本身继续">停止这一步</button></li>`);
      } else if (step.state === 'waiting_member') {
        const holder = step.holder;
        const where = !holder ? '' : holder.prompt ? `另一个任务「${esc(holder.prompt)}」` : '这个任务的另一步';
        lines.push(`<li><b>${esc(who)}</b> 正在忙${where ? '（' + where + '，已 ' + ago(holder.since) + '）' : ''}，这一步排队等它；同类活里没有空闲成员可以接手。</li>`);
      }
    }
    if (live.waitingFor) {
      const reasons = Object.entries(live.reasons || {}).map(([role, info]) => `${memberName(role === 'claude' ? 'lead' : role)}：${whyNot[info.reason] || info.reason}${info.until ? '（' + new Date(info.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' 恢复）' : ''}`);
      lines.push(`<li>等待能做「${esc(capabilityLabels[live.waitingFor] || live.waitingFor)}」的成员：${esc(reasons.join('；') || '没有已配置的成员')}${live.notBefore ? '，' + new Date(live.notBefore).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' 再试' : ''}。</li>`);
    }
    return lines.length ? `<ul class="task-live">${lines.join('')}</ul>` : '';
  }

  // Why a task failed, in words: the failing step and its error when there is one, else the task's detail.
  function failureReason(task) {
    const step = (task.steps || []).findLast((item) => item.state === 'failed');
    const detail = String(task.detail || '');
    const known = details[detail] || details[detail.split(':')[0]];
    if (step) return `${memberName(step.role === 'claude' ? 'lead' : step.role)} 的${capabilityLabels[step.capability] || '步骤'}失败：${String((step.error && errorText(step.error)) || detail || '未知错误').slice(0, 300)}`;
    return known || (detail ? detail.slice(0, 300) : '主控没有说明原因。');
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
    $('#sbGroupMembers').hidden = $('#sbQuota').hidden = $('#sbResources').hidden = !state.group;
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

  function messageRow(id, metadata, body, kind = 'text') {
    return `<article class="group-message" data-kind="${kind}" data-member="${id === 'claude' ? 'lead' : id}">${avatars.html(id, { still: true })}<div class="group-message-content">
      <header><strong>${memberName(id)}</strong>${metadata ? `<span>${esc(metadata)}</span>` : ''}</header>${body}
    </div></article>`;
  }

  function planMessages(task) {
    const show = (id) => (!filterSelect.value || filterSelect.value === id) && (filter !== 'mine' || id === 'you');
    if (task.redacted) return [];
    const disabled = busy || (!isExample(state.group) && !connected) ? 'disabled' : '';
    return (task.plan?.rounds || []).flatMap((round, index, rounds) => {
      const active = index === rounds.length - 1 && waitingForPlan(task);
      const localToolLabels = { files: '本机文件', commands: '本机命令', desktop: '本机桌面' };
      const steps = round.steps?.map((step) => `<li><strong>${esc(memberName(step.role))}</strong>${typeof step.write === 'boolean' ? (step.write ? '（可生成补丁）' : '（只读）') : ''}${Object.hasOwn(localToolLabels, step.localTools) ? ' · ' + localToolLabels[step.localTools] : ''} ${esc(step.prompt)}</li>`).join('');
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
      </div>`, round.questions ? 'question' : 'steps'));
      if (round.reply && show('you')) messages.push(messageRow('you', '回复组长', `<p class="group-user-text">${esc(round.reply)}</p>`));
      return messages;
    });
  }

  function acceptApproval(project, message) {
    const group = groups.get(project);
    // 审批属于发起请求的线程所绑定的项目，且只接入当前打开的群。
    if (!group || group !== currentGroup() || !approvals.permitted(message.method)) return false;
    const scope = approvals.identity(message);
    const params = message.params || {};
    const card = { id: crypto.randomUUID(), message, scope, state: 'pending',
      questions: message.method === approvals.question && Array.isArray(params.questions) ? params.questions.slice(0, 10) : null };
    if (scope && approvals.load(localStorage, project).some((rule) => approvals.matches(rule, scope))) {
      respondApproval(group, card, true);
      return true;
    }
    group.approvals.set(card.id, card);
    repaint();
    return true;
  }

  async function respondApproval(group, card, accept, { remember, answers } = {}) {
    if (card.state !== 'pending') return;
    card.state = 'sending';
    const { message } = card;
    const response = approvals.decision(message.method, accept, answers);
    const sent = await window.desk.codex.respond(message.id, response).catch(() => false);
    if (sent && accept && remember) approvals.remember(localStorage, group.id, card.scope);
    card.state = sent ? (accept ? 'approved' : 'declined') : 'expired';
    if (group === currentGroup()) repaint();
  }

  function approvalCards(group) {
    return [...group.approvals.values()].map((card) => {
      const params = card.message.params || {};
      const command = Array.isArray(params.command) ? params.command.join(' ') :
        params.command || params._meta?.tool_params?.command || params.grantRoot;
      const pending = card.state === 'pending';
      const outcome = { sending: '提交中', approved: '已批准', declined: '已拒绝', expired: '请求已过期' }[card.state];
      const form = `<form data-group-approval="${card.id}" class="group-plan group-approval">
        <strong>${card.questions ? 'Codex 提问' : 'Codex 请求授权'}</strong>
        <p>${esc(params.reason || params.message || params.cwd || '')}</p>
        ${command ? `<pre>${esc(String(command).slice(0, 4000))}</pre>` : ''}
        ${card.questions ? card.questions.map((question, index) => `<label>${esc(question.question || question.header || '')}
          ${pending ? `<input name="question-${index}" maxlength="2000" required />` : ''}</label>`).join('') : ''}
        ${pending ? `<div class="task-actions">
          <button class="btn primary" type="submit">${card.questions ? '提交回答' : '批准本次'}</button>
          <button class="btn" type="button" data-group-approval-deny>拒绝</button>
          ${card.scope ? '<label><input type="checkbox" name="remember" /> 在本群记住此线程、工具和目录</label>' : ''}
        </div>` : `<p role="status">${outcome}</p>`}
      </form>`;
      return messageRow('codex', '', form, card.questions ? 'question' : 'approval');
    }).join('');
  }

  timeline.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-group-approval]');
    const group = currentGroup();
    const card = group?.approvals.get(form?.dataset.groupApproval);
    if (!card) return;
    event.preventDefault();
    const data = new FormData(form);
    const answers = card.questions && Object.fromEntries(card.questions.map((question, index) =>
      [question.id, { answers: [data.get('question-' + index)] }]));
    respondApproval(group, card, true, { remember: data.has('remember'), answers });
  });

  const RECENT_TASKS = 4;
  const threadRoles = new Set(['codex', 'grok', 'gemini', 'antigravity']);   // members only; the lead works in the group itself
  const capabilityLabels = { plan: '规划', triage: '诊断', scout: '侦察', implement: '改代码', review: '审查', research: '查资料', accept: '验收' };
  const stepStates = { queued: '排队', waiting: '等待', running: '执行中', completed: '完成', failed: '失败',
    replaced: '已重新分配', cancelled: '已停止', skipped: '未执行', stopped: '已中止', proposed: '待你确认', waiting_choice: '等你选接手', waiting_permission: '等你批权限' };
  // The kinds of temporary access the lead may ask for (scheduler ACCESS_KINDS); credential and system folders never.
  const ACCESS_NAMES = { files_read: '读你电脑上的一个文件夹', files_write: '改你电脑上一个文件夹里的文件（项目以外）',
    commands: '在你电脑上运行一条命令', desktop: '操作桌面' };
  const terminalTask = new Set(['completed', 'failed', 'cancelled']);
  // A step still marked running or queued under a task that has already ended was cut off; show that
  // instead of a live state that contradicts the task.
  function stepDisplay(task, state) {
    if (!terminalTask.has(task.state)) return state;
    if (state === 'running') return 'stopped';
    if (['queued', 'pending', 'proposed', 'waiting'].includes(state)) return 'skipped';
    return state;
  }

  function milestone(step) {
    const text = step.verdict?.summary || step.error || step.output || '';
    const line = text.trim().split('\n').find((part) => part.trim()) || '';
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
  }

  // A short closing summary for the group: the member's verdict, or the opening lines of its final reply.
  // The group message folds it; expanding asks for a longer excerpt (the full text stays in the member's chat).
  function closingSummary(step, limit = 260) {
    if (step.verdict?.summary) return step.verdict.summary;
    const text = (step.error || step.output || '').trim();
    if (!text) return '';
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
    return lines.length > limit ? lines.slice(0, limit) + '…' : lines;
  }

  function stepBoard(task, steps) {
    if (!steps.length) return '';
    const rows = steps.map((step) => {
      const open = !task.redacted && threadRoles.has(step.role);
      const tag = open ? 'button' : 'div';
      const attrs = open ? `type="button" data-agent-thread="${step.role}" data-agent-task="${esc(task.id)}" data-agent-step="${esc(step.id)}" title="打开 ${esc(memberName(step.role))} 单聊"` : '';
      const what = [capabilityLabels[step.capability] || (step.write ? '修改' : ''), step.model].filter(Boolean).join(' · ');
      const tried = (step.history || []).map((entry) => memberName(entry.role) + (entry.model ? ' ' + entry.model : ''));
      // The counter is the escalation round: it grows when the step fails, before the lead has decided
      // whether to retry the same member or reassign. Say「等待组长诊断」until that decision is made.
      const triaging = task.state === 'triaging' && step.state === 'failed';
      const waiting = triaging && String(task.detail || '').startsWith('triage_unavailable');
      const progress = !step.reassigns ? ''
        : triaging ? `${waiting ? '等待' : ''}组长诊断 ${step.reassigns}/3` : `重排 ${step.reassigns}/3`;
      // A step the lead replaced after it failed keeps its failure on the progress board, in red, with the error.
      const failedRecord = step.state === 'failed' || (step.state === 'replaced' && Boolean(step.error || step.history?.length));
      const note = step.state === 'replaced'
        ? (failedRecord ? `失败记录 · ${milestone(step) || '已由新步骤接替'}` : '已由新步骤接替')
        : step.reassigns ? `${progress} · 之前：${tried.join('、')}${milestone(step) ? ' · ' + milestone(step) : ''}` : milestone(step);
      const shown = stepDisplay(task, step.state || 'queued');
      return `<${tag} class="step-row${failedRecord ? ' failed-record' : ''}" data-state="${esc(shown)}" data-member="${step.role === 'claude' ? 'lead' : esc(step.role)}" data-flight-to="${esc(task.id + ':' + step.id)}" data-step-anchor="${esc(task.id + ':' + step.id)}" style="--node-color:${window.AgentDeskLight?.colour(step.role) || 'var(--accent)'}" ${attrs}>
        ${shown === 'running' ? window.AgentDeskLight?.border(step.role) || '' : ''}<span class="step-node" aria-hidden="true"></span>
        ${avatars.html(step.role, { size: 22, still: true })}
        <span class="step-row-name">${esc(memberName(step.role))}</span>
        <span class="step-row-what">${esc(what)}</span>
        <span class="step-row-state">${esc(stepStates[shown] || shown || '排队')}</span>
        <span class="step-row-note">${esc(note)}</span>
        ${['queued', 'proposed', 'waiting_choice'].includes(shown) && step.role !== 'claude' && !['plan', 'triage', 'accept'].includes(step.capability) ? `<span class="step-row-adjust" role="button" tabindex="0" data-step-adjust="${esc(task.id + ':' + step.id)}" title="换成别的成员、模型或思考程度">换模型</span>` : ''}
        ${open ? '<span class="step-row-open">单聊 ›</span>' : ''}
      </${tag}>`;
    }).join('');
    return `<div class="step-board">${rows}</div>`;
  }

  function foldedTask(task) {
    const steps = task.steps || [];
    const roles = [...new Set(steps.map((step) => step.role))].map(memberName).join('、');
    const summary = [task.prompt ? task.prompt.slice(0, 36) + (task.prompt.length > 36 ? '…' : '') : '', roles, steps.length ? steps.length + ' 步' : '']
      .filter(Boolean).join(' · ');
    return `<div class="dispatch-thread folded" data-message-id="${esc(task.id)}">
      <button type="button" class="group-folded" data-expand-task="${esc(task.id)}">
        <span class="mono">${taskLabel(task)}</span>${pill(task.state)}<span>${esc(summary)}</span><span class="group-folded-more">展开</span>
      </button></div>`;
  }

  // The lead's own reasoning while it plans: read from its planning step's working record, on demand.
  // Expanded records refresh while the lead is still planning.
  const leadThoughts = new Map();   // taskId -> { activity, at, state }
  const localTests = new Map();
  function localTestActivity(task) {
    const entry = localTests.get(task.id);
    if (task.detail === 'isolated_test_sync' && task.isolatedSync) {
      return `<p class="panel-note">正在同步 Windows 测试版本 ${esc(task.isolatedSync.version.slice(0, 12))}</p>`;
    }
    if (task.isolatedTest) {
      const test = task.isolatedTest;
      const result = Number.isInteger(test.code) ? (test.code === 0 ? '已通过' : '失败，退出码 ' + test.code) : '等待结果';
      const logs = [test.stdout, test.stderr].filter(Boolean).join('\n');
      const live = task.state === 'testing' && entry?.activity?.items?.length ? window.__activity.html(entry.activity, {
        key: 'local-test:' + task.id, running: true, commandScope: { taskId: task.id, stepId: 'local-test' },
      }) : '';
      return `<details class="lead-think" data-step="local-test:${esc(task.id)}" data-local-test="${esc(task.id)}"><summary>Windows 隔离测试 · ${esc(result)}</summary>
        <p class="panel-note">版本 ${esc(test.version.slice(0, 12))} · 传输 ${test.transferred} 字节</p>
        ${live || (logs ? `<pre>${esc(logs)}</pre>` : '')}</details>`;
    }
    const body = entry?.activity?.items?.length ? window.__activity.html(entry.activity, {
      key: 'local-test:' + task.id, running: task.state === 'testing',
      commandScope: { taskId: task.id, stepId: 'local-test' },
    }) : `<p class="panel-note">${entry?.error ? esc(entry.error) : '展开后读取本机测试输出'}</p>`;
    return `<details class="lead-think" data-step="local-test:${esc(task.id)}" data-local-test="${esc(task.id)}">
      <summary>本机测试输出${task.state === 'testing' ? '<span class="lead-live">运行中</span>' : ''}</summary>${body}</details>`;
  }

  async function loadLocalTest(group, id) {
    const entry = localTests.get(id) || {};
    if (entry.loading) return;
    entry.loading = true;
    localTests.set(id, entry);
    try {
      entry.activity = await control('task_activity', { taskId: id, stepId: 'local-test' });
      entry.error = '';
    } catch (error) { entry.error = error.message; }
    finally {
      entry.loading = false;
      if (group === currentGroup()) render();
    }
  }
  function leadThinking(task) {
    if (task.redacted || isExample(state.group) || !(task.plan?.rounds?.length || task.state === 'planning') || !window.__activity) return '';
    const entry = leadThoughts.get(task.id);
    const live = task.state === 'planning';
    const body = entry?.activity?.items?.length
      ? window.__activity.html(entry.activity, { key: 'lead:' + task.id, running: live })
      : `<p class="panel-note">${entry ? (entry.error ? '读取失败：' + esc(entry.error) : '还没有记录到思考内容') : '展开后读取…'}</p>`;
    return `<details class="lead-think" data-step="lead:${esc(task.id)}" data-lead-think="${esc(task.id)}">
      <summary>组长 Opus 的思考过程${live ? '<span class="lead-live">思考中</span>' : ''}${entry?.activity?.items?.length ? `<small>${entry.activity.items.length} 条</small>` : ''}</summary>${body}</details>`;
  }
  async function loadLeadThinking(group, id) {
    const entry = leadThoughts.get(id) || {};
    if (entry.loading) return;
    entry.loading = true;
    leadThoughts.set(id, entry);
    try {
      entry.activity = await control('task_activity', { taskId: id, stepId: 'group-planner' })
        .catch(() => control('task_activity', { taskId: id, stepId: 'planner' }));
      delete entry.error;
    } catch (error) {
      entry.error = error.message;
    } finally {
      entry.loading = false;
      entry.at = Date.now();
      if (group === currentGroup()) render();
    }
  }
  // Keep open records of a lead that is still planning up to date.
  setInterval(() => {
    const group = currentGroup();
    if (!group || !state.group) return;
    for (const details of $$('details[data-lead-think][open]', timeline)) {
      const task = group.records.get(details.dataset.leadThink);
      if (task?.state === 'planning') loadLeadThinking(group, task.id);
    }
    for (const details of $$('details[data-local-test][open]', timeline)) {
      const task = group.records.get(details.dataset.localTest);
      const entry = task && localTests.get(task.id);
      if (task && (task.state === 'testing' || entry?.activity?.state === 'testing')) loadLocalTest(group, task.id);
    }
  }, 3000);
  timeline.addEventListener('toggle', (event) => {
    const details = event.target;
    if (details.matches?.('details[data-local-test]') && details.open && state.group && !localTests.has(details.dataset.localTest)) {
      loadLocalTest(currentGroup(), details.dataset.localTest);
    }
    if (!details.matches?.('details[data-lead-think]') || !details.open || !state.group) return;
    loadLeadThinking(currentGroup(), details.dataset.leadThink);
  }, true);

  const stepProgress = (records) => [...records.values()].flatMap((task) =>
    (task.steps || []).map((step) => ({ key: task.id + ':' + step.id, state: step.state, role: step.role })));
  // The step a node click is locating, so a live re-render keeps the conversation on it instead of jumping away.
  let laneLocateTarget = '';
  let laneLocateAt = 0;
  function renderTimeline() {
    const group = currentGroup();
    const ended = groupEnded(group);
    const { records } = group;
    const broadcasts = new Set();
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 70;
    const scrollTop = timeline.scrollTop;
    const ordered = [...records.values()].sort((a, b) => (Date.parse(a.createdAt || '') || a.time || 0) - (Date.parse(b.createdAt || '') || b.time || 0)).filter((task) => filter !== 'attention' || task.state === 'needs_review' || waitingForPlan(task));
    // Finished tasks beyond the most recent few fold into one line each, so the group does not grow without end.
    const folded = new Set(ordered.slice(0, -RECENT_TASKS).filter((task) => ['completed', 'failed', 'cancelled'].includes(task.state) && !group.expanded?.has(task.id)).map((task) => task.id));
    const html = ordered.map((task) => {
      if (folded.has(task.id)) return foldedTask(task);
      const sender = task.plan && !task.plan.approved ? 'lead' : owner(task);
      const steps = task.steps || [];
      const acceptance = acceptanceLabel(task);
      const stats = task.metrics || task;
      const badges = [
        task.owner ? '提交人 ' + task.owner : '',
        task.project ? '项目 ' + task.project : '',
        task.broadcastId ? '广播' : modeLabels[task.mode],
        task.via === 'wechat' ? '微信' : '',
        stats.testFailures ? '测试失败 ' + stats.testFailures : '',
        stats.reworkRounds ? '返工 ' + stats.reworkRounds : '',
        stats.reviewConflicts ? '冲突 ' + stats.reviewConflicts : '',
        task.container?.memPeak ? '容器峰值 ' + Math.ceil(task.container.memPeak / 1024 ** 2) + ' MB' : '',
      ].filter(Boolean);
      const cardDetail = task.detail === 'patches_ready' ? textOf(task.detail)
        : [steps.length ? steps.length + ' 个步骤' : '', pathsOf(task).length ? pathsOf(task).length + ' 个文件' : '', elapsed(task)].filter(Boolean).join(' · ') || '查看调度图';
      const card = `<button class="dispatch-card" type="button" data-task-id="${esc(task.id)}" data-task-view="graph">
        <span class="dispatch-top"><span class="dispatch-icon">${svg('term')}</span><strong>任务 <span class="mono">${taskLabel(task)}</span></strong>${pill(task.state)}</span>
        <span class="dispatch-detail">${esc([
          task.stage ? '阶段 ' + stageLabel(task.stage) : '',
          acceptance ? '验收 ' + acceptance : '',
          cardDetail,
        ].filter(Boolean).join(' · '))}</span>
        ${badges.length ? `<span class="group-task-badges">${badges.map((badge) => `<span>${esc(badge)}</span>`).join('')}</span>` : ''}
        ${quotaCharge(task, { compact: true })}
      </button>${!task.redacted && task.state && !terminal.has(task.state) && task.state !== 'needs_review' ? `<div class="task-stop-row"><button type="button" class="task-stop" data-stop-task="${esc(task.id)}" title="停止这个任务：正在运行的成员会被停下，已经生成的补丁不会应用">${svg('x')}停止任务</button></div>` : ''}${liveLine(task)}${!task.redacted ? (task.steps || []).filter((step) => step.state === 'waiting_permission').map((step) => `<div class="task-addition"><p>组长申请给 ${esc(memberName(step.role))} 临时开「${esc(ACCESS_NAMES[step.permissionRequest?.kind] || '')}」。</p><div class="task-actions"><button type="button" class="btn primary" data-permission-open="${esc(task.id + ':' + step.id)}">查看并批准</button></div></div>`).join('') : ''}${!task.redacted ? (task.steps || []).filter((step) => step.state === 'waiting_choice').map((step) => `<div class="task-addition"><p>${esc(memberName(step.role))} 这一步没完成，等你选接手的模型。</p><div class="task-actions"><button type="button" class="btn primary" data-handover-open="${esc(task.id + ':' + step.id)}">选择接手的模型</button></div></div>`).join('') : ''}${['failed', 'cancelled'].includes(task.state) && !task.redacted ? `<div class="task-failure">
        <p>${task.state === 'cancelled' ? '任务已取消，可在本群补充要求或重新安排。' : '<b>为什么失败：</b>' + esc(failureReason(task))}</p>
        <div class="task-actions">${ended ? '' : `<button type="button" class="btn primary" data-retry-task="${esc(task.id)}">让组长重新来</button>`}
        <button type="button" class="task-text-link" data-task-id="${esc(task.id)}" data-task-view="terminal">看输出 ${svg('chev')}</button></div></div>` : ''}`;
      const messages = [];
      const requiresReview = task.detail === 'patches_ready' || task.pendingRequest;
      if (task.prompt && !task.redacted && (!task.broadcastId || !broadcasts.has(task.broadcastId)) &&
          (!filterSelect.value || filterSelect.value === 'you')) {
        if (task.broadcastId) broadcasts.add(task.broadcastId);
        const time = task.time ? new Date(task.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        const quote = task.replyTo ? `<button class="group-quote" type="button" data-reference-jump="${esc(task.replyTo)}">查看引用 #${esc(task.replyTo.slice(0, 8))}</button>` : '';
        messages.push(messageRow('you', [memberName(sender), time].filter(Boolean).join(' · '), `${quote}<p class="group-user-text">${esc(task.prompt)}</p>`));
      }
      if (filter !== 'mine' && (!filterSelect.value || filterSelect.value === sender)) {
        messages.push(messageRow(sender, task.model || members[sender]?.role, card, 'dispatch'));
      }
      messages.push(...planMessages(task));
      const thinking = leadThinking(task);
      if (thinking && filter !== 'mine' && (!filterSelect.value || filterSelect.value === 'lead')) {
        messages.push(messageRow('lead', '思考过程', thinking, 'thinking'));
      }
      if (filter !== 'mine' && !filterSelect.value) {
        for (const note of reassignments(task)) messages.push(`<p class="group-system">${esc(note)}</p>`);
        for (const note of systemNotes(task)) messages.push(`<p class="group-system" data-kind="event">${esc(note)}</p>`);
      }
      if (requiresReview && (!filterSelect.value || filterSelect.value === 'local')) {
        const title = task.detail === 'patches_ready' ? '待审核的本机补丁' : '待核对的本机操作';
        const writer = !task.redacted && steps.findLast((step) => step.write && threadRoles.has(step.role));
        messages.push(messageRow('local', '工作区', `<div class="group-review">
          <strong>${svg('shield')}${title}</strong>
          ${writer ? `<button type="button" class="btn primary" data-agent-thread="${writer.role}" data-agent-task="${esc(task.id)}" data-agent-step="${esc(writer.id)}">在 ${esc(memberName(writer.role))} 单聊中审核</button>` : ''}
          <button type="button" class="btn" data-task-id="${esc(task.id)}">查看任务 ${taskLabel(task)}</button>
        </div>`));
      }
      // One progress board per task: who does what, on which model, how far, and a one-line result.
      // The full work of each member lives in that member's own conversation, so the group stays short.
      // Steps the lead stopped after a direction change never ran: they stay in the record but not on the board,
      // where they would otherwise sit beside the replacement steps as if the work were duplicated.
      const boardSteps = steps.filter((step) => step.state !== 'skipped' && step.capability !== 'triage');
      const board = stepBoard(task, boardSteps);
      // Q5 (groupFeatures.timeline): the board, the local test and the acceptance summary take their place in time
      // with everything else; the board sits where it last changed. Off: the old fixed order.
      const timeline = routeState.groupFeatures?.timeline === true;
      const deferred = [];
      const place = (at, html) => { if (timeline) deferred.push({ at, html }); else messages.push(html); };
      const boardAt = () => {
        const times = boardSteps.flatMap((step) => [step.finishedAt, step.startedAt]).concat(task.updatedAt)
          .map((value) => Date.parse(value || '')).filter(Number.isFinite);
        return times.length ? new Date(Math.max(...times)).toISOString() : task.time;
      };
      if (board && filter !== 'mine' && (!filterSelect.value || boardSteps.some((step) => step.role === filterSelect.value))) {
        place(boardAt(), messageRow('lead', '分工进度', board, 'board'));
      }
      if (!task.redacted && !isExample(state.group) && filter !== 'mine' && !filterSelect.value &&
          (task.state === 'testing' || task.detail === 'isolated_test_sync' || task.testResult || (task.command && terminal.has(task.state)))) {
        place(task.testResult?.at || task.updatedAt, messageRow('local', '本机测试', localTestActivity(task)));
      }
      // Requirement 7: the project reached the cloud (checked by sha256), and a downloaded patch passed its check.
      if (!task.redacted && filter !== 'mine' && !filterSelect.value && task.snapshotNotice && routeState.groupFeatures?.snapshotNotice) {
        const n = task.snapshotNotice;
        deferred.push({ at: n.at, html: messageRow('local', '项目已上传云端', `<p class="upload-ok">✓ 项目已上传到云端并校验通过：${n.changedFiles} 个文件含未提交改动${n.skipped ? `，跳过 ${n.skipped} 个敏感文件（如 .env、密钥）` : ''}。<span class="mono">sha256 ${esc(n.sha256)}</span></p>`) });
      }
      // Group chat v7 (M2, O3, Q6): what this computer enforces for group commands, stated once per task.
      const localRules = routeState.groupFeatures && (routeState.groupFeatures.localStages || routeState.groupFeatures.localCopy || routeState.groupFeatures.credentialSandbox);
      if (!task.redacted && filter !== 'mine' && !filterSelect.value && localRules && task.snapshotNotice) {
        const platform = window.desk?.platform;
        const note = platform === 'win32'
          ? 'Windows：群聊在本机运行的命令没有强制保护凭据目录，本机副本也没有强制隔离（只做改动检测）；AgentDesk 自己的文件工具和挂载仍拒绝凭据目录、.git 内部和 AgentDesk 密钥目录。'
          : platform === 'darwin'
            ? 'Mac：群聊在本机运行的命令在 sandbox 下运行，只挡 AgentDesk 自己的密钥目录（凭据目录、钥匙串和 .git 不挡，和单聊一样）；写代码阶段在本机副本里运行时禁止写原项目。需要已更新的 AgentDesk 连接组件，旧版本会如实提示未生效。'
            : '';
        if (note) deferred.push({ at: task.snapshotNotice.at, html: `<p class="group-system">${esc(note)}</p>` });
      }
      const downloaded = group.patchNotices?.[task.id];
      if (downloaded && filter !== 'mine' && !filterSelect.value) {
        deferred.push({ at: downloaded.at, html: messageRow('local', '补丁已下载', `<p class="upload-ok">✓ 补丁已下载到本机并校验通过：${downloaded.fileCount} 个文件，${downloaded.bytes} 字节。<span class="mono">sha256 ${esc(downloaded.sha256.slice(0, 12))}</span></p><p class="group-system">保存在 ${esc(downloaded.path)}。点「应用补丁」把它写入项目。</p>`) });
      }
      // Requirement 4: planning failed — the reason and single chats the person can open right away.
      if (!task.redacted && task.directAdvice && filter !== 'mine' && !filterSelect.value && routeState.groupFeatures?.planFailureAdvice) {
        const advice = task.directAdvice;
        const access = { fullAccess: '完全访问', readOnly: '只读' };
        const by = advice.source === 'lead' ? `<p class="group-system">由 ${esc(memberName(advice.by))}${advice.byModel ? ' · ' + esc(advice.byModel) : ''} 总结（组长链中的下一位）。</p>` : '';
        deferred.push({ at: advice.at, html: messageRow('lead', '下一步建议', `<div class="step-summary"><p><b>规划没有成功：</b>${esc(advice.reason)}。可以先用单聊试试：</p>${by}${
          (advice.options || []).map((option, index) => `<div class="task-addition"><p><b>${esc(memberName(option.role))}</b>${option.model ? ' · ' + esc(option.model) : ''} · ${access[option.access] || ''} · ${esc(option.why || '')}</p><div class="task-actions"><button type="button" class="btn${index === 0 ? ' primary' : ''}" data-direct-advice="${esc(task.id + ':' + index)}">在单聊打开</button></div></div>`).join('')
        }</div>`) });
      }
      // Group chat v7 (envFix): every environment fix on this computer, why, which files, whether it reached the
      // cloud, and an undo button (P1, R1–R3, E8, E10).
      // Shown whenever the task has fixes, also after the switch was turned off: they stay in the project and can be undone.
      if (!task.redacted && filter !== 'mine' && !filterSelect.value && Array.isArray(task.envFixes) && task.envFixes.length) {
        const stages = { test: '测试', triage: '诊断', review: '审查', accept: '验收', scout: '核验' };
        const cloud = { synced: '已回传云端', pending: '待回传云端（连上后自动回传）', conflict: '回传云端时有冲突，交给诊断', not_needed: '补丁已应用，无需回传' };
        for (const fix of task.envFixes) {
          const state = fix.reverted ? '已撤销' : fix.state === 'applied' ? '已写入本机项目' : fix.state === 'unknown' ? '结果未知，连上后核对' : fix.state === 'failed' ? '没有写入：' + esc(fix.error || '') : '写入中';
          const undo = fix.state === 'applied' && !fix.reverted ? `<div class="task-actions"><button type="button" class="btn" data-env-revert="${esc(task.id + ':' + fix.id)}">撤销这次修复</button></div>` : '';
          deferred.push({ at: fix.appliedAt || fix.at, html: messageRow('local', '环境修复（' + (stages[fix.stage] || fix.stage) + '阶段）', `<div class="step-summary"><p>${fix.state === 'applied' && !fix.reverted ? '<span class="upload-ok">✓</span> ' : ''}${state}${fix.state === 'applied' ? ' · ' + esc(cloud[fix.cloud] || fix.cloud || '') : ''}${fix.platformSource ? ' · 平台相关源码' : ''}</p><p>${esc(fix.reason || '')}</p><p class="group-system mono">${(fix.files || []).map(esc).join('，')}</p>${undo}</div>`) });
        }
      }
      // Group chat v7 (Q2/R1): files outside the project that a step changed, with their backup and a restore button.
      if (!task.redacted && filter !== 'mine' && !filterSelect.value && Array.isArray(task.outsideBackups) && task.outsideBackups.length) {
        for (const item of task.outsideBackups) {
          const restore = item.restoredAt ? '<p class="group-system">已还原</p>'
            : `<div class="task-actions"><button type="button" class="btn" data-outside-restore="${esc(task.id + ':' + item.backupId)}">还原原内容</button></div>`;
          deferred.push({ at: item.restoredAt || item.at, html: messageRow('local', '项目以外的文件已改动', `<p>改动前已备份：<span class="mono">${esc(item.path || '（批量写入）')}</span></p>${restore}`) });
        }
      }
      // Group chat v7 (localCopy): the writer's local copy, and what the platform does or does not enforce.
      if (!task.redacted && filter !== 'mine' && !filterSelect.value && Array.isArray(task.copyNotices) && routeState.groupFeatures?.localCopy) {
        const text = { created: '已在本机建立改写副本', unavailable: '没有建立本机副本，改写只在云端进行，本机测试在补丁应用后进行', original_changed: '副本里的命令运行期间原项目有改动（Windows 未强制隔离）' };
        const reasons = { too_large: '项目超过 2 GB', disk_space: '剩余空间不足副本的 2 倍', needs_git_root: '项目根目录不是 Git 仓库根' };
        for (const notice of task.copyNotices) {
          const labels = notice.enforcement?.labels?.length ? notice.enforcement.labels : notice.enforcement?.platform === 'mac' ? ['Mac：sandbox 禁止副本里的命令写原项目，并挡凭据目录'] : [];
          deferred.push({ at: notice.at, html: messageRow('local', '本机副本', `<p>${esc(text[notice.kind] || notice.kind)}${notice.reason ? '（' + esc(reasons[notice.reason] || notice.reason) + '）' : ''}</p>${labels.map((label) => `<p class="group-system">${esc(label)}</p>`).join('')}`) });
        }
      }
      // What the person said while the work was under way, how the lead applied it, and each member's closing
      // report. Merge them in the order they happened: an old report must not appear below a newer message and
      // read as a fresh reply. The lead's "调整" reply is shown once per task; later changes already show on
      // the board and in the events, and repeating the summary after every mid-work message buried the chat.
      const late = [];
      const lateAt = (value) => {
        const at = Date.parse(value || '');
        return Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER;
      };
      const addLate = (value, html) => { if (html) late.push({ at: lateAt(value), order: late.length, html }); };
      // When a step appears in the chat is when it ended, not when it started: a long step that failed after
      // a newer direction message must not be replayed above that message. Older records have no finishedAt,
      // so read the ending time from the task events.
      const endedAt = (step) => {
        if (step.finishedAt) return step.finishedAt;
        const wanted = step.state === 'completed' ? ':completed'
          : ['failed', 'replaced'].includes(step.state) ? ':failed' : '';
        if (wanted) {
          const event = [...(task.events || [])].reverse()
            .find((item) => item.stepId === step.id && String(item.detail || '').endsWith(wanted));
          if (event?.time) return event.time;
        }
        return step.startedAt;
      };
      // The lead answers the newest direction message, so the person always sees a reply to what they just said.
      // Older direction messages stay on their own; repeating every earlier "调整" summary buried the chat.
      const revisions = task.revisions || [];
      const latestRevision = revisions.at(-1);
      for (const revision of revisions) {
        const parts = [];
        if (!filterSelect.value) parts.push(messageRow('you', '改方向', `<p class="group-user-text">${esc(revision.text)}</p>`));
        if (revision === latestRevision) {
          if (revision.state === 'deciding') {
            parts.push(messageRow('lead', '调整', '<p>正在判断你的话影响哪些步骤…</p>'));
          } else {
            const names = (ids) => (ids || []).map((stepId) => {
              const step = (task.steps || []).find((item) => item.id === stepId);
              return step ? memberName(step.role) + '（' + (capabilityLabels[step.capability] || stepId) + '）' : stepId;
            }).join('、');
            const lines = revision.state === 'fallback'
              ? [`暂时没法逐步判断，已把你的话作为指导发给正在做的成员：${names(revision.guided) || '无'}。`]
              : [revision.summary,
                revision.guided?.length ? '补一句指导接着做：' + names(revision.guided) : '',
                revision.continued?.length ? '不受影响，继续：' + names(revision.continued) : '',
                revision.stopped?.length ? '方向变了，停下：' + names(revision.stopped) : '',
                revision.added?.length ? '新增：' + names(revision.added) : '',
                revision.remodeled?.length ? '只换模型：' + revision.remodeled.map((item) => `${item.step}「${item.from || '默认'}」→ ${item.to}`).join('、') : '',
                revision.modelFallbacks?.length ? '模型名没认出来，改用：' + revision.modelFallbacks.map((item) => `${item.step}「${item.requested}」→ ${item.used}`).join('、') : ''].filter(Boolean);
            const waiting = (task.steps || []).some((step) => step.state === 'proposed');
            const addition = waiting
              ? `<div class="task-addition"><p>新增的步骤要你确认后才开始（这个群聊的「方案确认」设置）。</p><div class="task-actions"><button type="button" class="btn primary" data-approve-addition="${esc(task.id)}">确认新增的步骤</button></div></div>` : '';
            parts.push(messageRow('lead', '调整', (lines.length ? lines.map((line) => `<p>${esc(line)}</p>`).join('') : '<p>已按你的话调整。</p>') + addition));
          }
        }
        addLate(revision.at, parts.join(''));
      }
      // Forwarded from each member's own conversation: that it took the work, and its closing summary.
      // The lead's own diagnosis steps stay internal: the "调整" reply above already says what was decided,
      // so posting a second "Claude Code 完成总结 · 诊断" after it reads as another AI speaking again.
      if (filter !== 'mine') {
        for (const step of steps) {
          if (!threadRoles.has(step.role) || step.capability === 'triage' ||
              (filterSelect.value && filterSelect.value !== step.role)) continue;
          const what = capabilityLabels[step.capability] || (step.write ? '修改' : '任务');
          const summaryKey = task.id + ':' + step.id;
          const expanded = Boolean(group.summaryOpen?.has(summaryKey));
          const fullSummary = closingSummary(step, 4000);
          const summary = closingSummary(step, expanded ? 900 : 160);
          // A failed step that the lead replaced keeps its closing report in the group as a red failure record.
          const failedRecord = step.state === 'failed' || (step.state === 'replaced' && Boolean(step.error || step.history?.length));
          if (summary && (['completed', 'failed'].includes(step.state) || failedRecord)) {
            const collapsible = fullSummary.length > 160;
            const link = !task.redacted && threadRoles.has(step.role)
              ? `<button type="button" class="task-text-link" data-agent-thread="${step.role}" data-agent-task="${esc(task.id)}" data-agent-step="${esc(step.id)}">在单聊查看全文 ${svg('chev')}</button>` : '';
            // A member's summary is its own report until the lead has accepted the task.
            const verdict = task.acceptance?.verdict;
            const checked = ['accept', 'pass'].includes(verdict) ? '已验收' : verdict === 'accept_with_risk' ? '已验收（带风险）' : '';
            const trust = failedRecord ? '' : `<span class="trust-tag${checked ? ' checked' : ''}">${checked || '成员自报 · 待验收'}</span>`;
            // Every member's closing summary folds the same way: the first lines stay, the long detail opens
            // on demand, and the full text remains one click away in that member's own conversation.
            addLate(endedAt(step), messageRow(step.role, [step.state === 'failed' ? '未完成' : step.state === 'replaced' ? '失败记录' : '完成总结', what, step.id].join(' · '),
              `<div class="step-summary${failedRecord ? ' failed' : ''}" data-flight-from="${esc(task.id + ':' + step.id)}" data-step-summary="${esc(task.id + ':' + step.id)}">${trust}
                <p class="step-summary-text${collapsible && !expanded ? ' clamped' : ''}">${esc(summary)}</p>
                ${collapsible ? `<button type="button" class="task-text-link" data-summary-toggle="${esc(summaryKey)}" aria-expanded="${expanded}">${expanded ? '收起详情' : '展开详情'}</button>` : ''}
                ${link}</div>`, 'summary'));
          }
        }
      }
      for (const entry of deferred) addLate(entry.at, entry.html);
      late.sort((a, b) => a.at - b.at || a.order - b.order);
      for (const entry of late) messages.push(entry.html);
      if (filter !== 'mine' && task.acceptance?.verdict && (!filterSelect.value || filterSelect.value === 'lead')) {
        const summaryRow = messageRow('lead', '验收总结 · ' + acceptanceLabel(task),
          `<div class="step-summary"><p>${esc(task.acceptance.summary || acceptanceLabel(task))}</p></div>`, 'summary');
        // Q5: in time order the acceptance summary is placed when it was given, not pinned to the end.
        if (timeline) {
          const at = Date.parse(task.acceptance.at || '');
          const index = Number.isFinite(at) ? late.findIndex((entry) => entry.at > at) : -1;
          if (index >= 0) messages.splice(messages.length - (late.length - index), 0, summaryRow); else messages.push(summaryRow);
        } else messages.push(summaryRow);
      }
      const reply = ended ? '' : `<button class="task-text-link group-reference" type="button" data-reference="${esc(task.id)}">引用</button>`;
      return messages.length ? `<div class="dispatch-thread" data-message-id="${esc(task.id)}">${messages.join('')}${reply}</div>` : '';
    }).join('') + approvalCards(group);

    setHtml(timeline, html || `<div class="group-empty">
      <span class="group-empty-icon">#</span>
      <h2>${records.size ? '没有符合筛选条件的消息' : '项目群聊'}</h2>
      ${records.size ? '' : '<p>组长先确认需求和方案，确认后开始执行。</p>'}
    </div>`);
    // A re-render replaces the conversation's HTML, which would otherwise throw away the reader's position.
    // Stay on the located step while the person is reading it, at the bottom when they were following it live,
    // and otherwise exactly where they were.
    const pinned = laneLocateTarget && Date.now() - laneLocateAt < 10000 ? timeline.querySelector(laneLocateTarget) : null;
    if (pinned) {
      laneLocateAt = Date.now();
      timeline.scrollTop = messageTop(pinned);
    } else if (atBottom && (records.size || group.approvals.size)) timeline.scrollTop = timeline.scrollHeight;
    else timeline.scrollTop = scrollTop;
    // A member that just finished sends a light from its summary to its row on the progress board (in the lanes
    // view, from its row in the event list to its node on the lane tree; see renderLanesView).
    if (!timeline.hidden) window.AgentDeskLight?.completed(timeline, stepProgress(records));
  }

  function laneClick(event) {
    const card = event.target.closest('[data-lane-event]');
    if (card) { laneSelect(card.dataset.laneEvent, card.dataset.laneStep); return true; }
    const head = event.target.closest('[data-lane-open]');
    if (!head) return false;
    const id = head.dataset.laneOpen;
    if (head.dataset.laneKind === 'chat') { A.openSession(id); return true; }
    const owner = groupsOf(projectIdOf(state.group)).find(({ id: group }) => groups.get(group)?.records.has(id));
    if (owner && owner.id !== state.group) A.openGroup(owner.id);
    selectTask(id, 'graph');
    return true;
  }
  document.querySelector('#panelBody').addEventListener('click', (event) => { if (state.group && state.panel === 'lanes') laneClick(event); });

  // An example project's group chat only plays demo replies. Say so plainly, and offer to connect it when this
  // computer has a free orchestrator workspace.
  function renderExampleBanner() {
    const banner = $('#groupExampleBanner');
    const projectId = projectIdOf(state.group);
    const project = A.proj(projectId);
    const example = Boolean(project) && projectId !== liveProject && isExample(projectId);
    banner.hidden = !example;
    if (!example) return;
    const free = supported && !temporary ? freeWorkspaces() : [];
    const users = workspaceUsers();
    $('#groupExampleText').textContent = '这是本地示例项目：组长和 AI 不会真的工作，这里的回复都是演示内容。' +
      (free.length ? '连接到主控后就会正式运行。'
        : !supported || temporary ? '' : !knownRoutes ? '正在读取主控工作区…'
          : users.length ? `这台电脑的主控工作区正被项目「${users.join('」「')}」使用。` : '主控没有给这台电脑分配工作区。');
    $('#groupConnect').hidden = !free.length || !/^group-[a-f0-9-]+$/.test(projectId);
  }

  // Turns an example project into a real one bound to this computer's free workspace. Its demo records are cleared;
  // the project's folder, name and chats stay.
  async function connectProject(projectId, { silent = false } = {}) {
    const workspace = freeWorkspaces()[0];
    const project = A.proj(projectId);
    if (!workspace || !project) { if (!silent) A.toast('现在没有可用的主控工作区'); return; }
    if (!silent && !window.confirm(`把项目「${project.name}」连接到主控工作区「${workspace}」？\n\n之后组长和 AI 会真正工作；这个项目里的示例记录会清掉，项目文件夹和单聊不变。`)) return;
    if (project.configured && window.AgentDeskProjects?.bindWorkspace) {
      const ok = await window.AgentDeskProjects.bindWorkspace(projectId, workspace);
      if (!ok) return;
    }
    project.serverProject = workspace;
    project.live = true;
    const saved = savedProjects.find((item) => item.id === projectId);
    if (saved) { saved.serverProject = workspace; saved.live = true; }
    if (!temporary) store.set('groupProjectBindings', savedProjects);
    for (const { id } of groupsOf(projectId)) {
      const group = groups.get(id);
      if (!group) continue;
      group.records.clear();
      group.selected = undefined;
      group.output = null;
      persist(group);
    }
    A.toast(`项目「${project.name}」已连接到主控，可以开始派活了`);
    repaint();
    refresh();
  }
  // Projects left unbound by older versions (or made while the orchestrator had no workspace for this computer)
  // are connected as soon as a free workspace shows up, instead of sitting there as a demo.
  const unbound = () => temporary ? [] : A.D.projects.filter((item) => /^group-[a-f0-9-]+$/.test(item.id) && !item.serverProject);
  let autoConnecting = false;
  async function autoConnect() {
    if (autoConnecting || !supported || temporary || !knownRoutes) return;
    autoConnecting = true;
    try {
      for (const project of unbound()) {
        if (!freeWorkspaces().length) break;
        await connectProject(project.id, { silent: true }).catch((error) => A.toast('自动连接主控没有完成：' + error.message));
      }
    } finally { autoConnecting = false; }
  }
  $('#groupConnect').addEventListener('click', () => {
    const projectId = projectIdOf(state.group);
    if (projectId) connectProject(projectId).catch((error) => A.toast('连接没有完成：' + error.message));
  });

  function render() {
    drawRoutes();
    if (!state.group) return;
    setTimeout(offerChoices, 0);
    const count = taskCount();
    $('#groupSubtitle').textContent = shownMembers().filter((id) => id !== 'you' && id !== 'local').length + ' 位 AI 成员' + (count ? ' · ' + count + ' 项未结任务' : '');
    renderExampleBanner();
    $('#taskBadge').textContent = count || '';
    for (const id of optional) {
      const option = provider.querySelector(`[value="${id}"]`);
      option.disabled = !canUse(id);
      option.hidden = id === 'gemini' && !canUse(id);
      option.textContent = canUse(id) ? members[id].name : members[id].name + '（' + availability(id) + '）';
    }
    const recipientReady = canUse(provider.value);
    setHtml($('#groupRoster'), shownMembers().filter((id) => id !== 'you').map((id) =>
      `<button type="button" data-roster="${id}" title="${memberName(id)} · ${members[id].role}">${memberAvatar(id, 30, 'roster')}<span>${memberName(id)}</span></button>`).join(''));
    setHtml($('#sbGroupMembers'), recipients.slice(1).flatMap((id) => {
      const { state: activity, task } = memberActivity(id);
      if (!activity) return [];
      const stats = [taskStats(task, id), usageText(task, id)].flat().filter(Boolean).join(' · ');
      return `<button type="button" class="sb-item clickable" data-status-member="${id}" title="${esc(memberName(id) + (stats ? ' · ' + stats : ''))}"><span class="status-dot ${{ asking: 'waiting', done: 'done', failed: 'failed' }[activity] || 'running'}"></span>${avatars.members[id].short} ${avatars.states[activity].label}${stats ? `<small class="sb-stats">${esc(stats)}</small>` : ''}</button>`;
    }).join(''));
    refreshQuotas();
    // The status bar keeps one entry for quota; its colour warns when a member is stepping back or stopped.
    const worst = quotaList().reduce((level, quota) => quota.level === 'stopped' ? 'stopped' : quota.level === 'reserved' && level !== 'stopped' ? 'reserved' : level, '');
    $('#sbQuotaOpen').dataset.level = worst;
    setHtml($('#sbQuota'), quotaStatusBar());
    setHtml($('#sbResources'), resourceLabels().map(({ label, warning }) =>
      `<button type="button" class="sb-item clickable sb-resource${warning ? ' resource-warning' : ''}">${esc(label)}</button>`).join(''));
    const canSend = isExample(state.group) || (supported && (currentGroup().planReply ? connected : hasRoute()));
    const ended = groupEnded(currentGroup());
    form.hidden = ended;
    $('#groupEnded').hidden = !ended;
    input.disabled = ended;
    $('#groupSend').disabled = ended || busy || !canSend || !recipientReady;
    const active = activeTasks(currentGroup());
    $('#groupStop').hidden = !active.length;
    $('#groupStop').title = active.length > 1 ? `停止这个群聊里正在进行的 ${active.length} 个任务中最新的一个` : '停止这个群聊里正在进行的任务';
    renderGroupAttachments();
    $('#groupPlanReplyCancel').disabled = busy;
    const connectionHint = !recipientReady ? `当前主控尚未启用 ${members[provider.value].name}。` : isExample(state.group) ? '本地示例'
      : !supported ? '此客户端尚未配置群聊主控。' : hasRoute() ? '' : knownRoutes ? '主控离线，请检查线路。' : '正在检查主控线路…';
    composerMessage.textContent = busy ? '正在处理…' : currentGroup().taskError || connectionHint;
    renderTimeline();
  }

  /* ---------- Quota (subscriptions: what runs out is quota, not tokens) ---------- */
  // Example projects show sample numbers so the layout can be checked without a server.
  const exampleQuotas = [
    { provider: 'claude', used: 64, level: 'reserved', policy: { soft: 60, hard: 95, keepFor: ['plan', 'accept'] },
      buckets: [{ id: 'claude', fiveHour: { usedPercent: 38 }, weekly: { usedPercent: 64 } }] },
    { provider: 'codex', used: 41, level: 'ok', policy: { soft: 70, hard: 95, keepFor: ['implement'] },
      buckets: [{ id: 'codex', fiveHour: { usedPercent: 41 }, weekly: { usedPercent: 22 } }] },
    { provider: 'grok', used: 97, level: 'stopped', policy: { soft: 95, hard: 95, keepFor: [] },
      buckets: [{ id: 'grok', fiveHour: { usedPercent: 97 }, weekly: { usedPercent: 51 } }] },
    { provider: 'gemini', used: 18, level: 'ok', policy: { soft: 95, hard: 95, keepFor: [] },
      buckets: [{ id: 'gemini', fiveHour: { usedPercent: 18 }, weekly: { usedPercent: 9 } }] },
  ];
  const capabilityNames = { plan: '规划', triage: '诊断', scout: '侦察', implement: '改代码', review: '审查', research: '查资料', accept: '验收' };
  // Snapshot numbers (the last turn's report, not a live reading) are shown as 离线, never as current quota.
  const staleQuota = (quota) => quota?.source === 'snapshot' || quota?.usedSource === 'snapshot';
  const quotaList = () => isExample(state.group) ? exampleQuotas : connected ? quotas : [];
  const quotaOf = (id) => quotaList().find((quota) => quota.provider === id);
  // When the fullest window that is holding this member back comes back, for the waiting message.
  function quotaResetAt(provider) {
    const windows = (quotaOf(provider)?.buckets || []).flatMap((bucket) => [bucket.fiveHour, bucket.weekly])
      .filter((window) => Number.isFinite(window?.usedPercent) && Number.isFinite(window?.resetsAt));
    const tightest = windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
    return tightest ? new Date(tightest.resetsAt * 1000) : null;
  }
  function resetClock(date) {
    if (!date || !Number.isFinite(date.getTime())) return '';
    const now = new Date();
    const day = date.toDateString() === now.toDateString() ? ''
      : `${date.getMonth() + 1} 月 ${date.getDate()} 日 `;
    return day + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const pct = (value) => Math.round(value) + '%';
  function levelText(quota) {
    if (quota.level === 'stopped') return '额度将尽，暂停派活';
    if (quota.level === 'reserved') return '让位中，只做' + quota.policy.keepFor.map((name) => capabilityNames[name] || name).join('、');
    return '';
  }

  // Status bar: Claude and Codex always (they are the scarce ones); others only when they are stepping back.
  function quotaStatusBar() {
    const shown = quotaList().filter((quota) => !staleQuota(quota) && Number.isFinite(quota.used) &&
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
    if (staleQuota(quota)) return '<div class="quota-meters"><span class="quota-label">额度</span><span class="quota-value">离线</span></div>';
    const bucket = quota?.buckets?.[0];
    if (!quota || (!bucket && !Number.isFinite(quota.used))) return '';
    const meter = (label, window) => {
      const left = window ? Math.max(0, 100 - window.usedPercent) : null;
      return `<span class="quota-label">${label}</span><span class="quota-bar" aria-hidden="true">${left === null ? '' : `<i style="width:${left}%"></i>`}</span>
        <span class="quota-value">${left === null ? '—' : '剩 ' + pct(left)}</span>`;
    };
    const rows = bucket ? meter('5 小时', bucket.fiveHour) + meter('每周', bucket.weekly)
      : meter('较紧窗口', { usedPercent: quota.used });
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
    return (task.events || []).map((event) => /^([\w-]+):reassigned:(\w+)->(\w+):(quota|auth|busy)$/.exec(event.detail || ''))
      .filter(Boolean).map(([, , from, to, reason]) =>
        `${memberName(from)} ${{ quota: '额度用尽', auth: '需要重新登录', busy: '正忙' }[reason]}，改由 ${memberName(to)} 接手`);
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
      else if (detail.startsWith('triage_unavailable')) add(textOf(detail));
      else if (detail === 'triage_rework' || detail === 'triage_retry') add('组长已给出处理意见，任务重新排队。');
      else if (detail === 'triage_limit' || detail === 'acceptance_limit') add('自动处理次数已达上限，请人工查看。');
      else if (detail === 'review_conflict') add('审查意见冲突，已交给组长判断。');
      else if (/^step_failed:|^reassign_started:|:reassigned_by_lead:|^reassign_limit|:stalled:|:model_switch:|:stopped_by_person$|:steered$|:revised_out$|^revise_deciding$|^revise_fallback$|:handover:|:chosen:|:needs_choice$|:adjusted:|^snapshot_skipped:|^mirror_synced:|:permission_requested:|:access_/.test(detail)) add(textOf(detail));
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

  function resourceLabels() {
    if (!isLiveGroup() || !resources) return [];
    const { host, docker, disk } = resources;
    const amount = (bytes) => {
      if (!Number.isFinite(bytes) || bytes < 0) return '—';
      return bytes < 1024 ** 3 ? Math.round(bytes / 1024 ** 2) + ' MB' : (bytes / 1024 ** 3).toFixed(1) + ' GB';
    };
    const labels = [];
    if (docker?.enabled) {
      if (docker.ok) {
        const limit = Number.isSafeInteger(docker.max) ? docker.max : '—';
        labels.push({ label: `容器 ${docker.count}/${limit}` }, { label: '容器内存 ' + amount(docker.memoryBytes) });
      } else labels.push({ label: '容器数据不可用', warning: true });
    }
    if (host) labels.push(
      { label: `主机内存 ${amount(host.memoryUsedBytes)} / ${amount(host.memoryTotalBytes)}` },
      { label: `Swap ${amount(host.swapUsedBytes)} / ${amount(host.swapTotalBytes)}` },
    );
    if (docker?.enabled && Number.isFinite(disk?.freeRatio) && disk.freeRatio < 0.15) {
      labels.push({ label: `磁盘仅余 ${Math.round(disk.freeRatio * 100)}%`, warning: true });
    }
    return labels;
  }

  function refreshResources(current) {
    if (checkingResources || !isLiveGroup()) return;
    checkingResources = control('resource_status').then((value) => {
      if (current === generation) resources = value;
    }, () => {
      if (current === generation) resources = undefined;
    }).finally(() => {
      checkingResources = null;
      if (current === generation) repaint();
    });
  }

  // Claude appears once, as the lead. Members the orchestrator has not set up are listed apart, not as rows.
  const usable = (id) => id === 'you' || id === 'lead' || id === 'local' || canUse(id) && (!routeState.team || routeState.team.configured.includes(id));
  const shownMembers = () => Object.keys(members).filter((id) => id !== 'claude' && usable(id));
  const hiddenMembers = () => Object.keys(members).filter((id) => !['claude', 'you', 'lead', 'local'].includes(id) && !usable(id));
  // What each member actually does, read from the live hand-out order: "改代码（首选）· 审查（第 2）".
  function duties(id) {
    const routes = routeState.team?.routes || (isExample(state.group) ? { plan: ['claude', 'codex'], triage: ['claude'], scout: ['antigravity', 'grok'],
      implement: ['antigravity', 'codex', 'grok'], review: ['antigravity', 'grok'], research: ['antigravity', 'grok'], accept: ['claude'] } : null);
    const role = id === 'lead' ? 'claude' : id;
    if (!routes) return '';
    const order = ['plan', 'triage', 'implement', 'scout', 'review', 'research', 'accept'];
    return order.filter((capability) => routes[capability]?.includes(role)).map((capability) => {
      const index = routes[capability].indexOf(role);
      return capabilityNames[capability] + (routes[capability].length === 1 ? '' : index === 0 ? '（首选）' : `（第 ${index + 1}）`);
    }).join(' · ');
  }

  function panelMembers() {
    refreshQuotas();
    const rules = approvals.load(localStorage, state.group);
    return `<div class="project-panel-body"><div class="member-panel-heading"><h3>项目成员</h3>
      <button type="button" class="task-text-link" data-avatar-sheet>状态图鉴 ${svg('chev')}</button></div>
      ${rules.length ? `<button type="button" class="task-text-link" data-clear-group-approvals>清除本群记住的授权（${rules.length}）</button>` : ''}

      ${shownMembers().map((id) => {
        const member = members[id];
        const { task, state: activity } = memberActivity(id);
        const role = duties(id) || member.role;
        return `<div class="member-row ${focusMember === id ? 'member-focused' : ''}">${memberAvatar(id, 48, 'members')}<div>
          <span class="member-caption"><strong>${member.name}</strong>${activity ? `<small>${avatars.states[activity].label}</small>` : ''}</span><small class="member-duties">${role}</small>
          ${['lead', 'codex', 'grok', 'antigravity', 'gemini'].includes(id) && (isLiveGroup() || isExample(state.group)) ? quotaMarkup(id === 'lead' ? 'claude' : id) : ''}
          ${task && [...taskStats(task, id), usageText(task, id)].filter(Boolean).length
            ? `<small class="member-task-stats">${esc([...taskStats(task, id), usageText(task, id)].filter(Boolean).join(' · '))}</small>` : ''}
          ${task ? `<button type="button" data-task-id="${esc(task.id)}" class="task-text-link">${taskLabel(task)} · ${statusName(task.state)}</button>` : ''}
        </div>${['codex','lead','grok','antigravity'].includes(id) ? `<button type="button" class="btn member-direct" data-direct-provider="${id === 'lead' ? 'claude' : id}">单聊</button>` : ''}</div>`;
      }).join('')}
      ${hiddenMembers().length ? `<p class="panel-note">未接入：${hiddenMembers().map((id) => members[id].name).join('、')}</p>` : ''}
      <button type="button" class="task-text-link" data-open-quota>查看额度与分工顺序 ${svg('chev')}</button></div>`;
  }

  function refreshQuotas() {
    if (!supported || !isLiveGroup() || !connected || quotaCheck || Date.now() < nextQuotaAt) return;
    const current = generation;
    nextQuotaAt = Date.now() + 15000;
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

  function taskOutputPanel(task) {
    if (!task || task.redacted || isExample(state.group)) return '';
    const output = currentGroup().output;
    const logStep = (output?.operation === 'task_log' ? output.stepId : '') || task.steps?.findLast((step) => ['running', 'failed', 'completed'].includes(step.state))?.id;
    const options = [
      ['task_diff', '完整补丁'],
      ['task_log', '实时日志'],
      ['task_artifacts', '产物'],
    ];
    const value = output?.value;
    const text = value?.patch ?? value?.text;
    return `<section class="group-output">
      <div class="task-actions">${options.map(([operation, label]) =>
        `<button class="btn" type="button" data-task-output="${operation}" data-log-step="${esc(logStep || '')}"
          aria-pressed="${output?.operation === operation}" ${operation === 'task_log' && !logStep ? 'disabled' : ''}>${label}</button>`).join('')}</div>
      ${output?.operation === 'task_log' && task.steps?.length ? `<label>日志步骤 <select data-log-select>${task.steps.map((step) =>
        `<option value="${esc(step.id)}" ${step.id === logStep ? 'selected' : ''}>${esc(step.id)}</option>`).join('')}</select></label>` : ''}
      ${output?.error ? `<p role="status">${esc(output.error)}</p>` : ''}
      ${Array.isArray(value) ? (value.map(({ id, name }) => `<button class="task-text-link" type="button" data-artifact="${esc(id)}">${esc(name)}</button>`).join('') || '<p>暂无产物</p>') : ''}
      ${text !== undefined ? `<pre>${esc(text || '没有改动')}${value.truncated ? '\n（仅显示日志末尾）' : ''}</pre>` : ''}
      ${output?.loading ? '<p role="status">读取中…</p>' : ''}
    </section>`;
  }

  async function updateOutput(group, output) {
    if (output.loading) return;
    const { operation, taskId, stepId, artifact } = output;
    output.loading = true;
    if (group === currentGroup()) A.renderPanel();
    try {
      output.value = await control(operation, { taskId, stepId, artifact });
      output.error = '';
    } catch (error) {
      output.error = error.message;
    } finally {
      output.loading = false;
      if (group === currentGroup() && group.output === output) A.renderPanel();
    }
  }

  function openTaskOutput(operation, { stepId, artifact } = {}) {
    const group = currentGroup();
    if (!group) return;
    const task = getSelected(group);
    if (!task || task.redacted || isExample(group.id) || !connected) return;
    group.output = { operation, taskId: task.id, stepId, artifact };
    updateOutput(group, group.output);
  }

  function panelTasks() {
    const { records, selected, statusError } = currentGroup();
    const task = getSelected();
    if (!records.size) return '<div class="empty-note">发送任务后，这里会显示进度和结果。</div>';
    const online = isExample(state.group) || connected;
    const steps = task?.steps || [];
    const logs = task?.redacted ? '' : steps.map((step) => `<details class="task-step" data-step="${esc(task.id + ':' + step.id)}"><summary><strong>${esc(memberName(step.role))}</strong>${pill(step.state)}</summary>
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
          ${!task.redacted && task.detail === 'patches_ready' ? `<button class="btn primary" type="button" data-task-operation="apply" ${busy || !online ? 'disabled' : ''}>应用补丁</button>` : ''}
          ${!task.redacted && task.detail === 'patches_ready' && routeState.groupFeatures?.patchDownload ? `<button class="btn" type="button" data-task-operation="patch_download" ${busy || !online ? 'disabled' : ''} title="把云端补丁下载到这台电脑并校验（断网后重新连上时也可以用）">下载补丁</button>` : ''}
          ${!task.redacted && task.pendingRequest ? `<button class="btn" type="button" data-task-operation="reconcile" ${busy || !online ? 'disabled' : ''}>核对操作</button>` : ''}
          ${!task.redacted && task.state && !terminal.has(task.state) ? `<button class="btn danger" type="button" data-task-operation="cancel" ${busy || !online ? 'disabled' : ''}>取消任务</button>` : ''}
          ${!groupEnded(currentGroup()) && !task.redacted && task.prompt && terminal.has(task.state) ? '<button class="btn" type="button" data-task-operation="draft">重跑…</button>' : ''}
        </div>
        ${events.length ? `<ol class="task-events">${events.map((event) => `<li>${statusName(event.state)}</li>`).join('')}</ol>` : ''}
        ${reassignments(task).map((note) => `<p class="task-reassigned">${esc(note)}</p>`).join('')}
        ${quotaCharge(task)}
        ${logs ? `<h3>步骤输出</h3>${logs}` : ''}
        ${taskOutputPanel(task)}
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

  // The group panel has three tabs: 成员, 任务, 文件. Inside 任务 a switch picks the task's details,
  // its dispatch graph, its changed files or its output, so related views share one tab.
  const TASK_VIEWS = [['tasks', '详情'], ['graph', '调度图'], ['diff', '改动'], ['terminal', '输出']];

  // Project lanes after Lancer's "工作树 · 泳道" (src/lanes.js): each group task and each single chat of this
  // project is a lane; events of every lane are interleaved by time. The right panel shows the tree; the
  // group's "泳道" view shows the member chains, the interleaved event list and the tree side by side.
  const laneRole = (role) => role === 'claude' ? 'lead' : role;
  const laneHelpers = {
    // The lead's lane header keeps the model readable at narrow widths; "Claude" is already the member name.
    memberName: (role) => role === 'claude' ? '组长' : role === 'you' ? '你' : memberName(laneRole(role)),
    colour: (role) => window.AgentDeskLight?.colour(laneRole(role)) || 'var(--accent)',
    avatar: (role) => avatars.html(laneRole(role), { size: 16, still: true }),
  };
  // The lanes belong to the group chat that is open: only its own tasks, never other group chats of the project
  // and never the person's own single chats.
  function lanesModel(limit = 6) {
    const group = currentGroup();
    if (!group) return [];
    const name = nameOf(group.id);
    const tasks = [...group.records.values()].filter((task) => !task.redacted && belongs(group, task))
      .map((task) => ({ task, groupName: name }));
    return window.AgentDeskLanes.model({ tasks, sessions: [], ...laneHelpers, limit });
  }
  let laneFocus = null;     // the task whose nodes are highlighted
  // The swimlane panel belongs to one group chat: the selected task is split into its members/models, not into
  // one column per task or per group chat. Nodes show step id, model, state, duration, files and retries.
  function panelLanes() {
    const group = currentGroup();
    if (!group) return '<div class="empty-note">选择一个群聊后，这里会按成员和模型显示节点。</div>';
    const width = document.querySelector('#panel')?.offsetWidth || 420;
    const tasks = [...group.records.values()].filter((task) => !task.redacted && belongs(group, task));
    if (!tasks.length) return `<div class="project-panel-body lanes-panel"><div class="member-panel-heading"><h3>群聊 · 泳道</h3><small>${esc(nameOf(state.group))}</small></div>
      <div class="empty-note">这个群聊还没有任务；发出任务后，这里会按成员和模型显示节点。</div></div>`;
    const selected = tasks.find((task) => task.id === group.selected) || tasks.at(-1);
    const picker = tasks.length > 1 ? `<label class="sg-pick"><span>任务</span><select data-lane-task>${tasks.map((task) =>
      `<option value="${esc(task.id)}" ${task.id === selected.id ? 'selected' : ''}>${taskLabel(task)} · ${esc((task.prompt || '').slice(0, 40))}</option>`).join('')}</select></label>` : '';
    const model = window.AgentDeskLanes.groupModel(selected, laneHelpers);
    return `<div class="project-panel-body lanes-panel">
      <div class="member-panel-heading"><h3>群聊 · 泳道</h3><small>${esc(nameOf(state.group))} · 按成员/模型分道</small></div>
      ${picker}${window.AgentDeskLanes.groupTree(model, { ...laneHelpers, focus: laneFocus, width })}</div>`;
  }
  // Clicking a node on the lane tree focuses its lane and finds the conversation it belongs to: a group task
  // scrolls into view in the conversation and a guide line stays until the node is clicked again; a single chat opens.
  const selectorOfMessage = (element) => {
    if (!element) return '';
    if (element.dataset.stepSummary) return `[data-step-summary="${CSS.escape(element.dataset.stepSummary)}"]`;
    if (element.dataset.stepAnchor) return `[data-step-anchor="${CSS.escape(element.dataset.stepAnchor)}"]`;
    if (element.dataset.messageId) return `[data-message-id="${CSS.escape(element.dataset.messageId)}"]`;
    return '';
  };
  const messageTop = (element) => {
    const view = timeline.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const margin = Math.min(120, Math.max(12, (timeline.clientHeight - Math.min(box.height, timeline.clientHeight)) / 2));
    return Math.max(0, timeline.scrollTop + box.top - view.top - margin);
  };
  let laneLocateRun = 0;
  // Scroll only the conversation, not every scrollable ancestor. Re-assert the position once a live refresh
  // has had time to re-render the message, so a click no longer finds the place and then springs back.
  function locateInTimeline(selector, run) {
    const scroll = () => {
      const element = selector ? timeline.querySelector(selector) : null;
      if (!element) return false;
      laneLocateAt = Date.now();
      timeline.scrollTo({ top: messageTop(element), behavior: 'auto' });
      return true;
    };
    if (!scroll()) return;
    for (const delay of [450, 1400]) {
      setTimeout(() => {
        if (run !== laneLocateRun) return;
        const element = selector ? timeline.querySelector(selector) : null;
        if (!element) return;
        const view = timeline.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        if (box.top < view.top + 8 || box.bottom > view.bottom - 8) scroll();
      }, delay);
    }
  }
  // A person scrolling away ends the pin, so a later live refresh never pulls the conversation back.
  timeline.addEventListener('scroll', () => {
    if (laneLocateTarget && Date.now() - laneLocateAt > 300) laneLocateTarget = '';
  }, { passive: true });
  function laneSelect(key, stepKey) {
    const laneId = key.split(':')[0];
    laneFocus = laneId;
    const group = currentGroup();
    // A finished task beyond the recent few is folded to one line; unfold it before locating a step in it.
    const hasTask = Boolean(timeline.querySelector(`[data-message-id="${CSS.escape(laneId)}"]`));
    if (!hasTask && group?.records.has(laneId)) {
      (group.expanded ||= new Set()).add(laneId);
      renderTimeline();
    }
    A.renderPanel();
    const run = ++laneLocateRun;
    requestAnimationFrame(() => {
      const nodeSelector = `[data-lane-event="${CSS.escape(key)}"]`;
      const node = document.querySelector(nodeSelector);
      // A node that names a step lands on that step's closing summary, else on its row in the progress
      // board; only the task as a whole when neither is shown (e.g. a filter hides it).
      const stepTarget = stepKey
        ? timeline.querySelector(`[data-step-summary="${CSS.escape(stepKey)}"]`) || timeline.querySelector(`[data-step-anchor="${CSS.escape(stepKey)}"]`)
        : null;
      const message = stepTarget || timeline.querySelector(`[data-message-id="${CSS.escape(laneId)}"]`);
      const messageSelector = selectorOfMessage(message);
      if (!message || !node) { window.AgentDeskLight?.arrive(node); return; }
      laneLocateTarget = messageSelector;
      laneLocateAt = Date.now();
      // The first click leaves the guide line on screen; clicking the same node again clears it.
      const already = window.AgentDeskLight?.hasGuide?.(nodeSelector, messageSelector);
      locateInTimeline(messageSelector, run);
      message.classList.remove('lane-located');
      void message.offsetWidth;
      message.classList.add('lane-located');
      setTimeout(() => {
        if (run !== laneLocateRun) return;
        if (already) { window.AgentDeskLight?.clearGuides?.(); return; }
        const current = document.querySelector(nodeSelector) || node;
        const colour = current.style.getPropertyValue('--lane').trim() || window.AgentDeskLight?.colour('lead');
        window.AgentDeskLight?.arrive(current);
        // A lasting animated line drawn from the node to what it located; it stays until the node is clicked again.
        window.AgentDeskLight?.guide?.(nodeSelector, messageSelector, colour);
      }, 380);
    });
  }
  function renderLanesView() { if (state.panelOpen && state.panel === 'lanes') A.renderPanel(); }


  function renderPanel(panel, body) {
    const task = getSelected();
    const inTasks = TASK_VIEWS.some(([key]) => key === panel);
    const put = (html) => setHtml(body, (inTasks ? `<div class="panel-seg" role="tablist" aria-label="任务视图">${TASK_VIEWS.map(([key, label]) =>
      `<button type="button" role="tab" data-task-sub="${key}" aria-selected="${key === panel}">${label}</button>`).join('')}</div>` : '') + html);
    if (panel === 'avatars') put(panelAvatars());
    else if (panel === 'members') put(panelMembers());
    else if (panel === 'tasks') put(panelTasks());
    else if (panel === 'graph') put(panelGraph());
    else if (panel === 'lanes') put(panelLanes());
    else if (panel === 'diff') {
      const paths = pathsOf(task);
      put(task ? `<div class="project-panel-body"><h3>任务 ${taskLabel(task)} · 改动文件</h3>
        ${paths.length ? `<ul class="task-paths">${paths.map((path) => `<li>${svg('file')}<span class="mono">${esc(path)}</span></li>`).join('')}</ul>` : '<p class="panel-note">当前任务暂无改动文件。</p>'}
      </div>` : '<div class="empty-note">选择任务以查看改动文件。</div>');
    } else if (panel === 'terminal') {
      const output = task?.steps?.filter((step) => step.output || step.error) || [];
      put(output.length ? `<div class="project-panel-body"><h3>任务 ${taskLabel(task)} · 输出摘要</h3>
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
    for (const id of groups.keys()) {
      const count = taskCount(id) + ':' + unreadCount(id);
      if (count === displayedCounts.get(id)) continue;
      displayedCounts.set(id, count);
      A.renderSidebar();
      break;
    }
    if (state.group && state.panelOpen && state.panel !== 'files') A.renderPanel();
  }

  async function control(operation, extra) {
    const project = A.proj(state.group);
    const answer = await api.control({ operation, ...(project?.configured && { projectId: project.id }), ...extra });
    if (answer.ok) return answer.value;
    const explanations = {
      bridge_offline: '没有可用线路，请检查 SSH 或 Relay。',
      operations_in_progress: '有任务在执行，结束后可以切换线路。',
      unknown_task: '主控上找不到这项任务。',
      invalid_attachment: '附件校验失败，请移除后重新添加；如果主控版本较旧，请先更新 VPS2。',
      invalid_model_selection: '请输入该 CLI 支持的模型 ID。',
      gemini_not_configured: 'VPS 2 尚未配置 Gemini 执行服务。',
      antigravity_not_configured: 'VPS 2 尚未配置 Antigravity。',
      unsupported_operation: '群聊规划需要更新主控和本机连接组件。',
      bridge_update_required: '这台电脑上的连接组件版本较旧，需要更新客户端后才能用这项功能。',
      env_fix_changed_since: '修复之后这些文件又改过，不能自动撤销。',
      outside_changed_since: '这个文件之后又改过，不能自动还原。',
      backup_already_restored: '这个文件已经还原过了。',
      invalid_plan_reply: '请输入 1 至 2000 字的回复。',
      plan_changed: '方案已更新，请按最新一轮的问题或方案操作。',
      invalid_plan: '组长未能生成可用的方案，请从任务详情重试。',
      sign_in_required: '请先登录 AgentDesk。',
      patch_too_large: '补丁超出 24 KiB 预览上限。',
      no_review_changes: '没有可审查的改动。',
      duo_requires_two_reviewers: '主控需要配置两名不同的审查者。',
      team_requires_two_slots: '组队任务需要两个调度槽位。',
      review_snapshot_failed: '无法读取工作区改动。',
      ENOENT: '产物尚未生成或已清理。',
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
    if (!supported || busy || (![...groups.keys()].some((id) => !isExample(id)) && !dialog.open && !projectDialog.open && !unbound().length)) return;
    if (checking) return checking;
    const current = generation;
    refreshResources(current);
    checking = (async () => {
      let routes;
      try {
        routes = await control('routes');
      } catch (error) {
        if (dialog.open && current === generation) routeMessage.textContent = error.message;
      }
      if (current !== generation) return;
      routeState = routes || {};
      renderModelOptions();
      knownRoutes = true;
      connected = Boolean(routeState.ssh || routeState.relay);
      syncProjectChoices();
      autoConnect();
      if (connected && !busy) await Promise.all([...groups.values()].filter((group) => !isExample(group.id)).map(async (group) => {
        try {
          const project = A.proj(group.id);
          const summaries = await control('project_tasks', { project: projectOf(group), projectId: project.configured ? project.id : undefined });
          if (current !== generation || !Array.isArray(summaries)) return;
          const visible = new Set(summaries.map((summary) => summary.id));
          for (const [id, task] of group.records) {
            if ((task.redacted && !visible.has(id)) || window.__providerDirect?.ownsTask(task)) group.records.delete(id);
          }
          for (const summary of summaries) {
            if (window.__providerDirect?.ownsTask(summary)) { group.records.delete(summary.id); continue; }
            if (!belongs(group, summary)) { group.records.delete(summary.id); continue; }
            if (isCleared(group.id, summary)) { group.records.delete(summary.id); continue; }
            const previous = group.records.get(summary.id);
            updateTask(group, summary.id, { ...summary, ...(previous?.prompt && { prompt: previous.prompt }) });
          }
          if (!group.selected || !group.records.has(group.selected)) group.selected = summaries.find((summary) => belongs(group, summary) && !isCleared(group.id, summary))?.id;
          persist(group);
        } catch { /* 旧主控继续从本地保存的任务 ID 同步。 */ }
      }));
      if (connected && isLiveGroup() && !busy) {
        const group = currentGroup();
        const { records, selected } = group;
        if (state.panelOpen && state.panel === 'tasks' && group.output?.operation === 'task_log') updateOutput(group, group.output);
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

  // A click while another group operation is still running used to do nothing at all.
  function stillBusy() {
    if (busy) A.toast('上一个操作还在进行，完成后再试');
    return busy;
  }

  async function run(action, group) {
    if (stillBusy()) return false;
    busy = true;
    if (!group || !isExample(group.id)) await checking;
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
    if (group.selected !== id) group.output = null;
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
    if (!task || task.redacted && operation !== 'status') return;
    if (operation === 'draft') {
      if (groupEnded(group)) return;
      if (group.planReply) { A.toast('请先结束当前规划回复'); return; }
      if (input.value.trim()) { A.toast('请先处理当前草稿'); return; }
      input.value = (task.provider && mentions[task.provider] ? '@' + mentions[task.provider] + ' ' : '') + task.prompt;
      provider.value = '';
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
      } else if (operation === 'patch_download') {
        // Q4: the patch stays on VPS2 while the computer is offline; once connected it is downloaded and checked.
        const patch = await control('patch_download', { taskId: id });
        const saved = await api.savePatch(patch);
        if (!saved?.ok) throw new Error(saved?.error === 'patch_checksum_mismatch' ? '补丁校验失败，已丢弃，请重试。' : (saved?.error || '补丁保存失败'));
        if (current !== generation) return;
        (group.patchNotices ||= {})[id] = { at: new Date().toISOString(), path: saved.path, sha256: patch.sha256, bytes: patch.bytes, fileCount: patch.fileCount };
        A.toast('补丁已下载并校验通过');
        render();
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
    // In the group the lead picks each member's model and effort; the person picks them only in direct chats.
    model.hidden = model.disabled = true;
    renderModelOptions();
    input.maxLength = reply ? 2000 : 12000;
    input.placeholder = reply ? '回复组长…' : '向组长描述任务…（@成员 可指定这一条给谁做）';
    $('#groupPlanReply').hidden = !reply;
    const reference = group?.reference;
    $('#groupReference').hidden = !reference || Boolean(reply);
    if (reference) $('#groupReferenceLabel').textContent = '引用 #' + reference.slice(0, 8);
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
    suggestionItems = kind === '@' ? [...recipients.filter((id) => canUse(id) && memberName(id).toLowerCase().includes(query)), ...('all'.startsWith(query) ? ['all'] : [])]
      : Object.keys(availableCommands).filter((name) => name.startsWith(query));
    if (!suggestionItems.length) { hideSuggestions(); return; }
    suggestionIndex = Math.min(suggestionIndex, suggestionItems.length - 1);
    setHtml(suggestions, suggestionItems.map((item, index) => `<button type="button" data-suggestion="${index}" aria-selected="${index === suggestionIndex}">
      ${item === 'all' && kind === '@' ? '<span class="mono">@all</span><small>只读广播</small>' : kind === '@' ? `${memberAvatar(item, 25)} ${memberName(item)} <small>${avatars.states[memberActivity(item).state || 'idle'].label}</small>`
        : `<span class="mono">/${item}</span><small>${availableCommands[item]}</small>`}
    </button>`).join(''));
    suggestions.hidden = false;
  }

  function pickSuggestion(index) {
    const token = suggestionToken();
    const item = suggestionItems[index];
    if (!token || !item) return;
    if (token.kind === '@' && item === 'all') {
      input.value = '@all ' + input.value.slice(input.selectionStart);
      input.setSelectionRange(5, 5);
      hideSuggestions();
      input.focus();
      return;
    }
    if (token.kind === '@' && token.index > 0) {
      // A mention typed in the middle goes to the front, where it names who does this message's work.
      input.setRangeText('', token.index, input.selectionStart, 'end');
      const rest = input.value.replace(/^@\S+\s+/, '');
      input.value = '@' + mentions[item] + ' ' + rest;
      input.setSelectionRange(input.value.length, input.value.length);
      hideSuggestions();
      input.focus();
      return;
    }
    const value = token.kind + (token.kind === '@' ? mentions[item] : item) + ' ';
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

  function groupDraft(draft, group) {
    const command = /^[/](duo|team|compact|review|broadcast|chat|edit)(?:\s+|$)/i.exec(draft);
    const all = /^@all(?:\s+|$)/i.exec(draft);
    const modes = { duo: 'duo', team: 'team', review: 'review_only', chat: 'chat', edit: 'edit' };
    const kind = all ? 'broadcast' : command?.[1].toLowerCase();
    let prompt = command || all ? draft.slice((command || all)[0].length).trim() : draft;
    let reviewOf;
    if (kind === 'review') {
      const target = /^#?([0-9a-f-]{6,36})(?:\s+|$)/i.exec(prompt);
      if (target) {
        const matches = [...group.records.values()].filter((task) => !task.redacted && task.id.startsWith(target[1]));
        if (matches.length !== 1) throw new Error('找不到唯一的本人任务，请使用完整任务编号。');
        reviewOf = matches[0].id;
        prompt = prompt.slice(target[0].length).trim();
      }
      if (!prompt) prompt = '审查补丁的正确性和回归风险。';
    }
    const aliases = { '组长': '', codex: 'codex', claude: '', 'claude code': '', grok: 'grok', 'grok build': 'grok', gemini: 'gemini', antigravity: 'antigravity' };
    const mention = /^@(组长|codex|claude(?: code)?|grok(?: build)?|gemini|antigravity)(?:\s+|$)/i.exec(prompt);
    // A member is named with @ in the message itself and only for that message; nothing stays selected.
    let recipient = mention ? aliases[mention[1].toLowerCase()] : '';
    if (kind === 'edit' && mention && /^claude/i.test(mention[1])) recipient = 'claude';
    if (kind === 'edit' && !recipient) throw new Error('请用 /edit @成员 任务内容 指定修改者。');
    if (['duo', 'team', 'review', 'broadcast', 'compact'].includes(kind)) recipient = '';
    if (mention) prompt = prompt.slice(mention[0].length).trim();
    if (recipient && !canUse(recipient)) throw new Error(`当前主控尚未启用 ${members[recipient].name}。`);
    if (!prompt && kind !== 'compact') throw new Error('请输入任务内容。');
    const mode = modes[kind] || 'normal';
    const files = (group.attachments || []).map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 }));
    if (files.length && (['broadcast', 'compact'].includes(kind) || mode === 'review_only')) {
      throw new Error('广播、项目简报和审查任务不能带附件，请先移除附件。');
    }
    const operation = kind === 'compact' ? 'compact_project' : kind === 'broadcast' ? 'broadcast'
      : ['review_only', 'chat', 'edit'].includes(mode) ? 'submit' : 'start_plan';
    const parent = group.reference ? group.records.get(group.reference) : latestTask(group);
    if (!kind && parent && !parent.redacted && ['failed', 'cancelled'].includes(parent.state) && parent.prompt && !prompt.includes(parent.prompt)) {
      const lastStep = parent.steps?.filter(step => step.output).at(-1);
      const context = '\n\n上次任务（' + statusName(parent.state) + '）：' + parent.prompt +
        (lastStep ? '\n最后一步的记录：' + String(lastStep.output).slice(-1000) : '');
      prompt += context.slice(0, Math.max(0, 12000 - prompt.length));
    }
    return {
      operation,
      request: {
        prompt, mode, reviewOf, via: 'desktop', project: projectOf(group), replyTo: parent?.id, group: group.id,
        leadEffort: $('#groupLeadEffort')?.value || undefined,
        leadModel: $('#groupLeadModel')?.value || undefined,
        approval: $('#groupApproval')?.value || undefined,
        autoHandover: $('#groupAutoHandover') ? $('#groupAutoHandover').checked : undefined,
        provider: recipient || undefined,
        // The person's member order from the quota page (only the kinds of work they reordered).
        ...(!['broadcast', 'compact'].includes(kind) && personRouteOrder()),
        ...(files.length && { attachments: files }),
      },
    };
  }

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
      if (task.redacted || !task.state || terminal.has(task.state)) { A.toast('这项任务当前不可取消'); return true; }
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
    if (!group || groupEnded(group) || !draft || stillBusy()) return;
    if (group.planReply) {
      const { id, revision } = group.planReply;
      if (!isExample(group.id) && !connected) { A.toast('主控线路还没连上，连上后再发送回复'); return; }
      if (await sendPlanAction(group, id, revision, 'plan_reply', draft)) {
        if (group === currentGroup()) cancelPlanReply(group);
        else {
          group.draft = group.planReply.previousDraft;
          group.planReply = null;
        }
      }
      return;
    }
    // In a group the person talks to the lead: while the lead is waiting for answers or for a decision on its
    // plan, a plain message is that answer (no new task). Commands and @mentions still start their own work.
    const waiting = !/^[/@]/.test(draft) && !group.reference ? latestTask(group) : null;
    if (waiting && waitingForPlan(waiting) && !waiting.redacted) {
      const round = waiting.plan?.rounds?.at(-1);
      if (round && (isExample(group.id) || connected)) {
        if (await sendPlanAction(group, waiting.id, round.revision, 'plan_reply', draft)) {
          if (group === currentGroup() && input.value.trim() === draft) input.value = '';
        }
        return;
      }
    }
    // ...and while the lead's task is still under way, the message changes that task's plan (same task, same
    // workbench): the lead keeps what is done and plans the rest again. Only a finished task starts a new one.
    if (waiting && !waiting.redacted && waiting.state && !terminal.has(waiting.state) && !waitingForPlan(waiting) && waiting.plan) {
      if (isExample(group.id)) {
        updateTask(group, waiting.id, { state: 'planning', detail: 'plan_revise_requested' });
        input.value = '';
        A.toast('已交给组长：保留已完成的部分，按你的话重新规划剩下的');
        render();
        return;
      }
      if (connected) {
        const current = generation;
        const sent = await run(async () => {
          const answer = await control('revise_plan', { taskId: waiting.id, reply: draft });
          if (current === generation) updateTask(group, waiting.id, answer, true);
        }, group);
        if (sent) {
          if (group === currentGroup() && input.value.trim() === draft) input.value = '';
          A.toast('已交给组长：它会判断哪些步骤继续、补一句指导接着做，或者停下');
        }
        return;
      }
    }
    if (handleCommand(draft) || (!isExample(group.id) && (!supported || !hasRoute()))) return;
    hideSuggestions();
    let parsed;
    try {
      parsed = groupDraft(draft, group);
    } catch (error) {
      group.taskError = error.message;
      render();
      return;
    }
    const { operation, request } = parsed;
    const key = JSON.stringify(parsed);
    if (group.pending?.key !== key) group.pending = { key, id: crypto.randomUUID() };
    const id = group.pending.id;
    const current = generation;
    const sent = await run(async () => {
      if (current !== generation) return;
      if (operation === 'compact_project') {
        const summary = isExample(group.id) ? { taskCount: group.records.size } : await control(operation, { project: request.project });
        A.toast(`项目简报已更新 · ${summary.taskCount} 项任务`);
        return;
      }
      const demo = operation === 'start_plan' ? {
        state: 'awaiting_details', detail: 'plan_questions',
        plan: { rounds: [{ revision: 1, questions: ['这项任务的交付物是什么？', '你会根据哪些条件验收？'] }] },
      } : { state: 'completed', steps: [{ id: 'scout', role: request.provider || 'codex', output: '示例 · 已完成只读处理。' }] };
      const summaries = isExample(group.id) ? [demo] : await control(operation, { taskId: id, ...request });
      if (current !== generation) return;
      for (const summary of Array.isArray(summaries) ? summaries : [summaries]) {
        const taskId = summary.id || id;
        updateTask(group, taskId, { ...request, ...summary, time: Date.now() });
        group.selected = taskId;
      }
      group.output = null;
      persist(group);
      group.statusError = '';
      if (group === currentGroup()) {
        filter = 'all';
        filterSelect.value = '';
        updateFilters();
      }
    }, group);
    if (!sent || current !== generation) return;
    group.pending = null;
    group.reference = null;
    if (request.attachments) {
      // Sent: the desktop has handed the files over and forgotten them.
      const sentIds = new Set(request.attachments.map((file) => file.id));
      group.attachments = (group.attachments || []).filter((file) => !sentIds.has(file.id));
      if (window.AgentDeskAttachNotice) A.toast(window.AgentDeskAttachNotice.sent(sentIds.size, 'group'));
      if (group === currentGroup()) renderGroupAttachments();
    }
    if (group === currentGroup()) {
      if (input.value.trim() === draft) input.value = '';
      setRecipient(group);
      timeline.scrollTop = timeline.scrollHeight;
    } else if (group.draft.trim() === draft) group.draft = '';
  });

  // The saved order, kept to members the orchestrator routes each kind of work to right now (an order naming a
  // member it no longer routes would be refused). Nothing is sent when nothing was reordered.
  function personRouteOrder() {
    // Entries are members or member@model, and may name members the route does not list (the quota page's
    // 「+ 补充」); only members the orchestrator has configured are sent, and only Claude for the lead's work.
    const saved = store.get('routeOrder', {});
    const configured = routeState.team?.configured;
    const lead = ['plan', 'triage', 'accept'];
    const order = {};
    for (const [capability, list] of Object.entries(saved)) {
      if (!Array.isArray(list)) continue;
      const allowed = list.filter((entry) => {
        const role = String(entry).split('@')[0];
        return (!configured || configured.includes(role)) && (lead.includes(capability) ? role === 'claude' : role !== 'claude');
      });
      if (allowed.length) order[capability] = allowed;
    }
    return Object.keys(order).length ? { routeOrder: order } : {};
  }

  // Stopping a whole task: from its card, or the composer's stop button (the group's newest unfinished task).
  const activeTasks = (group) => [...(group?.records.values() || [])].filter((task) => belongs(group, task) && !task.redacted &&
    task.state && !terminal.has(task.state) && task.state !== 'needs_review')
    .sort((a, b) => (Date.parse(b.createdAt || '') || b.time || 0) - (Date.parse(a.createdAt || '') || a.time || 0));
  async function stopTask(id) {
    const group = currentGroup();
    const task = group?.records.get(id);
    if (!task || stillBusy()) return;
    if (!window.confirm(`停止任务「${String(task.prompt || '').slice(0, 40)}」？\n正在运行的成员会被停下；已经生成、还没应用的补丁不会应用。`)) return;
    group.selected = id;
    await taskAction('cancel');
    A.toast('已停止任务');
  }
  timeline.addEventListener('click', (event) => {
    const id = event.target.closest('[data-stop-task]')?.dataset.stopTask;
    if (id) stopTask(id);
  });
  $('#groupStop').addEventListener('click', () => { const task = activeTasks(currentGroup())[0]; if (task) stopTask(task.id); });

  // Stop one running step: the lead reassigns it; the task carries on.
  timeline.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-stop-step]');
    if (!button || stillBusy()) return;
    if (!window.confirm('停止这一步？它会交给组长换成员或换模型重新安排，任务本身继续。')) return;
    try {
      const answer = await control('stop_step', { taskId: button.dataset.stopStep, stepId: button.dataset.step });
      updateTask(currentGroup(), button.dataset.stopStep, answer);
      A.toast('已停止这一步，交给组长重新安排');
      render();
    } catch (error) { A.toast('停止失败：' + error.message); }
  });
  timeline.addEventListener('click', async (event) => {
    const id = event.target.closest('[data-approve-addition]')?.dataset.approveAddition;
    const group = currentGroup();
    if (!id || !group || stillBusy()) return;
    await run(async () => {
      const answer = await control('approve_addition', { taskId: id });
      updateTask(group, id, answer, true);
    }, group);
    render();
  });
  timeline.addEventListener('click', (event) => {
    const id = event.target.closest('[data-retry-task]')?.dataset.retryTask;
    const group = currentGroup();
    const task = id && group?.records.get(id);
    if (!task || groupEnded(group) || stillBusy()) return;
    group.reference = task.id;
    input.value = `${task.prompt || ''}\n\n（上一次没完成：${failureReason(task)}。请组长换个办法重新安排。）`;
    form.requestSubmit();
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
  $('#groupClearAll').addEventListener('click', clearAllGroups);
  $('#sbGroupMembers').addEventListener('click', (event) => showMember(event.target.closest('[data-status-member]')?.dataset.statusMember));
  $('#sbResources').addEventListener('click', (event) => {
    if (!event.target.closest('button')) return;
    focusMember = undefined;
    A.showPanel('members');
    $('#panelResources')?.scrollIntoView({ block: 'nearest' });
  });
  $('#panelBody').addEventListener('click', (event) => { if (event.target.closest('[data-open-quota]')) window.__quotaView?.open(); });
  $('#panelBody').addEventListener('change', (event) => {
    if (state.group && event.target.matches('[data-log-select]')) openTaskOutput('task_log', { stepId: event.target.value });
    if (state.group && event.target.matches('[data-lane-task]')) selectTask(event.target.value, 'lanes');
    if (state.group && event.target.id === 'flowTask') selectTask(event.target.value, 'graph');
  });
  for (const surface of [timeline, $('#panelBody')]) {
    surface.addEventListener('click', (event) => {
      if (!state.group) return;
      const group = currentGroup();
      const summaryToggle = event.target.closest('[data-summary-toggle]');
      if (summaryToggle) {
        const key = summaryToggle.dataset.summaryToggle;
        group.summaryOpen ||= new Set();
        if (group.summaryOpen.has(key)) group.summaryOpen.delete(key); else group.summaryOpen.add(key);
        render();
        return;
      }
      const sub = event.target.closest('[data-task-sub]');
      if (sub) { A.showPanel(sub.dataset.taskSub); return; }
      const thread = event.target.closest('[data-agent-thread]');
      if (thread) {
        window.__agentThreadsReady.then(() => window.__agentThreads?.open(group.id, thread.dataset.agentThread, thread.dataset.agentTask, thread.dataset.agentStep));
        return;
      }
      const expand = event.target.closest('[data-expand-task]');
      if (expand) {
        (group.expanded ||= new Set()).add(expand.dataset.expandTask);
        render();
        return;
      }
      if (event.target.closest('[data-clear-group-approvals]')) {
        approvals.clear(localStorage, group.id);
        A.renderPanel();
        return;
      }
      const deny = event.target.closest('[data-group-approval-deny]');
      if (deny) {
        const id = deny.closest('[data-group-approval]').dataset.groupApproval;
        respondApproval(group, group.approvals.get(id), false);
        return;
      }
      const jump = event.target.closest('[data-reference-jump]');
      if (jump) {
        filter = 'all';
        filterSelect.value = '';
        updateFilters();
        renderTimeline();
        timeline.querySelector(`[data-message-id="${CSS.escape(jump.dataset.referenceJump)}"]`)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      const reference = event.target.closest('[data-reference]');
      if (reference && !group.planReply && !groupEnded(group)) {
        group.reference = reference.dataset.reference;
        setRecipient(group);
        input.focus();
        return;
      }
      const output = event.target.closest('[data-task-output]');
      if (output) {
        openTaskOutput(output.dataset.taskOutput, { stepId: output.dataset.logStep || undefined });
        return;
      }
      const artifact = event.target.closest('[data-artifact]');
      if (artifact) {
        if (artifact.dataset.artifact.startsWith('build:')) {
          const selected = currentGroup().output;
          if (selected?.taskId) api.saveBuild({ taskId: selected.taskId, projectId: state.group, artifact: artifact.dataset.artifact })
            .then((result) => {
              if (!result.ok) { selected.error = result.error || '构建产物保存失败'; A.renderPanel(); }
            }).catch(() => { selected.error = '构建产物保存失败'; A.renderPanel(); });
          return;
        }
        openTaskOutput('task_artifacts', { artifact: artifact.dataset.artifact });
        return;
      }
      const planButton = event.target.closest('[data-plan-action]');
      if (planButton) {
        const group = currentGroup();
        const id = planButton.dataset.planTask;
        const round = group.records.get(id)?.plan?.rounds.at(-1);
        if (!round) { A.toast('方案已更新，请按最新一轮操作'); return; }
        if (stillBusy()) return;
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
      const laneTask = event.target.closest('[data-lane-task]');
      if (laneTask) {
        const target = laneTask.dataset.laneGroup;
        if (target !== state.group) A.openGroup(target);
        selectTask(laneTask.dataset.laneTask, 'graph');
        return;
      }
      const laneGroup = event.target.closest('[data-lane-open-group]')?.dataset.laneOpenGroup;
      if (laneGroup) { if (laneGroup !== state.group) A.openGroup(laneGroup); A.showPanel('lanes'); return; }
      const laneChat = event.target.closest('[data-lane-open-chat]')?.dataset.laneOpenChat;
      if (laneChat) { A.openSession(laneChat); return; }
      const task = event.target.closest('[data-task-id]');
      const action = event.target.closest('[data-task-operation]');
      if (task) selectTask(task.dataset.taskId, task.dataset.taskView);
      if (action) taskAction(action.dataset.taskOperation);
      // Group chat v7 (envFix): undo one environment fix (only while its files are as the fix left them).
      const restoreButton = event.target.closest('[data-outside-restore]');
      if (restoreButton) {
        const [taskId, backupId] = restoreButton.dataset.outsideRestore.split(':');
        const group = currentGroup();
        run(async () => {
          await control('outside_restore', { taskId, backupId });
          A.toast('已还原原内容');
          await syncTask(group, taskId);
        }, group);
        return;
      }
      const revertButton = event.target.closest('[data-env-revert]');
      if (revertButton) {
        const [taskId, fixId] = revertButton.dataset.envRevert.split(':');
        const group = currentGroup();
        run(async () => {
          await control('env_fix_revert', { taskId, fixId });
          A.toast('环境修复已撤销');
          await syncTask(group, taskId);
        }, group);
        return;
      }
      // Requirement 4: open one of the lead's suggested single chats, with the suggested first message ready.
      const adviceButton = event.target.closest('[data-direct-advice]');
      if (adviceButton) {
        const [taskId, index] = adviceButton.dataset.directAdvice.split(':');
        const option = currentGroup()?.records?.get(taskId)?.directAdvice?.options?.[Number(index)];
        if (!option) return;
        Promise.resolve(A.newDirect(state.group, option.role)).then(() => {
          const box = $('#input');
          if (box && !box.value.trim()) { box.value = option.prompt || ''; box.dispatchEvent(new Event('input')); }
          const mode = $('#modeSelect');
          if (mode) { mode.value = option.access === 'readOnly' ? 'plan' : 'auto'; mode.dispatchEvent(new Event('change')); }
        }).catch((error) => A.toast(error.message));
        return;
      }
      const directButton = event.target.closest('[data-direct-provider]');
      if (directButton) {
        const provider = directButton.dataset.directProvider;
        const direct = A.D.sessions.find((session) => session.project === state.group
          && !session.provider && !session.agentThread && (session.agent || 'codex') === provider)
          || A.D.sessions.find((session) => session.project === state.group
            && !session.agentThread && session.provider === provider);
        if (direct) A.openSession(direct.id);
        else A.newDirect(state.group, provider);
      }
    });
  }

  $('#groupReferenceClear').addEventListener('click', () => {
    const group = currentGroup();
    if (!group) return;
    group.reference = null;
    setRecipient(group);
  });
  $('#newGroupProject').hidden = false;
  // The local folder is chosen in the dialog itself (main keeps the path; the window holds only a token).
  let pickedFolder = null;
  const localProjects = () => LIVE && !temporary && Boolean(window.AgentDeskProjects?.bindForDirect);
  const showPickedFolder = () => {
    $('#groupProjectFolder').textContent = pickedFolder?.path || '未选择';
    $('#groupProjectFolder').title = pickedFolder?.path || '';
  };
  $('#groupProjectFolderPick').addEventListener('click', async () => {
    const picked = await window.AgentDeskProjects?.pickFolder?.().catch((error) => ({ ok: false, error: error?.message }));
    if (picked?.ok) {
      pickedFolder = picked;
      showPickedFolder();
      const name = $('#groupProjectName');
      if (!name.value.trim()) name.value = picked.path.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 60) || '';
    } else if (picked?.error) A.toast(picked.error);
  });
  $('#newGroupProject').addEventListener('click', () => {
    delete projectBinding.dataset.touched;
    pickedFolder = null;
    showPickedFolder();
    $('#groupProjectFolderRow').hidden = $('#groupProjectHint').hidden = !localProjects();
    projectDialog.showModal();
    syncProjectChoices();
    refresh();
  });
  $('#groupProjectClose').addEventListener('click', () => projectDialog.close());
  let creatingProject = false;
  $('#groupProjectForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (creatingProject) return;
    const name = $('#groupProjectName').value.trim();
    if (!name) return;
    const binding = projectBinding.value;
    if (binding && !routeState.projects?.includes(binding)) { A.toast('这个主控工作区现在不可用，请刷新线路后重新选择'); return; }
    // The orchestrator's workspaces are still loading: creating now would make an unbound project in which
    // attachments never work. Wait for the list instead of creating it silently unbound.
    if (!binding && supported && !knownRoutes && !temporary) {
      A.toast('正在读取主控的工作区，读到后再选择并创建');
      Promise.resolve(refresh()).finally(syncProjectChoices);
      return;
    }
    if (!binding) {
      A.toast($('#groupProjectBindingHint').textContent || '没有可用的主控工作区，暂时不能新建项目');
      return;
    }
    const project = { id: 'group-' + crypto.randomUUID(), name, branch: 'main', live: Boolean(binding), serverProject: binding || undefined };
    // A new project starts from its folder on this computer: the person picks it first and AgentDesk turns it into a
    // Git repository (git init, or the parent repository it sits in) before the project exists. Cancelling the
    // folder picker creates nothing. The folder is only the working directory: group and single chats still read
    // files anywhere their file permissions allow, not just inside it.
    const local = localProjects();
    // Listed first (unconfigured) so registering it keeps its orchestrator binding; taken back out if nothing was made.
    A.D.projects.push(project);
    if (local) {
      creatingProject = true;
      let made = false;
      // The folder picked in the dialog, or (none picked) the picker opens now.
      try { made = await window.AgentDeskProjects.bindForDirect(project, pickedFolder?.token); }
      catch (error) { A.toast('没能建好本机仓库：' + (error?.message || String(error))); }
      finally { creatingProject = false; pickedFolder = null; showPickedFolder(); }
      if (!made) {
        const at = A.D.projects.findIndex((item) => item.id === project.id && !item.configured);
        if (at >= 0) A.D.projects.splice(at, 1);
        A.renderAll();
        return;
      }
    }
    savedProjects.push(project);
    if (!temporary) store.set('groupProjectBindings', savedProjects);
    createGroup(project.id);
    event.target.reset();
    projectDialog.close();
    A.openGroup(project.id);
    // With a local folder the Git result was already reported (projects.js reportInit). Otherwise, created from the
    // orchestrator: the project is set up straight away, so attachments and single chats work.
    if (!local && binding && !temporary) {
      Promise.resolve(window.AgentDeskProjects?.ensureRegistered?.(project)).then((ok) => {
        if (ok) A.toast(`项目「${name}」已建好，可以直接添加附件、开始单聊`);
      }).catch((error) => A.toast(error.message));
    }
  });

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
      for (const group of [...groups.values()].filter((group) => !isExample(group.id))) {
        group.records.clear();
        group.approvals.clear();
        group.output = group.reference = null;
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

  document.addEventListener('visibilitychange', () => {
    if (currentGroup()) markSeen(currentGroup());
    repaint();
  });
  const leadEffort = $('#groupLeadEffort');
  if (leadEffort) {
    const savedEffort = (state.group && workbench[state.group]?.leadEffort) || 'high';
    if ([...leadEffort.options].some((option) => option.value === savedEffort)) leadEffort.value = savedEffort;
    leadEffort.addEventListener('change', () => {
      const group = currentGroup();
      if (group) { group.leadEffort = leadEffort.value; saveWorkbench(group); }
    });
  }
  // 自动接手 is one setting for all groups, kept as last left (like 完全访问 in single chats).
  const autoHandover = $('#groupAutoHandover');
  if (autoHandover) {
    autoHandover.checked = store.get('groupAutoHandover', true) !== false;
    autoHandover.addEventListener('change', () => {
      store.set('groupAutoHandover', autoHandover.checked);
      A.toast(autoHandover.checked ? '自动接手：失败后按顺序直接换模型接着做' : '失败时弹窗，由你选择接手的模型');
    });
  }
  const approvalPick = $('#groupApproval');
  if (approvalPick) {
    approvalPick.value = (state.group && workbench[state.group]?.approval) || 'small';
    approvalPick.addEventListener('change', () => {
      const group = currentGroup();
      if (group) { group.approval = approvalPick.value; saveWorkbench(group); }
    });
  }
  const leadModelPick = $('#groupLeadModel');
  if (leadModelPick) {
    leadModelPick.addEventListener('change', () => {
      const group = currentGroup();
      if (group) { group.leadModel = leadModelPick.value; saveWorkbench(group); }
      fitLeadEffort();
    });
  }

  // Example groups only: change a task the way a status update would, to preview the board, lights and lanes.
  // The failure dialog: a step nobody could finish (or any failed step while 自动接手 is off) waits for the person
  // to pick who takes it over — every member that can do this kind of work, each of its models (newest first)
  // and a thinking level — or to stop the step. It opens once per waiting step; a card in the conversation
  // opens it again.
  const shownChoices = new Set();
  const versionOf = (id) => (/(\d+(?:[.-]\d+)*)/.exec(id)?.[1] || '').split(/[.-]/).map(Number).filter((n) => n <= 999);
  const newestFirst = (ids) => [...ids].sort((a, b) => { const x = versionOf(a), y = versionOf(b); for (let i = 0; i < Math.max(x.length, y.length); i += 1) { const d = (y[i] ?? -1) - (x[i] ?? -1); if (d) return d; } return 0; });
  const EFFORT_NAMES = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
  function waitingChoices(group) {
    return [...group.records.values()].flatMap((task) => (task.steps || []).filter((step) => step.state === 'waiting_choice').map((step) => ({ task, step })));
  }
  function choiceDialog(task, step, adjust = false) {
    let dialog = document.querySelector('#handoverDialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'handoverDialog';
      dialog.className = 'handover-dialog';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.closest('[data-handover-close]')) dialog.close(); });
      dialog.addEventListener('change', (event) => {
        if (!event.target.matches('[name="handoverModel"]')) return;
        const [role, model] = event.target.value.split('|');
        const efforts = (dialog.profiles || routeState.modelProfiles)?.[role]?.models?.[model]?.efforts || [];
        const select = dialog.querySelector('#handoverEffort');
        select.replaceChildren(new Option('默认', ''), ...efforts.map((level) => new Option(EFFORT_NAMES[level] || level, level)));
        select.disabled = !efforts.length;
      });
      dialog.addEventListener('submit', async (event) => {
        event.preventDefault();
        const { taskId, stepId } = dialog.dataset;
        const stop = event.submitter?.dataset.handoverStop === '1';
        const adjusting = dialog.dataset.adjust === '1';
        const picked = dialog.querySelector('[name="handoverModel"]:checked')?.value;
        if (!stop && !picked) { A.toast('先选一个接手的模型'); return; }
        const [role, model] = (picked || '|').split('|');
        const effort = dialog.querySelector('#handoverEffort').value || undefined;
        const group = currentGroup();
        const ok = await run(async () => {
          const answer = isExample(group.id) ? null : await control('handover_choose', { taskId, stepId, ...(stop ? { stop: true } : { role, model: model || undefined, effort }) });
          if (answer) updateTask(group, taskId, answer, true);
          if (isExample(group.id) && adjusting) {
            const task = group.records.get(taskId);
            const target = [...(task?.steps || []), ...(task?.plan?.rounds?.at(-1)?.steps || [])].find((item) => item.id === stepId);
            if (target) Object.assign(target, { role, model: model || undefined, effort });
          }
        }, group);
        if (ok) { dialog.close(); A.toast(stop ? '已停止这一步' : adjusting ? `这一步改由 ${memberName(role)} 做` : `已交给 ${memberName(role)} 接着做`); render(); }
      });
    }
    const write = Boolean(step.write);
    // Example groups have no orchestrator: a sample list, so the dialog can be tried offline.
    const sample = isExample(state.group) && !routeState.modelProfiles;
    const profiles = sample ? { codex: { models: { 'gpt-5.5': { label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }, 'gpt-5.4': { label: 'GPT-5.4', efforts: ['low', 'medium', 'high'] } } },
      grok: { models: { 'grok-4.7': { efforts: ['low', 'high'] } } }, antigravity: { models: { 'gemini-4-hydrogen': {}, 'gemini-3.8-flash-medium': {} } } } : routeState.modelProfiles || {};
    const roles = (sample ? Object.keys(profiles) : routeState.team?.configured || Object.keys(profiles)).filter((role) => role !== 'claude' &&
      (!write || sample || (routeState.writeProviders || []).includes(role)));
    const rows = roles.map((role) => {
      const models = newestFirst(Object.keys(profiles[role]?.models || {}));
      const options = (models.length ? models : ['']).map((model) => {
        const label = model ? (profiles[role].models[model]?.label || window.AgentDeskLanes?.modelShort?.(model) || model) : '默认模型';
        const same = role === step.role && (model || undefined) === (step.model || undefined);
        return `<label class="handover-option${same && !adjust ? ' failed' : ''}"><input type="radio" name="handoverModel" value="${esc(role)}|${esc(model)}" ${same && adjust ? 'checked' : ''} />${esc(label)}${same ? (adjust ? '<small class="now">现在</small>' : '<small>刚失败</small>') : ''}</label>`;
      }).join('');
      return `<div class="handover-member">${avatars.html(role, { size: 20, still: true })}<b>${esc(memberName(role))}</b><div class="handover-models">${options}</div></div>`;
    }).join('');
    dialog.dataset.taskId = task.id;
    dialog.dataset.stepId = step.id;
    dialog.dataset.adjust = adjust ? '1' : '';
    dialog.profiles = profiles;
    const what = capabilityLabels[step.capability] || (write ? '改代码' : '只读');
    dialog.innerHTML = `<form method="dialog"><header><h3>${adjust ? '调整这一步的模型' : '这一步需要你选接手的模型'}</h3><button type="button" class="qv-close" data-handover-close aria-label="关闭">×</button></header>
      ${adjust ? `<p class="handover-why">${esc(step.id)} · ${esc(what)} · 现在是 <b>${esc(memberName(step.role))}${step.model ? '（' + esc(step.model) + '）' : ''}</b>${step.effort ? ' · 思考 ' + esc(EFFORT_NAMES[step.effort] || step.effort) : ''}</p>
        <p class="handover-note">还没开始，换成你选的成员、模型和思考程度来做。</p>`
      : `<p class="handover-why"><b>${esc(memberName(step.role))}${step.model ? '（' + esc(step.model) + '）' : ''}</b> 没完成：${esc(failureText(step.choice?.error || step.error || ''))}</p>
      ${step.choice?.tried?.length ? `<p class="handover-tried">已经试过：${esc(step.choice.tried.join('、'))}</p>` : ''}
      <p class="handover-note">选中的模型会接着上一个的改动继续做（${esc(what)}）。</p>`}
      <div class="handover-list">${rows || '<p>现在没有能接这种活的成员。</p>'}</div>
      <label class="handover-effort">思考程度 <select id="handoverEffort" disabled><option value="">默认</option></select></label>
      <footer>${adjust ? '' : '<button type="submit" class="btn" data-handover-stop="1">停止这一步</button>'}<span class="grow"></span>
        <button type="button" class="btn" data-handover-close>${adjust ? '取消' : '稍后'}</button><button type="submit" class="btn primary">${adjust ? '确定' : '接手并继续'}</button></footer></form>`;
    if (!dialog.open) dialog.showModal();
    // the current model's thinking levels, when it is preselected
    dialog.querySelector('[name="handoverModel"]:checked')?.dispatchEvent(new Event('change', { bubbles: true }));
    if (adjust && step.effort) dialog.querySelector('#handoverEffort').value = step.effort;
  }
  const failureText = (error) => window.__providerDirect?.errors?.[error] || ({ cli_exit_1: 'CLI 异常退出', cli_timeout: '超时', cli_stalled: '长时间没有输出' })[String(error).split(':')[0]] || String(error).slice(0, 300);
  // The lead asks for temporary access for one step: the person allows it for this step, for the whole task
  // (same kind, until the task ends), or declines.
  function permissionDialog(task, step) {
    let dialog = document.querySelector('#permissionDialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'permissionDialog';
      dialog.className = 'handover-dialog';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', async (event) => {
        if (event.target === dialog || event.target.closest('[data-permission-close]')) { dialog.close(); return; }
        const button = event.target.closest('[data-permission-answer]');
        if (!button) return;
        const group = currentGroup();
        const { taskId, stepId } = dialog.dataset;
        const answer = button.dataset.permissionAnswer;
        const ok = await run(async () => {
          if (isExample(group.id)) return;
          const request = group.records.get(taskId)?.steps?.find((item) => item.id === stepId)?.permissionRequest || {};
          const grant = answer !== 'deny' && (request.path || request.argv) ? { kind: request.kind, path: request.path, argv: request.argv, workspace: request.workspace } : undefined;
          updateTask(group, taskId, await control('permission_answer', { taskId, stepId, reply: answer, group: group.id, ...(grant && { grant }) }), true);
        }, group);
        if (ok) { dialog.close(); A.toast({ step: '已允许这一步', task: '已允许这项任务里同类的权限', deny: '已拒绝，这一步会不用它把能做的做完' }[answer]); render(); }
      });
    }
    const request = step.permissionRequest || {};
    dialog.dataset.taskId = task.id;
    dialog.dataset.stepId = step.id;
    dialog.innerHTML = `<form method="dialog"><header><h3>组长申请临时权限</h3><button type="button" class="qv-close" data-permission-close aria-label="关闭">×</button></header>
      <p class="handover-why"><b>${esc(memberName(step.role))}${step.model ? '（' + esc(step.model) + '）' : ''}</b> 在 ${esc(step.id)} 这一步因为权限不够没做完。</p>
      <p class="permission-kind">申请：<b>${esc(ACCESS_NAMES[request.kind] || request.kind || '')}</b></p>
      ${request.path ? `<p class="permission-target">文件夹：<code>${esc(request.path)}</code></p>` : ''}
      ${request.argv ? `<p class="permission-target">命令：<code>${esc(request.argv.join(' '))}</code>（在项目文件夹里运行，不经过 shell）</p>` : ''}
      ${request.reason ? `<p class="handover-note">组长的理由：${esc(request.reason)}</p>` : ''}
      ${request.denials?.length ? `<p class="handover-tried">被拒绝的操作：${esc(request.denials.join('；'))}</p>` : ''}
      <p class="handover-note">${request.path || request.argv ? '这可能超出这台电脑配置允许的范围，由你在这台电脑上批准；只给这项任务用，任务结束或 6 小时后收回。' : '只给这一步（或这项任务）用，结束就收回。'}凭据目录、.git、绕过补丁直接改项目，无论怎样都不会开。</p>
      <footer><button type="button" class="btn" data-permission-answer="deny">拒绝</button><span class="grow"></span>
        <button type="button" class="btn" data-permission-answer="task">这项任务都允许</button><button type="button" class="btn primary" data-permission-answer="step">允许这一步</button></footer></form>`;
    if (!dialog.open) dialog.showModal();
  }
  function offerChoices() {
    const group = currentGroup();
    if (!group || document.hidden) return;
    for (const task of group.records.values()) {
      for (const step of (task.steps || []).filter((item) => item.state === 'waiting_permission')) {
        const key = 'permission:' + task.id + ':' + step.id + ':' + (step.permissionRequest?.kind || '');
        if (shownChoices.has(key)) continue;
        shownChoices.add(key);
        permissionDialog(task, step);
        return;
      }
    }
    for (const { task, step } of waitingChoices(group)) {
      const key = task.id + ':' + step.id + ':' + (step.history?.length || 0);
      if (shownChoices.has(key)) continue;
      shownChoices.add(key);
      choiceDialog(task, step);
      return;
    }
  }
  // 「换模型」on a node beside the group or on a progress row: steps not started yet and steps waiting for a choice.
  document.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-step-adjust]');
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    const group = currentGroup();
    const [taskId, stepId] = chip.dataset.stepAdjust.split(':');
    const task = group?.records.get(taskId);
    const step = task && [...(task.steps || []), ...(task.plan?.rounds?.at(-1)?.steps || [])].find((item) => item.id === stepId);
    if (step) choiceDialog(task, step, step.state !== 'waiting_choice');
  }, true);
  timeline.addEventListener('click', (event) => {
    const open = event.target.closest('[data-permission-open]');
    if (!open) return;
    const [taskId, stepId] = open.dataset.permissionOpen.split(':');
    const task = currentGroup()?.records.get(taskId);
    const step = task?.steps?.find((item) => item.id === stepId && item.state === 'waiting_permission');
    if (step) permissionDialog(task, step);
  });
  timeline.addEventListener('click', (event) => {
    const button = event.target.closest('[data-handover-open]');
    if (!button) return;
    const group = currentGroup();
    const found = waitingChoices(group).find(({ task, step }) => task.id + ':' + step.id === button.dataset.handoverOpen);
    if (found) choiceDialog(found.task, found.step);
  });

  function demoUpdate(id, patch) {
    const group = currentGroup();
    if (!group || !isExample(group.id) || !group.records.has(id)) return false;
    updateTask(group, id, patch);
    render();
    if (state.panelOpen) A.renderPanel();
    return true;
  }
  // The right panel tab this group was left on (lanes for a group opened for the first time).
  const panelFor = (id) => groups.get(id)?.panel || workbench[id]?.panel || 'lanes';
  function rememberPanel(id, panel) {
    const group = groups.get(id);
    if (!group || !panel) return;
    group.panel = panel;
    saveWorkbench(group);
  }
  window.__group = { removeProject, panelFor, rememberPanel, demoUpdate, addFiles, createGroup, deleteGroup, clearAll: clearAllGroups, hasGroup, switchGroup, taskCount, unreadCount, acceptApproval, refresh, render, renderPanel,
    projects: () => [...groups.keys()], isExample, groupsOf, nameOf, projectOf: projectIdOf,
    // Full status fetched for members' conversations also feeds the group's summaries.
    merge(project, task) {
      const group = groups.get(project);
      if (!group?.records.has(task.id)) return;
      updateTask(group, task.id, task);
      if (group === currentGroup()) render();
    },
    tasks: (id) => [...(groups.get(id)?.records.values() || [])],
    async showTask(project, id) {
      A.openGroup(project);
      const group = groups.get(project);
      if (!group?.records.has(id) && group && !isExample(project)) {
        try { await syncTask(group, id); } catch {}
      }
      if (state.group !== project) return;
      if (!group?.records.has(id)) return A.toast('原群聊任务暂时无法读取。');
      filter = 'all';
      filterSelect.value = '';
      updateFilters();
      (group.expanded ||= new Set()).add(id);
      selectTask(id);
      renderTimeline();
      timeline.querySelector(`[data-task-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
    } };
  A.renderSidebar();
  if (supported) setInterval(refresh, 5000);
})();
