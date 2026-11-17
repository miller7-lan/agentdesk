const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Router, validateRoutes } = require('../orchestrator/routing');
const { parsePlan, Scheduler } = require('../orchestrator/scheduler');
const { runAdapter, normalizeUsage, classifyFailure } = require('../orchestrator/adapters');
const Store = require('../orchestrator/store');

const adapters = (...names) => Object.fromEntries(names.map((name) => [name, { bin: name, env: {} }]));

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
  assert.equal(router.pick('implement', ['codex']), null);   // implementation never falls back to Claude
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
  assert.deepEqual(steps.map((step) => [step.role, step.write]), [['antigravity', false], ['codex', true], ['grok', false], ['grok', false]]);
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
      if (name === 'grok') throw Object.assign(new Error('cli_quota_exhausted'), { usage: { input: 3 } });
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
  assert.equal(classifyFailure('TypeError: cannot read properties'), null);
  assert.deepEqual(normalizeUsage({ input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 1, cost_usd: 0.5 }),
    { input: 5, cachedInput: 7, output: 1, costUsd: 0.5 });
  assert.equal(normalizeUsage({ unrelated: 1 }), null);
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
  const template = { prompt: 'arg', output: 'jsonl', session: 'field', args: ['-p', '{prompt}'], readonlyArgs: ['--read-only'],
    modelArgs: ['--model', '{model}'], outputField: 'reply.text', sessionField: 'sessionId', usageField: 'stats' };
  const base = { name: 'antigravity', config: { bin, env: { PATH: process.env.PATH }, template }, cwd: dir, readonly: true,
    timeout: 10000, signal: new AbortController().signal, log: path.join(dir, 'log'), model: 'fast' };
  let session;
  const result = await runAdapter({ ...base, prompt: 'scan repo', onSession: (id) => { session = id; } });
  assert.equal(result.output, 'brief: --read-only --model fast -p scan repo');
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
  assert.equal(validateTemplate(example.adapters.antigravity.template, 'antigravity').prompt, 'arg');
  assert.throws(() => validateTemplate({ prompt: 'arg', args: ['-p'] }, 'antigravity'), /invalid_antigravity_template/);
  assert.throws(() => validateTemplate(undefined, 'antigravity'), /antigravity_template_required/);
});

test('quota decides who works: Claude and Codex step back early and keep their quota for their main jobs', () => {
  const { validateQuotaPolicy } = require('../orchestrator/routing');
  const router = new Router({ adapters: adapters('codex', 'claude', 'grok', 'antigravity') });
  const quota = (used) => router.setQuota(Object.entries(used).map(([provider, percent]) => ({
    provider, buckets: [{ fiveHour: { usedPercent: 10 }, weekly: { usedPercent: percent } }] })));
  quota({ claude: 70, codex: 80 });
  assert.equal(router.pick('plan'), 'claude');                 // above 60%: still plans
  assert.equal(router.pick('implement'), 'codex');             // above 70%: still implements
  assert.equal(router.pick('implement', ['codex']), null);     // Claude no longer takes implementation work
  assert.equal(router.pick('accept', ['claude']), null);       // nor Codex acceptance work
  assert.equal(router.pick('review'), 'grok');
  quota({ claude: 96, codex: 10, grok: 97 });
  assert.equal(router.pick('plan'), 'codex');                  // Claude above 95%: out entirely
  assert.equal(router.pick('review'), 'antigravity');          // Grok above 95%: skipped
  quota({});                                                   // unknown quota counts as available
  assert.equal(router.pick('review'), 'grok');
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
