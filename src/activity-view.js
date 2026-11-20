// Shows how a member worked on a step: its thinking, the commands it ran and what they printed, the files it
// changed, the tools and searches it used, its plan and its replies. The record comes from the orchestrator's
// task_activity operation; both the lead-dispatched conversations and the person's own conversations use it.
(() => {
  const A = window.__desk;
  if (!A?.LIVE) return;
  const { esc } = A;
  const api = window.desk.orchestrator;

  // Older orchestrators only understood the final Antigravity result line. If the activity record has no
  // working rows, read the step log the group view already exposes and turn its step_update entries into
  // the same rows here, so a running chat shows its commands without restarting the orchestrator.
  const WORK = new Set(['thinking', 'command', 'edit', 'tool', 'search', 'plan']);
  const SHELL = /^(bash|shell|run_shell_command|run_command|windows_run_command|windows_run_shell_command|exec(_command)?|terminal)$/i;
  const EDIT = /^(edit|write|multiedit|notebookedit|write_file|write_to_file|windows_write_file|replace|replace_file_content|multi_replace_file_content|windows_replace_file_content|edit_file|sed_file|apply_patch|windows_apply_patch|str_replace\w*)$/i;
  const clip = (value, limit = 3000) => {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  };
  const tail = (value, limit = 3000) => {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    return text.length > limit ? '…' + text.slice(-limit) : text;
  };
  const brief = (input) => {
    if (!input || typeof input !== 'object') return clip(input, 300);
    const pick = input.command ?? input.cmd ?? input.CommandLine ?? input.commandLine ?? input.file_path ?? input.path ??
      input.absolute_path ?? input.TargetFile ?? input.targetFile ?? input.DirectoryPath ?? input.directoryPath ??
      input.pattern ?? input.query ?? input.url;
    return clip(typeof pick === 'string' ? pick : JSON.stringify(input), 300);
  };
  const unwrapTool = (name, input) => {
    if (name !== 'call_mcp_tool' || !input || typeof input !== 'object') return { name, input };
    let args = input.Arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* keep the text */ }
    }
    return { name: input.ToolName || name, input: args ?? input };
  };
  function parseAntigravity(text) {
    const items = [];
    const byId = new Map();
    const push = (item) => { if (items.length >= 300) items.shift(); items.push(item); };
    for (const line of String(text || '').split('\n')) {
      const space = line.indexOf(' ');
      if (space < 0 || line.slice(0, space) !== 'stdout') continue;
      let event;
      try { event = JSON.parse(line.slice(space + 1)); } catch { continue; }
      if (event?.event === 'result') {
        const answer = event.result?.response;
        const spoken = items.filter((item) => item.kind === 'message').map((item) => item.text).join('').trim();
        if (typeof answer === 'string' && answer.trim() && spoken !== answer.trim()) push({ kind: 'message', text: clip(answer) });
        continue;
      }
      const step = event?.step_update;
      if (!step) continue;
      if (step.step_type === 'tool') {
        const id = 'antigravity:' + step.step_index;
        const tool = unwrapTool(step.tool_name || step.tool_info?.name || 'tool', step.tool_info?.parameters);
        let item = byId.get(id);
        if (!item) {
          if (SHELL.test(tool.name)) item = { kind: 'command', command: brief(tool.input), status: 'running' };
          else if (EDIT.test(tool.name)) item = { kind: 'edit', files: [{ path: brief(tool.input), change: tool.name }] };
          else item = { kind: 'tool', name: tool.name, input: brief(tool.input), status: 'running' };
          byId.set(id, item);
          push(item);
        }
        if (step.state !== 'ACTIVE') {
          const output = String(step.tool_info?.output ?? '');
          const match = /Command exited with code (\d+)/i.exec(output);
          const exitCode = match ? Number(match[1]) : undefined;
          const failed = /fail|error|cancel/i.test(step.state || '') || (exitCode !== undefined && exitCode !== 0);
          if (item.kind === 'command' || item.kind === 'tool') {
            item.output = tail(output);
            item.status = failed ? 'failed' : 'completed';
            if (exitCode !== undefined) item.exitCode = exitCode;
          } else if (failed) item.error = clip(output, 600);
        }
      } else if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
        const last = items.at(-1);
        if (last?.kind === 'message') last.text = clip(last.text + step.text_delta);
        else push({ kind: 'message', text: clip(step.text_delta) });
      }
    }
    return { items, dropped: 0, truncated: false };
  }
  const hasWork = (activity) => (activity?.items || []).some((item) => WORK.has(item.kind));

  async function load(project, taskId, stepId, { configuredOnly = false } = {}) {
    const withProject = !configuredOnly || A.proj(project)?.configured;
    const scope = { taskId, stepId, ...(withProject && { projectId: project }) };
    const result = await api.control({ operation: 'task_activity', ...scope });
    if (!result?.ok) throw Error(result?.error || 'activity_unavailable');
    if (!hasWork(result.value)) {
      try {
        const log = await api.control({ operation: 'task_log', ...scope });
        if (log?.ok && /"step_update"\s*:/.test(log.value?.text || '')) {
          const parsed = parseAntigravity(log.value.text);
          if (parsed.items.length) return { ...parsed, truncated: Boolean(log.value.truncated), state: result.value.state, fallback: true };
        }
      } catch { /* keep the activity record */ }
    }
    return result.value;
  }

  const preview = (text, limit = 90) => {
    const line = String(text || '').trim().split('\n').find((part) => part.trim()) || '';
    return line.length > limit ? line.slice(0, limit) + '…' : line;
  };
  const changeNames = { add: '新建', create: '新建', delete: '删除', remove: '删除', update: '修改', modify: '修改' };

  function commandState(item, running, failed) {
    const states = { cancelling: '正在停止', cancelled: '已停止', timed_out: '超时', unknown: '结果待确认' };
    if (states[item.status]) return states[item.status];
    if (item.status === 'in_progress' || item.status === 'running') return running ? '运行中' : '结果待确认';
    const exit = Number.isInteger(item.exitCode) ? ' · 退出码 ' + item.exitCode : '';
    return (failed ? '失败' : '完成') + exit;
  }

  function commandStop(item, scope) {
    if (!scope || !item.requestId || item.location !== 'local' || item.status !== 'running') return '';
    return `<button type="button" class="btn" data-stop-local-run="${esc(item.requestId)}"
      data-run-task="${esc(scope.taskId)}" data-run-step="${esc(scope.stepId)}">停止命令</button>`;
  }

  // open: the person's own choices for which parts are expanded, by key; parts they never touched use defaults.
  function html(activity, { key, open = new Map(), running = false, commandScope } = {}) {
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
          const state = commandState(item, running, failed);
          return `<details class="act act-cmd${failed ? ' failed' : ''}" data-act="${esc(id)}" ${isOpen(id, failed || (running && last)) ? 'open' : ''}>
            <summary><span class="act-tag">${item.location === 'local' ? '本机' : 'VPS'}</span><code>${esc(item.command)}</code>${state ? `<span class="act-state">${state}</span>` : ''}</summary>
            ${item.cwd ? `<div class="io-label command-cwd">${esc(item.cwd)}</div>` : ''}
            ${item.validation ? `<div class="io-label">${item.validation.afterPatch ? '补丁应用后' : '当前工作区'}${item.validation.base ? ' · 基线 ' + esc(item.validation.base.slice(0, 12)) : ''}</div>` : ''}
            ${item.output ? `<pre>${esc(item.output)}</pre>` : '<p class="act-empty">没有输出</p>'}
            ${commandStop(item, running ? commandScope : null)}</details>`;
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

  document.getElementById('timeline').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-stop-local-run]');
    if (!button) return;
    button.disabled = true;
    try {
      const result = await api.control({ operation: 'stop_command', taskId: button.dataset.runTask, stepId: button.dataset.runStep,
        artifact: button.dataset.stopLocalRun });
      const state = result?.value?.state;
      if (!result?.ok || !state || state === 'unknown') A.toast(result?.error || '本机命令状态待确认');
      else A.toast(state === 'cancelling' ? '正在停止本机命令' : '本机命令已退出');
    } catch (error) { A.toast(error.message); }
    finally { button.disabled = false; }
  });

  window.__activity = { load, html, hasReply, commandState, commandStop };
})();
