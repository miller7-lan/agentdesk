const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const Store = require('../orchestrator/store');
const { Router } = require('../orchestrator/routing');
const { Scheduler, parsePlan } = require('../orchestrator/scheduler');

const adapters = (...names) => Object.fromEntries(names.map((name) => [name, { bin: name, env: {} }]));

async function folder(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-scheduling-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function repository(t) {
  const dir = await folder(t);
  const workspace = path.join(dir, 'workspace');
  const mirror = path.join(dir, 'mirror.git');
  await fs.mkdir(workspace);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(workspace, 'init');
  await fs.writeFile(path.join(workspace, 'README.md'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'base');
  const head = git(workspace, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--bare', workspace, mirror);
  return { dir, head, mirror };
}

async function until(check) {
  for (let i = 0; i < 300; i++) {
    const value = check();
    if (value) return value;
    await wait(20);
  }
  assert.fail('timed out waiting for condition');
}

const PLAN = JSON.stringify([
  { id: 'edit', capability: 'implement', prompt: 'Change the fixture', dependsOn: [] },
]);

test('a blocked implementer keeps the task queued and resumes without planning again', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  const adapter = async ({ name }) => {
    calls.push(name);
    return { output: name === 'claude' ? PLAN : 'done' };
  };
  const config = {
    stateDir: dir, quota: false, maxConcurrentTasks: 1,
    adapters: adapters('codex', 'claude', 'grok'),
    workspaces: { mac: { repository: mirror } },
  };
  const scheduler = new Scheduler({ config, store, files: { endpoint: {} }, adapter });
  scheduler.router.block('codex', 'quota', 60_000);
  try {
    const id = randomUUID();
    const task = scheduler.submit(id, { workspace: 'mac', prompt: 'change the fixture' });
    task.base = head;
    scheduler.start(task);

    await until(() => task.state === 'queued' && task.detail === 'executor_waiting:implement');
    assert.equal(task.waitingFor, 'implement');
    assert.ok(task.notBefore > Date.now() + 30_000);
    assert.equal(task.planRaw, PLAN);
    assert.deepEqual(calls, ['claude']);     // planned once; the implement step never ran

    scheduler.router.blocked.clear();
    task.notBefore = Date.now() - 1;
    scheduler.start(task);
    await until(() => task.state === 'completed');

    assert.deepEqual(calls, ['claude', 'codex']);
    assert.equal(task.steps[0].role, 'codex');
    assert.equal(task.steps[0].state, 'completed');
    assert.equal(task.planRaw, undefined);
    assert.equal(task.waitingFor, undefined);
    assert.equal(task.notBefore, undefined);
  } finally {
    scheduler.stopped = true;
  }
});

test('Claude waiting does not hand acceptance or triage to another CLI', () => {
  const router = new Router({ adapters: adapters('codex', 'claude', 'grok') });
  router.block('claude', 'quota', 60_000);
  router.block('codex', 'quota', 60_000);
  for (const capability of ['accept', 'triage']) {
    assert.throws(() => parsePlan(JSON.stringify([
      { id: 'check', capability, prompt: 'judge', dependsOn: [] },
    ]), router.availableRoles(), router), new RegExp('executor_waiting:' + capability));
  }
  // Implementation waits for Codex even though Claude is configured and would be readable code-wise.
  assert.throws(() => parsePlan(JSON.stringify([
    { id: 'edit', capability: 'implement', prompt: 'change', dependsOn: [] },
  ]), router.availableRoles(), router), /executor_waiting:implement/);
});

test('a capability with no configured candidate fails instead of waiting forever', () => {
  const router = new Router({ adapters: adapters('grok') });
  assert.throws(() => parsePlan(JSON.stringify([
    { id: 'edit', capability: 'implement', prompt: 'change', dependsOn: [] },
  ]), router.availableRoles(), router), /no_executor:implement/);
});