const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { Router, validateRoutes } = require('../orchestrator/routing');
const { parsePlan, Scheduler } = require('../orchestrator/scheduler');
const { runAdapter, normalizeUsage, classifyFailure, formatDuration } = require('../orchestrator/adapters');
const Store = require('../orchestrator/store');

const adapters = (...names) => Object.fromEntries(names.map((name) => [name, { bin: name, env: {} }]));

// A standalone CLI fixture runs as `node <script>`; when the adapter prepends one of its global flags, drop the
// flag (and its value) so the fake script still starts on every platform, Windows included.
function freshRunAdapter(t, cleanArgs) {
  const filename = require.resolve('../orchestrator/adapters');
  const cached = require.cache[filename];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file, args, options) => spawn(file, cleanArgs(file, args), options));
  delete require.cache[filename];
  t.after(() => { if (cached) require.cache[filename] = cached; else delete require.cache[filename]; });
  return require(filename).runAdapter;
}

test('the router picks the first available candidate and skips blocked CLIs until the block lifts', () => {
  let now = 0;
  const router = new Router({ adapters: adapters('codex', 'claude', 'grok', 'gemini') }, () => now);
  assert.equal(router.pick('plan'), 'claude');
  assert.equal(router.pick('scout'), 'gemini');           // Antigravity is not configured
  assert.equal(router.pick('review'), 'grok');
  router.block('grok', 'quota', 1000);
  assert.equal(router.pick('review'), 'gemini');
  assert.deepEqual(Object.keys(router.status().blocked), ['grok']);
  now = 1001;
  assert.equal(router.pick('review'), 'grok');
  assert.equal(router.pick('implement', ['codex']), 'grok');            // implementation steps down in order…
  assert.equal(router.pick('implement', ['codex', 'grok']), null);     // …but never to Claude or read-only Gemini
});

test('a configured CLI awaiting interactive login is retained but never dispatched', () => {
  const router = new Router({ adapters: { antigravity: { authRequired: true }, grok: {} } });
  assert.ok(router.roles().includes('antigravity'));
  assert.equal(router.available('antigravity'), false);
  assert.equal(router.pick('scout'), 'grok');
});

test('routing overrides are validated; a read-only CLI can never be routed to implementation', () => {
  assert.deepEqual(validateRoutes({ review: ['grok'] }).review, ['grok']);
  assert.throws(() => validateRoutes({ review: ['claude'] }), /invalid_routing:review:lead_reserved/);
  assert.throws(() => validateRoutes({ accept: ['codex'] }), /invalid_routing:accept:lead_required/);
  assert.throws(() => validateRoutes({ implement: ['gemini'] }), /invalid_routing:implement/);
  assert.throws(() => validateRoutes({ review: ['someone'] }), /invalid_routing/);
  assert.throws(() => validateRoutes({ deploy: ['codex'] }), /invalid_routing/);
});

test('plans that name a capability are assigned by the router; only implement steps write', () => {
  const router = new Router({ adapters: adapters('codex', 'claude', 'grok', 'antigravity') });
  const steps = parsePlan(JSON.stringify([
    { id: 'scout', capability: 'scout', prompt: 'read', dependsOn: [] },
    { id: 'edit', capability: 'implement', prompt: 'change', dependsOn: ['scout'] },
    { id: 'check', capability: 'review', role: 'grok', prompt: 'review', dependsOn: ['edit'] },
    { id: 'look', capability: 'research', role: 'codex', prompt: 'look up', dependsOn: [] },
  ]), router.availableRoles(), router);
  assert.deepEqual(steps.map((step) => [step.role, step.write]), [['antigravity', false], ['codex', true], ['grok', false], ['antigravity', false]]);   // Codex writes; Antigravity reads and researches
  assert.throws(() => parsePlan(JSON.stringify([{ id: 'a', capability: 'deploy', prompt: 'x', dependsOn: [] }]), router.availableRoles(), router), /invalid_plan/);
  assert.throws(() => parsePlan(JSON.stringify([{ id: 'a', capability: 'implement', role: 'claude', prompt: 'x', dependsOn: [] }]),
    router.availableRoles(), router), /invalid_plan:lead_capability/);
});

