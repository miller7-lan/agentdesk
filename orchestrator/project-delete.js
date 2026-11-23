const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { git } = require('./git');

const ID = /^[A-Za-z0-9._-]{1,96}$/;
const belongs = (group, id) => group === id || group?.startsWith(id + '~');

async function cliHistory({ home, provider, cwd, sessions = [], subtree = false }) {
  // These directories are keyed by the CLI's working directory. Only AgentDesk-created task/thread roots
  // are passed here, so removing one directory also clears its subagent transcripts without touching a login.
  const roots = provider === 'claude' ? [path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))]
    : provider === 'grok' ? [path.join(home, '.grok', 'sessions', encodeURIComponent(cwd))] : [];
  if (subtree && roots.length) {
    const parent = path.dirname(roots[0]);
    const prefix = path.basename(roots[0]) + (provider === 'grok' ? '%2F' : '-');
    const entries = await fs.readdir(parent).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of entries) if (name.startsWith(prefix)) roots.push(path.join(parent, name));
  }
  for (const target of roots) await fs.rm(target, { recursive: true, force: true });
  if (provider === 'antigravity') {
    const cache = path.join(home, '.gemini', 'antigravity-cli', 'cache');
    const load = name => {
      const file = path.join(cache, name);
      try { const text = disk.readFileSync(file, 'utf8'); return { file, text, value: JSON.parse(text) }; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const write = entry => {
      if (!entry || JSON.stringify(entry.value) === JSON.stringify(JSON.parse(entry.text))) return;
      if (disk.readFileSync(entry.file, 'utf8') !== entry.text) throw Error('project_history_changed');
      const temporary = entry.file + '.agentdesk-' + process.pid;
      disk.writeFileSync(temporary, JSON.stringify(entry.value), { mode: 0o600 });
      disk.renameSync(temporary, entry.file);
    };
    const last = load('last_conversations.json');
    const metadata = load('conversation_metadata.json');
    const ids = new Set(sessions);
    for (const directory of Object.keys(last?.value || {})) {
      if (directory !== cwd && !(subtree && directory.startsWith(cwd + '/'))) continue;
      ids.add(last.value[directory]); delete last.value[directory];
    }
    for (const id of ids) if (metadata?.value.conversations) delete metadata.value.conversations[id];
    // Both writes happen synchronously while this process is quiescent, preserving all unrelated entries.
    write(metadata);
    write(last);
  }

}

async function projectDelete(scheduler, body, owner) {
  const { config, tasks } = scheduler;
  if (!owner || !ID.test(body.group || '')) throw Error('invalid_project_delete');
  const workspace = config.workspaces?.[body.workspace];
  if (!workspace || workspace.sshBridge !== owner) throw Error('workspace_not_authorized');
  const selected = [...tasks.values()].filter(task => task.owner === owner && task.workspace === body.workspace && belongs(task.group, body.group));
  const root = workspace.repository && path.resolve(workspace.repository);
  if (root) {
    const resolved = await fs.realpath(root).catch(error => { if (error.code === 'ENOENT') return root; throw error; });
    if (resolved !== root) throw Error('project_repository_changed');
  }
  const shared = root && ([...tasks.values()].some(task => task.workspace === body.workspace && !selected.includes(task)) ||
    Object.entries(config.workspaces).some(([name, value]) => name !== body.workspace && value.repository && path.resolve(value.repository) === root));
  // Repositories outside the managed cache are never deleted as a side effect of a project menu action.
  const repoRoot = path.join(path.resolve(config.stateDir), 'repos') + path.sep;
  const repository = root?.startsWith(repoRoot) && !shared ? root : null;
  const snapshot = { group: body.group, workspace: body.workspace, taskIds: selected.map(task => task.id).sort(), repository };
  const revision = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const plan = { ...snapshot, revision, sharedRepository: Boolean(root && !repository), tasks: selected.length };
  if (body.action === 'preview') {
    const offset = body.after ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > plan.taskIds.length) throw Error('invalid_project_page');
    const taskIds = plan.taskIds.slice(offset, offset + 1000);
    return { ...plan, taskIds, nextOffset: offset + taskIds.length < plan.taskIds.length ? offset + taskIds.length : null };
  }
  if (body.action !== 'delete' || body.revision !== revision) throw Error('project_delete_changed');
  if (scheduler.deletingProjects?.has(body.group)) throw Error('project_delete_in_progress');
  scheduler.deletingProjects ||= new Set();
  scheduler.deletingProjects.add(body.group);
  scheduler.deletingWorkspaces ||= new Set();
  if (scheduler.deletingWorkspaces.has(body.workspace)) { scheduler.deletingProjects.delete(body.group); throw Error('project_delete_in_progress'); }
  scheduler.deletingWorkspaces.add(body.workspace);
  try {
    // Applying/testing can be in a separate Bridge process. Require it to settle before touching its files.
    if (selected.some(task => ['applying', 'testing'].includes(task.state) || task.pendingRequest)) throw Error('project_delete_busy');
    scheduler.store.put('settings', 'deleted-project:' + owner + ':' + body.group, { deleted: true });
    for (const task of selected) scheduler.cancel(task);
    const end = Date.now() + 8000;
    while (selected.some(task => scheduler.running.has(task.id))) {
      if (Date.now() >= end) throw Error('project_delete_busy');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const codexSessions = selected.flatMap(task => [...(task.projectSessions || []).filter(entry => entry.role === 'codex').map(entry => entry.id),
      ...(task.steps || []).filter(step => step.role === 'codex')
      .flatMap(step => [...(step.previousSessions || []), step.session].filter(Boolean))]);
    await require('./codex-sessions').deleteCodexSessions(config.adapters?.codex, { sessions: codexSessions, roots: selected.map(task => path.join(config.stateDir, 'worktrees', task.id)) });
    for (const task of selected) {
      if (!/^[0-9a-f-]{36}$/i.test(task.id)) throw Error('invalid_project_task');
      const work = path.join(config.stateDir, 'worktrees', task.id);
      for (const provider of ['claude', 'grok', 'antigravity']) {
        const adapter = config.adapters?.[provider];
        const sessions = [...(task.projectSessions || []).filter(entry => entry.role === provider).map(entry => entry.id),
          ...(task.steps || []).filter(step => step.role === provider).flatMap(step => [...(step.previousSessions || []), step.session].filter(Boolean))];
        if (adapter?.env?.HOME) await cliHistory({ home: adapter.env.HOME, provider, cwd: work, sessions, subtree: true });
      }
      for (const kind of ['worktrees', 'logs', 'chat-attachments']) await fs.rm(path.join(config.stateDir, kind, task.id), { recursive: true, force: true });
      if (root && !repository) {
        await git(root, ['worktree', 'prune']);
        const refs = (await git(root, ['for-each-ref', '--format=%(refname:short)', `refs/heads/agentdesk/${task.id}/`])).split('\n').filter(Boolean);
        if (refs.length) await git(root, ['branch', '-D', ...refs]);
      }
    }
    if (root) await git(root, ['worktree', 'prune']).catch(error => {
      if (error.code !== 'ENOENT' && !repository) throw error;
    });
    if (repository) {
      scheduler.store.put('settings', 'deleted-repository:' + body.workspace, { repository });
      await fs.rm(repository, { recursive: true, force: true });
    }
    scheduler.store.deleteTaskMessages(selected.map(task => task.id));
    scheduler.store.deleteTasks(selected.map(task => task.id));
    for (const task of selected) tasks.delete(task.id);
    return { ...plan, taskIds: [], deleted: true };
  } finally { scheduler.deletingProjects.delete(body.group); scheduler.deletingWorkspaces.delete(body.workspace); }
}

module.exports = { projectDelete, belongs, cliHistory };
