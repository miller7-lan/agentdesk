const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

// Two people (bridges "alice" and "bob"), each with their own workspace.
function setup({ maxConcurrentTasks, projects, ownerCaps, now } = {}) {
  const store = new Store(':memory:');
  const config = {
    maxConcurrentTasks, sshBridges: ['alice', 'bob'], quota: false,
    workspaces: { a: { sshBridge: 'alice' }, b: { sshBridge: 'bob' } },
    adapters: { codex: { bin: 'codex', env: {} }, claude: { bin: 'claude', env: {} } },
    ...(projects && { projects }),
    ...(ownerCaps && { ownerCaps }),
  };
  const scheduler = new Scheduler({ config, store, files: {}, ...(now && { now }) });
  const started = [];
  const finish = new Map();
  // Stand-in for a whole task run: it starts, then waits until the test lets it finish.
  scheduler.run = (task) => {
    started.push(task.id);
    return new Promise((resolve) => finish.set(task.id, () => { task.state = 'completed'; resolve(); }));
  };
  return { store, scheduler, started, finish };
}

test('tasks from different people run in parallel and take turns fairly', async (t) => {
  const { store, scheduler, started, finish } = setup({ maxConcurrentTasks: 2 });
  t.after(() => store.close());
  const id = (name) => '00000000-0000-4000-8000-' + name.padStart(12, '0');
  // Everything is queued before the scheduler picks (as when tasks pile up behind a long one).
  scheduler.stopped = true;
  scheduler.submit(id('a1'), { workspace: 'a', prompt: 'alice 1' });
  scheduler.submit(id('a2'), { workspace: 'a', prompt: 'alice 2' });
  scheduler.submit(id('a3'), { workspace: 'a', prompt: 'alice 3' });
  scheduler.submit(id('b1'), { workspace: 'b', prompt: 'bob 1' });
  scheduler.stopped = false;
  scheduler.pump();
  // Two slots: Alice's oldest task, then Bob's, even though Alice queued more and earlier.
  assert.deepEqual(started, [id('a1'), id('b1')]);
  assert.equal(scheduler.tasks.get(id('b1')).owner, 'bob');
  finish.get(id('a1'))();
  await delay(10);
  assert.deepEqual(started, [id('a1'), id('b1'), id('a2')]);
  assert.deepEqual(scheduler.list().map((task) => task.owner).sort(), ['alice', 'alice', 'alice', 'bob']);
});

test('the default is two tasks at a time', async (t) => {
  const { store, scheduler, started } = setup();
  t.after(() => store.close());
  for (const n of [1, 2, 3]) scheduler.submit('00000000-0000-4000-8000-00000000000' + n, { workspace: 'a', prompt: 'x' + n });
  assert.equal(started.length, 2);
});

