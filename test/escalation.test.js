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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-escalation-'));
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

function verdict(value, summary = value) {
  return '```json\n' + JSON.stringify({ verdict: value, summary, findings: [] }) + '\n```';
}

function decision(value, extra = {}) {
  return '```json\n' + JSON.stringify({ decision: value, reason: value + ' reason', instructions: 'do the next thing', steps: [], ...extra }) + '\n```';
}

function schedulerFor(dir, mirror, adapter, config = {}) {
  return new Scheduler({
    config: {
      stateDir: dir, quota: false,
      adapters: adapters('codex', 'claude', 'grok', 'gemini'),
      workspaces: { mac: { repository: mirror } },
      ...config,
    },
    store: new Store(':memory:'),
    files: { endpoint: {} },
    adapter,
  });
}

function readOnlyTask(scheduler, head, prompt = 'inspect the fixture') {
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt, command: 'smoke' });
  task.base = head;
  task.planRaw = JSON.stringify([{ id: 'look', capability: 'scout', prompt: 'look around', dependsOn: [] }]);
  return task;
}

test('two consecutive test failures trigger one triage and a retry can complete the task', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let tests = 0;
  let triagePrompts = 0;
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt }) => {
    if (name === 'claude') {
      assert.match(prompt, /Diagnose this escalation/);
      assert.match(prompt, /Brief \(summaries only/);
      triagePrompts += 1;
      return { output: decision('retry') };
    }
    return { output: 'looked around' };
  }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());
  scheduler.files.endpoint.request = async () => ({ code: ++tests === 3 ? 0 : 1, stdout: tests === 3 ? 'ok' : 'FAIL', stderr: '' });

  const task = readOnlyTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);

  assert.equal(task.state, 'completed');
  assert.equal(task.testFailures, 0);
  assert.equal(task.triageRounds, 1);
  assert.equal(triagePrompts, 1);
  assert.equal(tests, 3);
  assert.equal(task.steps.filter((step) => step.capability === 'triage').length, 1);
  assert.equal(task.metrics.accepted, true);
  assert.equal(task.metrics.firstPass, false);    // the retry after triage is not a first pass
  assert.equal(task.metrics.triageRounds, 1);
  assert.equal(task.metrics.roleCalls.gemini, 1);
  assert.equal(task.metrics.roleCalls.claude, 1);
  assert.ok(task.metrics.durationMs >= 0);
  const events = scheduler.store.events(task.id).map((event) => event.detail);
  assert.equal(events.filter((detail) => detail === 'triage_started').length, 1);
  assert.ok(events.includes('triage_decision:retry'));
  assert.ok(events.includes('test_failed:2'));
});

test('a review conflict asks the lead once and its rework replaces the writer patch', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let triageCalls = 0;
  const prompts = [];
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt, cwd }) => {
    if (name === 'claude') {
      triageCalls += 1;
      return { output: decision('rework', { steps: [{ capability: 'implement', prompt: 'Address the conflicting review feedback' }] }) };
    }
    if (name === 'codex') {
      await fs.writeFile(path.join(cwd, 'README.md'), prompt.includes('conflicting review feedback') ? 'version two\n' : 'version one\n');
      return { output: 'edited' };
    }
    prompts.push([name, prompt]);
    return { output: prompt.includes('review one') ? verdict('pass', 'looks fine') : verdict('rework', 'needs another pass') };
  }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());

  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'change the fixture' });
  task.base = head;
  task.planRaw = JSON.stringify([
    { id: 'edit', capability: 'implement', prompt: 'edit the fixture', dependsOn: [] },
    { id: 'review-one', capability: 'review', role: 'grok', prompt: 'review one', dependsOn: ['edit'] },
    { id: 'review-two', capability: 'review', role: 'gemini', prompt: 'review two', dependsOn: ['edit'] },
  ]);
  await scheduler.run(task, new AbortController().signal);

  assert.equal(triageCalls, 1);
  assert.equal(task.reviewConflicts, 1);
  assert.equal(task.triageRounds, 1);
  assert.equal(task.reworkRounds, 1);
  assert.equal(task.state, 'queued');
  assert.equal(task.detail, 'triage_rework');
  assert.equal(task.stage, 'reworking');
  assert.equal(task.escalation.decision.decision, 'rework');
  assert.equal(task.acceptance, undefined);
  const events = scheduler.store.events(task.id).map((event) => event.detail);
  assert.equal(events.filter((detail) => detail === 'review_conflict').length, 1);
  assert.equal(events.filter((detail) => detail === 'triage_started').length, 1);

  await scheduler.run(task, new AbortController().signal);
  const edit = task.steps.find((step) => step.id === 'edit');
  const fix = task.steps.find((step) => step.id === 'fix-1');
  assert.equal(fix.state, 'completed');
  assert.equal(fix.capability, 'implement');
  assert.equal(fix.reworkOf, 'edit');
  assert.equal(edit.supersededBy, 'fix-1');
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'patches_ready');
  assert.equal(task.steps.filter((step) => step.capability === 'accept').length, 0);
});

