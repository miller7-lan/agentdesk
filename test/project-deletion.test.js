const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { deleteProject, projectDirectory, purgeCheckpoints } = require('../project-deletion');
const { projectDelete } = require('../orchestrator/project-delete');
const { Scheduler } = require('../orchestrator/scheduler');
const Store = require('../orchestrator/store');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ad-delete-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// A state folder with an open store. The store is closed before the folder is removed: after-hooks run in the order
// they are registered, and Windows cannot delete an SQLite file that is still open.
async function stateFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ad-delete-')));
  const store = new Store(path.join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { stateDir: root, store };
}

const exists = target => fs.stat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });

async function repo(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, 'init', '-q');
  await fs.writeFile(path.join(root, 'file.txt'), 'project data');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
}

test('deleting a project removes its files, Git and linked worktrees after remote cleanup, preserving siblings', async t => {
  const base = await fixture(t), root = path.join(base, 'project'), linked = path.join(base, 'linked');
  await repo(root);git(root, 'worktree', 'add', '-q', '-b', 'work', linked);
  const sibling = path.join(base, 'other');await fs.mkdir(sibling);await fs.writeFile(path.join(sibling, 'keep'), 'keep');
  const project = { id: 'p', localRoot: root };
  const order = [];
  const result = await deleteProject({ project, projects: [project], preview: async () => ({ threadIds: ['chat'] }),
    confirm: async plan => { assert.deepEqual(plan.worktrees, [linked]); return true; },
    remote: async () => { assert.ok(await exists(path.join(root, '.git'))); order.push('remote'); },
    local: async () => order.push('local'), unregister: async () => { assert.ok(!await exists(root)); order.push('unregister'); } });
  assert.ok(result.deleted);assert.deepEqual(order, ['remote', 'local', 'unregister']);
  assert.ok(!await exists(root));assert.ok(!await exists(linked));assert.ok(await exists(path.join(sibling, 'keep')));
});

test('cancelling or a remote failure preserves files and registration, and a partial deletion can be retried', async t => {
  const base = await fixture(t), root = path.join(base, 'project');await repo(root);
  const project = { id: 'p', localRoot: root };let removed = false, remoteDone = false, saved;
  const options = { project, projects: [project], preview: async () => ({ threadIds: ['chat'] }), confirm: async () => false,
    remote: async () => { throw Error('offline'); }, local: async () => {}, unregister: async () => { removed = true; }, savePlan: async plan => { saved = plan; } };
  assert.ok((await deleteProject(options)).cancelled);assert.equal(saved, undefined);
  await assert.rejects(deleteProject({ ...options, confirm: async () => true }), /offline/);
  assert.ok(await exists(root));assert.equal(removed, false);assert.deepEqual(saved.threadIds, ['chat']);
  await assert.rejects(deleteProject({ ...options, confirm: async () => true, remote: async () => { remoteDone = true; }, local: async () => { throw Error('disk failure'); } }), /disk failure/);
  assert.ok(remoteDone);assert.equal(removed, false);
  await deleteProject({ ...options, confirm: async () => true, remote: async () => {}, local: async () => {} });
  assert.equal(removed, true);assert.ok(!await exists(root));
});

test('home, protected paths, overlapping projects and external Git directories cannot be deleted', async t => {
  const base = await fixture(t), root = path.join(base, 'project');await fs.mkdir(root);
  await assert.rejects(projectDirectory({ id: 'p', localRoot: os.homedir() }, []), /用户目录/);
  await assert.rejects(projectDirectory({ id: 'p', localRoot: root }, [], [root]), /AgentDesk/);
  await assert.rejects(projectDirectory({ id: 'p', localRoot: root }, [{ id: 'other', localRoot: root }]), /另一个项目/);
  await fs.writeFile(path.join(root, '.git'), 'gitdir: ../other/.git');
  await assert.rejects(projectDirectory({ id: 'p', localRoot: root }, []), /外部 Git/);
});

test('checkpoint cleanup removes only the project threads', async t => {
  const base = await fixture(t);
  for (const [turn, threadId] of [['one', 'mine'], ['two', 'other']]) {
    await fs.mkdir(path.join(base, turn));await fs.writeFile(path.join(base, turn, 'manifest.json'), JSON.stringify({ threadId }));
  }
  await purgeCheckpoints(base, ['mine']);assert.ok(!await exists(path.join(base, 'one')));assert.ok(await exists(path.join(base, 'two')));
});

