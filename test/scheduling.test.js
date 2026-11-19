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
  scheduler.router.block('grok', 'quota', 60_000);   // every implementer in the step-down order is out
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

test('a planned step whose model was removed falls back to the role default', () => {
  const store = new Store(':memory:');
  const scheduler = new Scheduler({
    config: {
      adapters: { antigravity: { bin: 'agy', env: {},
        profiles: { defaultModel: 'new-model', models: { 'new-model': { billing: 'subscription' } } } } },
      workspaces: { mac: { repository: '/nonexistent' } },
    },
    store, files: {},
  });
  const task = {
    steps: [{ role: 'antigravity', model: 'old-model' }],
    groupPlan: { rounds: [{ steps: [{ role: 'antigravity', model: 'old-model' }] }] },
  };
  scheduler.refreshModels(task);
  assert.equal(task.steps[0].model, 'new-model');
  assert.equal(task.groupPlan.rounds[0].steps[0].model, 'new-model');
  store.close();
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

test('a task whose whole route is over the owner daily cap waits for local midnight once', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  let nowMs = new Date(2026, 10, 17, 10, 0).getTime();
  const calls = [];
  const scheduler = new Scheduler({
    config: {
      stateDir: dir, quota: false, maxConcurrentTasks: 1, acceptance: { mode: 'off' },
      ownerCaps: { default: { claude: 10, codex: 5 } },
      adapters: adapters('codex', 'claude', 'grok'),
      workspaces: { mac: { repository: mirror } },
    },
    store, files: { endpoint: { ssh: { ready: true } } },
    adapter: async ({ name }) => {
      calls.push(name);
      return { output: name === 'claude' ? PLAN : 'done' };
    },
    now: () => nowMs,
  });
  try {
    const prior = {
      id: randomUUID(), workspace: 'mac', owner: 'local', state: 'completed', detail: 'completed',
      metrics: { startedAt: new Date(nowMs).toISOString() },
      quota: { claude: { fiveHour: 10 }, codex: { fiveHour: 5 } },
    };
    scheduler.tasks.set(prior.id, prior);

    const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'change the fixture', project: 'agentdesk' });
    task.base = head;
    scheduler.start(task);
    await until(() => task.state === 'queued' && task.detail === 'owner_quota_cap' && !scheduler.running.has(task.id));

    assert.equal(task.waitingFor, 'plan');
    assert.equal(task.notBefore, new Date(2026, 10, 18, 0, 0).getTime());
    assert.deepEqual(calls, []);
    const events = () => scheduler.store.events(task.id).filter((event) => event.detail === 'owner_quota_cap');
    assert.equal(events().length, 1);
    assert.equal(events()[0].kind, 'waiting');
    assert.equal(events()[0].owner, 'local');
    assert.equal(events()[0].project, 'agentdesk');
    assert.deepEqual(events()[0].data, { capability: 'plan' });

    const report = scheduler.control({ kind: 'task.status', task_id: randomUUID(), body: { operation: 'report' } }, 'admin');
    assert.deepEqual(report.owners.local.usage, { claude: 10, codex: 5 });
    assert.deepEqual(report.owners.local.caps, { claude: 10, codex: 5 });

    // A retry on the same day keeps waiting and does not append another event.
    scheduler.start(task);
    await until(() => !scheduler.running.has(task.id));
    assert.equal(task.state, 'queued');
    assert.equal(task.detail, 'owner_quota_cap');
    assert.equal(events().length, 1);

    assert.equal(scheduler.nextTask(), undefined);
    nowMs = new Date(2026, 10, 17, 23, 59, 59).getTime();
    assert.equal(scheduler.nextTask(), undefined);
    nowMs = new Date(2026, 10, 18, 0, 0, 1).getTime();
    assert.equal(scheduler.nextTask(), task);

    scheduler.start(task);
    await until(() => task.state === 'completed' && !scheduler.running.has(task.id));
    assert.deepEqual(calls, ['claude', 'codex']);
    assert.equal(task.notBefore, undefined);
    assert.equal(task.waitingFor, undefined);
  } finally {
    scheduler.stopped = true;
  }
});

test('Claude waiting does not hand acceptance or triage to another CLI', () => {
  const router = new Router({ adapters: adapters('codex', 'claude', 'grok') });
  router.block('claude', 'quota', 60_000);
  router.block('codex', 'quota', 60_000);
  router.block('grok', 'quota', 60_000);
  for (const capability of ['accept', 'triage']) {
    assert.throws(() => parsePlan(JSON.stringify([
      { id: 'check', capability, prompt: 'judge', dependsOn: [] },
    ]), router.availableRoles(), router), new RegExp('executor_waiting:' + capability));
  }
  // With Codex and Grok Build both out, implementation waits rather than going to Claude.
  assert.throws(() => parsePlan(JSON.stringify([
    { id: 'edit', capability: 'implement', prompt: 'change', dependsOn: [] },
  ]), router.availableRoles(), router), /executor_waiting:implement/);
});

