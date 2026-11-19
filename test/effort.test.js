const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// A stand-in CLI that answers in each CLI's output format with the arguments and effort it was given.
async function fakeCli(dir) {
  const file = path.join(dir, 'fake-cli.js');
  await fs.writeFile(file, `#!${process.execPath}
const report = JSON.stringify({ args: process.argv.slice(2), env: process.env.CLAUDE_CODE_EFFORT_LEVEL || null });
const kind = process.env.FAKE_KIND;
if (kind === 'claude') console.log(JSON.stringify({ type: 'result', result: report, session_id: 's' }));
else if (kind === 'codex') console.log(JSON.stringify({ type: 'item.completed', thread_id: 't', item: { type: 'agent_message', text: report } }));
else console.log(report);
`, { mode: 0o755 });
  return file;
}

test('each CLI gets the reasoning effort the way it accepts it, and unknown levels are dropped', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-effort-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = await fakeCli(dir);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file, args, options) => spawn(process.execPath, [file, ...args], options));
  const { runAdapter } = require('../orchestrator/adapters');
  const run = async (name, effort) => {
    const { output } = await runAdapter({ name, config: { bin, env: { FAKE_KIND: name, PATH: process.env.PATH } }, cwd: dir, prompt: 'p',
      readonly: true, timeout: 10000, signal: new AbortController().signal, log: path.join(dir, name + '.log'), onSession() {}, effort });
    return JSON.parse(output.trim().split('\n').at(-1));
  };
  const codex = await run('codex', 'high');
  assert.ok(codex.args.join(' ').includes('-c model_reasoning_effort="high"'));
  const claude = await run('claude', 'max');
  assert.equal(claude.env, 'max');                              // through the environment, which every version honours
  const grok = await run('grok', 'xhigh');
  assert.equal(grok.args[grok.args.indexOf('--effort') + 1], 'xhigh');
  const unknown = await run('grok', 'ultra');
  assert.ok(!unknown.args.includes('--effort'));                // never passed on
});

test('a model profile narrows the effort levels it accepts', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-model-effort-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = await fakeCli(dir);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file, args, options) => spawn(process.execPath, [file, ...args], options));
  const { runAdapter } = require('../orchestrator/adapters');
  const config = {
    bin, env: { PATH: process.env.PATH },
    template: { prompt: 'arg', output: 'plain', args: ['-p', '{prompt}'], modelArgs: ['--model', '{model}'],
      efforts: ['low', 'high'], effortArgs: ['--effort', '{effort}'] },
    // agy encodes the level in the model ID: the low model only accepts low.
    profiles: { models: { 'm-low': { efforts: ['low'], billing: 'subscription' }, 'm-high': { billing: 'subscription' } } },
  };
  const run = async (model, effort) => {
    const { output } = await runAdapter({ name: 'antigravity', config, cwd: dir, prompt: 'p', readonly: true,
      timeout: 10000, signal: new AbortController().signal, log: path.join(dir, 'model.log'), onSession() {}, model, effort });
    return JSON.parse(output.trim().split('\n').at(-1));
  };
  const narrowed = await run('m-low', 'high');
  assert.ok(!narrowed.args.includes('--effort'));                // conflicting level is dropped, not passed
  const declared = await run('m-low', 'low');
  assert.equal(declared.args[declared.args.indexOf('--effort') + 1], 'low');
  const fallback = await run('m-high', 'high');
  assert.equal(fallback.args[fallback.args.indexOf('--effort') + 1], 'high');   // model without efforts uses the role list
});

test('an exit code keeps the CLI line that explains it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bad-cli.js');
  await fs.writeFile(bin, `#!${process.execPath}
process.stderr.write('error: invalid model selection (--model "gemini-4-hydrogen" --effort "medium"): --effort is not supported for model "gemini-4-hydrogen"\\n');
process.exit(1);
`, { mode: 0o755 });
  const { runAdapter } = require('../orchestrator/adapters');
  await assert.rejects(runAdapter({ name: 'codex', config: { bin, env: { PATH: process.env.PATH } }, cwd: dir, prompt: 'p',
    readonly: true, timeout: 10000, signal: new AbortController().signal, log: path.join(dir, 'error.log'), onSession() {} }),
  (error) => {
    assert.match(error.message, /^cli_exit_1: error: invalid model selection/);
    return true;
  });
});

