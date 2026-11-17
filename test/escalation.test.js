const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

// A real Git working tree for the step, so runStep can compute its patch.
function setup(t, adapter, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-esc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'edit');
  fs.mkdirSync(folder);
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: folder, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(folder, 'app.js'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = { workspaces: {}, quota: false, stateDir: root,
    adapters: { codex: { bin: 'codex', env: {} }, claude: { bin: 'claude', env: {} } }, ...extra };
  const scheduler = new Scheduler({ config, store, files: {}, adapter });
  scheduler.ensureWorktree = async () => {};
  const task = { id: 'task', prompt: 'Add retry to the webhook handler', state: 'running', base: git('rev-parse', 'HEAD'),
    steps: [{ id: 'edit', role: 'codex', capability: 'implement', write: true, prompt: 'Edit app.js', dependsOn: [], state: 'queued', attempts: 0 }] };
  scheduler.tasks.set(task.id, task);
  return { scheduler, task, step: task.steps[0], root, folder };
}

const fail = (message, output) => Object.assign(new Error(message), { output });

test('a failed code change goes back to Claude, who revises the instructions, and the second attempt succeeds', async (t) => {
  const calls = [];
  const adapter = async ({ name, prompt, cwd }) => {
    calls.push(name);
    if (name === 'claude') {
      const failure = JSON.parse(prompt.split('\n').at(-1));
      assert.equal(failure.error, 'cli_exit_1');
      assert.match(failure.output, /TypeError: retry is not a function/);
      assert.deepEqual(failure.changedFiles, ['app.js']);
      return { output: JSON.stringify({ decision: 'retry', prompt: 'Use setTimeout-based backoff instead of the retry helper', reason: 'the helper does not exist' }) };
    }
    fs.writeFileSync(path.join(cwd, 'app.js'), prompt.startsWith('Use setTimeout') ? 'fixed\n' : 'half done\n');
    if (!prompt.startsWith('Use setTimeout')) throw fail('cli_exit_1', 'TypeError: retry is not a function');
    return { output: 'done' };
  };
  const { scheduler, task, step, root } = setup(t, adapter);
  await scheduler.runStep(task, step, null, root, new AbortController().signal);
  assert.deepEqual(calls, ['codex', 'claude', 'codex']);
  assert.equal(step.state, 'completed');
  assert.deepEqual(step.paths, ['app.js']);
  assert.deepEqual(step.escalation, { by: 'claude', decision: 'retry', reason: 'the helper does not exist' });
  const details = scheduler.store.events('task').map((event) => event.detail);
  assert.ok(details.includes('edit:escalated:claude') && details.includes('edit:escalation:retry'));
});

test('when Claude says stop, the step fails with the reason recorded, and it is asked only once', async (t) => {
  const calls = [];
  const adapter = async ({ name }) => {
    calls.push(name);
    if (name === 'claude') return { output: '{"decision":"stop","reason":"需要先确认支付网关的接口文档"}' };
    throw fail('cli_exit_2', 'cannot resolve module');
  };
  const { scheduler, task, step, root } = setup(t, adapter);
  await assert.rejects(scheduler.runStep(task, step, null, root, new AbortController().signal), /cli_exit_2/);
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.equal(step.state, 'failed');
  assert.equal(step.escalation.reason, '需要先确认支付网关的接口文档');
});

test('no hand-back for read-only steps, quota failures, or when escalation is turned off', async (t) => {
  for (const [label, change, error, extra] of [
    ['read-only', (step) => { step.write = false; step.capability = 'review'; }, 'cli_exit_1', {}],
    ['quota', () => {}, 'cli_quota_exhausted', {}],
    ['disabled', () => {}, 'cli_exit_1', { escalation: false }],
  ]) {
    const calls = [];
    const { scheduler, task, step, root } = setup(t, async ({ name }) => { calls.push(name); throw fail(error, ''); }, extra);
    change(step);
    await assert.rejects(scheduler.runStep(task, step, null, root, new AbortController().signal), new RegExp(error));
    // (On a quota failure Claude may still be called, as the next implementer; that is routing, not a hand-back.)
    assert.equal(step.escalation, undefined, label + ': no hand-back');
    assert.ok(!scheduler.store.events('task').some((event) => /:escalated:/.test(event.detail)), label + ': no hand-back event');
    if (label !== 'quota') assert.deepEqual(calls, [step.role], label + ': only the executor ran');
  }
});
