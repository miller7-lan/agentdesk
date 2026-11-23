const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { start, startBridge } = require('../orchestrator/service');
const { request } = require('../orchestrator/mcp');
const { deleteProject } = require('../project-deletion');
const { AppConfig } = require('../app-config');
const Store = require('../orchestrator/store');

const exists = target => fs.stat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

test('project deletion through the real Bridge control socket clears both sides before unregistering the project', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ad-purge-e2e-')));
  const local = path.join(base, 'project'), stateDir = path.join(base, 'vps'), bridgeDir = path.join(base, 'bridge');
  await fs.mkdir(local);const git = (...args) => execFileSync('git', ['-C', local, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
  git('init', '-q');await fs.writeFile(path.join(local, 'private.txt'), 'fixture');git('add', '.');git('commit', '-qm', 'fixture');
  const repository = path.join(stateDir, 'repos', 'project.git');await fs.mkdir(path.dirname(repository), { recursive: true });git('clone', '--bare', local, repository);
  const service = start({ stateDir, adapters: {}, sshBridges: ['mac'], workspaces: { project: { repository, sshBridge: 'mac' } } });
  const socket = path.join(base, 'control.sock');
  const stop = startBridge({ config: { stateDir: bridgeDir, ssh: {}, controlSocket: socket, controlWorkspace: 'project', groupCopies: path.join(base, 'copies'),
    workspaces: { project: { root: local, write: true } } }, desktop: { enabled: false },
    spawnSsh: () => spawn(process.execPath, [require.resolve('../orchestrator/ssh-gateway'), path.join(stateDir, 'bridge-mac.sock')]) });
  t.after(async () => { stop();service.close();await new Promise(resolve => setTimeout(resolve, 100));await fs.rm(base, { recursive: true, force: true }); });
  const end = Date.now() + 5000;
  while (!service.endpoint['ssh:mac']?.ready) { if (Date.now() > end) throw Error('bridge connection timed out');await new Promise(resolve => setTimeout(resolve, 20)); }
  const app = new AppConfig(path.join(base, 'app.json'), { localRoot: local });await app.load();
  const project = app.active;const taskId = randomUUID();
  const task = { id: taskId, owner: 'mac', workspace: 'project', group: project.id + '~one', state: 'completed', steps: [] };
  service.scheduler.tasks.set(taskId, task);service.scheduler.store.put('tasks', taskId, task);
  const bridgeStore = new Store(path.join(bridgeDir, 'bridge.sqlite'));
  bridgeStore.put('received', taskId, { id: taskId, taskId, reply: 'private fixture receipt' });bridgeStore.close();
  for (const directory of [path.join(stateDir, 'logs', taskId), path.join(stateDir, 'worktrees', taskId), path.join(bridgeDir, 'chat-attachments', taskId), path.join(base, 'copies', taskId)]) {
    await fs.mkdir(directory, { recursive: true });await fs.writeFile(path.join(directory, 'data'), 'private fixture');
  }
  const control = frame => request(socket, { operation: 'project_delete', group: project.id, ...frame }, 15000);
  const result = await deleteProject({ project, projects: app.value.projects,
    preview: async () => ({ tasks: await control({ action: 'preview' }) }), confirm: async plan => { assert.equal(plan.tasks.tasks, 1);return true; },
    remote: plan => control({ action: 'delete', revision: plan.tasks.revision }),
    local: plan => control({ action: 'local', taskIds: plan.tasks.taskIds }),
    unregister: id => app.remove(id, { purged: true }) });
  assert.ok(result.deleted);assert.ok(!await exists(local));assert.ok(!await exists(repository));
  assert.ok(!await exists(path.join(stateDir, 'logs', taskId)));assert.ok(!await exists(path.join(bridgeDir, 'chat-attachments', taskId)));
  assert.ok(!await exists(path.join(base, 'copies', taskId)));assert.equal(service.scheduler.tasks.has(taskId), false);
  const checked = new Store(path.join(bridgeDir, 'bridge.sqlite'));
  assert.equal(checked.get('received', taskId), undefined);checked.close();
  assert.deepEqual(app.list().projects, []);assert.deepEqual(app.list().deletedProjects, [project.id]);
});