test('the lead runs on the model the person picked, else the newest Opus, never the CLI default', () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const models = { 'claude-haiku-5-5': {}, 'claude-opus-4-8': {}, 'claude-opus-5-5': {}, 'claude-sonnet-5-5': {} };
  const self = (extra = {}) => ({ config: { adapters: { claude: { profiles: { defaultModel: 'claude-haiku-5-5', models }, ...extra } } } });
  const pick = (context, task) => Scheduler.prototype.leadModelFor.call(context, task);
  assert.equal(pick(self(), {}), 'claude-opus-5-5');                                       // newest Opus beats a small default
  assert.equal(pick(self(), { leadModel: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');     // the person may pick any model
  assert.equal(pick(self(), { leadModel: 'claude-haiku-5-5' }), 'claude-haiku-5-5');
  assert.equal(pick(self({ leadModel: 'claude-sonnet-5-5' }), {}), 'claude-sonnet-5-5');   // configured lead model
  assert.equal(pick(self(), { leadModel: 'gone' }), 'claude-opus-5-5');                    // a retired choice falls back
});

test('a message while the lead\'s task is under way changes that task\'s plan, keeping the finished steps', () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const aborted = [];
  const saved = [];
  const self = {
    stepControllers: new Map([['t1:edit', { abort: (reason) => aborted.push('edit:' + reason.message) }]]),
    running: new Map([['t1', { abort: (reason) => aborted.push('task:' + reason.message) }]]),
    save(task, state, detail) { task.state = state; saved.push(detail); },
    pump() {}, status: (id) => ({ id }),
  };
  self.updatePlan = Scheduler.prototype.updatePlan.bind(self);
  self.approveRound = Scheduler.prototype.approveRound.bind(self);
  const task = { id: 't1', state: 'running', groupPlan: { approved: 1, rounds: [{ revision: 1, steps: [] }] },
    steps: [{ id: 'scout', state: 'completed', output: 'found it' }, { id: 'edit', state: 'running' }, { id: 'review', state: 'queued' }] };
  Scheduler.prototype.revisePlan.call(self, task, '别改数据库，只改接口');
  assert.equal(task.state, 'queued');
  assert.deepEqual(saved, ['plan_revise_requested']);
  assert.deepEqual(aborted, ['edit:revised', 'task:revised']);
  assert.equal(task.groupPlan.approved, undefined);
  assert.deepEqual(task.steps.map((step) => step.id), ['scout']);
  assert.equal(task.groupPlan.rounds[0].reply, '别改数据库，只改接口');
  // The lead's new plan reuses an id; approval keeps the finished step and renames the new one.
  task.groupPlan.rounds.push({ revision: 2, steps: [{ id: 'scout', state: 'queued', dependsOn: [] }, { id: 'api', state: 'queued', dependsOn: ['scout'] }] });
  task.state = 'awaiting_approval';
  Scheduler.prototype.updatePlan.call(self, task, { operation: 'plan_approve', revision: 2 });
  assert.deepEqual(task.steps.map((step) => [step.id, step.dependsOn || []]), [['scout', []], ['scout-2', []], ['api', ['scout-2']]]);
  // A finished task is not revised; a new message starts new work instead.
  task.state = 'completed';
  assert.throws(() => Scheduler.prototype.revisePlan.call(self, task, 'x'), /task_finished/);
});

test('a small plan starts by itself when the group allows it; bigger ones wait for the person', () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const auto = (approval, steps) => Scheduler.prototype.autoApproves.call({}, { approval }, steps);
  const read = (n) => Array.from({ length: n }, (_, i) => ({ id: 's' + i, write: false }));
  const write = (n) => Array.from({ length: n }, (_, i) => ({ id: 'w' + i, write: true }));
  assert.equal(auto(undefined, read(1)), false);            // a client that says nothing keeps confirming every plan
  assert.equal(auto('always', read(1)), false);
  assert.equal(auto('small', read(8)), true);               // changes no files
  assert.equal(auto('small', write(3)), true);              // at most three steps
  assert.equal(auto('small', [...write(2), ...read(2)]), false);
  assert.equal(auto('auto', write(9)), true);
});
