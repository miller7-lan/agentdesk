const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

const adapters = (...names) => Object.fromEntries(names.map((name) => [name, { bin: name, env: {} }]));

async function folder(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-accept-'));
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

function verdict(value) {
  return '```json\n' + JSON.stringify({ verdict: value, summary: value + ' summary', findings: [] }) + '\n```';
}

function schedulerFor(dir, mirror, adapter, acceptance = { mode: 'auto' }) {
  return new Scheduler({
    config: {
      stateDir: dir, quota: false, acceptance,
      adapters: adapters('codex', 'claude', 'grok'),
      workspaces: { mac: { repository: mirror } },
    },
    store: new Store(':memory:'),
    files: { endpoint: {} },
    adapter,
  });
}

function writerTask(scheduler, head, prompt = 'change the fixture') {
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt });
  task.base = head;
  task.planRaw = JSON.stringify([{ id: 'edit', capability: 'implement', prompt: 'edit the fixture', dependsOn: [] }]);
  return task;
}

test('auto acceptance gates a writer task and apply accepts its verdict', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const prompts = [];
  let patch;
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt, cwd }) => {
    prompts.push([name, prompt]);
    if (name === 'claude') return { output: verdict('accept') };
    await fs.writeFile(path.join(cwd, 'README.md'), 'changed\n');
    return { output: 'edited' };
  });
  t.after(() => scheduler.store.close());
  scheduler.files.patch = async (...args) => {
    patch = args[4];
    return { applied: true };
  };
  const task = writerTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);

  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'patches_ready');
  assert.equal(task.acceptance.verdict, 'accept');
  assert.equal(task.acceptance.round, 1);
  assert.equal(task.steps.filter((step) => step.capability === 'accept').length, 1);
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'acceptance_started'));
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'acceptance_verdict:accept'));
  const acceptPrompt = prompts.find(([name, prompt]) => name === 'claude' && prompt.includes('accepting this task'))[1];
  assert.match(acceptPrompt, /Brief \(summaries only/);

  const applied = await scheduler.apply(task);
  assert.equal(applied.state, 'completed');
  assert.match(String(patch), /changed/);
});

test('auto acceptance is skipped for a small read-only task', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async () => ({ output: 'looked around' }));
  t.after(() => scheduler.store.close());
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'inspect' });
  task.base = head;
  task.planRaw = JSON.stringify([{ id: 'look', capability: 'scout', prompt: 'look', dependsOn: [] }]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'completed');
  assert.equal(task.acceptance, undefined);
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'acceptance_skipped'));
});

test('always mode accepts a read-only task too', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => ({ output: name === 'claude' ? verdict('accept') : 'looked around' }),
    { mode: 'always' });
  t.after(() => scheduler.store.close());
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'inspect' });
  task.base = head;
  task.planRaw = JSON.stringify([{ id: 'look', capability: 'scout', prompt: 'look', dependsOn: [] }]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'completed');
  assert.equal(task.acceptance.verdict, 'accept');
});

test('a rework runs in the writer worktree and replaces its patch before a new acceptance', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let acceptRound = 0;
  let patch;
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt, cwd }) => {
    if (name === 'claude') {
      acceptRound += 1;
      return { output: acceptRound === 1
        ? '```json\n' + JSON.stringify({ verdict: 'rework', summary: 'Use the newer wording',
          findings: [{ severity: 'major', file: 'README.md', line: 1, issue: 'Wording is stale', suggestion: 'Write version two' }] }) + '\n```'
        : verdict('accept') };
    }
    const text = prompt.includes('Address the acceptance findings') ? 'version two\n' : 'version one\n';
    await fs.writeFile(path.join(cwd, 'README.md'), text);
    return { output: 'edited' };
  });
  t.after(() => scheduler.store.close());
  scheduler.files.patch = async (...args) => {
    patch = args[4];
    return { applied: true };
  };
  const task = writerTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);

  assert.equal(task.state, 'needs_review');
  assert.equal(task.acceptance.verdict, 'accept');
  assert.equal(task.acceptance.round, 2);
  assert.equal(task.reworkRounds, 1);
  const edit = task.steps.find((step) => step.id === 'edit');
  const rework = task.steps.find((step) => step.id === 'rework-1');
  assert.equal(rework.state, 'completed');
  assert.equal(rework.reworkOf, 'edit');
  assert.equal(edit.supersededBy, 'rework-1');
  assert.deepEqual(task.steps.filter((step) => step.capability === 'accept').map((step) => step.id), ['accept-1', 'accept-2']);
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'acceptance_rework'));

  await scheduler.apply(task);
  assert.match(String(patch), /version two/);
  assert.doesNotMatch(String(patch), /version one/);
});

