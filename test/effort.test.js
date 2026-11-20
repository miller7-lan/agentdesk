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
  const S = Scheduler.prototype;
  const pick = (context, task) => Scheduler.prototype.leadModelFor.call({ ...context, orderModels: S.orderModels, orderEntries: S.orderEntries }, task);
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
    running: new Map(),   // nothing of this task is at work right now (e.g. between stages): the rest is planned again
    save(task, state, detail) { task.state = state; saved.push(detail); },
    pump() {}, status: (id) => ({ id }), isAcceptStep: () => false,
  };
  self.updatePlan = Scheduler.prototype.updatePlan.bind(self);
  self.approveRound = Scheduler.prototype.approveRound.bind(self);
  const task = { id: 't1', state: 'queued', groupPlan: { approved: 1, rounds: [{ revision: 1, steps: [] }] },
    steps: [{ id: 'scout', state: 'completed', output: 'found it' }, { id: 'edit', state: 'running' }, { id: 'review', state: 'queued' }] };
  Scheduler.prototype.revisePlan.call(self, task, '别改数据库，只改接口');
  assert.equal(task.state, 'queued');
  assert.deepEqual(saved, ['plan_revise_requested']);
  assert.deepEqual(aborted, ['edit:revised']);
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

test('while members work, the lead decides per step: continue, guide with the work kept, stop, or add steps', async () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const S = Scheduler.prototype;
  const events = [];
  const aborted = [];
  const reply = { summary: '只改接口', steps: { edit: { action: 'guide', guidance: '只改 client.js' }, docs: { action: 'continue' }, review: { action: 'stop' } },
    add: [{ id: 'api', capability: 'implement', prompt: '改接口签名', dependsOn: ['edit'] }] };
  const routes = { implement: ['codex'], triage: ['claude'], review: ['grok'], research: ['grok'] };
  const self = {
    config: { stateDir: require('node:os').tmpdir(), adapters: { claude: { profiles: { models: { 'claude-opus-5-5': {} } } }, codex: { profiles: { defaultModel: 'gpt-5.5', models: { 'gpt-5.5': {} } } }, grok: {} } },
    router: { routes, quotaAllows: () => true, canWrite: () => true, available: () => true, pick: () => 'codex' },
    running: new Map([['t2', new AbortController()]]),
    stepControllers: new Map([['t2:edit', { abort: (r) => aborted.push('edit:' + r.message) }], ['t2:review', { abort: (r) => aborted.push('review:' + r.message) }]]),
    now: () => Date.now(), save(task, state, detail) { task.state = state; events.push(detail); }, status: (id) => ({ id }), pump() {},
    pickForTask: (task, capability) => routes[capability]?.[0], availableRoles: () => ['claude', 'codex', 'grok'], ordered: (t, n, list) => list,
    ownerAllows: () => ({ allowed: true }), isAcceptStep: () => false,
    execute: async () => ({ output: JSON.stringify(reply) }),
  };
  for (const name of ['decideRevision', 'resolveModel', 'reviseFallback', 'steerStep', 'leadModelFor', 'autoApproves', 'approveAddition', 'revisePlan', 'updatePlan', 'orderModels', 'orderEntries', 'defaultModelFor']) self[name] = S[name].bind(self);
  const task = { id: 't2', state: 'running', approval: 'always', prompt: '修登录', groupPlan: { approved: 1, rounds: [{ revision: 1, summary: 's', steps: [] }] },
    steps: [{ id: 'scout', role: 'grok', state: 'completed', dependsOn: [] }, { id: 'edit', role: 'codex', state: 'running', dependsOn: ['scout'] },
      { id: 'docs', role: 'grok', state: 'running', dependsOn: ['scout'] }, { id: 'review', role: 'grok', state: 'queued', dependsOn: ['edit'] }] };
  self.revisePlan(task, '别改数据库，只改接口');
  assert.equal(task.revisions[0].state, 'deciding');
  for (let i = 0; i < 50 && task.revisions[0].state === 'deciding'; i += 1) await new Promise((r) => setTimeout(r, 5));
  const step = (id) => task.steps.find((s) => s.id === id);
  assert.deepEqual(aborted, ['edit:steered']);                         // guided: same session, work kept
  assert.equal(step('edit').guidance.at(-1).text, '只改 client.js');
  assert.equal(step('docs').state, 'running');                         // unaffected
  assert.equal(step('review').state, 'skipped');                       // stopped before it started
  assert.equal(step('api').state, 'proposed');                         // added; this group confirms every plan
  assert.deepEqual(step('api').dependsOn, ['edit']);
  assert.equal(step('api').model, 'gpt-5.5');
  assert.deepEqual([task.revisions[0].guided, task.revisions[0].stopped, task.revisions[0].added], [['edit'], ['review'], ['api']]);
  self.approveAddition(task);
  assert.equal(step('api').state, 'queued');
  // An unusable reply from the lead: every member at work gets the message as guidance instead.
  self.execute = async () => ({ output: 'not json' });
  self.revisePlan(task, '再加个日志');
  for (let i = 0; i < 50 && task.revisions.at(-1).state === 'deciding'; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(task.revisions.at(-1).state, 'fallback');
  assert.equal(step('docs').guidance.at(-1).text, '再加个日志');
});

