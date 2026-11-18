// Provider conversations use the existing Orchestrator -> worktree -> reviewed Bridge patch flow.
(() => {
  const A = window.__desk;
  if (!A?.LIVE) return;
  const { $, esc, store, D } = A;
  const api = window.desk.orchestrator;
  const names = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', gemini: 'Gemini', antigravity: 'Antigravity' };
  const terminal = new Set(['completed', 'failed', 'cancelled', 'needs_review', 'awaiting_approval', 'awaiting_details']);
  const labels = { queued: '等待执行或额度恢复', running: '执行中', planning: '规划中',
    completed: '已完成', failed: '失败', cancelled: '已停止', needs_review: '等待确认', applying: '正在写入本机' };
  const errors = { provider_write_not_enabled: '服务器尚未启用此 AI 的修改能力。',
    cli_quota_exhausted: '该 AI 当前额度已用尽。', cli_auth_required: '该 AI 的登录或账号不可用，需要在 VPS 上处理。',
    windows_workspace_dirty: '本机项目有未提交的改动，请先处理后再生成补丁。',
    bridge_offline: 'Windows Bridge 尚未连接。', claude_reserved: '服务器需要更新以支持 Claude 单聊。' };
  const saved = store.get('providerDirectSessions', []);
  if (Array.isArray(saved)) for (const s of saved.slice(0, 40)) {
    if (!s || !names[s.provider] || s.provider === 'codex' || s.agentThread || typeof s.id !== 'string' ||
        typeof s.project !== 'string' || !Array.isArray(s.items)) continue;
    D.sessions.push({ ...s, live: true, diffs: [], term: [],
      items: s.items.filter(it => it && ['user', 'provider-task'].includes(it.t)) });
  }
  function persist() {
    store.set('providerDirectSessions', D.sessions.filter(s => s.provider && s.provider !== 'codex' && !s.agentThread).slice(0, 40)
      .map(({ id, project, provider, title, items, busy, taskId, status, time }) =>
        ({ id, project, provider, title, items: items.slice(-60).map(({ activity, ...item }) => item), busy, taskId, status, time })));
  }
  async function control(s, operation, params = {}) {
    const result = await api.control({ projectId: s.project, operation, ...params });
    if (!result?.ok) throw Error(result?.error || '主控请求失败');
    return result.value;
  }
  function update(s, item, task) {
    item.task = task;
    s.busy = !terminal.has(task.state);
    s.status = task.state === 'completed' ? 'done' : task.detail === 'patches_ready' ? 'waiting' : s.busy ? 'running' : 'idle';
    s.time = '刚刚';
    if (s.agentThread) window.__agentThreads?.persist(); else persist();
    if (A.state.active === s.id) A.renderAll(); else A.renderSidebar();
  }
  const polling = new Set();
  async function poll(s) {
    if (!s.taskId || polling.has(s.id)) return;
    polling.add(s.id);
    try {
      const item = s.items.findLast(it => it.t === 'provider-task' && it.task?.id === s.taskId);
      if (item) {
        update(s, item, await control(s, 'status', { taskId: s.taskId }));
        await loadActivity(s, [item]);
      }
    } catch (error) {
      if (A.state.active === s.id) A.toast(errors[error.message] || error.message);
    } finally { polling.delete(s.id); }
  }
  // The member's working record for each of the given tasks (thinking, commands, edits, replies).
  async function loadActivity(s, items) {
    if (!window.__activity) return;
    let changed = false;
    for (const item of items) {
      for (const step of item.task?.steps || []) {
        if (step.state === 'queued') continue;
        try {
          const activity = await window.__activity.load(s.project, item.task.id, step.id);
          (item.activity ||= {});
          if (JSON.stringify(activity) !== JSON.stringify(item.activity[step.id])) { item.activity[step.id] = activity; changed = true; }
        } catch { /* older orchestrators have no activity record; the reply below still shows */ }
      }
    }
    if (changed && A.state.active === s.id && !A.state.group) A.renderAll();
  }
  async function send(s, fromButton) {
    const input = $('#input');
    const text = input.value.trim();
    if (s.busy) {
      if (text) { A.toast('当前任务正在执行；可清空输入框后点击停止，再发送新任务。'); return; }
      if (fromButton && s.taskId) {
        try { await control(s, 'cancel', { taskId: s.taskId }); await poll(s); } catch (error) { A.toast(error.message); }
      }
      return;
    }
    if (!text) return;
    if (text.length > 9000) { A.toast('单次消息请控制在 9000 字符以内。'); return; }
    s.busy = true; s.status = 'running'; A.renderAll();
    try {
      const routes = await control(s, 'routes');
      if (!routes.providers?.includes(s.provider)) throw Error(`${names[s.provider]} 尚未在 VPS 配置或登录。`);
      const readonly = $('#modeSelect').value === 'plan';
      if (!readonly && !routes.writeProviders?.includes(s.provider)) throw Error('provider_write_not_enabled');
      const history = s.items.slice(-12).flatMap(it => it.t === 'user' ? ['User: ' + it.text]
        : it.t === 'dispatch-step' ? [it.snap?.brief && 'Lead assigned you: ' + it.snap.brief, it.snap?.output && names[s.provider] + ': ' + it.snap.output].filter(Boolean)
        : (it.task?.steps || []).filter(step => step.output).map(step => names[s.provider] + ': ' + step.output)).join('\n').slice(-3000);
      const prompt = (history ? 'Previous messages for context:\n' + history + '\n\nCurrent request:\n' : '') + text;
      const taskId = crypto.randomUUID();
      const task = await control(s, 'submit', { taskId, provider: s.provider, mode: readonly ? 'chat' : 'edit', prompt, via: 'desktop' });
      s.items.push({ t: 'user', text }, { t: 'provider-task', task });
      s.taskId = taskId;
      if (s.title === '新会话') s.title = text.slice(0, 24);
      input.value = ''; A.autosize();
      update(s, s.items.at(-1), task);
    } catch (error) {
      s.busy = false; s.status = 'idle';
      A.toast(errors[error.message] || error.message);
      if (s.agentThread) window.__agentThreads?.persist(); else persist();
      A.renderAll();
    }
  }
  function itemHtml(it, index) {
    if (it.t !== 'provider-task') return null;
    const task = it.task;
    const s = A.sess(A.state.active);
    const running = !terminal.has(task.state);
    const work = (task.steps || []).map(step => window.__activity?.html(it.activity?.[step.id],
      { key: task.id + ':' + step.id, open: s?.actOpen, running: running && step.state === 'running' }) || '').join('');
    const output = (task.steps || []).filter(step => step.output && !window.__activity?.hasReply(it.activity?.[step.id]))
      .map(step => step.output).join('\n\n');
    const patches = task.detail === 'patches_ready';
    const error = task.state === 'failed' ? errors[task.detail] || task.detail : '';
    return `<div class="group-output"><strong>${esc(names[task.provider] || 'AI')} · ${esc(labels[task.state] || task.state)}</strong>
      ${work}
      ${output ? `<pre style="white-space:pre-wrap">${esc(output)}</pre>` : ''}
      ${error ? `<p class="err-note">${esc(error)}</p>` : ''}
      ${patches ? `<p>改动已生成，尚未写入本机。请先查看补丁，再确认应用。</p>
        <button class="btn" data-provider-action="diff" data-provider-index="${index}">查看补丁</button>
        ${it.preview !== undefined ? `<pre style="white-space:pre-wrap">${esc(it.preview)}</pre>
          <button class="btn primary" data-provider-action="apply" data-provider-index="${index}">确认并应用到本机</button>` : ''}` : ''}
    </div>`;
  }
  $('#timeline').addEventListener('click', async event => {
    const button = event.target.closest('[data-provider-action]');
    if (!button) return;
    const s = A.sess(A.state.active);
    const item = s?.items[Number(button.dataset.providerIndex)];
    if (!s?.provider || item?.t !== 'provider-task') return;
    button.disabled = true;
    try {
      if (button.dataset.providerAction === 'diff') {
        const result = await control(s, 'task_diff', { taskId: item.task.id });
        item.preview = result.patch;
      } else if (item.preview !== undefined) {
        const task = await control(s, 'apply', { taskId: item.task.id });
        delete item.preview; update(s, item, task);
      }
      if (s.agentThread) window.__agentThreads?.persist(); else persist();
      A.renderAll();
    } catch (error) { button.disabled = false; A.toast(errors[error.message] || error.message); }
  });
  function create(project, provider) {
    if (!A.proj(project) || !names[provider]) return;
    const s = { id: 'P' + crypto.randomUUID(), project, provider, title: '新会话', status: 'idle', time: '刚刚',
      items: [], live: true, diffs: [], term: [] };
    D.sessions.unshift(s); persist(); A.openSession(s.id); $('#input').focus();
  }
  async function choose(project) {
    const dialog = document.createElement('dialog'); dialog.className = 'provider-picker';
    // Gemini CLI 已停用；其余四家都走本机文件工具的单聊。
    const pickable = ['codex', 'claude', 'grok', 'antigravity'];
    dialog.innerHTML = `<h2>选择单聊 AI</h2><p>每个会话独立；AI 直接读写本机文件，修改即时生效。</p>
      <div>${pickable.map((id) => `<button type="button" class="btn" data-provider-choice="${id}">${names[id]}</button>`).join(' ')}</div>
      <p class="panel-note">未配置或额度用尽的 AI 会显示对应状态。</p><button class="btn" data-provider-close>关闭</button>`;
    dialog.addEventListener('click', event => {
      const chosen = event.target.closest('[data-provider-choice]')?.dataset.providerChoice;
      if (chosen) { dialog.close(); A.newDirect(project, chosen); }
      else if (event.target.closest('[data-provider-close]')) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog); dialog.showModal();
  }
  const controls = new Map();
  // Sessions handled here instead of by the live Codex connection: every non-Codex AI, and every member's
  // conversation that receives work from the lead (Codex included).
  const handles = (s) => Boolean(s?.provider && (s.provider !== 'codex' || s.agentThread));
  function render(s) {
    const other = handles(s);
    for (const id of ['modelSelect', 'effortWrap', 'tierSelect']) {
      const element = $('#' + id); if (!element) continue;
      if (other && !controls.has(id)) controls.set(id, element.hidden);
      if (other) element.hidden = true;
      else if (controls.has(id)) { element.hidden = controls.get(id); controls.delete(id); }
    }
    $('#attachBtn').disabled = other;
    // 本机单聊（agent 字段）由 live.js 自己设置输入提示，别被这里的 Codex 文案覆盖。
    if (other) $('#input').placeholder = `向 ${names[s.provider]} 描述任务…（计划模式只读，其他模式可生成本机补丁）`;
    else if (!s?.agent) $('#input').placeholder = '向 Codex 描述任务…';
  }
  window.__providerDirect = { names, choose, create, send, render, handles, errors, onOpen: (s) => { poll(s); window.__agentThreads?.onOpen(s);
      if (!s.agentThread) loadActivity(s, s.items.filter(it => it.t === 'provider-task' && it.task && !it.activity).slice(-3)); },
    avatarState: s => s.busy ? 'thinking' : s.status === 'waiting' ? 'asking' : 'idle' };
  const liveItemHtml = window.__live.itemHtml;
  window.__live.itemHtml = (it, index) => itemHtml(it, index) ?? liveItemHtml(it, index);
  setInterval(() => { for (const s of D.sessions) if (s.provider && s.busy) poll(s); }, 2500);
})();
