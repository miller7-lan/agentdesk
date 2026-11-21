(function () {
  const api = window.desk?.projects;
  if (!api) return;
  const A = window.__desk;
  const { $, D, esc } = A;
  const dialog = $('#workspaceDialog');
  const form = $('#workspaceForm');
  const list = $('#workspaceList');
  const name = $('#workspaceName');
  const kind = $('#workspaceKind');
  const remote = $('#workspaceRemote');
  const binding = $('#workspaceBinding');
  const choose = $('#workspacePick');
  const status = $('#workspaceStatus');
  let snapshot;
  let editing;
  let switching;

  function apply(result) {
    if (!result || !Array.isArray(result.projects)) return;
    const old = new Set(D.projects.filter((item) => item.configured).map(({ id }) => id));
    const records = result.projects.map((item) => {
      const serverProject = D.projects.find(project => project.id === item.id)?.serverProject;
      return { ...item, ...(serverProject && { serverProject }), branch: 'main', live: true, configured: true };
    });
    // Built-in demos are only useful before a real workspace is configured.
    const priorExamples = new Set(D.projects.filter(item => item.example).map(item => item.id));
    const configuredIds = new Set(records.map(item => item.id));
    const retained = D.projects.filter((item) => !configuredIds.has(item.id) && !item.configured && item.id !== 'live' && (!records.length || !item.example));
    D.projects.splice(0, D.projects.length, ...records, ...retained);
    const valid = new Set(D.projects.map(({ id }) => id));
    for (let index = D.sessions.length - 1; index >= 0; index--) {
      const { project } = D.sessions[index];
      if ((old.has(project) || priorExamples.has(project)) && !valid.has(project)) D.sessions.splice(index, 1);
    }
    snapshot = result;
    if (A.state.group ? !valid.has(A.state.group.split('~')[0]) : !A.sess(A.state.active)) openProject(result.activeProject);
    if (dialog.open) render();
    A.renderAll();
  }

  function render() {
    list.innerHTML = snapshot?.projects.map((project) =>
      `<div class="workspace-row"><strong>${esc(project.name)}</strong>
        <small>${esc(project.localRoot || project.remoteCwd || '云端默认目录')}</small>
        <button type="button" class="btn" data-workspace-select="${esc(project.id)}"
          ${project.id === snapshot.activeProject ? 'disabled' : ''}>切换</button>
        <button type="button" class="btn" data-workspace-edit="${esc(project.id)}">编辑</button></div>`).join('') || '<p>暂无工作区</p>';
    if (snapshot?.configError) status.textContent = '配置文件无法读取，修复后可编辑。';
  }

  function details(project) {
    editing = project?.id;
    form.reset();
    name.value = project?.name || '';
    kind.value = project?.kind || 'local';
    remote.value = project?.remoteCwd || '';
    binding.value = project?.orchestratorWorkspace || '';
    $('#workspaceExisting').textContent = project?.localRoot || '';
    $('#workspaceRemove').hidden = !editing;
    $('#workspaceSave').textContent = editing ? '保存' : '添加';
    status.textContent = '';
  }

  function select(id) {
    if (!snapshot?.projects.some((project) => project.id === id)) return Promise.resolve(false);
    if (snapshot.activeProject === id && !switching) return Promise.resolve(true);
    const request = api.select(id).then((result) => {
      if (result.ok) apply(result);
      else A.toast(result.error);
      return result.ok;
    });
    switching = request;
    request.finally(() => { if (switching === request) switching = undefined; });
    return request;
  }

  function openProject(id) {
    const target = D.sessions.find((session) => session.project === id);
    if (target) A.openSession(target.id);
    else if (id) A.newDirect(id);
    else {
      const example = D.sessions.find((session) => !session.live);
      if (example) A.openSession(example.id);
    }
  }

  $('#workspaceSettings').hidden = false;
  $('#workspaceSettings').addEventListener('click', () => {
    details();
    dialog.showModal();
    render();
  });
  $('#workspaceClose').addEventListener('click', () => dialog.close());
  $('#workspaceNew').addEventListener('click', () => { details(); name.focus(); });
  list.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-workspace-edit]');
    if (edit) {
      details(snapshot.projects.find(({ id }) => id === edit.dataset.workspaceEdit));
      name.focus();
    }
    const selection = event.target.closest('[data-workspace-select]');
    if (selection && await select(selection.dataset.workspaceSelect)) {
      dialog.close();
      openProject(selection.dataset.workspaceSelect);
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const request = {
      id: editing, name: name.value, kind: kind.value, remoteCwd: remote.value.trim(),
      orchestratorWorkspace: binding.value.trim(), pickLocal: choose.checked,
    };
    const result = await (editing ? api.update(request) : api.add(request));
    if (!result.ok) {
      if (!result.cancelled) status.textContent = result.error;
      return;
    }
    apply(result);
    dialog.close();
    openProject(result.activeProject);
    reportInit(result.init, result.activeProject);
  });
  // Tells the person what binding the folder did to Git (spec §7): nothing, the parent repository, or git init.
  function reportInit(init, projectId) {
    if (!init) return;
    const messages = {
      repository: '',
      subdirectory: `所选文件夹在一个 Git 仓库里，将使用父仓库（工作目录：${init.subdirectory}）。`,
      existing: '已在该文件夹执行 git init；现有文件未提交（显示为未跟踪），也没有创建 .gitignore。',
      empty: init.committed ? '已初始化新仓库：创建 .gitignore 并完成首个提交（只含 .gitignore，未添加远程）。'
        : init.reason === 'missing_identity' ? '已初始化新仓库并创建 .gitignore。未提交：缺少 Git 身份（user.name / user.email）。'
          : '已初始化新仓库并创建 .gitignore。首个提交未完成：' + (init.detail || init.reason || ''),
    };
    const text = messages[init.kind];
    if (!text) return;
    if (init.kind === 'empty' && !init.committed && init.reason === 'missing_identity' && api.initialCommit) {
      const retry = window.confirm(text + '\n\n请先在终端设置 git config user.name 和 user.email。设置好后点“确定”补做首个提交，或点“取消”稍后再说。');
      if (retry) api.initialCommit(projectId).then((answer) => A.toast(answer.ok && answer.committed ? '已补做首个提交。'
        : '仍未提交：' + (answer.error || (answer.reason === 'missing_identity' ? '缺少 Git 身份' : answer.reason)))).catch((error) => A.toast(error.message));
      return;
    }
    A.toast(text);
  }
  async function removeProject(id) {
    const project = snapshot?.projects.find(item => item.id === id);
    if (!project || !window.confirm(`从 AgentDesk 删除「${project.name}」？本机文件和远程仓库会保留。`)) return;
    const result = await api.remove(id);
    if (!result.ok) { A.toast(result.error); return; }
    apply(result);
    if (dialog.open) dialog.close();
  }
  $('#workspaceRemove').addEventListener('click', () => removeProject(editing));

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.hidden = true;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '删除项目…';
  menu.append(remove);
  document.body.append(menu);
  $('#sessionList').addEventListener('contextmenu', (event) => {
    menu.hidden = true;
    const id = event.target.closest('.group-head')?.closest('[data-proj]')?.dataset.proj;
    if (!snapshot?.projects.some(project => project.id === id)) return;
    event.preventDefault();
    menu.dataset.project = id;
    menu.hidden = false;
    menu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth)) + 'px';
    menu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight)) + 'px';
    remove.focus();
  });
  remove.addEventListener('click', () => {
    menu.hidden = true;
    removeProject(menu.dataset.project).catch(error => A.toast(error.message));
  });
  window.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) menu.hidden = true; });
  window.addEventListener('keydown', event => { if (event.key === 'Escape') menu.hidden = true; });
  api.onChanged(apply);
  async function bindForDirect(project) {
    const result = await api.add({ groupId: project.id, name: project.name, kind: 'local',
      orchestratorWorkspace: project.serverProject || '' });
    if (!result.ok) {
      if (!result.cancelled) A.toast(result.error);
      return false;
    }
    apply(result);
    return true;
  }
  window.AgentDeskProjects = { select, bindForDirect, openSettings: () => $('#workspaceSettings').click() };
  api.list().then((result) => {
    if (!result.ok) return;
    apply(result);
    if (result.activeProject && result.activeProject !== A.sess(A.state.active)?.project) openProject(result.activeProject);
  });
})();