test('a step moves to the next candidate when its CLI is out of quota, and token use is kept per CLI', async () => {
  const store = new Store(':memory:');
  try {
    const calls = [];
    const adapter = async ({ name }) => {
      calls.push(name);
      if (name === 'grok') throw Object.assign(new Error('cli_quota_exhausted: Grok Build usage balance exhausted'), { usage: { input: 3 } });
      return { output: 'ok', usage: { input: 10, output: 2 } };
    };
    const config = { workspaces: {}, adapters: adapters('codex', 'claude', 'grok', 'antigravity'), stateDir: os.tmpdir() };
    const scheduler = new Scheduler({ config, store, files: {}, adapter });
    const task = { id: 't', steps: [] };
    const step = { id: 'review', role: 'grok', capability: 'review', write: false };
    const { output } = await scheduler.execute(task, step, os.tmpdir(), new AbortController().signal, 'x');
    assert.equal(output, 'ok');
    assert.deepEqual(calls, ['grok', 'antigravity']);
    assert.equal(step.role, 'antigravity');
    assert.deepEqual(task.usage, { grok: { input: 3 }, antigravity: { input: 10, output: 2 } });
    assert.equal(scheduler.router.available('grok'), false);
    // A step without a capability is pinned to its CLI and fails instead of moving.
    await assert.rejects(scheduler.execute(task, { id: 'pinned', role: 'grok', write: false }, os.tmpdir(), new AbortController().signal, 'x'),
      /cli_quota_exhausted/);
  } finally {
    store.close();
  }
});

test('failure text is classified as a login or quota problem, and usage shapes are normalised', () => {
  assert.equal(classifyFailure('Error: Not logged in. Please run login.'), 'cli_auth_required');
  assert.equal(classifyFailure('You have hit your usage limit. Resets at 18:00'), 'cli_quota_exhausted');
  assert.equal(classifyFailure('429 Too Many Requests'), 'cli_quota_exhausted');
  assert.equal(classifyFailure('402 Payment Required: Grok Build usage balance exhausted'), 'cli_quota_exhausted');
  assert.equal(classifyFailure('model_not_found'), 'cli_model_unavailable');
  assert.equal(classifyFailure('ECONNRESET'), 'cli_network_error');
  assert.equal(classifyFailure("You've hit your 5-hour limit · resets 7:20pm (UTC)"), 'cli_quota_exhausted');
  assert.equal(classifyFailure('print timeout after 10m0s with the turn still in progress; the response is partial'), 'cli_print_timeout');
  assert.equal(classifyFailure('TypeError: cannot read properties'), null);
  assert.equal(formatDuration(870000), '14m30s');
  assert.equal(formatDuration(60000), '1m');
  assert.deepEqual(normalizeUsage({ input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 1, cost_usd: 0.5 }),
    { input: 5, cachedInput: 7, output: 1, costUsd: 0.5 });
  assert.equal(normalizeUsage({ unrelated: 1 }), null);
});

test('Codex JSON errors classify quota exhaustion without treating recovered retries as failures', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesk-codex-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'exec'), [
    "const type = process.env.MOCK_CODEX_RESULT;",
    "const message = 'You’ve hit your usage limit. Try again at 7:11 AM.';",
    "console.log(JSON.stringify({ type: 'error', message }));",
    "if (type === 'recovered') {",
    "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }));",
    "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3 } }));",
    "} else {",
    "  if (type === 'terminal') console.log(JSON.stringify({ type: 'turn.failed', error: { message } }));",
    "  process.exitCode = 1;",
    "}",
  ].join('\n'));
  // The adapter runs Codex with the global --search flag before `exec`; drop it for the Node stand-in.
  const runAdapterWithSearch = freshRunAdapter(t,
    (file, args) => file === process.execPath && args[0] === '--search' ? args.slice(1) : args);
  const run = (result) => runAdapterWithSearch({
    name: 'codex', config: { bin: process.execPath, env: { ...process.env, MOCK_CODEX_RESULT: result } },
    cwd: dir, readonly: true, signal: new AbortController().signal, timeout: 5000,
    prompt: 'hello', log: path.join(dir, result + '.log'), onSession() {},
  });
  await assert.rejects(run('terminal'), /cli_quota_exhausted/);
  await assert.rejects(run('error_only'), /cli_quota_exhausted/);
  assert.deepEqual(await run('recovered'), { output: 'ok', usage: { input: 3 } });
});

