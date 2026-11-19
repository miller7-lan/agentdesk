(() => {
  const states = {
    queued: '排队中', planning: '规划中', awaiting_details: '待你补充', awaiting_approval: '待你确认',
    running: '执行中', applying: '应用补丁', testing: '验证中', needs_review: '待处理',
    triaging: '组长诊断', awaiting_acceptance: '待验收', auth_expired: '登录过期', quota_limited: '额度受限', accepted: '已验收',
    completed: '已完成', failed: '失败', cancelled: '已取消', pending: '未开始', proposed: '拟执行', replaced: '已重新分配',
    stopped: '已中止', skipped: '未执行',
  };
  const endStates = new Set(['completed', 'failed', 'cancelled']);
  // Once the task itself has ended, a step that still says running or queued was cut off. Showing it as
  // live under a "任务结束 · 失败" node would contradict the task; say that it was stopped or never ran.
  function shownState(task, state) {
    if (!endStates.has(task.state)) return state;
    if (state === 'running') return 'stopped';
    if (['queued', 'pending', 'proposed', 'waiting'].includes(state)) return 'skipped';
    return state;
  }
  const stepKey = (id) => 'step:' + id;

  function build(task, memberName) {
    const round = task.plan?.rounds?.at(-1);
    const proposal = task.plan?.rounds?.findLast((item) => item.steps?.length);
    const planSteps = proposal?.steps || [];
    const runtime = task.steps || [];
    const planned = new Map(planSteps.map((step) => [step.id, step]));
    const steps = runtime.length ? runtime.map((step) => ({ ...planned.get(step.id), ...step })) : planSteps;
    const hasProposal = planSteps.length > 0;
    const proposedOnly = hasProposal && !runtime.length;
    const mode = task.plan || !task.provider ? '组长规划' : '直接指派';
    const rootState = steps.length ? 'completed'
      : endStates.has(task.state) || ['planning', 'awaiting_details'].includes(task.state) ? task.state : 'queued';
    const root = {
      key: 'dispatch', depth: 0, title: mode, member: mode === '组长规划' ? 'lead' : task.provider,
      subtitle: task.provider ? '指定 ' + memberName(task.provider) : '拆分任务与安排依赖',
      state: rootState,
      description: proposal?.summary || task.prompt,
      questions: task.state === 'awaiting_details' ? round?.questions : null,
      parents: [],
    };
    const nodes = [root];
    const edges = [];
    const ready = new Map([[root.key, root]]);
    function add(node) {
      nodes.push(node);
      ready.set(node.key, node);
      for (const parent of node.parents) edges.push({ from: parent, to: node.key });
    }

    let entry = root.key;
    if (hasProposal && (task.plan?.approved != null || task.state === 'awaiting_approval')) {
      const approved = task.plan?.approved != null;
      add({ key: 'approval', depth: 1, title: '确认执行方案', subtitle: '由你审核',
        state: approved ? 'completed' : 'awaiting_approval',
        description: approved ? '已确认方案。主控按下方依赖关系执行。' : '当前显示组长提出的方案，确认后才进入执行。',
        parents: [root.key] });
      entry = 'approval';
    }

    const waiting = new Map(steps.map((step) => [stepKey(step.id), step]));
    // A step the lead replaced after it failed stays on the graph, linked to the steps that took its place.
    const predecessor = (step) => Array.isArray(step.dependsOn)
      ? [...new Set([...step.dependsOn, ...(step.replaces || [])])].map(stepKey) : null;
    // reassigns counts escalation rounds, not reassignments: the step failed and the lead is diagnosing it.
    const progress = (step) => {
      if (!step.reassigns) return '';
      const triaging = task.state === 'triaging' && step.state === 'failed';
      if (!triaging) return `重排 ${step.reassigns}/3`;
      return `${String(task.detail || '').startsWith('triage_unavailable') ? '等待组长诊断' : '组长诊断中'} ${step.reassigns}/3`;
    };
    const entryDepth = ready.get(entry).depth;
    while (waiting.size) {
      const count = waiting.size;
      for (const [key, step] of waiting) {
        const deps = predecessor(step);
        if (deps?.some((parent) => waiting.has(parent))) continue;
        const parents = deps?.filter((parent) => ready.has(parent)) || [];
        if (deps && !deps.length) parents.push(entry);
        const completeDependencies = deps && deps.every((parent) => ready.has(parent));
        add({
          key, step, parents, depth: Math.max(entryDepth, ...parents.map((parent) => ready.get(parent).depth)) + 1,
          title: memberName(step.role),
          subtitle: [step.id, step.model, progress(step)].filter(Boolean).join(' · '),
          state: proposedOnly ? 'proposed' : shownState(task, step.state || 'pending'),
          // A replaced step that failed keeps its red record instead of reading as a neutral reassignment.
          fail: step.state === 'failed' || (step.state === 'replaced' && Boolean(step.error || step.history?.length)),
          description: [step.prompt || step.brief, (step.history || []).length
            ? '之前尝试：' + step.history.map((entry) => memberName(entry.role) + (entry.model ? ' ' + entry.model : '')).join('、') : '']
            .filter(Boolean).join('\n'),
          missingDependencies: !completeDependencies,
        });
        waiting.delete(key);
      }
      if (waiting.size === count) break;
    }
    if (nodes.some((node) => node.step)) {
      const upstream = new Set(edges.map((edge) => edge.from));
      const terminalSteps = nodes.filter((node) => node.step && node.step.state !== 'replaced' && !upstream.has(node.key));
      const stopped = task.state === 'failed' || task.state === 'cancelled';
      const detail = {
        patches_ready: '等待你审核并应用补丁',
        interrupted_windows_operation: '等待核对本机操作',
      }[task.detail];
      const event = task.events?.at(-1);
      const waitingFor = /executor_waiting|owner_quota_cap/.test(task.detail || '');
      const liveState = event?.data?.reason === 'auth' ? 'auth_expired' : event?.data?.reason === 'quota' ? 'quota_limited'
        : waitingFor && task.detail === 'owner_quota_cap' ? 'quota_limited' : task.stage === 'accepted' ? 'accepted' : task.state;
      add({
        key: 'result', depth: Math.max(...nodes.map((node) => node.depth)) + 1,
        title: stopped ? '任务结束' : '汇总结果',
        subtitle: detail || (task.state === 'applying' || task.state === 'testing' ? states[task.state] : '汇总各执行步骤'),
        state: ['needs_review', 'applying', 'testing', 'triaging', 'awaiting_acceptance', 'auth_expired', 'quota_limited', 'accepted'].includes(liveState) || endStates.has(liveState) ? liveState : 'pending',
        parents: terminalSteps.map((node) => node.key),
      });
    }
    return { nodes, edges, incomplete: waiting.size > 0 || nodes.some((node) => node.missingDependencies) };
  }

  function layout(graph) {
    const layers = new Map();
    for (const node of graph.nodes) {
      if (!layers.has(node.depth)) layers.set(node.depth, []);
      layers.get(node.depth).push(node);
    }

    const nodeWidth = 140;
    const nodeHeight = 67;
    const columnGap = 12;
    const rowGap = 31;
    const margin = 12;
    const maxColumns = Math.max(...Array.from(layers.values(), (row) => row.length));
    const span = (count) => count * nodeWidth + (count - 1) * columnGap;
    const width = span(maxColumns) + margin * 2;
    const height = Math.max(...layers.keys()) * (nodeHeight + rowGap) + nodeHeight + margin * 2;
    const positions = new Map();
    for (const [depth, row] of layers) {
      const left = (width - span(row.length)) / 2;
      row.forEach((node, i) => positions.set(node.key, { x: left + i * (nodeWidth + columnGap), y: margin + depth * (nodeHeight + rowGap) }));
    }
    return { width, height, nodeWidth, nodeHeight, positions, maxColumns };
  }

  function render(task, { selected, esc, memberName, avatar }) {
    const graph = build(task, memberName);
    const { width, height, nodeWidth, nodeHeight, positions, maxColumns } = layout(graph);
    let longEdge = 0;
    const choice = graph.nodes.find((node) => node.key === selected) || graph.nodes[0];
    const labels = new Map(graph.nodes.map((node) => [node.key, node.step ? node.title + ' · ' + node.step.id : node.title]));
    const children = graph.edges.filter(({ from }) => from === choice.key).map(({ to }) => labels.get(to));
    const parents = choice.parents.map((parent) => labels.get(parent));
    const links = (names, empty) => names.length ? names.map(esc).join('、') : empty;
    const status = (state) => Object.hasOwn(states, state) ? states[state] : '待同步';
    const lines = graph.edges.map(({ from, to }) => {
      const start = positions.get(from);
      const end = positions.get(to);
      const x1 = start.x + nodeWidth / 2;
      const y1 = start.y + nodeHeight;
      const x2 = end.x + nodeWidth / 2;
      const y2 = end.y - 4;
      const mid = y1 + (y2 - y1) * .52;
      const active = from === choice.key || to === choice.key;
      const lane = y2 - y1 > 55 ? width + 4 + longEdge++ * 7 : null;
      const path = lane === null ? `M${x1} ${y1} C${x1} ${mid},${x2} ${mid},${x2} ${y2}`
        : `M${x1} ${y1} v10 H${lane} V${y2 - 10} H${x2} V${y2}`;
      return `<path class="${active ? 'flow-link-active' : 'flow-link'}" d="${path}" marker-end="url(#${active ? 'flowArrowActive' : 'flowArrow'})"/>`;
    }).join('');
    const nodeButtons = graph.nodes.map((node) => {
      const point = positions.get(node.key);
      const state = Object.hasOwn(states, node.state) ? node.state : 'unknown';
      const role = node.step?.role || node.member;
      // A step node is also a light target: a member that finishes sends a light here (src/light.js).
      const flight = node.step ? ` data-flight-to="${esc(task.id + ':' + node.step.id)}"` : '';
      return `<button class="flow-node" type="button" data-flow-node="${esc(node.key)}" aria-pressed="${node.key === choice.key}" data-flow-role="${esc(role || '')}"
        data-flow-state="${state}" data-flow-fail="${node.fail ? 'true' : 'false'}"${flight} style="left:${point.x}px;top:${point.y}px;width:${nodeWidth}px;height:${nodeHeight}px;--node-color:${window.AgentDeskLight?.colour(role) || 'var(--accent)'}"
        title="${esc(labels.get(node.key) + ' · ' + status(state))}">
        ${node.step && state === 'running' ? window.AgentDeskLight?.border(role) || '' : ''}<span class="flow-node-dot" aria-hidden="true"></span>
        <span class="flow-node-title">${role ? avatar?.(role) || '' : ''}<strong>${esc(node.title)}</strong></span>
        <span>${esc(node.subtitle)}</span><small>${status(state)}${node.fail && state === 'replaced' ? ' · 失败记录' : ''}</small>
      </button>`;
    }).join('');
    const step = choice.step;
    const diagramWidth = width + (longEdge ? 10 + longEdge * 7 : 0);
    return `<div class="flow-viewport" tabindex="0" aria-label="任务调度线路">
      <div class="flow-diagram" style="width:${diagramWidth}px;height:${height}px">
        <svg class="flow-edges" viewBox="0 0 ${diagramWidth} ${height}" aria-hidden="true">
          <defs>
            <marker id="flowArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 8 4 0 8Z"/></marker>
            <marker id="flowArrowActive" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 8 4 0 8Z"/></marker>
          </defs>${lines}
        </svg>${nodeButtons}
      </div>
    </div>
    <p class="panel-note">箭头表示等待上游完成。同层无相互依赖，实际并发由主控调度。${maxColumns > 2 ? '可左右滚动查看完整线路。' : ''}</p>
    ${graph.incomplete ? '<p class="panel-note">主控返回的部分依赖不完整。</p>' : ''}
    ${!graph.nodes.some((node) => node.step) && !endStates.has(task.state) ? '<p class="panel-note">等待主控返回执行步骤。</p>' : ''}
    <section class="flow-details" aria-label="所选节点详情">
      <h3>${esc(labels.get(choice.key))} <span>${status(choice.state)}</span></h3>
      ${choice.description ? `<p class="flow-description">${esc(choice.description)}</p>` : ''}
      ${choice.questions?.length ? `<ul>${choice.questions.map((question) => `<li>${esc(question)}</li>`).join('')}</ul>` : ''}
      <dl>
        <dt>上游依赖</dt><dd>${links(parents, choice.missingDependencies ? '未返回' : '无')}</dd>
        <dt>后续节点</dt><dd>${links(children, '无')}</dd>
        ${step && typeof step.write === 'boolean' ? `<dt>工作区</dt><dd>${step.write ? '可在任务工作区修改' : '只读'}</dd>` : ''}
        ${step?.model ? `<dt>模型</dt><dd>${esc(step.model)}</dd>` : ''}
      </dl>
      ${step?.paths?.length ? `<h4>改动文件</h4><ul class="mono">${step.paths.map((path) => `<li>${esc(path)}</li>`).join('')}</ul>` : ''}
      ${step?.output || step?.error ? `<h4>${step.error ? '错误' : '输出摘要'}</h4><pre>${esc(step.error || step.output)}</pre>` : ''}
    </section>`;
  }

  window.AgentDeskTaskGraph = { render };
})();
