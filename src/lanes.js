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
    const role = (step) => step?.role || 'lead';
    const events = [];
    const add = (event) => events.push({ lane: task.id, ...event });
    let previousRole = 'claude';
    const t0 = time(task.createdAt) || time(task.time) || 0;
    (task.events || []).forEach((event, index) => {
      const detail = String(event.detail || '');
      const at = time(event.time) || t0 + index;
      const step = steps.find((s) => s.id === event.stepId) || steps.find((s) => detail.startsWith(s.id + ':'));
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
      else if ((m = /^test_failed:(\d+)$/.exec(detail))) add({ at, kind: 'test', role: 'local', label: '测试失败 #' + m[1], fail: true });
      else if ((m = /^reassign_started:([\w-]+):(\d+)\/(\d+)$/.exec(detail))) add({ at, kind: 'retry', role: 'claude', label: `重排 ${m[2]}/${m[3]}`, sub: m[1] });
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
    const current = [...steps].reverse().find((s) => s.state === 'running') || [...steps].reverse().find((s) => s.state !== 'queued');
    const done = steps.filter((s) => s.state === 'completed').length;
    const chain = [];
    for (const step of steps) {
      const r = role(step);
      if (chain.at(-1)?.role === r) { chain.at(-1).state = step.state === 'running' ? 'running' : chain.at(-1).state === 'running' ? 'running' : step.state; continue; }
      chain.push({ role: r, state: step.state });
    }
    if (waiting) chain.push({ role: 'you', state: 'running' });
    return {
      id: task.id, kind: 'task', name: groupName, title: String(task.prompt || '任务').slice(0, 40), tag: short(task.prompt || groupName),
      colour: colour(role(current) === 'claude' ? 'lead' : role(current)), current: role(current) === 'claude' ? 'lead' : role(current),
      progress: steps.length ? done / steps.length : 0, progressText: steps.length ? `${done}/${steps.length}` : '',
      status: running ? '进行中' : waiting ? '等你' : task.state === 'completed' ? '完成' : task.state === 'failed' ? '失败' : task.state || '',
      running, waiting, chain, events, last: events.at(-1)?.at || t0,
      tail: running ? '等待 ' + memberName(role(current)) : waiting ? '等你' : '',
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

  window.AgentDeskLanes = { model, tree, list, pipeline, KINDS };
})();