test('a capability with no configured candidate fails instead of waiting forever', () => {
  const router = new Router({ adapters: adapters('gemini') });   // Gemini is read-only in group work
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
  const verdictEvent = scheduler.store.events(task.id).find((event) => event.detail === 'review_verdict:review:pass');
  assert.equal(verdictEvent.kind, 'review');
  assert.equal(verdictEvent.stepId, 'review');
  assert.equal(verdictEvent.role, 'grok');
  assert.deepEqual(verdictEvent.data, { stepId: 'review', verdict: 'pass' });
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

test('a CLI print timeout continues the same session and records the continuation', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const prompts = [];
  const adapter = async ({ onSession, prompt, cwd }) => {
    prompts.push(prompt);
    onSession('session-1');
    if (prompts.length === 1) {
      throw new Error('cli_print_timeout: print timeout after 10m0s with the turn still in progress; the response is partial');
    }
    await fs.writeFile(path.join(cwd, 'README.md'), 'changed\n');
    return { output: 'done' };
  };
  const config = {
    stateDir: dir, quota: false, acceptance: { mode: 'off' },
    adapters: adapters('codex', 'claude', 'grok'),
    workspaces: { mac: { repository: mirror } },
  };
  const scheduler = new Scheduler({ config, store, files: { endpoint: {} }, adapter });
  const id = randomUUID();
  await fs.mkdir(path.join(dir, 'logs', id), { recursive: true });
  const step = { id: 'edit', role: 'codex', capability: 'implement', write: true, state: 'queued', attempts: 0, dependsOn: [], prompt: 'edit the fixture' };
  const task = { id, workspace: 'mac', owner: 'local', mode: 'normal', base: head, steps: [step] };
  scheduler.tasks.set(id, task);

  await scheduler.runStep(task, step, mirror, path.join(dir, 'worktrees', id), new AbortController().signal);
  assert.equal(step.state, 'completed');
  assert.equal(step.continuations, 1);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /continuation 1\/1/);
  assert.ok(scheduler.store.events(id).some((event) => event.detail === 'edit:continuing:1/1'));
  const budget = scheduler.cliBudget({ mode: 'normal' });
  assert.equal(budget.outer, 2700000);
  assert.equal(budget.print, 2640000);
  // A configured limit wins over the default, and an explicit print deadline stays inside the outer one.
  scheduler.config.cliTimeoutMs = 1800000;
  assert.deepEqual(scheduler.cliBudget({ mode: 'normal' }), { outer: 1800000, print: 1740000 });
  scheduler.config.printTimeoutMs = 2000000;
  assert.deepEqual(scheduler.cliBudget({ mode: 'normal' }), { outer: 1800000, print: 1795000 });
  delete scheduler.config.printTimeoutMs;
  delete scheduler.config.cliTimeoutMs;
});

test('an unresolved bridge write failure keeps the step from claiming completion', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const id = randomUUID();
  const adapter = async ({ cwd }) => {
    await fs.appendFile(path.join(dir, 'logs', id, 'edit.receipts.jsonl'), JSON.stringify({
      operation: 'write', root: 'computer', path: '/tmp/report.md', expectedVersion: 'old', ok: false, error: 'version_conflict',
    }) + '\n');
    await fs.writeFile(path.join(cwd, 'README.md'), 'changed\n');
    return { output: 'done' };
  };
  const config = {
    stateDir: dir, quota: false, acceptance: { mode: 'off' },
    adapters: adapters('codex', 'claude', 'grok'),
    workspaces: { mac: { repository: mirror } },
  };
  const scheduler = new Scheduler({ config, store, files: { endpoint: {} }, adapter });
  await fs.mkdir(path.join(dir, 'logs', id), { recursive: true });
  const step = { id: 'edit', role: 'codex', capability: 'implement', write: true, state: 'queued', attempts: 0, dependsOn: [], prompt: 'edit the fixture' };
  const task = { id, workspace: 'mac', owner: 'local', mode: 'normal', base: head, steps: [step] };
  scheduler.tasks.set(id, task);

  await assert.rejects(scheduler.runStep(task, step, mirror, path.join(dir, 'worktrees', id), new AbortController().signal),
    /write_failed:\/tmp\/report\.md/);
  assert.equal(step.state, 'failed');
  assert.equal(step.deliveries[0].ok, false);
  assert.equal(step.deliveries[0].expectedVersion, 'old');
});

test('maintenance drains queued work and survives a restart', async (t) => {
  const { dir, mirror } = await repository(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = {
    stateDir: dir, quota: false, acceptance: { mode: 'off' },
    adapters: adapters('codex', 'claude', 'grok'),
    workspaces: { mac: { repository: mirror } },
  };
  const scheduler = new Scheduler({ config, store, files: {}, adapter: async () => ({ output: 'x' }) });
  const id = randomUUID();
  const task = { id, workspace: 'mac', state: 'queued', steps: [], createdAt: new Date().toISOString() };
  scheduler.tasks.set(id, task);
  assert.equal(scheduler.nextTask()?.id, id);

  const status = scheduler.setMaintenance('on', 'deploy', 'test');
  assert.equal(status.enabled, true);
  assert.equal(status.queued, 1);
  assert.equal(status.ready, true);
  assert.equal(scheduler.nextTask(), undefined);

  const restarted = new Scheduler({ config, store, files: {}, adapter: async () => ({ output: 'x' }) });
  assert.equal(restarted.maintenance.reason, 'deploy');
  restarted.setMaintenance('off');
  restarted.tasks.set(id, task);
  assert.equal(restarted.nextTask()?.id, id);
});