test('accept_with_risk keeps the result for a person and allows apply', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => ({
    output: name === 'claude' ? decision('accept_with_risk') : 'looked around',
  }), { acceptance: { mode: 'auto' } });
  t.after(() => scheduler.store.close());
  scheduler.files.endpoint.request = async () => ({ code: 1, stdout: 'FAIL', stderr: '' });

  const task = readOnlyTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'accepted_with_risk');
  assert.equal(task.acceptance.verdict, 'accept_with_risk');
  assert.equal(task.testFailures, 2);
  assert.equal(task.steps.filter((step) => step.capability === 'triage').length, 1);
});

test('a fail decision stops the task', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => ({
    output: name === 'claude' ? decision('fail') : 'looked around',
  }), { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());
  scheduler.files.endpoint.request = async () => ({ code: 1, stdout: 'FAIL', stderr: '' });

  const task = readOnlyTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'failed');
  assert.equal(task.detail, 'rejected_by_lead');
  assert.equal(task.triageRounds, 1);
});

test('a malformed triage reply is not treated as an instruction to retry', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => ({
    output: name === 'claude' ? 'I think you should probably try again.' : 'looked around',
  }), { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());
  scheduler.files.endpoint.request = async () => ({ code: 1, stdout: 'FAIL', stderr: '' });

  const task = readOnlyTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'triage_unparseable');
  assert.equal(task.escalation.decision.decision, 'unknown');
});

test('a blocked Claude makes triage wait instead of handing the decision to Codex', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const calls = [];
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => {
    calls.push(name);
    return { output: name === 'claude' ? decision('fail') : 'looked around' };
  }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());
  scheduler.files.endpoint.request = async () => ({ code: 1, stdout: 'FAIL', stderr: '' });
  const task = readOnlyTask(scheduler, head);
  scheduler.router.block('claude', 'quota', 60_000);
  await scheduler.run(task, new AbortController().signal);

  assert.equal(task.state, 'triaging');
  assert.equal(task.detail, 'triage_unavailable:quota');
  assert.equal(task.waitingFor, 'triage');
  assert.equal(task.waitingReason, 'quota');
  assert.ok(task.notBefore > Date.now());
  assert.deepEqual(calls, ['gemini']);
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'triage_unavailable:quota'));

  scheduler.router.blocked.clear();
  task.notBefore = Date.now() - 1;
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'failed');
  assert.equal(task.detail, 'rejected_by_lead');
  assert.deepEqual(calls, ['gemini', 'claude']);
});

test('one stage cannot start more than two triage rounds', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const scheduler = schedulerFor(dir, mirror, async () => ({ output: 'x' }), { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());
  const task = readOnlyTask(scheduler, head);
  task.escalation = { reason: 'test_failures', active: true };
  assert.equal(scheduler.beginTriage(task, 'test_failures'), false);
  assert.equal(task.state, 'queued');
  task.escalation = { reason: 'test_failures', active: false };
  task.triageRounds = 2;
  assert.equal(scheduler.beginTriage(task, 'test_failures'), false);
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'triage_limit');
});

