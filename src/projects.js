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
    for (const id of result.deletedProjects || []) window.__group?.removeProject?.(id);
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
  // A project made in the group chat: no local folder and not in the app's project list.
  function groupOnly(id) {
    const project = typeof id === 'string' && D.projects.find(item => item.id === id);
    return Boolean(project && !project.configured && !project.example && id.startsWith('group-') && window.__group?.groupsOf?.(id)?.length);
  }
  async function removeGroupProject(id) {
    const project = D.projects.find(item => item.id === id);
    if (!project || !window.desk.groupProjects) return;
    A.toast('正在核对 VPS 上的群聊任务…');
    const result = await window.desk.groupProjects.remove({ id, name: project.name, ...(project.serverProject && { workspace: project.serverProject }) });
    if (!result.ok) { if (!result.cancelled) window.alert('删除项目没有完成：' + result.error); return; }
    window.__group?.removeProject?.(id);
    A.renderAll();
    A.toast(`已删除「${project.name}」，VPS 上清理了 ${result.tasks} 个群聊任务。`);
  }
  async function removeProject(id) {
    if (groupOnly(id) && !snapshot?.projects.some(item => item.id === id)) return removeGroupProject(id);
    const project = snapshot?.projects.find(item => item.id === id);
    if (!project) return;
    status.textContent = '正在核对删除范围，确认后清理本机与 VPS 数据…';
    const result = await api.remove(id);
    if (!result.ok) {
      status.textContent = result.cancelled ? '' : result.error;
      if (!result.cancelled) window.alert('删除项目没有完成：' + result.error + '\n\n已清理的部分不会恢复，处理后可再次删除继续。');
      return;
    }
    window.__group?.removeProject?.(id);
    apply(result);
    if (dialog.open) dialog.close();
    A.toast('项目及本机、VPS 关联数据已删除。');
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
    if (!snapshot?.projects.some(project => project.id === id) && !groupOnly(id)) return;
    event.preventDefault();
    menu.dataset.project = id;
    menu.hidden = false;
    menu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth)) + 'px';
    menu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight)) + 'px';
    remove.focus();
  });
  // The ··· button on a project row opens the same menu, so deleting a project does not depend on a right click.
  $('#sessionList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-project-menu]');
    if (!button || !(snapshot?.projects.some(project => project.id === button.dataset.projectMenu) || groupOnly(button.dataset.projectMenu))) return;
    event.stopPropagation();
    menu.dataset.project = button.dataset.projectMenu;
    menu.hidden = false;
    const box = button.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(box.left, innerWidth - menu.offsetWidth)) + 'px';
    menu.style.top = Math.max(0, Math.min(box.bottom + 4, innerHeight - menu.offsetHeight)) + 'px';
    remove.focus();
  }, true);
  remove.addEventListener('click', () => {
    menu.hidden = true;
    removeProject(menu.dataset.project).catch(error => window.alert('删除项目没有完成：' + error.message));
  });
  window.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) menu.hidden = true; });
  window.addEventListener('keydown', event => { if (event.key === 'Escape') menu.hidden = true; });
  api.onChanged(apply);
  async function bindForDirect(project, folderToken) {
    const result = await api.add({ groupId: project.id, name: project.name, kind: 'local',
      orchestratorWorkspace: project.serverProject || '', ...(folderToken && { folderToken }) });
    if (!result.ok) {
      if (!result.cancelled) A.toast(result.error);
      return false;
    }
    apply(result);
    return true;
  }
  // A project created from the orchestrator (a group project bound to one of its workspaces) is registered as a
  // project of this app at once — as a cloud project with that binding, no folder to pick — so attachments and
  // single chats work in it from the start (they need a registered project). A local folder can still be chosen
  // later in the workspace settings. Nothing existing is changed: an already registered project is left alone.
  const registering = new Map();
  async function ensureRegistered(project) {
    if (!project || project.configured) return true;
    if (!project.serverProject || !/^group-[0-9a-f-]+$/.test(project.id)) return false;
    if (!registering.has(project.id)) {
      registering.set(project.id, (async () => {
        const result = await api.add({ groupId: project.id, name: project.name, kind: 'remote', orchestratorWorkspace: project.serverProject })
          .catch((error) => ({ ok: false, error: error?.message || String(error) }));
        if (!result?.ok) {
          // Registered meanwhile (another window, an earlier click): fine as long as it is there now.
          const listed = await api.list().catch(() => null);
          if (listed?.projects?.some((item) => item.id === project.id)) { apply(listed); return true; }
          A.toast('项目没能自动建好：' + (result?.error || '未知错误') + '。可在「工作区」里手动添加。');
          return false;
        }
        apply(result);
        return true;
      })().finally(() => registering.delete(project.id)));
    }
    return registering.get(project.id);
  }
  const pickFolder = () => api.pickFolder ? api.pickFolder() : Promise.resolve({ ok: false });
  window.AgentDeskProjects = { select, bindForDirect, pickFolder, ensureRegistered, openSettings: () => $('#workspaceSettings').click() };
  api.list().then((result) => {
    if (!result.ok) return;
    apply(result);
    if (result.activeProject && result.activeProject !== A.sess(A.state.active)?.project) openProject(result.activeProject);
  });
})();
