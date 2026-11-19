// Stage templates for single chats (after Lancer's module sessions): a conversation can follow a short
// workflow, e.g. research → implement → self-review. Clicking a stage switches the reasoning effort (and the
// model, when the stage names one this conversation offers) and loads the stage's goal and deliverable into
// the input. Nothing is sent automatically: the person reads the draft and sends it. Templates are kept on
// this computer; the two built-in ones can be copied and edited.
(() => {
  const A = window.__desk;
  if (!A) { window.__stageStrip = () => {}; return; }
  const { $, esc, sess, state, store, toast } = A;
  const strip = $('#stageStrip');
  const button = $('#stageBtn');
  const input = $('#input');

  const BUILT_IN = [
    { id: 'builtin-research', name: '调研 → 实现 → 自查', builtIn: true, stages: [
      { name: '调研', effort: 'high', goal: '先阅读与这个需求相关的代码、文档和测试，弄清现状。不要修改任何文件。', deliverable: '要改的文件清单、实现方案和风险点。' },
      { name: '实现', effort: 'medium', goal: '按上一步确定的方案修改代码，并补充或更新测试。', deliverable: '完成的改动、新增的测试，以及测试运行结果。' },
      { name: '自查', effort: 'high', goal: '逐个检查本次改动：边界条件、错误处理、遗漏的调用点和测试覆盖。发现问题直接修复。', deliverable: '发现的问题和修复，以及最终的测试结果。' },
    ] },
    { id: 'builtin-bug', name: '排查 Bug', builtIn: true, stages: [
      { name: '复现', effort: 'medium', goal: '根据描述复现问题，找到最小的复现步骤。不要修改代码。', deliverable: '复现步骤和实际与预期的差别。' },
      { name: '定位', effort: 'high', goal: '找出根因，说明为什么会出错，以及影响范围。不要修改代码。', deliverable: '根因、相关代码位置和修复思路。' },
      { name: '修复', effort: 'medium', goal: '修复根因（不是只处理表面症状），并加一个能防止复发的测试。', deliverable: '改动和新增的测试。' },
      { name: '回归', effort: 'medium', goal: '运行相关测试，确认修复有效且没有引入新问题。', deliverable: '测试结果和剩余风险。' },
    ] },
  ];
  const custom = () => store.get('stageTemplates', []);
  const templates = () => [...BUILT_IN, ...custom()];
  const find = (id) => templates().find((t) => t.id === id);

  // The stage a conversation is on survives a restart (kept by thread, the id that stays the same).
  const saved = () => store.get('sessionStages', {});
  function remember(s) {
    if (!s?.threadId) return;
    const all = saved();
    if (JSON.stringify(all[s.threadId]) === JSON.stringify(s.stage)) return;   // render runs often; write only changes
    if (s.stage) all[s.threadId] = s.stage; else delete all[s.threadId];
    store.set('sessionStages', Object.fromEntries(Object.entries(all).slice(-200)));
  }
  function render(s) {
    if (s && !s.stage && s.threadId && saved()[s.threadId]) s.stage = saved()[s.threadId];
    if (s?.stage) remember(s);
    const live = !state.group && s && !s.agentThread;
    button.hidden = !live;
    const template = live && s.stage && find(s.stage.template);
    strip.hidden = !template;
    if (!template) return;
    const at = s.stage.index ?? -1;
    strip.innerHTML = `<span class="stage-name" title="会话流程">${esc(template.name)}</span>${template.stages.map((stage, i) =>
      `<button type="button" class="stage-chip${i === at ? ' current' : i < at ? ' done' : ''}" data-stage="${i}" title="${esc(stage.goal)}${stage.model ? '\n模型：' + esc(stage.model) : ''}${stage.effort ? '\n思考：' + esc(stage.effort) : ''}"><b>${i + 1}</b>${esc(stage.name)}</button>`).join('<span class="stage-arrow">›</span>')}
      <span class="grow"></span><button type="button" class="stage-close" data-stage-close title="关闭流程">×</button>`;
  }

  // Selects an option only when this conversation offers it; returns whether it did.
  function choose(select, value) {
    if (!select || !value || select.closest('[hidden]')) return false;
    if (![...select.options].some((option) => option.value === value && !option.disabled)) return false;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function load(s, index) {
    const template = find(s.stage.template);
    const stage = template?.stages[index];
    if (!stage) return;
    if (s.busy) { toast('会话还在运行，结束后再切换阶段'); return; }
    if (input.value.trim() && !window.confirm('输入框里已有内容。用这个阶段的任务替换它吗？')) return;
    const notes = [];
    if (stage.model && !choose($('#modelSelect'), stage.model) && !choose($('#directModel'), stage.model)) notes.push(`这个会话没有模型 ${stage.model}，沿用当前模型`);
    if (stage.effort && !choose($('#effortSelect'), stage.effort)) notes.push('这个会话不能调思考程度');
    input.value = `【${template.name} · 第 ${index + 1}/${template.stages.length} 步：${stage.name}】\n目标：${stage.goal}\n交付：${stage.deliverable}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    s.stage.index = index;
    render(s);
    toast(notes.length ? notes.join('；') : `已载入「${stage.name}」，检查后发送`);
  }

  function pick(s) {
    const dialog = document.createElement('dialog');
    dialog.className = 'stage-picker';
    const list = () => templates().map((t) => `<div class="stage-template"><button type="button" class="btn" data-use="${esc(t.id)}">${esc(t.name)}</button>
      <small>${t.stages.map((x) => esc(x.name)).join(' → ')}</small>
      <button type="button" class="task-text-link" data-edit="${esc(t.id)}">${t.builtIn ? '复制并编辑' : '编辑'}</button>
      ${t.builtIn ? '' : `<button type="button" class="task-text-link" data-remove="${esc(t.id)}">删除</button>`}</div>`).join('');
    const draw = () => { dialog.innerHTML = `<h2>会话流程</h2><p>按阶段推进这个单聊。点阶段会切换思考程度（和模型），并把任务载入输入框，不会自动发送。</p>${list()}
      <div class="stage-actions"><button type="button" class="btn" data-new>新建流程</button><span class="grow"></span><button type="button" class="btn" data-close>关闭</button></div>`; };
    draw();
    dialog.addEventListener('click', (event) => {
      const t = event.target;
      if (t.closest('[data-close]')) return dialog.close();
      const use = t.closest('[data-use]')?.dataset.use;
      if (use) { s.stage = { template: use, index: -1 }; dialog.close(); render(s); load(s, 0); return; }
      const remove = t.closest('[data-remove]')?.dataset.remove;
      if (remove) { store.set('stageTemplates', custom().filter((x) => x.id !== remove)); draw(); return; }
      const edit = t.closest('[data-edit]')?.dataset.edit;
      if (edit || t.closest('[data-new]')) { dialog.close(); editor(s, edit ? find(edit) : null); }
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog); dialog.showModal();
  }

  function editor(s, source) {
    const copy = source ? JSON.parse(JSON.stringify(source)) : { name: '新流程', stages: [{ name: '第一步', effort: '', model: '', goal: '', deliverable: '' }] };
    if (!source || source.builtIn) { copy.id = 'custom-' + crypto.randomUUID().slice(0, 8); copy.builtIn = false; if (source) copy.name += '（副本）'; }
    const dialog = document.createElement('dialog');
    dialog.className = 'stage-editor';
    const row = (stage, i) => `<fieldset data-row="${i}"><legend>第 ${i + 1} 步 <button type="button" class="task-text-link" data-drop="${i}">删除</button></legend>
      <label>名称<input data-field="name" maxlength="40" value="${esc(stage.name || '')}"></label>
      <label>思考程度<select data-field="effort">${['', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => `<option value="${v}" ${stage.effort === v ? 'selected' : ''}>${v || '沿用当前'}</option>`).join('')}</select></label>
      <label>模型 ID（可选）<input data-field="model" maxlength="128" value="${esc(stage.model || '')}" placeholder="留空沿用当前模型"></label>
      <label>目标<textarea data-field="goal" rows="2" maxlength="4000">${esc(stage.goal || '')}</textarea></label>
      <label>交付与验收<textarea data-field="deliverable" rows="2" maxlength="4000">${esc(stage.deliverable || '')}</textarea></label></fieldset>`;
    const collect = () => {
      copy.name = dialog.querySelector('[data-name]').value.trim() || '未命名流程';
      copy.stages = [...dialog.querySelectorAll('[data-row]')].map((set) => Object.fromEntries([...set.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value.trim()])));
    };
    const draw = () => { dialog.innerHTML = `<h2>编辑流程</h2><label>流程名称<input data-name maxlength="40" value="${esc(copy.name)}"></label>
      <div class="stage-rows">${copy.stages.map(row).join('')}</div>
      <div class="stage-actions"><button type="button" class="btn" data-add ${copy.stages.length >= 8 ? 'disabled' : ''}>添加一步</button><span class="grow"></span>
      <button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn primary" data-save>保存</button></div>`; };
    draw();
    dialog.addEventListener('click', (event) => {
      const t = event.target;
      if (t.closest('[data-cancel]')) return dialog.close();
      if (t.closest('[data-add]')) { collect(); copy.stages.push({ name: '第 ' + (copy.stages.length + 1) + ' 步', effort: '', model: '', goal: '', deliverable: '' }); draw(); return; }
      const drop = t.closest('[data-drop]')?.dataset.drop;
      if (drop !== undefined) { collect(); if (copy.stages.length > 1) copy.stages.splice(+drop, 1); draw(); return; }
      if (t.closest('[data-save]')) {
        collect();
        if (copy.stages.some((stage) => !stage.name || !stage.goal)) { toast('每一步都要有名称和目标'); return; }
        store.set('stageTemplates', [...custom().filter((x) => x.id !== copy.id), copy]);
        dialog.close();
        toast('已保存流程「' + copy.name + '」');
        pick(s);
      }
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog); dialog.showModal();
  }

  button.addEventListener('click', () => { const s = sess(state.active); if (s) pick(s); });
  strip.addEventListener('click', (event) => {
    const s = sess(state.active);
    if (!s?.stage) return;
    if (event.target.closest('[data-stage-close]')) { delete s.stage; remember(s); render(s); return; }
    const index = event.target.closest('[data-stage]')?.dataset.stage;
    if (index !== undefined) load(s, +index);
  });

  window.__stageStrip = render;
})();
