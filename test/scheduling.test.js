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
    stateDir: dir, quota: false, maxConcurrentTasks: 1, acceptance: { mode: 'off' },
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

test('task metadata is validated and stored for reports and benchmarks', async (t) => {
  const { dir, mirror } = await repository(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const scheduler = new Scheduler({
    config: { stateDir: dir, quota: false, adapters: adapters('codex', 'claude'), workspaces: { mac: { repository: mirror } } },
    store, files: { endpoint: {} }, adapter: async () => ({ output: 'x' }),
  });
  const task = scheduler.submit(randomUUID(), {
    workspace: 'mac', prompt: 'change', project: 'agentdesk', tags: [' ui ', 'ui', 'tests'],
    benchmarkId: 'bench-1', arm: 'multi',
  });
  assert.equal(task.project, 'agentdesk');
  assert.deepEqual(task.tags, ['ui', 'tests']);
  assert.equal(task.benchmarkId, 'bench-1');
  assert.equal(task.arm, 'multi');
  assert.throws(() => scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
    /invalid_task/);
  assert.throws(() => scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'x', project: 'Bad Project' }), /invalid_task/);
  assert.throws(() => scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'x', arm: 'team' }), /invalid_task/);
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

function reviewFixture(t, adapter) {
  return repository(t).then(({ dir, head, mirror }) => {
    const store = new Store(':memory:');
    t.after(() => store.close());
    const scheduler = new Scheduler({
      config: {
        stateDir: dir, quota: false, maxConcurrentTasks: 1, acceptance: { mode: 'off' },
        adapters: adapters('codex', 'claude', 'grok'),
        workspaces: { mac: { repository: mirror } },
      },
      store, files: { endpoint: {} }, adapter,
    });
    const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'change the fixture' });
    task.base = head;
    task.planRaw = JSON.stringify([
      { id: 'edit', capability: 'implement', prompt: 'edit', dependsOn: [] },
      { id: 'review', capability: 'review', prompt: 'review', dependsOn: ['edit'] },
    ]);
    return { task, scheduler };
  });
}

test('a review sees the writer worktree and cannot claim the writer patch', async (t) => {
  let reviewSaw;
  const { task, scheduler } = await reviewFixture(t, async ({ name, cwd }) => {
    if (name === 'codex') {
      await fs.writeFile(path.join(cwd, 'README.md'), 'updated\n');
      return { output: 'edited' };
    }
    reviewSaw = await fs.readFile(path.join(cwd, 'README.md'), 'utf8');
    return { output: 'reviewed' };
  });
  await scheduler.run(task, new AbortController().signal);
  assert.equal(reviewSaw, 'updated\n');
  const review = task.steps.find((step) => step.id === 'review');
  assert.equal(review.state, 'completed');
  assert.equal(review.reviewedStep, 'edit');
  assert.deepEqual(review.paths, []);
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'patches_ready');
});

test('a review verdict is parsed, stored and recorded as an event', async (t) => {
  const { task, scheduler } = await reviewFixture(t, async ({ name, cwd }) => {
    if (name === 'codex') {
      await fs.writeFile(path.join(cwd, 'README.md'), 'updated\n');
      return { output: 'edited' };
    }
    return { output: 'All good.\n```json\n' + JSON.stringify({
      verdict: 'pass', summary: 'Small and correct',
      findings: [{ severity: 'nit', file: 'README.md', line: 1, issue: 'Wording', suggestion: 'Tighten it' }],
      tests: 'fixture only',
    }) + '\n```' };
  });
  await scheduler.run(task, new AbortController().signal);
  const review = task.steps.find((step) => step.id === 'review');
  assert.equal(review.verdict.verdict, 'pass');
  assert.equal(review.verdict.findings[0].severity, 'nit');
  assert.equal(task.reviews.review.verdict, 'pass');
  assert.equal(task.reviews.review.role, 'grok');
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'review_verdict:review:pass'));
});

test('a shared-worktree review that edits a writer file is rejected', async (t) => {
  const { task, scheduler } = await reviewFixture(t, async ({ name, cwd }) => {
    if (name === 'codex') {
      await fs.writeFile(path.join(cwd, 'README.md'), 'updated\n');
      return { output: 'edited' };
    }
    await fs.writeFile(path.join(cwd, 'README.md'), 'tampered\n');
    return { output: 'reviewed' };
  });
  await assert.rejects(scheduler.run(task, new AbortController().signal), /readonly_step_changed_files/);
  const review = task.steps.find((step) => step.id === 'review');
  assert.equal(review.state, 'failed');
  assert.equal(review.error, 'readonly_step_changed_files');
});

test('a review with two writer dependencies is ambiguous', async (t) => {
  const { task, scheduler } = await reviewFixture(t, async ({ name }) => ({ output: name === 'codex' ? 'edited' : 'reviewed' }));
  task.planRaw = JSON.stringify([
    { id: 'one', capability: 'implement', prompt: 'one', dependsOn: [] },
    { id: 'two', capability: 'implement', prompt: 'two', dependsOn: [] },
    { id: 'review', capability: 'review', prompt: 'review', dependsOn: ['one', 'two'] },
  ]);
  await assert.rejects(scheduler.run(task, new AbortController().signal), /ambiguous_review_target/);
  assert.equal(task.steps.find((step) => step.id === 'review').state, 'queued');
});