test('a CLI described by template runs with its flags, and an exhausted quota is reported as such', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesk-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'agy');
  await fs.writeFile(bin, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    "if (args.includes('quota-test')) { console.error('Error: usage limit reached for your plan'); process.exit(3); }",
    "console.log(JSON.stringify({ sessionId: 's-1', reply: { text: 'brief: ' + args.join(' ') }, stats: { input_tokens: 9, output_tokens: 4 } }));",
  ].join('\n'), { mode: 0o700 });
  const template = { prompt: 'arg', output: 'jsonl', session: 'field', args: ['--print-timeout', '10m', '-p', '{prompt}'],
    readonlyArgs: ['--read-only'], modelArgs: ['--model', '{model}'], outputField: 'reply.text', sessionField: 'sessionId', usageField: 'stats' };
  const base = { name: 'antigravity', config: { bin, env: { PATH: process.env.PATH }, template }, cwd: dir, readonly: true,
    timeout: 10000, printTimeoutMs: 870000, signal: new AbortController().signal, log: path.join(dir, 'log'), model: 'fast' };
  let session;
  const result = await runAdapter({ ...base, prompt: 'scan repo', onSession: (id) => { session = id; } });
  const match = /^brief: --settings (\S+) --read-only --model fast --print-timeout 14m30s -p scan repo$/.exec(result.output);
  assert.ok(match, result.output);
  const permissions = JSON.parse(match[1]).permissions;
  assert.ok(permissions.allow.includes('read_url(*)') && permissions.allow.includes('search_web(*)'));
  // Without a sandbox the CLI's own file and shell tools stay denied, and a read-only step cannot write.
  assert.deepEqual(permissions.deny, ['execute_url(*)', 'read_file(*)', 'command(*)', 'write_file(*)']);
  assert.deepEqual(result.usage, { input: 9, output: 4 });
  assert.equal(session, 's-1');
  await assert.rejects(runAdapter({ ...base, prompt: 'quota-test', onSession() {} }), /cli_quota_exhausted/);
});

test('the VPS2 example config is valid: subscription models, routing and the Antigravity template', () => {
  const { validateTemplate } = require('../orchestrator/service');
  const { modelProfiles } = require('../orchestrator/model-profiles');
  const example = require('../orchestrator/vps2.example.json');
  for (const settings of Object.values(example.adapters)) modelProfiles(settings);
  assert.deepEqual(validateRoutes(example.routing), example.routing);
  const antigravity = validateTemplate(example.adapters.antigravity.template, 'antigravity');
  assert.equal(antigravity.prompt, 'arg');
  // agy encodes the effort level in the model ID; a conflicting --effort is rejected, so the template has none.
  assert.equal(antigravity.efforts, undefined);
  assert.equal(antigravity.effortArgs, undefined);
  assert.throws(() => validateTemplate({ prompt: 'arg', args: ['-p'] }, 'antigravity'), /invalid_antigravity_template/);
  assert.throws(() => validateTemplate({ ...antigravity, efforts: ['ultra'] }, 'antigravity'), /invalid_antigravity_template/);
  assert.throws(() => validateTemplate({ ...antigravity, effortArgs: ['--effort', '{effort}'] }, 'antigravity'), /invalid_antigravity_template/);
  assert.throws(() => validateTemplate(undefined, 'antigravity'), /antigravity_template_required/);
});

test('model profiles expose display labels and reasoning efforts', () => {
  const { modelProfiles } = require('../orchestrator/model-profiles');
  const profile = modelProfiles({
    models: {
      'claude-opus-5-5': {
        label: 'Opus 5.5', strengths: 'Deep analysis.', billing: 'subscription',
        efforts: ['low', 'high', 'max'], defaultEffort: 'high',
      },
    },
  });
  assert.deepEqual(profile.models['claude-opus-5-5'], {
    label: 'Opus 5.5', strengths: 'Deep analysis.', billing: 'subscription',
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
  });
  const example = require('../orchestrator/vps2.example.json');
  assert.equal(example.adapters.claude.models['claude-opus-5-5'].label, 'Opus 5.5');
  assert.deepEqual(example.adapters.grok.models['grok-4.7'].efforts, ['low', 'medium', 'high', 'xhigh']);

  const invalid = [
    { efforts: [] },
    { efforts: ['low', 'low'] },
    { efforts: ['ultra'] },
    { efforts: ['low'], defaultEffort: 'high' },
    { defaultEffort: 'high' },
    { label: '' },
  ];
  for (const extra of invalid) {
    assert.throws(() => modelProfiles({
      models: { 'claude-opus-5-5': { strengths: 'Deep analysis.', billing: 'subscription', ...extra } },
    }), /invalid_model/, JSON.stringify(extra));
  }
});

