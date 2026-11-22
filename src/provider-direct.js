// Provider conversations use the existing Orchestrator -> worktree -> reviewed Bridge patch flow.
(() => {
  const A = window.__desk;
  if (!A?.LIVE) return;
  const { $, esc, store, D } = A;
  const api = window.desk.orchestrator;
  const catalogs = new Map();
  const localScopes = new Map();
  const localProposals = new WeakMap();
  const sendErrors = new WeakMap();
  const attachments = new WeakMap();
  const names = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', gemini: 'Gemini', antigravity: 'Antigravity' };
  const terminal = new Set(['completed', 'failed', 'cancelled', 'needs_review', 'awaiting_approval', 'awaiting_details']);
  const labels = { queued: '等待执行或额度恢复', running: '执行中', planning: '规划中',
    completed: '已完成', failed: '失败', cancelled: '已停止', needs_review: '等待确认', applying: '正在写入本机' };
  const errors = { provider_write_not_enabled: '服务器尚未启用此 AI 的修改能力。',
    direct_workspace_not_bound: '此项目尚未绑定同一路径的可写 Bridge 工作区。请选择已绑定的 Git 项目后再生成补丁。',
    cli_quota_exhausted: '该 AI 当前额度已用尽。', cli_auth_required: '该 AI 的登录或账号不可用，需要在 VPS 上处理。',
    cli_tool_permission_required: '本机工具未获执行许可，本次操作没有完成，请检查主控的工具权限配置。',
    invalid_attachment: '附件校验失败，请移除后重新选择。',
    attachments_unsupported: '当前主控版本尚不支持此单聊的附件，请先更新 VPS2 和 Bridge。',
    windows_workspace_dirty: '生成项目补丁需要干净的 Git 工作区。若要改桌面或其他目录，请选择「修改本机文件」。',
    bridge_offline: 'Windows Bridge 尚未连接。', claude_reserved: '服务器需要更新以支持 Claude 单聊。' };
  const saved = store.get('providerDirectSessions', []);
  if (Array.isArray(saved)) for (const s of saved.slice(0, 40)) {
    if (!s || !names[s.provider] || s.provider === 'codex' || s.agentThread || typeof s.id !== 'string' ||
        typeof s.project !== 'string' || !Array.isArray(s.items)) continue;
    const items = s.items.filter(it => it && ['user', 'provider-task'].includes(it.t));
    // Saved as running but with no task left to follow (the app closed while sending): it is not running.
    const following = s.busy && s.taskId && items.some(it => it.t === 'provider-task' && it.task?.id === s.taskId);
    D.sessions.push({ ...s, live: true, diffs: [], term: [], items,
      ...(s.busy && !following && { busy: false, status: 'idle' }) });
  }
  function persist() {
    store.set('providerDirectSessions', D.sessions.filter(s => s.provider && s.provider !== 'codex' && !s.agentThread).slice(0, 40)
      .map(({ id, project, provider, title, items, busy, taskId, taskMode, model, status, time }) =>
        ({ id, project, provider, title, taskMode, model, items: items.slice(-60).map(({ activity, ...item }) => item), busy, taskId, status, time })));
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
  function settle(s, note) {
    s.busy = false; s.status = 'idle';
    if (note) sendErrors.set(s, note);
    if (s.agentThread) window.__agentThreads?.persist(); else persist();
    if (A.state.active === s.id && !A.state.group) A.renderAll(); else A.renderSidebar();
  }
  const polling = new Set();
  async function poll(s) {
    if (!s.taskId || polling.has(s.id)) return;
    polling.add(s.id);
    try {
      const item = s.items.findLast(it => it.t === 'provider-task' && it.task?.id === s.taskId);
      if (!item) { settle(s, null); return; }
      update(s, item, await control(s, 'status', { taskId: s.taskId }));
      await loadActivity(s, [item]);
    } catch (error) {
      // The orchestrator no longer has this task: stop following it instead of staying "running" (and repeating
      // the same error every 2.5 s).
      if (/^(unknown_task|task_access_denied|invalid_task_id)$/.test(error.message)) { settle(s, '主控上已经没有这项任务，已停止跟踪'); return; }
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
    const draft = input.value.trim();
    const files = attachments.get(s) || [];
    const text = draft || (files.length ? '请查看随附的文件。' : '');
    if (s.busy) {
      if (text) { A.toast('当前任务正在执行；可清空输入框后点击停止，再发送新任务。'); return; }
      if (fromButton && s.taskId) {
        try { await control(s, 'cancel', { taskId: s.taskId }); await poll(s); } catch (error) { A.toast(error.message); }
      }
      return;
    }
    if (!text) return;
    if (text.length > 9000) { A.toast('单次消息请控制在 9000 字符以内。'); return; }
    sendErrors.delete(s);
    s.busy = true; s.status = 'running'; A.renderAll();
    try {
      const routes = await control(s, 'routes');
      catalogs.set(s.project, routes.modelProfiles || {});
      if (!routes.providers?.includes(s.provider)) throw Error(`${names[s.provider]} 尚未在 VPS 配置或登录。`);
      if (files.length && !routes.directAttachments) throw Error('attachments_unsupported');
      const readonly = s.taskMode !== 'edit';
      const scope = s.taskMode === 'local' ? localScopes.get(s.id) : undefined;
      if (s.taskMode === 'local' && !scope) throw Error('请先选择要修改的本机文件或允许新建的目录。');
      if (!readonly && !routes.writeProviders?.includes(s.provider)) throw Error('provider_write_not_enabled');
      const history = s.items.slice(-12).flatMap(it => it.t === 'user' ? ['User: ' + it.text]
        : it.t === 'dispatch-step' ? [it.snap?.brief && 'Lead assigned you: ' + it.snap.brief, it.snap?.output && names[s.provider] + ': ' + it.snap.output].filter(Boolean)
        : (it.task?.steps || []).filter(step => step.output).map(step => names[s.provider] + ': ' + step.output)).join('\n').slice(-3000);
      let prompt = (history ? 'Previous messages for context:\n' + history + '\n\nCurrent request:\n' : '') + text;
      if (scope) {
        const actions = scope.kind === 'file'
          ? 'Return JSON only: {"action":"replace","content":"complete replacement text"}. Selected file: ' +
            JSON.stringify({ name: scope.path.split(/[\\/]/).at(-1), content: scope.before })
          : 'Return JSON only: {"action":"mkdir","name":"one folder name"} or {"action":"create","name":"one file name","content":"text"}. The destination directory was selected locally.';
        prompt = 'Propose one local change for user review. Do not call write tools or claim to write anything. ' + actions +
          '\nUse at most 2000 UTF-8 bytes for content. For unsupported requests return {"action":"unsupported"}. User request: ' + text.slice(0, 4000);
      }
      const taskId = crypto.randomUUID();
      if (s.model && !Object.hasOwn(routes.modelProfiles?.[s.provider]?.models || {}, s.model)) {
        s.model = '';
        throw Error('所选模型已从 VPS 列表移除，请重新选择。');
      }
      const task = await control(s, 'submit', { taskId, provider: s.provider, model: s.model || undefined,
        mode: readonly ? 'chat' : 'edit', prompt, via: 'desktop', tags: ['direct'], ...(files.length && { attachments: files }) });
      const item = { t: 'provider-task', task };
      if (scope) localProposals.set(item, scope.token);
      s.items.push({ t: 'user', text: text + (files.length ? '\n📎 ' + files.map(file => file.name).join('、') : '') }, item);
      attachments.delete(s);
      if (files.length && window.AgentDeskAttachNotice) A.toast(window.AgentDeskAttachNotice.sent(files.length));
      s.taskId = taskId;
      if (s.title === '新会话') s.title = text.slice(0, 24);
      if (s.draft?.trim() === draft) s.draft = '';
      if (A.state.active === s.id && input.value.trim() === draft) {
        input.value = ''; A.autosize();
      }
      update(s, s.items.at(-1), task);
    } catch (error) {
      s.busy = false; s.status = 'idle';
      sendErrors.set(s, error.message);
      if (s.agentThread) window.__agentThreads?.persist(); else persist();
      if (A.state.active === s.id && !A.state.group) A.renderAll(); else A.renderSidebar();
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
    const model = task.steps?.find(step => step.model)?.model || task.model;
    const awaitingLocal = task.state === 'completed' && localProposals.has(it);
    return `<div class="group-output"><strong>${esc(names[task.provider] || 'AI')} · ${awaitingLocal ? '等待确认本机操作' : esc(labels[task.state] || task.state)}${model ? ' · ' + esc(model) : ''}</strong>
      ${work}
      ${output ? `<pre style="white-space:pre-wrap">${esc(output)}</pre>` : ''}
      ${error ? `<p class="err-note">${esc(error)}</p>` : ''}
      ${awaitingLocal ? `<button class="btn primary" type="button" data-provider-action="local" data-provider-index="${index}">查看并确认本机操作</button>` : ''}
      ${it.localApplied ? `<p>已应用到 ${esc(it.localApplied)}</p>` : ''}
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
      if (button.dataset.providerAction === 'local') {
        const output = item.task.steps?.findLast(step => step.output)?.output.trim();
        const json = output?.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] || output;
        let proposal;
        try { proposal = JSON.parse(json); } catch { throw Error('模型未返回可审核的本机操作。'); }
        const token = localProposals.get(item);
        const result = await window.desk.localChange.apply({ token, proposal });
        if (result.error) throw Error(result.error);
        if (result.ok) {
          localProposals.delete(item);
          if (localScopes.get(s.id)?.token === token) localScopes.delete(s.id);
          item.localApplied = result.path;
        }
      } else if (button.dataset.providerAction === 'diff') {
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
      <label class="picker-option"><input type="checkbox" data-provider-worktree ${window.desk.worktrees ? '' : 'disabled'} />
        <span><strong>独立工作树</strong>　需要已有提交的 Git 仓库根目录。在新的 Git 分支和独立目录里改，项目目录不受影响；完成后查看差异、合回或丢弃。适合同时开多个单聊改同一个项目。</span></label>
      <p class="panel-note">未配置或额度用尽的 AI 会显示对应状态。</p><button class="btn" data-provider-close>关闭</button>`;
    dialog.addEventListener('click', event => {
      const chosen = event.target.closest('[data-provider-choice]')?.dataset.providerChoice;
      const worktree = dialog.querySelector('[data-provider-worktree]')?.checked;
      if (chosen) { dialog.close(); A.newDirect(project, chosen, { worktree }); }
      else if (event.target.closest('[data-provider-close]')) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog); dialog.showModal();
  }
  const controls = new Map();
  // Any file type, up to 10 per message; a folder is sent as one .zip.
  const MAX_ATTACH = 10;
  function addFiles(s, { files = [], errors = [] }) {
    const existing = attachments.get(s) || [];
    const added = files.slice(0, Math.max(0, MAX_ATTACH - existing.length));
    attachments.set(s, [...existing, ...added]);
    for (const extra of files.slice(added.length)) window.desk.files.forgetChat(extra.id);
    if (errors.length || added.length < files.length) {
      sendErrors.set(s, errors.join('；') || `每条消息最多附加 ${MAX_ATTACH} 个文件。`);
    } else if (added.length) sendErrors.delete(s);
    if (A.state.active === s.id && !A.state.group) render(s);
    // Success is announced too (it used to be silent): the files stay on this computer until the message is sent.
    if (added.length && window.AgentDeskAttachNotice) A.toast(window.AgentDeskAttachNotice.added(added, 'chat'));
  }
  const usable = (s) => !s.agentThread && !s.busy && window.desk.files?.pickChat;
  async function attach(s, folders = false) {
    if (!usable(s)) return;
    try { addFiles(s, await window.desk.files.pickChat(s.project, folders)); } catch (error) { A.toast(error.message); }
  }
  async function dropFiles(s, list) {
    if (!usable(s)) return;
    try { addFiles(s, await window.desk.files.dropChat(s.project, list)); } catch (error) { A.toast(error.message); }
  }
  async function pasteFiles(s, list) {
    if (!usable(s)) return;
    for (const file of list) {
      try {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
        const name = file.name && file.name !== 'image.png' ? file.name : `粘贴文件-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace(/[^\w]/g, '') || 'bin'}`;
        addFiles(s, await window.desk.files.pasteChat(s.project, name, b64));
      } catch (error) { A.toast(error.message); }
    }
  }
  $('#attachList').addEventListener('click', (event) => {
    const id = event.target.closest('[data-provider-attachment]')?.dataset.providerAttachment;
    if (!id) return;
    const s = A.sess(A.state.active);
    if (!s || s.busy) return;
    attachments.set(s, (attachments.get(s) || []).filter(file => file.id !== id));
    window.desk.files.forgetChat(id);
    render(s);
  });
  // Sessions handled here instead of by the live Codex connection: every non-Codex AI, and every member's
  // conversation that receives work from the lead (Codex included).
  const handles = (s) => Boolean(s?.provider && (s.provider !== 'codex' || s.agentThread));
  const ownsTask = (task) => task.tags?.includes('direct') || (typeof task.id === 'string' && D.sessions.some(s => !s.agentThread &&
    (s.taskId === task.id || s.items?.some(it => it.t === 'provider-task' && it.task?.id === task.id))));
  $('#directTaskMode').addEventListener('change', (event) => {
    const s = A.sess(A.state.active);
    if (!handles(s) || s.agentThread) return;
    s.taskMode = event.target.value;
    sendErrors.delete(s);
    persist(); render(s);
  });
  $('#providerSendError').addEventListener('click', (event) => {
    const mode = event.target.closest('[data-recover-provider-mode]')?.dataset.recoverProviderMode;
    if (!mode) return;
    const picker = $('#directTaskMode');
    picker.value = mode;
    picker.dispatchEvent(new Event('change'));
    $('#input').focus();
  });
  $('#directModel').addEventListener('change', (event) => {
    const s = A.sess(A.state.active);
    if (!handles(s) || s.agentThread) return;
    s.model = event.target.value;
    persist();
  });
  const localSupported = window.desk.platform === 'win32' && Boolean(window.desk.localChange);
  $('#directTaskMode').querySelector('[value="local"]').hidden = !localSupported;
  for (const [id, kind] of [['pickLocalDirectory', 'directory'], ['pickLocalFile', 'file']]) {
    $('#' + id).addEventListener('click', async () => {
      const s = A.sess(A.state.active);
      const scope = await window.desk.localChange.pick(kind);
      if (scope.error) A.toast(scope.error);
      if (scope.token) { localScopes.set(s.id, scope); if (A.state.active === s.id) render(s); }
    });
  }
  function renderModels(s) {
    const picker = $('#directModel');
    const profiles = catalogs.get(s.project)?.[s.provider];
    const models = Object.entries(profiles?.models || {});
    picker.replaceChildren(new Option(profiles?.defaultModel ? '默认 · ' + profiles.defaultModel : 'CLI 默认模型', ''));
    for (const [id, profile] of models) {
      const option = new Option(profile.label || id, id);
      option.title = [id, profile.strengths].filter(Boolean).join(' · ');
      picker.add(option);
    }
    picker.value = models.some(([id]) => id === s.model) ? s.model : '';
    picker.disabled = !models.length || s.busy;
  }
  function render(s) {
    const other = handles(s);
    const error = other && !s.agentThread ? sendErrors.get(s) : undefined;
    const message = $('#providerSendError');
    message.hidden = !error;
    $('#providerSendErrorText').textContent = error ? errors[error] || error : '';
    const wrongMode = ['direct_workspace_not_bound', 'provider_write_not_enabled'].includes(error);
    message.querySelector('[data-recover-provider-mode="chat"]').hidden = !wrongMode && s?.taskMode !== 'local';
    message.querySelector('[data-recover-provider-mode="local"]').hidden = !wrongMode || !localSupported;
    $('#directTaskWrap').hidden = !other || Boolean(s.agentThread);
    $('#directModelWrap').hidden = !other || Boolean(s.agentThread);
    if (other && !s.agentThread) renderModels(s);
    $('#permissionModeWrap').hidden = other;
    $('#sbMode').hidden = other;
    const local = localSupported && other && !s.agentThread && s.taskMode === 'local';
    $('#directTaskMode').value = local ? 'local' : s?.taskMode === 'edit' ? 'edit' : 'chat';
    $('#pickLocalDirectory').hidden = $('#pickLocalFile').hidden = !local;
    $('#pickLocalDirectory').title = $('#pickLocalFile').title = localScopes.get(s?.id)?.path || '';
    for (const id of ['modelSelect', 'effortWrap', 'tierSelect']) {
      const element = $('#' + id); if (!element) continue;
      if (other && !controls.has(id)) controls.set(id, element.hidden);
      if (other) element.hidden = true;
      else if (controls.has(id)) { element.hidden = controls.get(id); controls.delete(id); }
    }
    $('#attachBtn').disabled = other && (s.agentThread || s.busy || !window.desk.files?.pickChat);
    if (other) $('#attachBtn').hidden = false;
    if (other) {
      $('#attachList').innerHTML = (attachments.get(s) || []).map(file =>
        `<button type="button" class="attach-pill" data-provider-attachment="${esc(file.id)}" title="移除附件">${esc(file.name)} ×</button>`).join('');
    } else if ($('#attachList').querySelector('[data-provider-attachment]')) $('#attachList').replaceChildren();
    // 本机 agent 单聊的提示由 live.js 设置；这里只处理 provider-direct 会话和 Codex。
    if (local) $('#input').placeholder = localScopes.get(s.id)?.path || '先选择本机文件或目录，再描述要做的改动…';
    else if (other) {
      $('#input').placeholder = s.taskMode === 'edit'
        ? `让 ${names[s.provider]} 修改 Git 项目文件，预览补丁后确认应用…`
        : `与 ${names[s.provider]} 单聊，可查看已授权的本机目录；修改文件请切换任务类型…`;
    } else if (!s?.agent) $('#input').placeholder = '向 Codex 描述任务…';
  }
  window.__providerDirect = { names, choose, create, send, render, attach, dropFiles, pasteFiles, handles, ownsTask, errors, onOpen: (s) => { poll(s); window.__agentThreads?.onOpen(s);
      if (!s.agentThread) control(s, 'routes').then(routes => {
        catalogs.set(s.project, routes.modelProfiles || {});
        if (A.state.active === s.id && !A.state.group) renderModels(s);
      }).catch(() => {});
      if (!s.agentThread) loadActivity(s, s.items.filter(it => it.t === 'provider-task' && it.task && !it.activity).slice(-3)); },
    avatarState: s => s.busy ? 'thinking' : s.status === 'waiting' ? 'asking' : 'idle' };
  const liveItemHtml = window.__live.itemHtml;
  window.__live.itemHtml = (it, index) => itemHtml(it, index) ?? liveItemHtml(it, index);
  setInterval(() => { for (const s of D.sessions) if (s.provider && s.busy) poll(s); }, 2500);
})();
