(() => {
  if (window.desk?.platform !== 'darwin') return;
  document.documentElement.classList.add('native-mac');
  const element = (id) => document.getElementById(id);
  const entry = element('sbOrchestrator');
  const dialog = element('orchestratorDialog');
  const form = element('orchestratorForm');
  const provider = element('orchestratorProvider');
  const model = element('orchestratorModel');
  const prompt = element('orchestratorPrompt');
  const message = element('orchestratorMessage');
  const taskPanel = element('orchestratorTask');
  const taskText = element('orchestratorTaskText');
  const buttons = [element('orchestratorSsh'), element('orchestratorRelay')];
  const submit = element('orchestratorSubmit');
  const cancel = element('orchestratorCancel');
  const apply = element('orchestratorApply');
  const reconcile = element('orchestratorReconcile');
  const statusLabels = {
    queued: '排队中', planning: '制定计划', running: '执行中', applying: '应用补丁',
    testing: '运行测试', needs_review: '待处理', completed: '已完成', failed: '失败', cancelled: '已取消',
  };
  let taskId = localStorage.getItem('agentdesk.macTask');
  let busy = false;
  let routeState = { route: null };
  let task;
  entry.hidden = false;

  async function control(operation, extra) {
    const answer = await window.desk.orchestrator.control({ operation, ...extra });
    if (!answer.ok) {
      const explanations = {
        bridge_offline: '工作线路离线。请选择另一条在线线路。',
        operations_in_progress: '有任务正在执行。完成或取消任务后可以切换。',
        unknown_task: '主控上找不到这个任务。',
        invalid_model_selection: '请填写该 CLI 支持的模型 ID。',
      };
      throw new Error(explanations[answer.error] || answer.error);
    }
    return answer.value;
  }

  function drawRoutes() {
    const selected = routeState.route?.split(':')[0];
    for (const button of buttons) {
      const route = button.dataset.route;
      button.disabled = busy || !routeState[route] || route === selected;
      button.setAttribute('aria-pressed', String(route === selected));
      button.querySelector('span').textContent = (routeState[route] ? '在线' : '离线') + (route === selected ? ' · 当前' : '');
    }
    submit.disabled = busy || !routeState[selected];
    entry.textContent = selected === 'relay' ? '线路与模型 · Relay' : '线路与模型';
  }

  function drawTask() {
    taskPanel.hidden = !taskId;
    if (!taskId) return;
    const state = task?.state;
    const heading = task ? [statusLabels[state] || state, task.provider, task.model].filter(Boolean).join(' · ') : '正在读取任务';
    const steps = task?.steps?.map((step) => [
      step.role + ' · ' + (statusLabels[step.state] || step.state), step.output || step.error, step.paths?.length ? step.paths.join('\n') : null,
    ].filter(Boolean).join('\n')) || [];
    taskText.textContent = [heading, taskId, task?.detail, ...steps].filter(Boolean).join('\n\n');
    apply.hidden = task?.detail !== 'patches_ready';
    reconcile.hidden = !task?.pendingRequest;
    cancel.disabled = busy || !task || ['completed', 'failed', 'cancelled', 'needs_review'].includes(state);
    apply.disabled = reconcile.disabled = busy;
  }

  async function refresh() {
    if (busy || !dialog.open) return;
    try {
      routeState = await control('routes');
      drawRoutes();
      if (taskId && (routeState.ssh || routeState.relay)) task = await control('status', { taskId });
      drawTask();
    } catch (error) {
      message.textContent = error.message;
    }
  }

  async function act(action) {
    if (busy) return;
    busy = true;
    message.textContent = '';
    drawRoutes();
    drawTask();
    try { await action(); }
    catch (error) { message.textContent = error.message; }
    finally {
      busy = false;
      drawRoutes();
      drawTask();
      await refresh();
    }
  }

  entry.addEventListener('click', () => {
    dialog.showModal();
    drawRoutes();
    drawTask();
    refresh();
  });
  for (const button of buttons) {
    button.addEventListener('click', () => act(() => control('select_route', { route: button.dataset.route })));
  }
  provider.addEventListener('change', () => {
    model.disabled = !provider.value;
    model.value = '';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    act(async () => {
      const id = crypto.randomUUID();
      task = await control('submit', {
        taskId: id, prompt: prompt.value.trim(), provider: provider.value || undefined,
        model: provider.value && model.value.trim() || undefined,
      });
      taskId = task.id;
      localStorage.setItem('agentdesk.macTask', taskId);
      prompt.value = '';
    });
  });
  element('orchestratorRefresh').addEventListener('click', refresh);
  cancel.addEventListener('click', () => act(() => control('cancel', { taskId })));
  apply.addEventListener('click', () => act(() => control('apply', { taskId })));
  reconcile.addEventListener('click', () => act(() => control('reconcile', { taskId })));
  setInterval(refresh, 5000);
})();