test('a triage interrupted before its decision is recovered and processed after restart', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const id = randomUUID();
  const task = {
    id, workspace: 'mac', owner: 'local', project: 'agentdesk', prompt: 'inspect', base: head,
    state: 'triaging', detail: 'triage_started', stage: 'triaging',
    testFailures: 2, lastTestFailure: 'windows_test_failed', triageRounds: 0,
    escalation: { reason: 'test_failures', applied: false, active: true, requestedAt: new Date().toISOString(), stepId: 'triage-1' },
    steps: [
      { id: 'look', role: 'gemini', capability: 'scout', write: false, state: 'completed', attempts: 1,
        dependsOn: [], prompt: 'look', output: 'seen' },
      { id: 'triage-1', role: 'claude', capability: 'triage', write: false, usesBrief: true, state: 'queued',
        attempts: 0, dependsOn: [], prompt: 'Diagnose this escalation and choose exactly one next action.' },
    ],
  };
  store.saveTask(task, { state: 'triaging', detail: 'triage_started' });
  const scheduler = new Scheduler({
    config: {
      stateDir: dir, quota: false, acceptance: { mode: 'off' },
      adapters: adapters('codex', 'claude', 'grok', 'gemini'),
      workspaces: { mac: { repository: mirror } },
    },
    store, files: { endpoint: {} },
    adapter: async ({ name }) => ({ output: name === 'claude' ? decision('fail') : 'x' }),
  });
  const restored = scheduler.tasks.get(id);
  assert.equal(restored.state, 'queued');
  assert.equal(restored.detail, 'recovered');
  await scheduler.run(restored, new AbortController().signal);
  assert.equal(restored.state, 'failed');
  assert.equal(restored.detail, 'rejected_by_lead');
  assert.equal(restored.triageRounds, 1);
  assert.equal(restored.steps.filter((step) => step.capability === 'triage').length, 1);
});

test('a risk acceptance permits a manual apply', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let patch;
  const scheduler = schedulerFor(dir, mirror, async () => ({ output: 'x' }), { acceptance: { mode: 'auto' } });
  t.after(() => scheduler.store.close());
  scheduler.files.patch = async (...args) => { patch = args[4]; return { applied: true }; };
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'change' });
  task.base = head;
  task.state = 'needs_review';
  task.detail = 'accepted_with_risk';
  task.stage = 'accepted';
  task.acceptance = { verdict: 'accept_with_risk', round: 1, stepId: 'triage-1', summary: 'tests fail', findings: [], at: new Date().toISOString() };
  task.steps = [{
    id: 'edit', role: 'codex', capability: 'implement', write: true, state: 'completed', attempts: 1,
    dependsOn: [], prompt: 'edit', paths: ['README.md'],
  }];
  const patchDir = path.join(dir, 'worktrees', task.id);
  await fs.mkdir(patchDir, { recursive: true });
  await fs.writeFile(path.join(patchDir, 'edit.patch'), 'diff --git a/README.md b/README.md\n');

  const applied = await scheduler.apply(task);
  assert.equal(applied.state, 'completed');
  assert.match(String(patch), /diff --git/);
});