test('the lead gets exact model ids when it revises, changes a queued model in place, and understands "4hy"', async () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const S = Scheduler.prototype;
  let prompt = '';
  const reply = { summary: 'ok', steps: {
    edit: { action: 'continue', model: 'gemini 4 hy' },
    docs: { action: 'continue', model: 'gemini 4 hy' },
  }, add: [
    { id: 'a', capability: 'implement', prompt: 'x', model: 'Gemini 4 Hydrogen (High)' },
    { id: 'b', capability: 'implement', prompt: 'y', model: '4hydragon' },
    { id: 'c', capability: 'implement', prompt: 'z', model: 'not-a-model' },
  ] };
  const routes = { implement: ['antigravity'], triage: ['antigravity'] };
  const self = {
    config: { stateDir: require('node:os').tmpdir(), adapters: { antigravity: { profiles: { defaultModel: 'gemini-4-neon-high', models: {
      'gemini-4-hydrogen-high': { label: 'Gemini 4 Hydrogen (High)', strengths: 'x', billing: 'subscription' },
      'gemini-4-neon-high': { label: 'Gemini 4 Neon (High)', strengths: 'x', billing: 'subscription' } } } } } },
    router: { routes, quotaAllows: () => true, canWrite: () => true, available: () => true, pick: () => 'antigravity' },
    running: new Map(), stepControllers: new Map(), now: () => Date.now(),
    save() {}, status: (id) => ({ id }), pump() {},
    pickForTask: () => 'antigravity', availableRoles: () => ['antigravity'], ordered: (t, n, list) => list,
    ownerAllows: () => ({ allowed: true }), isAcceptStep: () => false,
    execute: async (task, step, cwd, signal, text) => { prompt = text; return { output: JSON.stringify(reply) }; },
  };
  for (const name of ['decideRevision', 'resolveModel', 'leadModelFor', 'autoApproves', 'approveAddition', 'orderModels', 'orderEntries', 'defaultModelFor']) self[name] = S[name].bind(self);
  const task = { id: 't3', state: 'running', approval: 'auto', prompt: 'p', groupPlan: { rounds: [] },
    steps: [
      { id: 'edit', role: 'antigravity', capability: 'implement', state: 'queued', dependsOn: [], model: 'gemini-4-neon-high' },
      { id: 'docs', role: 'antigravity', capability: 'implement', state: 'running', dependsOn: [], model: 'gemini-4-neon-high' },
    ],
    revisions: [{ text: '用 hydrogen', state: 'deciding' }] };
  await S.decideRevision.call(self, task, '用 hydrogen');
  // The context carries each step's actual model, and the ids and labels the lead must choose from.
  assert.match(prompt, /"model":"gemini-4-neon-high"/);
  assert.match(prompt, /gemini-4-hydrogen-high/);
  assert.match(prompt, /Gemini 4 Hydrogen \(High\)/);
  assert.match(prompt, /exact id/);
  // A queued step changes model in place; a running step keeps the model it started with.
  const step = (id) => task.steps.find((item) => item.id === id);
  assert.equal(step('edit').model, 'gemini-4-hydrogen-high');
  assert.equal(step('docs').model, 'gemini-4-neon-high');
  assert.deepEqual(task.revisions.at(-1).remodeled, [{ step: 'edit', from: 'gemini-4-neon-high', to: 'gemini-4-hydrogen-high' }]);
  // "gemini 4 hy", "4hy" and "4hydragon" all mean the Hydrogen family; a label resolves too. Only an unknown name
  // falls back to the default, and that fallback is recorded for the chat instead of hidden.
  assert.equal(S.resolveModel.call(self, 'antigravity', 'gemini 4 hy'), 'gemini-4-hydrogen-high');
  assert.equal(S.resolveModel.call(self, 'antigravity', '4hy'), 'gemini-4-hydrogen-high');
  assert.equal(S.resolveModel.call(self, 'antigravity', 'hy'), 'gemini-4-hydrogen-high');
  assert.equal(S.resolveModel.call(self, 'antigravity', '4hydragon'), 'gemini-4-hydrogen-high');
  assert.equal(step('a').model, 'gemini-4-hydrogen-high');
  assert.equal(step('b').model, 'gemini-4-hydrogen-high');
  assert.equal(step('c').model, 'gemini-4-neon-high');
  assert.deepEqual(task.revisions.at(-1).modelFallbacks, [{ step: 'c', requested: 'not-a-model', used: 'gemini-4-neon-high' }]);
});

