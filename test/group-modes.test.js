const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { git } = require('../orchestrator/git');
const { WindowsOperations } = require('../orchestrator/windows');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const adapters = Object.fromEntries(['codex', 'claude', 'grok', 'gemini'].map((role) => [role, { bin: role, env: {} }]));
  const config = {
    adapters, quota: false, workspaces: { a: { sshBridge: 'alice' }, b: { sshBridge: 'bob' } },
    projects: { group: { members: ['alice', 'bob'], workspaces: { alice: 'a', bob: 'b' } } },
  };
  const scheduler = new Scheduler({ config, store, files: {} });
  scheduler.stopped = true;
  const control = (body, route = 'ssh:alice', id = randomUUID()) =>
    scheduler.control({ task_id: id, kind: 'task.status', body }, route);
  return { scheduler, store, control };
}

test('broadcasts are retryable, scoped, pinned and read-only', (t) => {
  const { scheduler, control } = setup(t);
  const id = randomUUID();
  const frame = { operation: 'broadcast', workspace: 'a', project: 'group', prompt: '查看文档' };
  const tasks = control(frame, 'ssh:alice', id);
  assert.deepEqual(tasks.map(({ provider }) => provider).sort(), ['codex', 'gemini', 'grok']);
  assert.ok(tasks.every(({ mode, broadcastId, plan }) => mode === 'chat' && broadcastId === id && !plan));
  assert.deepEqual(control(frame, 'ssh:alice', id).map(({ id }) => id), tasks.map(({ id }) => id));
  assert.throws(() => control({ ...frame, workspace: 'b' }), /workspace_not_authorized/);
  assert.throws(() => scheduler.submit(randomUUID(), { ...frame, mode: 'chat', command: 'build' }), /invalid_task/);
});

test('duo adds two fixed reviewers and uses the lead for acceptance', (t) => {
  const { scheduler } = setup(t);
  const task = scheduler.submit(randomUUID(), { workspace: 'a', mode: 'duo', prompt: '修复问题' });
  const steps = [{ id: 'write', role: 'codex', write: true, capability: 'implement' }];
  scheduler.addDuoReviews(task, steps);
  assert.deepEqual(steps.slice(1).map(({ role, dependsOn, write }) => [role, dependsOn, write]),
    [['grok', ['write'], false], ['gemini', ['write'], false]]);
  assert.equal(scheduler.acceptanceRequired(task), true);
  assert.equal(scheduler.pickForTask(task, 'accept'), 'claude');
});

test('team tasks drain active slots and run exclusively', (t) => {
  const { scheduler } = setup(t);
  const normal = scheduler.submit(randomUUID(), { workspace: 'a', prompt: '任务' });
  const team = scheduler.submit(randomUUID(), { workspace: 'b', mode: 'team', prompt: '组队' });
  assert.equal(team.slotCost, 2);
  scheduler.running.set(normal.id, {});
  assert.equal(scheduler.nextTask(), undefined);
  scheduler.running.delete(normal.id);
  assert.equal(scheduler.nextTask(), team);
  scheduler.running.set(team.id, {});
  assert.equal(scheduler.nextTask(), undefined);
});

test('project compaction omits private text and peer artifact access is denied', (t) => {
  const { scheduler, store, control } = setup(t);
  const id = randomUUID();
  scheduler.submit(id, { workspace: 'a', project: 'group', prompt: 'private prompt' });
  const brief = control({ operation: 'compact_project', project: 'group' });
  assert.equal(brief.taskCount, 1);
  assert.deepEqual(store.get('projectBriefs', 'group'), JSON.parse(JSON.stringify(brief)));
  assert.doesNotMatch(JSON.stringify(brief), /private prompt/);
  assert.throws(() => control({ operation: 'task_diff' }, 'ssh:bob', id), /task_access_denied/);
});

test('review snapshots include staged, unstaged and untracked changes while preserving the index', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentdesk-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  await git(root, ['init'], signal);
  await writeFile(path.join(root, 'tracked'), 'base\n');
  await git(root, ['add', '--all'], signal);
  await git(root, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'base'], signal);
  await writeFile(path.join(root, 'tracked'), 'staged\n');
  await git(root, ['add', 'tracked'], signal);
  await writeFile(path.join(root, 'tracked'), 'final\n');
  await writeFile(path.join(root, 'untracked'), 'new\n');
  const index = await git(root, ['diff', '--cached'], signal);
  const operations = Object.create(WindowsOperations.prototype);
  operations.config = {};
  const result = await operations.reviewDiff(root, signal);
  assert.match(result.patch, /\+final/);
  assert.match(result.patch, /\+new/);
  assert.equal(await git(root, ['diff', '--cached'], signal), index);
});