test('a test failure after apply triages but never rewrites already applied patches', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let patchApplied = false;
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => {
    if (name === 'claude') return { output: decision('rework', { steps: [{ capability: 'implement', prompt: 'rewrite' }] }) };
    throw new Error('unexpected_implementer_call');
  }, { acceptance: { mode: 'auto' } });
  t.after(() => scheduler.store.close());
  scheduler.files.patch = async () => { patchApplied = true; return { applied: true }; };
  scheduler.files.endpoint.request = async () => ({ code: 1, stdout: 'FAIL', stderr: '' });

  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'change', command: 'smoke' });
  task.base = head;
  task.state = 'needs_review';
  task.detail = 'patches_ready';
  task.stage = 'accepted';
  task.acceptance = { verdict: 'accept', round: 1, stepId: 'accept-1', summary: 'ok', findings: [], at: new Date().toISOString() };
  task.steps = [{
    id: 'edit', role: 'codex', capability: 'implement', write: true, state: 'completed', attempts: 1,
    dependsOn: [], prompt: 'edit', paths: ['README.md'],
  }];
  const patchDir = path.join(dir, 'worktrees', task.id);
  await fs.mkdir(patchDir, { recursive: true });
  await fs.writeFile(path.join(patchDir, 'edit.patch'), 'diff --git a/README.md b/README.md\n');

  const result = await scheduler.apply(task);
  assert.equal(patchApplied, true);
  assert.equal(result.state, 'queued');
  assert.equal(result.detail, 'triage_pending');
  assert.equal(task.pendingTriage.reason, 'test_failures');
  assert.equal(task.pendingTriage.applied, true);

  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'rework_after_apply');
  assert.equal(task.triageRounds, 1);
  assert.equal(task.steps.filter((step) => step.id.startsWith('fix-')).length, 0);
  assert.equal(task.steps.find((step) => step.id === 'edit').supersededBy, undefined);
});
function failingScoutTask(scheduler, head, extra = []) {
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'inspect the fixture' });
  task.base = head;
  task.planRaw = JSON.stringify([{ id: 'look', capability: 'scout', prompt: 'look around', dependsOn: [] }, ...extra]);
  return task;
}

test('a failed step goes back to the lead, who reassigns it to another member', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const calls = [];
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt }) => {
    calls.push(name);
    if (name === 'claude') {
      assert.match(prompt, /step_failed/);
      return { output: decision('retry', { executor: 'grok' }) };
    }
    if (name === 'gemini') throw new Error('cli_exit_1');
    return { output: 'looked around' };
  }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());

  const task = failingScoutTask(scheduler, head);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'queued');
  assert.equal(task.detail, 'triage_retry');
  assert.equal(task.reassignRounds, 1);
  assert.equal(task.triageRounds || 0, 0);   // reassignments do not use up the test and review triage rounds
  const look = task.steps.find((step) => step.id === 'look');
  assert.equal(look.role, 'grok');
  assert.deepEqual(look.failedRoles, ['gemini']);

  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'completed');
  const events = scheduler.store.events(task.id).map((event) => event.detail);
  assert.ok(events.includes('step_failed:look:gemini'));
  assert.ok(events.includes('reassign_started:look:1/3'));
  assert.ok(events.includes('look:reassigned_by_lead:gemini->grok'));
});

test('each step is handed back to the lead at most three times, then the task fails', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let leadCalls = 0;
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => {
    if (name === 'claude') {
      leadCalls += 1;
      return { output: decision('retry') };
    }
    throw new Error('cli_exit_1');
  }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());

  const task = failingScoutTask(scheduler, head);
  for (let run = 0; run < 4; run += 1) {
    await scheduler.run(task, new AbortController().signal).catch((error) => scheduler.save(task, 'failed', error.message));
  }
  assert.equal(leadCalls, 3);
  assert.equal(task.steps.find((step) => step.id === 'look').reassigns, 3);
  assert.equal(task.state, 'failed');
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'reassign_limit:look'));
});

test('a lead rework replaces the failed step and its dependents wait for the replacement', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const prompts = [];
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt }) => {
    if (name === 'claude') {
      return { output: decision('rework', { steps: [{ capability: 'scout', prompt: 'look somewhere else', executor: 'grok' }] }) };
    }
    prompts.push([name, prompt]);
    if (prompt.startsWith('look around')) throw new Error('cli_exit_1');
    return { output: 'done: ' + prompt.slice(0, 20) };
  }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());

  const task = failingScoutTask(scheduler, head, [{ id: 'after', capability: 'scout', prompt: 'summarize findings', dependsOn: ['look'] }]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.detail, 'triage_rework');
  const look = task.steps.find((step) => step.id === 'look');
  assert.equal(look.state, 'replaced');
  const fix = task.steps.find((step) => step.id === look.replacedBy);
  assert.equal(fix.role, 'grok');
  assert.deepEqual(task.steps.find((step) => step.id === 'after').dependsOn, [fix.id]);

  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'completed');
  assert.ok(prompts.some(([, prompt]) => prompt.startsWith('look somewhere else')));
  assert.ok(prompts.some(([, prompt]) => prompt.startsWith('summarize findings')));
});