test('an administrator can change a queued step model by shorthand, but not a running one', () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const S = Scheduler.prototype;
  const self = {
    config: { adapters: { antigravity: { profiles: { models: {
      'gemini-4-hydrogen-high': { label: 'Gemini 4 Hydrogen (High)', strengths: 'x', billing: 'subscription' },
      'gemini-4-neon-high': { label: 'Gemini 4 Neon (High)', strengths: 'x', billing: 'subscription' } } } } } },
    save() {}, status: () => ({ ok: true }),
  };
  self.resolveModel = S.resolveModel.bind(self);
  const task = { id: 't', state: 'queued', steps: [
    { id: 'a', role: 'antigravity', state: 'queued', model: 'gemini-4-neon-high' },
    { id: 'b', role: 'antigravity', state: 'running', model: 'gemini-4-neon-high' },
  ] };
  const result = S.setStepModels.call(self, task, { a: 'hy' });
  assert.equal(task.steps[0].model, 'gemini-4-hydrogen-high');
  assert.deepEqual(result.changed, [{ step: 'a', from: 'gemini-4-neon-high', to: 'gemini-4-hydrogen-high' }]);
  assert.throws(() => S.setStepModels.call(self, task, { b: 'hy' }), /step_started/);
  assert.equal(task.steps[1].model, 'gemini-4-neon-high');
});