test('VPS project purge is scoped to the authenticated owner/group and removes task worktrees, branches, logs, attachments and receipts', async t => {
  const { stateDir, store } = await stateFixture(t), repository = path.join(stateDir, 'repos', 'project.git');await repo(repository);
  const own = { id: randomUUID(), owner: 'mac', workspace: 'mac', group: 'project~one', state: 'completed', steps: [{ id: 'edit' }] };
  const other = { id: randomUUID(), owner: 'mac', workspace: 'mac', group: 'another', state: 'completed', steps: [] };
  const foreign = { id: randomUUID(), owner: 'windows', workspace: 'mac', group: 'project', state: 'completed', steps: [] };
  const tasks = new Map([own, other, foreign].map(task => [task.id, task]));
  for (const task of tasks.values()) {
    store.put('tasks', task.id, task);store.put('received', task.id, { id: task.id, taskId: task.id, reply: 'history' });
    for (const kind of ['logs', 'chat-attachments']) {await fs.mkdir(path.join(stateDir, kind, task.id), { recursive: true });}
  }
  const worktree = path.join(stateDir, 'worktrees', own.id, 'edit');
  git(repository, 'worktree', 'add', '-q', '-b', `agentdesk/${own.id}/edit`, worktree);
  const scheduler = { config: { stateDir, adapters: {}, workspaces: { mac: { repository, sshBridge: 'mac' } } }, tasks, store, running: new Map(), cancel() {} };
  await assert.rejects(projectDelete(scheduler, { group: 'project', workspace: 'mac', action: 'preview' }, 'windows'), /authorized/);
  const plan = await Scheduler.prototype.control.call(scheduler, { task_id: randomUUID(), kind: 'task.status', body: { operation: 'project_delete', group: 'project', workspace: 'mac', action: 'preview' } }, 'ssh:mac');
  assert.deepEqual(plan.taskIds, [own.id]);assert.equal(plan.sharedRepository, true);
  await assert.rejects(projectDelete(scheduler, { group: 'project', workspace: 'mac', action: 'delete', revision: 'stale' }, 'mac'), /changed/);
  await projectDelete(scheduler, { group: 'project', workspace: 'mac', action: 'delete', revision: plan.revision }, 'mac');
  assert.ok(!await exists(worktree));assert.equal(git(repository, 'branch', '--list', `agentdesk/${own.id}/*`).trim(), '');
  assert.equal(store.get('tasks', own.id), undefined);assert.equal(store.get('received', own.id), undefined);
  assert.ok(store.get('tasks', other.id));assert.ok(store.get('tasks', foreign.id));
  assert.ok(await exists(path.join(stateDir, 'logs', other.id)));
});

test('VPS purge deletes an exclusive managed Git cache and refuses unsettled local writes', async t => {
  const { stateDir, store } = await stateFixture(t), repository = path.join(stateDir, 'repos', 'project.git');await repo(repository);
  const task = { id: randomUUID(), owner: 'mac', workspace: 'mac', group: 'project', state: 'applying', pendingRequest: 'write' };
  const scheduler = { config: { stateDir, workspaces: { mac: { repository, sshBridge: 'mac' } } }, tasks: new Map([[task.id, task]]), store, running: new Map(), cancel() {} };
  const plan = await projectDelete(scheduler, { group: 'project', workspace: 'mac', action: 'preview' }, 'mac');
  assert.equal(plan.repository, repository);
  await assert.rejects(projectDelete(scheduler, { group: 'project', workspace: 'mac', action: 'delete', revision: plan.revision }, 'mac'), /busy/);
  assert.ok(await exists(repository));task.state = 'completed';delete task.pendingRequest;
  await projectDelete(scheduler, { group: 'project', workspace: 'mac', action: 'delete', revision: plan.revision }, 'mac');
  assert.ok(!await exists(repository));
});

