// Shows how a member worked on a step: its thinking, the commands it ran and what they printed, the files it
// changed, the tools and searches it used, its plan and its replies. The record comes from the orchestrator's
// task_activity operation; both the lead-dispatched conversations and the person's own conversations use it.
(() => {
  const A = window.__desk;
  if (!A?.LIVE) return;
  const { esc } = A;
  const api = window.desk.orchestrator;

  async function load(project, taskId, stepId, { configuredOnly = false } = {}) {
    const withProject = !configuredOnly || A.proj(project)?.configured;
    const result = await api.control({ operation: 'task_activity', taskId, stepId, ...(withProject && { projectId: project }) });
    if (!result?.ok) throw Error(result?.error || 'activity_unavailable');
    return result.value;
  }

  const preview = (text, limit = 90) => {
    const line = String(text || '').trim().split('\n').find((part) => part.trim()) || '';
    return line.length > limit ? line.slice(0, limit) + '…' : line;
  };
  const changeNames = { add: '新建', create: '新建', delete: '删除', remove: '删除', update: '修改', modify: '修改' };

  // open: the person's own choices for which parts are expanded, by key; parts they never touched use defaults.
  function html(activity, { key, open = new Map(), running = false } = {}) {
    const items = activity?.items || [];
    if (!items.length) return '';
    const isOpen = (id, fallback) => open.has(id) ? open.get(id) : fallback;
    const rows = items.map((item, index) => {
      const id = key + ':' + index;
      const last = index === items.length - 1;
      switch (item.kind) {
        case 'thinking':
          return `<details class="act act-think" data-act="${esc(id)}" ${isOpen(id, true) ? 'open' : ''}>
            <summary><span class="act-tag">思考</span><span class="act-preview">${esc(preview(item.text))}</span></summary>
            <div class="act-body">${esc(item.text)}</div></details>`;
        case 'message':
          return `<div class="act act-msg"><div class="act-body">${esc(item.text)}</div></div>`;
        case 'command': {
          const failed = item.status === 'failed' || (Number.isFinite(item.exitCode) && item.exitCode !== 0);
          const state = item.status === 'in_progress' || item.status === 'running' ? (running ? '运行中' : '')
            : failed ? '失败' + (Number.isFinite(item.exitCode) ? ' · 退出码 ' + item.exitCode : '') : '完成';
          return `<details class="act act-cmd${failed ? ' failed' : ''}" data-act="${esc(id)}" ${isOpen(id, failed || (running && last)) ? 'open' : ''}>
            <summary><span class="act-tag">运行</span><code>${esc(item.command)}</code>${state ? `<span class="act-state">${state}</span>` : ''}</summary>
            ${item.output ? `<pre>${esc(item.output)}</pre>` : '<p class="act-empty">没有输出</p>'}</details>`;
        }
        case 'edit':
          return `<div class="act act-edit"><span class="act-tag">改文件</span><ul>${(item.files || []).map((file) =>
            `<li><code>${esc(file.path)}</code>${changeNames[file.change] ? `<span>${changeNames[file.change]}</span>` : ''}</li>`).join('')}</ul>
            ${item.error ? `<p class="act-error">${esc(item.error)}</p>` : ''}</div>`;
        case 'tool':
          return `<details class="act act-tool" data-act="${esc(id)}" ${isOpen(id, false) ? 'open' : ''}>
            <summary><span class="act-tag">工具</span><strong>${esc(item.name)}</strong><span class="act-preview">${esc(item.input || '')}</span>
            ${item.status === 'failed' ? '<span class="act-state">失败</span>' : ''}</summary>
            ${item.output ? `<pre>${esc(item.output)}</pre>` : '<p class="act-empty">没有返回内容</p>'}</details>`;
        case 'search':
          return `<div class="act act-line"><span class="act-tag">搜索</span><span>${esc(item.text)}</span></div>`;
        case 'plan':
          return `<div class="act act-plan"><span class="act-tag">计划</span><ul>${(item.steps || []).map((step) =>
            `<li class="${step.done ? 'done' : ''}">${esc(step.text)}</li>`).join('')}</ul></div>`;
        case 'error':
          return `<div class="act act-err"><span class="act-tag">错误</span><span>${esc(item.text)}</span></div>`;
        default:
          return '';
      }
    }).join('');
    const notes = [activity.truncated ? '只显示最近的记录' : '', activity.dropped ? `另有 ${activity.dropped} 条较早的记录未显示` : ''].filter(Boolean);
    return `<div class="activity">${notes.length ? `<p class="act-note">${notes.join('，')}</p>` : ''}${rows}
      ${running ? '<div class="act act-live"><span class="act-dot"></span>正在工作…</div>' : ''}</div>`;
  }

  const hasReply = (activity) => (activity?.items || []).some((item) => item.kind === 'message');

  // Remembers what the person expanded or collapsed, so a refresh does not undo it.
  document.getElementById('timeline').addEventListener('toggle', (event) => {
    const element = event.target;
    if (!element.matches?.('details[data-act]')) return;
    const s = A.sess(A.state.active);
    if (!s) return;
    (s.actOpen ||= new Map()).set(element.dataset.act, element.open);
  }, true);

  window.__activity = { load, html, hasReply };
})();