test('each step has its own three reassignments, and the lead can switch model without switching member', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const seen = [];
  const config = adapters('codex', 'claude', 'grok', 'gemini');
  config.grok.profiles = { defaultModel: 'grok-fast', models: { 'grok-fast': {}, 'grok-heavy': {} } };
  let failFirst = 2;
  let failSecond = 2;
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt, model }) => {
    if (name === 'claude') return { output: decision('retry', { executor: 'grok', model: 'grok-heavy' }) };
    seen.push([prompt.slice(0, 12), name, model]);
    if (prompt.startsWith('first') && failFirst-- > 0) throw new Error('cli_exit_1');
    if (prompt.startsWith('second') && failSecond-- > 0) throw new Error('cli_exit_1');
    return { output: 'ok' };
  }, { acceptance: { mode: 'off' }, adapters: config });
  t.after(() => scheduler.store.close());

  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'two stages' });
  task.base = head;
  task.planRaw = JSON.stringify([
    { id: 'one', capability: 'scout', prompt: 'first stage', dependsOn: [] },
    { id: 'two', capability: 'scout', prompt: 'second stage', dependsOn: ['one'] },
  ]);
  for (let run = 0; run < 6 && task.state !== 'completed'; run += 1) await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'completed');
  // Four handbacks in all, two per stage: more than three per task, within three per stage.
  assert.equal(task.reassignRounds, 4);
  assert.deepEqual(task.steps.filter((step) => ['one', 'two'].includes(step.id)).map((step) => step.reassigns), [2, 2]);
  const one = task.steps.find((step) => step.id === 'one');
  assert.equal(one.role, 'grok');
  assert.equal(one.model, 'grok-heavy');
  assert.deepEqual(one.history.map((entry) => entry.role), ['gemini', 'grok']);
  const events = scheduler.store.events(task.id).map((event) => event.detail);
  assert.ok(events.includes('one:reassigned_by_lead:gemini->grok/grok-heavy'));
  assert.ok(seen.some(([, name, model]) => name === 'grok' && model === 'grok-heavy'));
});

test('a task stops at its budget and waits for the person instead of failing or reassigning', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let calls = 0;
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => {
    calls += 1;
    if (name === 'claude') return { output: decision('retry') };
    return { output: 'looked', usage: { input_tokens: 600, output_tokens: 500, cached_input_tokens: 99999 } };
  }, { acceptance: { mode: 'off' }, taskBudget: { steps: 10, tokens: 2000 } });
  t.after(() => scheduler.store.close());

  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'three looks' });
  task.base = head;
  task.planRaw = JSON.stringify([
    { id: 'one', capability: 'scout', prompt: 'first', dependsOn: [] },
    { id: 'two', capability: 'scout', prompt: 'second', dependsOn: ['one'] },
    { id: 'three', capability: 'scout', prompt: 'third', dependsOn: ['two'] },
  ]);
  scheduler.start(task);
  await new Promise((resolve) => { const wait = () => scheduler.running.has(task.id) ? setTimeout(wait, 20) : resolve(); wait(); });
  assert.equal(task.state, 'needs_review');
  assert.equal(task.detail, 'budget_exceeded:tokens');
  assert.equal(calls, 2);                                  // 2 × 1100 tokens passes 2000; cached reads do not count
  assert.equal(task.steps.find((step) => step.id === 'three').state, 'queued');
  assert.equal(task.budget.used.tokens, 2200);
  assert.equal(task.reassignRounds, undefined);
});

test('the person can rank the members of a capability; the order only ranks members the routes allow', async (t) => {
  const { dir, head, mirror } = await repository(t);
  const used = [];
  const scheduler = schedulerFor(dir, mirror, async ({ name }) => { used.push(name); return { output: 'ok' }; }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());
  assert.deepEqual(scheduler.router.routes.scout.filter((role) => scheduler.router.configured(role)), ['gemini', 'grok']);

  assert.throws(() => scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'x', routeOrder: { implement: ['claude'] } }), /invalid/);
  assert.throws(() => scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'x', routeOrder: { plan: ['codex'] } }), /invalid/);
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'look', routeOrder: { scout: ['grok', 'gemini'] } });
  task.base = head;
  task.planRaw = JSON.stringify([{ id: 'look', capability: 'scout', prompt: 'look around', dependsOn: [] }]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'completed');
  assert.equal(task.steps[0].role, 'grok');      // the routes would have picked gemini first
  assert.deepEqual(used, ['grok']);
});