test('one process per CLI across tasks: a second Codex step waits for the first', async (t) => {
  const { store, scheduler } = setup();
  t.after(() => store.close());
  const task = { id: 't', state: 'running', steps: [] };
  const signal = new AbortController().signal;
  const first = await scheduler.acquireCli(task, { id: 'edit', role: 'codex' }, signal);
  let second = null;
  const waiting = scheduler.acquireCli(task, { id: 'edit2', role: 'codex' }, signal).then((release) => { second = release; });
  const claude = await scheduler.acquireCli(task, { id: 'review', role: 'claude' }, signal);   // other CLIs are not held up
  await delay(5);
  assert.equal(second, null);
  first();
  await waiting;
  assert.equal(typeof second, 'function');
  second();
  claude();
  // A step that is cancelled while waiting leaves the queue.
  const hold = await scheduler.acquireCli(task, { id: 'a', role: 'codex' }, signal);
  const controller = new AbortController();
  const cancelled = scheduler.acquireCli(task, { id: 'b', role: 'codex' }, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(cancelled, /cancelled/);
  hold();
  assert.equal(scheduler.cliBusy.get('codex'), 0);
});

test('one person reaching the daily cap does not block another person', (t) => {
  const { store, scheduler } = setup({
    ownerCaps: { default: { claude: 10, codex: 0 } },
    now: () => new Date(2026, 10, 17, 10, 0).getTime(),
  });
  t.after(() => store.close());
  scheduler.stopped = true;
  const id = (name) => '00000000-0000-4000-8000-' + name.padStart(12, '0');
  const alice = scheduler.submit(id('a1'), { workspace: 'a', prompt: 'alice' });
  const bob = scheduler.submit(id('b1'), { workspace: 'b', prompt: 'bob' });
  scheduler.tasks.set(id('prior'), {
    id: id('prior'), owner: 'alice', state: 'completed',
    metrics: { startedAt: new Date(2026, 10, 17, 9, 0).toISOString() },
    quota: { claude: { fiveHour: 10 } },
  });
  assert.equal(scheduler.pickForTask(alice, 'plan'), null);
  assert.equal(alice.ownerCapBlocked, true);
  assert.equal(scheduler.pickForTask(bob, 'plan'), 'claude');     // Bob's own daily allowance is untouched
  assert.equal(bob.ownerCapBlocked, undefined);
});

test('project members see a redacted status, cannot control another owner, and lose access when removed', (t) => {
  const { store, scheduler } = setup({
    projects: {
      shared: { members: ['alice', 'bob'], workspaces: { alice: 'a', bob: 'b' } },
      secret: { members: ['bob'], workspaces: { bob: 'b' } },
    },
  });
  t.after(() => store.close());
  scheduler.stopped = true;
  const id = (name) => '00000000-0000-4000-8000-' + name.padStart(12, '0');
  const status = (bridge, task) => scheduler.control({ kind: 'task.status', task_id: task.id, body: { operation: 'status' } }, bridge);
  const aliceTask = scheduler.submit(id('a1'), { workspace: 'a', prompt: 'alice private prompt', project: 'shared' });
  aliceTask.steps = [{
    id: 'edit', role: 'codex', capability: 'implement', state: 'completed', attempts: 1, dependsOn: [],
    prompt: 'private step prompt', output: 'raw private output', paths: ['src/alice-secret.js'],
    verdict: { verdict: 'pass', summary: 'fine', findings: [{ file: 'src/alice-secret.js' }] },
  }];
  aliceTask.base = 'deadbeef';
  aliceTask.container = { name: 'agentdesk-alice', image: 'codex:1', id: 'abc', memPeak: 123 };
  aliceTask.testResult = { code: 0, stdout: 'private test log', stderr: '' };
  aliceTask.acceptance = {
    verdict: 'accept', summary: 'looks right', round: 1, at: '2026-11-17T00:00:00.000Z',
    findings: [{ file: 'src/alice-secret.js', issue: 'private' }],
  };

  const view = status('ssh:bob', aliceTask);
  assert.equal(view.redacted, true);
  assert.equal(view.owner, 'alice');
  assert.equal(view.project, 'shared');
  assert.equal(view.prompt, undefined);
  assert.equal(view.workspace, undefined);
  assert.equal(view.base, undefined);
  assert.equal(view.steps[0].prompt, undefined);
  assert.equal(view.steps[0].output, undefined);
  assert.equal(view.steps[0].paths, undefined);
  assert.deepEqual(view.steps[0].verdict, { verdict: 'pass', summary: 'fine' });
  assert.deepEqual(view.acceptance, { verdict: 'accept', summary: 'looks right', round: 1, at: '2026-11-17T00:00:00.000Z' });
  assert.deepEqual(view.testResult, { code: 0 });
  assert.equal(view.container.memPeak, 123);
  assert.equal(status('ssh:alice', aliceTask).redacted, undefined);
  assert.equal(status('ssh:alice', aliceTask).workspace, 'a');
  assert.equal(status('ssh:alice', aliceTask).steps[0].output, 'raw private output');
  assert.equal(status('admin', aliceTask).workspace, 'a');

  assert.throws(() => scheduler.control({ kind: 'task.status', task_id: aliceTask.id, body: { operation: 'cancel' } }, 'ssh:bob'),
    /task_access_denied/);
  assert.throws(() => scheduler.control({ kind: 'task.status', task_id: aliceTask.id, body: { operation: 'apply' } }, 'ssh:bob'),
    /task_access_denied/);

  const bobTask = scheduler.submit(id('b1'), { workspace: 'b', prompt: 'bob shared', project: 'shared' });
  const bobSecret = scheduler.submit(id('b2'), { workspace: 'b', prompt: 'bob secret', project: 'secret' });
  assert.throws(() => status('ssh:alice', bobSecret), /unknown_task/);

  const projectTasks = scheduler.control({ kind: 'task.status', task_id: id('c1'), body: { operation: 'project_tasks' } }, 'ssh:alice');
  assert.deepEqual(projectTasks.map((task) => task.id).sort(), [aliceTask.id, bobTask.id].sort());
  assert.equal(projectTasks.find((task) => task.id === aliceTask.id).workspace, 'a');
  assert.equal(projectTasks.find((task) => task.id === bobTask.id).redacted, true);
  assert.throws(() => scheduler.control({ kind: 'task.status', task_id: id('c2'), body: { operation: 'project_tasks', project: 'secret' } }, 'ssh:alice'),
    /project_access_denied/);

  assert.throws(() => scheduler.submit(id('s1'), { workspace: 'a', prompt: 'not a member', project: 'secret' }),
    /project_access_denied/);
  scheduler.config.workspaces.c = { sshBridge: 'alice' };
  assert.throws(() => scheduler.submit(id('s2'), { workspace: 'c', prompt: 'wrong workspace', project: 'shared' }),
    /project_workspace_mismatch/);

  scheduler.config.projects.shared.members = ['bob'];
  assert.throws(() => status('ssh:alice', bobTask), /unknown_task/);
  assert.deepEqual(scheduler.control({ kind: 'task.status', task_id: id('c3'), body: { operation: 'project_tasks' } }, 'ssh:alice'), []);
});

test("one person's running task does not stop another person switching lines", async (t) => {
  const { store, scheduler } = setup();
  t.after(() => store.close());
  scheduler.config.relayBridges = { alice: true, bob: true };
  scheduler.submit('00000000-0000-4000-8000-0000000000a1', { workspace: 'a', prompt: 'alice' });
  assert.throws(() => scheduler.setRoute('relay', 'alice'), /operations_in_progress/);
  assert.deepEqual(scheduler.setRoute('relay', 'bob'), { route: 'relay', bridge: 'bob' });
});