test('acceptance stops at maxRework and leaves the task for a person', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async ({ name, cwd }) => {
    if (name === 'claude') return { output: verdict('rework') };
    await fs.writeFile(path.join(cwd, 'README.md'), 'attempt\n');
    return { output: 'edited' };
  }, { mode: 'auto', maxRework: 1 });
  t.after(() => scheduler.store.close());
  const task = writerTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'acceptance_limit');
  assert.equal(task.reworkRounds, 1);
});

test('apply refuses a patch that the lead never accepted', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async () => ({ output: 'x' }));
  t.after(() => scheduler.store.close());
  const task = writerTask(scheduler, head);
  task.steps = [{ id: 'edit', role: 'codex', capability: 'implement', write: true, state: 'completed', attempts: 1,
    dependsOn: [], prompt: 'edit', paths: ['README.md'] }];
  task.state = 'needs_review';
  task.detail = 'patches_ready';
  await assert.rejects(scheduler.apply(task), /acceptance_required/);
});

test('a crash while awaiting acceptance resumes the queued acceptance step', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => ({ output: name === 'claude' ? verdict('accept') : 'edited' }));
  t.after(() => scheduler.store.close());
  const id = randomUUID();
  const task = {
    id, workspace: 'mac', owner: 'local', project: 'agentdesk', prompt: 'change', base: head,
    state: 'awaiting_acceptance', detail: 'acceptance_started', stage: 'awaiting_acceptance',
    steps: [
      { id: 'edit', role: 'codex', capability: 'implement', write: true, state: 'completed', attempts: 1,
        dependsOn: [], prompt: 'edit', paths: ['README.md'] },
      { id: 'accept-1', role: 'claude', capability: 'accept', write: false, usesBrief: true, state: 'queued',
        attempts: 0, dependsOn: ['edit'], prompt: 'You are the lead accepting this task.' },
    ],
  };
  scheduler.store.saveTask(task, { state: 'awaiting_acceptance', detail: 'acceptance_started' });
  scheduler.tasks.set(id, task);
  const recovered = new Scheduler({
    config: scheduler.config, store: scheduler.store, files: scheduler.files, adapter: scheduler.adapter,
  });
  const restored = recovered.tasks.get(id);
  assert.equal(restored.state, 'queued');
  assert.equal(restored.detail, 'recovered');
  await recovered.run(restored, new AbortController().signal);
  assert.equal(restored.acceptance.verdict, 'accept');
  assert.equal(restored.state, 'needs_review');
  assert.equal(restored.detail, 'patches_ready');
});

test('a planned accept step is the acceptance; no duplicate automatic round is added', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async ({ name, cwd }) => {
    if (name === 'claude') return { output: verdict('accept') };
    await fs.writeFile(path.join(cwd, 'README.md'), 'changed\n');
    return { output: 'edited' };
  });
  t.after(() => scheduler.store.close());
  const task = writerTask(scheduler, head);
  task.planRaw = JSON.stringify([
    { id: 'edit', capability: 'implement', prompt: 'edit the fixture', dependsOn: [] },
    { id: 'accept', capability: 'accept', prompt: 'accept the fixture', dependsOn: ['edit'] },
  ]);
  await scheduler.run(task, new AbortController().signal);

  assert.equal(task.acceptance.verdict, 'accept');
  assert.equal(task.acceptance.round, 1);
  assert.deepEqual(task.steps.filter((step) => step.capability === 'accept').map((step) => step.id), ['accept']);
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'patches_ready');
});

test('invalid acceptance settings are rejected', async (t) => {
  const { dir, mirror } = await repository(t);
  assert.throws(() => schedulerFor(dir, mirror, async () => ({ output: 'x' }), { mode: 'sure' }), /invalid_acceptance/);
  assert.throws(() => schedulerFor(dir, mirror, async () => ({ output: 'x' }), { mode: 'auto', maxRework: 9 }), /invalid_acceptance/);
});