test('a step whose member is busy moves to an idle member of the same kind of work, unless that member was chosen', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let release;
  const holding = new Promise((resolve) => { release = resolve; });
  const used = [];
  const scheduler = schedulerFor(dir, mirror, async ({ name, prompt }) => {
    used.push([prompt.slice(0, 6), name]);
    if (prompt.startsWith('first')) await holding;     // gemini stays busy with the first step
    return { output: 'ok' };
  }, { acceptance: { mode: 'off' } });
  t.after(() => scheduler.store.close());

  // Two independent scout steps: both prefer gemini; the second moves to grok instead of waiting.
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'two looks' });
  task.base = head;
  task.planRaw = JSON.stringify([
    { id: 'one', capability: 'scout', prompt: 'first look', dependsOn: [] },
    { id: 'two', capability: 'scout', prompt: 'second look', dependsOn: [] },
  ]);
  const running = scheduler.run(task, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(used.map(([, name]) => name).sort(), ['gemini', 'grok']);
  release();
  await running;
  assert.equal(task.state, 'completed');
  assert.ok(scheduler.store.events(task.id).some((event) => event.detail === 'two:reassigned:gemini->grok:busy'));

  // A member the lead named is waited for.
  used.length = 0;
  let releaseNamed;
  const holdingNamed = new Promise((resolve) => { releaseNamed = resolve; });
  scheduler.adapter = async ({ name, prompt }) => { used.push([prompt.slice(0, 6), name]); if (prompt.startsWith('first')) await holdingNamed; return { output: 'ok' }; };
  const named = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'named' });
  named.base = head;
  named.planRaw = JSON.stringify([
    { id: 'one', capability: 'scout', prompt: 'first look', dependsOn: [] },
    { id: 'two', capability: 'scout', role: 'gemini', prompt: 'second look', dependsOn: [] },
  ]);
  const second = scheduler.run(named, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(used.map(([, name]) => name), ['gemini']);   // the named step waits for gemini
  releaseNamed();
  await second;
  assert.deepEqual(used.map(([, name]) => name), ['gemini', 'gemini']);
});

test('the status says what a running step is doing and what a queued step waits for', async (t) => {
  const { dir, head, mirror } = await repository(t);
  let release;
  const holding = new Promise((resolve) => { release = resolve; });
  const scheduler = schedulerFor(dir, mirror, async () => { await holding; return { output: 'ok' }; },
    { acceptance: { mode: 'off' }, routing: { scout: ['gemini'] } });
  t.after(() => scheduler.store.close());
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'two looks' });
  task.base = head;
  task.planRaw = JSON.stringify([
    { id: 'one', capability: 'scout', prompt: 'first look', dependsOn: [] },
    { id: 'two', capability: 'scout', prompt: 'second look', dependsOn: ['one'] },
  ]);
  const other = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'another task' });
  other.base = head;
  other.planRaw = JSON.stringify([{ id: 'x', capability: 'scout', prompt: 'other look', dependsOn: [] }]);
  const first = scheduler.run(task, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = scheduler.run(other, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const running = scheduler.status(task.id).live.steps[0];
  assert.equal(running.state, 'running');
  assert.equal(running.role, 'gemini');
  assert.ok(running.startedAt);
  const waiting = scheduler.status(other.id).live.steps[0];
  assert.equal(waiting.state, 'waiting_member');
  assert.equal(waiting.holder.taskId, task.id);
  assert.equal(waiting.holder.prompt, 'two looks');
  release();
  await Promise.all([first, second]);
  assert.equal(scheduler.status(task.id).live, undefined);   // finished tasks carry no live line
});