test('the lead prefers new models: newest generation first, full before small, a date is not a version', () => {
  const { newestFirst, preferredModel } = require('../orchestrator/model-profiles');
  assert.deepEqual(newestFirst(['gpt-5', 'gpt-5.4-mini', 'gpt-5.5-mini', 'gpt-5.4', 'gpt-5.5-codex']), ['gpt-5.5-codex', 'gpt-5.5-mini', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5']);
  assert.deepEqual(newestFirst(['grok-4', 'grok-4.7-build-fast', 'grok-4.7']), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4']);
  assert.deepEqual(newestFirst(['gemini-3-pro', 'gemini-4-hydrogen', 'gemini-2.5-flash-medium']), ['gemini-4-hydrogen', 'gemini-3-pro', 'gemini-2.5-flash-medium']);
  assert.deepEqual(newestFirst(['claude-3-5-sonnet-20241022', 'claude-sonnet-5-5']), ['claude-sonnet-5-5', 'claude-3-5-sonnet-20241022']);
  // an older configured default gives way to the newest model; one of the newest generation is kept
  assert.equal(preferredModel({ defaultModel: 'gpt-5.4', models: { 'gpt-5.4': {}, 'gpt-5.5': {} } }), 'gpt-5.5');
  assert.equal(preferredModel({ defaultModel: 'gemini-4-hydrogen-medium', models: { 'gemini-4-hydrogen-high': {}, 'gemini-4-hydrogen-medium': {}, 'gemini-3-pro': {} } }), 'gemini-4-hydrogen-medium');
  assert.equal(preferredModel({ defaultModel: 'gemini-4-hydrogen-high', models: { 'gemini-4-hydrogen-high': {}, 'gemini-4-neon-high': {} } }), 'gemini-4-hydrogen-high');
  assert.equal(preferredModel({ defaultModel: 'gpt-5.5-mini', models: { 'gpt-5.5-mini': {}, 'gpt-5.5': {} } }), 'gpt-5.5');
});

test('the person fills each kind of work with more members and models; the lead stays Claude', () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const S = Scheduler.prototype;
  const models = (...ids) => ({ profiles: { models: Object.fromEntries(ids.map((id) => [id, {}])) } });
  const self = {
    config: { adapters: { claude: models('claude-opus-5-5', 'claude-sonnet-5-5'), codex: models('gpt-5.5', 'gpt-5.4'), grok: models('grok-4.7'), gemini: models('gemini-3-pro') } },
    router: { configured: (role) => ['claude', 'codex', 'grok', 'gemini'].includes(role), canWrite: (role) => role !== 'gemini',
      candidates: (capability, exclude) => ({ scout: ['codex'], implement: ['codex'] }[capability] || []).filter((role) => !exclude.includes(role)),
      available: () => true, quotaAllows: () => true, roles: () => ['claude', 'codex', 'grok', 'gemini'] },
  };
  for (const name of ['validRouteOrder', 'orderEntries', 'orderModels', 'ordered', 'candidatesFor', 'balanced']) self[name] = S[name].bind(self);
  // Nobody in the chain can take the work: every other member that can do it is filled in (never Claude; a
  // read-only member never for changing code). A chain that has someone is left alone.
  assert.deepEqual(self.candidatesFor({}, 'research', [], true), ['codex', 'grok', 'gemini']);
  assert.deepEqual(self.candidatesFor({}, 'implement', ['codex'], true), ['grok']);
  assert.deepEqual(self.candidatesFor({}, 'implement', [], true), ['codex']);
  assert.deepEqual(self.candidatesFor({}, 'research', [], false), []);
  assert.equal(self.validRouteOrder({ implement: ['grok', 'codex@gpt-5.5', 'codex@gpt-5.4'] }), true);
  assert.equal(self.validRouteOrder({ triage: ['claude@claude-sonnet-5-5'], plan: ['claude@claude-opus-5-5'] }), true);
  assert.equal(self.validRouteOrder({ implement: ['claude'] }), false);            // Claude never takes member work
  assert.equal(self.validRouteOrder({ plan: ['codex'] }), false);                  // the lead stays Claude
  assert.equal(self.validRouteOrder({ implement: ['gemini'] }), false);            // a read-only member cannot change code
  assert.equal(self.validRouteOrder({ scout: ['codex@gpt-9'] }), false);           // not one of its models
  const task = { routeOrder: { scout: ['grok', 'codex@gpt-5.4'], implement: ['codex@gpt-5.4', 'codex@gpt-5.5'] } };
  assert.deepEqual(self.candidatesFor(task, 'scout'), ['grok', 'codex']);          // grok added by the person, first
  assert.deepEqual(self.orderModels(task, 'implement', 'codex'), ['gpt-5.4', 'gpt-5.5']);
});

test('work is spread by quota left and members keep their configured model defaults', () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const S = Scheduler.prototype;
  const self = { router: { quota: { antigravity: 72, codex: 18, grok: 65 } }, orderEntries: () => [],
    config: { adapters: { antigravity: { profiles: { defaultModel: 'gemini-3.8-flash-medium', models: { 'gemini-3.8-flash-high': {}, 'gemini-3.8-flash-medium': {}, 'gemini-4-pro': {} } } },
      codex: { profiles: { defaultModel: 'gpt-5.4', models: { 'gpt-5.4': {}, 'gpt-5.5': {} } } } } } };
  const balanced = (list, task = {}) => S.balanced.call(self, task, 'review', list);
  assert.deepEqual(S.balanced.call(self, {}, 'implement', ['codex', 'antigravity']), ['codex', 'antigravity']);   // the writer is not spread
  assert.deepEqual(balanced(['antigravity', 'codex', 'grok']), ['codex', 'antigravity', 'grok']);   // 18% goes first; 72 and 65 share a band
  self.router.quota = { antigravity: 30, codex: 22 };
  assert.deepEqual(balanced(['antigravity', 'codex']), ['antigravity', 'codex']);                  // close: the configured order stays
  self.router.quota = { codex: 10 };
  assert.deepEqual(balanced(['antigravity', 'codex', 'grok']), ['antigravity', 'codex', 'grok']);  // unknown quota keeps its place
  assert.deepEqual(S.balanced.call({ ...self, orderEntries: () => [{ role: 'antigravity' }] }, {}, 'review', ['antigravity', 'codex']), ['antigravity', 'codex']);   // the person's order wins
  assert.equal(S.defaultModelFor.call(self, 'antigravity'), 'gemini-3.8-flash-medium');
  assert.equal(S.defaultModelFor.call(self, 'codex'), 'gpt-5.4');
});

test('a step not started yet can get another member, model and effort from its node; running and lead steps cannot', () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const S = Scheduler.prototype;
  const events = [];
  const self = {
    config: { adapters: { codex: { profiles: { defaultModel: 'gpt-5.5', models: { 'gpt-5.5': {}, 'gpt-5.4': {} } } }, grok: { profiles: { models: { 'grok-4.7': {} } } } } },
    router: { configured: () => true, canWrite: () => true }, running: new Map(),
    save: (task, state, detail) => events.push(detail), status: (id) => ({ id }), pump() {},
  };
  self.defaultModelFor = S.defaultModelFor.bind(self);
  const choose = (task, body) => S.chooseHandover.call(self, task, body);
  const task = { id: 't', state: 'running', steps: [
    { id: 'edit', role: 'grok', capability: 'implement', write: true, state: 'queued', session: 's' },
    { id: 'look', role: 'grok', capability: 'scout', state: 'running' },
    { id: 'accept-1', role: 'claude', capability: 'accept', state: 'queued' },
  ] };
  choose(task, { stepId: 'edit', role: 'codex', model: 'gpt-5.4', effort: 'high' });
  const edit = task.steps[0];
  assert.deepEqual([edit.role, edit.model, edit.named, edit.session, edit.state], ['codex', 'gpt-5.4', true, undefined, 'queued']);
  assert.equal(events.at(-1), 'edit:adjusted:codex/gpt-5.4');
  assert.throws(() => choose(task, { stepId: 'look', role: 'codex' }), /step_not_waiting/);        // running: not offered
  assert.throws(() => choose(task, { stepId: 'accept-1', role: 'codex' }), /invalid_handover/);    // the lead's work stays the lead's
  assert.throws(() => choose(task, { stepId: 'edit', role: 'codex', model: 'gpt-9' }), /invalid_handover/);
  // A step in a plan not confirmed yet.
  const planned = { id: 'p', state: 'awaiting_approval', steps: [], groupPlan: { rounds: [{ revision: 1, steps: [{ id: 'fix', role: 'codex', capability: 'implement', write: true, state: 'queued' }] }] } };
  choose(planned, { stepId: 'fix', role: 'grok' });
  assert.equal(planned.groupPlan.rounds[0].steps[0].role, 'grok');
});