test('Antigravity streaming results preserve responses, sessions, usage and authentication failures', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-agy-json-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'fixture.js');
  await fs.writeFile(fixture, `const bad=process.argv[2]==='fail'; console.log(JSON.stringify({event:'result',result:{conversation_id:'agy-session',response:bad?'':'connected',usage:{input_tokens:5,output_tokens:2},...(bad?{error:'authentication required'}:{})}}));`);
  // The adapter prepends Antigravity's --settings (flag and JSON); drop the pair for the Node stand-in.
  const runAdapterWithSettings = freshRunAdapter(t,
    (file, args) => file === process.execPath && args[0] === '--settings' ? args.slice(2) : args);
  const template = { ...require('../orchestrator/vps2.example.json').adapters.antigravity.template,
    args: [fixture, '{prompt}'], readonlyArgs: [], writeArgs: [], resumeArgs: [] };
  let session;
  const run = prompt => runAdapterWithSettings({ name:'antigravity', config:{bin:process.execPath,env:process.env,template},
    cwd:dir, prompt, readonly:true, signal:new AbortController().signal, timeout:5000,
    log:path.join(dir,'result.log'), onSession:id=>{session=id;} });
  assert.deepEqual(await run('ok'), { output:'connected', usage:{input:5,output:2} });
  assert.equal(session,'agy-session');
  await assert.rejects(run('fail'), /cli_auth_required/);
});

test('quota decides who works: Claude and Codex step back early and keep their quota for their main jobs', () => {
  const { validateQuotaPolicy } = require('../orchestrator/routing');
  const router = new Router({ adapters: adapters('codex', 'claude', 'grok', 'antigravity') });
  const quota = (used) => router.setQuota(Object.entries(used).map(([provider, percent]) => ({
    provider, buckets: [{ fiveHour: { usedPercent: 10 }, weekly: { usedPercent: percent } }] })));
  quota({ claude: 70, codex: 80 });
  assert.equal(router.pick('plan'), 'claude');                 // above 60%: still plans
  assert.equal(router.pick('implement'), 'codex');                          // above 70%: Codex still implements (its main job)
  assert.equal(router.pick('implement', ['codex']), 'antigravity');          // Codex cannot: the next writer
  assert.equal(router.pick('implement', ['codex', 'antigravity']), 'grok');
  assert.equal(router.pick('implement', ['antigravity', 'codex', 'grok']), null);   // never Claude
  assert.equal(router.pick('accept', ['claude']), null);       // nor Codex acceptance work
  assert.equal(router.pick('review'), 'antigravity');
  quota({ claude: 96, codex: 10, grok: 97 });
  assert.equal(router.pick('plan'), 'codex');                  // Claude above 95%: out entirely
  assert.equal(router.pick('review', ['antigravity']), null);  // Grok above 95%: skipped
  // The person-facing status can say why the only triage member is waiting.
  assert.equal(router.unavailableReason('claude', 'triage'), 'quota');
  router.block('grok', 'auth', 1000);
  assert.equal(router.unavailableReason('grok', 'review'), 'auth');
  assert.equal(router.unavailableReason('antigravity', 'scout'), 'busy');
  router.blocked.clear();
  quota({});                                                   // unknown quota counts as available
  assert.equal(router.pick('review', ['antigravity']), 'grok');
  assert.equal(validateQuotaPolicy({ claude: { soft: 40 } }).claude.hard, 95);
  assert.throws(() => validateQuotaPolicy({ claude: { soft: 99, hard: 90 } }), /invalid_quota_policy:claude/);
  assert.throws(() => validateQuotaPolicy({ codex: { keepFor: ['deploy'] } }), /invalid_quota_policy:codex/);
});