test('Codex cleanup uses the CLI deletion protocol and filters histories by their exact working directory', async t => {
  const { spawn } = require('node:child_process');
  const { deleteCodexSessions } = require('../orchestrator/codex-sessions');
  const base = await fixture(t), cwd = path.join(base, 'project'), report = path.join(base, 'report.json'), binary = path.join(base, 'cli.cjs');
  await fs.writeFile(binary, `const fs=require('fs');const deleted=[];
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params}=JSON.parse(line);if(id===undefined)return;
 let result={};
 if(method==='thread/list')result={data:[{id:'mine',cwd:${JSON.stringify(cwd)}},{id:'other',cwd:'/another-project'}]};
 if(method==='thread/delete'){deleted.push(params.threadId);fs.writeFileSync(process.env.REPORT,JSON.stringify(deleted));}
 console.log(JSON.stringify({id,result}));
});`);
  await deleteCodexSessions({ bin: 'fixture', env: { ...process.env, REPORT: report } }, { directories: [cwd],
    spawnProcess: (_bin, args, options) => spawn(process.execPath, [binary, ...args], options) });
  assert.deepEqual(JSON.parse(await fs.readFile(report, 'utf8')), ['mine']);
});

test('Antigravity project cleanup removes its cached conversation summaries and preserves another project', async t => {
  const { cliHistory } = require('../orchestrator/project-delete');
  const home = await fixture(t), cache = path.join(home, '.gemini', 'antigravity-cli', 'cache');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'last_conversations.json'), JSON.stringify({ '/mine': 'mine-last', '/other': 'keep' }));
  await fs.writeFile(path.join(cache, 'conversation_metadata.json'), JSON.stringify({ conversations: { 'mine-old': { summary: 'old project' }, 'mine-last': { summary: 'new project' }, keep: { summary: 'other project' } } }));
  await cliHistory({ home, provider: 'antigravity', cwd: '/mine', sessions: ['mine-old'] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cache, 'last_conversations.json'), 'utf8')), { '/other': 'keep' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cache, 'conversation_metadata.json'), 'utf8')).conversations, { keep: { summary: 'other project' } });
});

test('large project previews page task IDs within the Bridge frame limit with one revision', async () => {
  const tasks = new Map(Array.from({ length: 1001 }, () => { const id = randomUUID();return [id, { id, owner: 'mac', workspace: 'mac', group: 'large' }]; }));
  const scheduler = { config: { stateDir: '/fixture', workspaces: { mac: { sshBridge: 'mac' } } }, tasks };
  const first = await projectDelete(scheduler, { group: 'large', workspace: 'mac', action: 'preview' }, 'mac');
  const second = await projectDelete(scheduler, { group: 'large', workspace: 'mac', action: 'preview', after: first.nextOffset }, 'mac');
  assert.equal(first.taskIds.length, 1000);assert.equal(second.taskIds.length, 1);assert.equal(second.nextOffset, null);
  assert.equal(first.revision, second.revision);assert.equal(new Set([...first.taskIds, ...second.taskIds]).size, 1001);
});

test('a project bound to a personal folder keeps every file; only an empty AgentDesk .git is removed', async t => {
  const home = await fixture(t), desktop = path.join(home, 'Desktop');
  await fs.mkdir(desktop);await fs.writeFile(path.join(desktop, 'notes.txt'), 'keep me');git(desktop, 'init', '-q');
  const project = { id: 'p', localRoot: desktop };let shown, removed = false;
  const result = await deleteProject({ project, projects: [project], home, preview: async () => ({ threadIds: [] }),
    confirm: async plan => { shown = plan; return true; }, remote: async () => {}, local: async () => {}, unregister: async () => { removed = true; } });
  assert.ok(result.deleted);assert.ok(removed);assert.equal(shown.keepFolder, true);assert.equal(shown.removeGit, true);
  assert.equal(await fs.readFile(path.join(desktop, 'notes.txt'), 'utf8'), 'keep me');assert.ok(!await exists(path.join(desktop, '.git')));
});

test('a personal folder with real Git history keeps its .git too', async t => {
  const home = await fixture(t), documents = path.join(home, 'Documents');await repo(documents);
  const project = { id: 'p', localRoot: documents };
  await deleteProject({ project, projects: [project], home, preview: async () => ({ threadIds: [] }),
    confirm: async plan => { assert.equal(plan.removeGit, false); return true; }, remote: async () => {}, local: async () => {}, unregister: async () => {} });
  assert.ok(await exists(path.join(documents, '.git')));assert.ok(await exists(path.join(documents, 'file.txt')));
});
