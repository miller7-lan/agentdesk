const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

// Two people (bridges "alice" and "bob"), each with their own workspace.
function setup({ maxConcurrentTasks } = {}) {
  const store = new Store(':memory:');
  const config = {
    maxConcurrentTasks, sshBridges: ['alice', 'bob'], quota: false,
    workspaces: { a: { sshBridge: 'alice' }, b: { sshBridge: 'bob' } },
    adapters: { codex: { bin: 'codex', env: {} }, claude: { bin: 'claude', env: {} } },
  };
  const scheduler = new Scheduler({ config, store, files: {} });
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

test("one person's running task does not stop another person switching lines", async (t) => {
  const { store, scheduler } = setup();
  t.after(() => store.close());
  scheduler.config.relayBridges = { alice: true, bob: true };
  scheduler.submit('00000000-0000-4000-8000-0000000000a1', { workspace: 'a', prompt: 'alice' });
  assert.throws(() => scheduler.setRoute('relay', 'alice'), /operations_in_progress/);
  assert.deepEqual(scheduler.setRoute('relay', 'bob'), { route: 'relay', bridge: 'bob' });
});