test('a step refused access goes to the lead, who asks the person; allowed access continues the same session', async () => {
  const { Scheduler } = require('../orchestrator/scheduler');
  const S = Scheduler.prototype;
  const events = [];
  const decisions = [{ grant: 'commands', reason: '要在本机跑 Windows 测试' }];
  const self = {
    config: { stateDir: require('node:os').tmpdir(), workspaces: { mac: { groupLocalDrives: ['C', 'D'] } }, adapters: { claude: { profiles: { models: {} } } } },
    tasks: new Map(), running: new Map(), now: () => Date.now(),
    save: (task, state, detail) => { task.state = state; events.push(detail); }, status: (id) => ({ id }), pump() {},
    pickForTask: () => 'claude', leadModelFor: () => undefined, orderModels: () => [],
    execute: async () => ({ output: JSON.stringify(decisions.shift()) }),
  };
  for (const name of ['recordDenial', 'requestPermission', 'leadAccessDecision', 'requeueAfterAccess', 'answerPermission', 'grantAccess']) self[name] = S[name].bind(self);
  const task = { id: 't', workspace: 'mac', state: 'running', prompt: '修好并在本机测试', steps: [
    { id: 'check', role: 'grok', capability: 'review', state: 'running', session: 's1' }] };
  self.tasks.set('t', task);
  self.recordDenial('t', 'check', { operation: 'run', command: 'windows-test', error: 'mcp_permission_denied: this step cannot run local commands' });
  const step = task.steps[0];
  step.state = 'failed';
  step.error = 'cli_exit_1';
  assert.equal(await self.requestPermission(task, new AbortController().signal), true);
  assert.equal(step.state, 'waiting_permission');
  assert.equal(step.permissionRequest.kind, 'commands');
  assert.match(step.permissionRequest.denials[0], /cannot run local commands/);
  // Allowed for the whole task: the same session goes on, and the same kind is not asked again in this task.
  self.answerPermission(task, { stepId: 'check', decision: 'task' });
  assert.deepEqual([step.state, step.session, step.extraAccess, task.extraAccess], ['queued', 's1', ['commands'], ['commands']]);
  assert.ok(events.includes('check:access_granted_task'));
  // Declining: the step continues without it and is told what is missing.
  decisions.push({ grant: 'files_write', reason: '要把报告写到 D 盘' });
  step.state = 'failed';
  self.recordDenial('t', 'check', { operation: 'write', path: 'D:/out/report.txt', error: 'mcp_permission_denied: this step cannot change files on the person\'s computer' });
  await self.requestPermission(task, new AbortController().signal);
  self.answerPermission(task, { stepId: 'check', decision: 'deny' });
  assert.equal(step.state, 'queued');
  assert.match(step.guidance.at(-1).text, /没有允许/);
  assert.equal(step.localDrives, undefined);
  assert.throws(() => self.answerPermission(task, { stepId: 'check', decision: 'step' }), /step_not_waiting/);
});