test('a task is charged the quota each CLI used between its start and end', () => {
  const windows = Scheduler.quotaWindows([
    { provider: 'codex', buckets: [{ fiveHour: { usedPercent: 12 }, weekly: { usedPercent: 30 } }, { fiveHour: { usedPercent: 20 }, weekly: null }] },
    { provider: 'grok', buckets: [] },
  ]);
  assert.deepEqual(windows, { codex: { fiveHour: 20, weekly: 30 } });
});

test('a review goes to a different member than the one who wrote the change', () => {
  const router = new Router({ adapters: adapters('codex', 'claude', 'grok', 'antigravity') });
  const plan = (steps) => parsePlan(JSON.stringify(steps), router.availableRoles(), router).map((step) => step.role);
  // Codex writes by default; Antigravity, first in line for review, reviews it.
  assert.deepEqual(plan([
    { id: 'edit', capability: 'implement', prompt: 'change', dependsOn: [] },
    { id: 'check', capability: 'review', prompt: 'review', dependsOn: ['edit'] },
  ]), ['codex', 'antigravity']);
  // Antigravity writes (named by the lead), so the review that would have gone to it goes to Grok Build.
  assert.deepEqual(plan([
    { id: 'edit', capability: 'implement', role: 'antigravity', prompt: 'change', dependsOn: [] },
    { id: 'check', capability: 'review', prompt: 'review', dependsOn: ['edit'] },
  ]), ['antigravity', 'grok']);
  // The lead names Codex for a hard change; Antigravity, first in line for review, reviews it.
  assert.deepEqual(plan([
    { id: 'edit', capability: 'implement', role: 'codex', prompt: 'hard change', dependsOn: [] },
    { id: 'check', capability: 'review', prompt: 'review', dependsOn: ['edit'] },
  ]), ['codex', 'antigravity']);
  // Nobody else can review: the author's own review is kept rather than none.
  router.block('grok', 'quota', 60_000);
  assert.deepEqual(plan([
    { id: 'edit', capability: 'implement', role: 'antigravity', prompt: 'change', dependsOn: [] },
    { id: 'check', capability: 'review', prompt: 'review', dependsOn: ['edit'] },
  ]), ['antigravity', 'antigravity']);
});

test('a CLI without a quota source is judged by its own calls against its configured limits', () => {
  const store = new Store(':memory:');
  try {
    let now = Date.parse('2026-11-18T10:00:00Z');
    const config = { stateDir: os.tmpdir(), workspaces: {}, adapters: {
      antigravity: { bin: 'agy', env: {}, callLimits: { fiveHour: 10, weekly: 100 } }, grok: { bin: 'grok', env: {} } } };
    const scheduler = new Scheduler({ config, store, files: {}, adapter: async () => ({ output: '' }), now: () => now });
    for (let i = 0; i < 9; i++) { scheduler.recordCall('antigravity'); now += 60_000; }
    scheduler.recordCall('grok');   // no limits configured: not tracked
    const [agy, grok] = scheduler.withEstimates([
      { provider: 'antigravity', state: 'unavailable', buckets: [] }, { provider: 'grok', state: 'unavailable', buckets: [] }]);
    assert.equal(agy.source, 'estimate');
    assert.equal(agy.buckets[0].fiveHour.usedPercent, 90);
    assert.equal(agy.buckets[0].weekly.usedPercent, 9);
    assert.equal(agy.buckets[0].fiveHour.resetsAt, Math.ceil((Date.parse('2026-11-18T10:00:00Z') + 5 * 3600_000) / 1000));
    assert.equal(grok.source, undefined);
    scheduler.router.setQuota([agy]);
    assert.equal(scheduler.router.pick('implement'), 'antigravity');   // 90% is under its 95% hard line
    scheduler.recordCall('antigravity');
    scheduler.router.setQuota(scheduler.withEstimates([{ provider: 'antigravity', state: 'unavailable', buckets: [] }]));
    assert.notEqual(scheduler.router.pick('implement'), 'antigravity');   // 100%: steps back
    now += 5 * 3600_000;                                                    // the 5-hour window rolls on
    scheduler.router.setQuota(scheduler.withEstimates([{ provider: 'antigravity', state: 'unavailable', buckets: [] }]));
    assert.equal(scheduler.router.pick('implement'), 'antigravity');
  } finally {
    store.close();
  }
});
