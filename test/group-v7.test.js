// Group chat v7 capabilities (docs/GROUP-V2.md): each behind its own switch in groupFeatures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { groupFeatures, FEATURES } = require('../orchestrator/group-features');
const { Router, validateRoutes } = require('../orchestrator/routing');
const { Scheduler } = require('../orchestrator/scheduler');

const S = Scheduler.prototype;
const allOn = Object.fromEntries(Object.keys(FEATURES).map((name) => [name, true]));

test('switches: missing means off (old behaviour), each can be set on its own, typos are refused', () => {
  assert.deepEqual(Object.values(groupFeatures(undefined)), Object.keys(FEATURES).map(() => false));
  assert.equal(groupFeatures({ timeline: true }).timeline, true);
  assert.equal(groupFeatures({ timeline: true }).anyLead, false);
  assert.throws(() => groupFeatures({ timelines: true }), /invalid_group_features/);
  assert.throws(() => groupFeatures({ timeline: 'yes' }), /invalid_group_features/);
});

test('Q1 anyLead: any member may lead and Claude may do member work; off keeps the Claude-only lead', () => {
  assert.throws(() => validateRoutes({ plan: ['codex'] }), /lead_required/);
  assert.throws(() => validateRoutes({ implement: ['claude'] }), /lead_reserved/);
  const routes = validateRoutes({ plan: ['codex', 'claude'], triage: ['grok'], accept: ['codex'], implement: ['claude', 'codex'] }, { anyLead: true });
  assert.deepEqual(routes.plan, ['codex', 'claude']);
  const adapters = { claude: {}, codex: {}, grok: {} };
  assert.equal(new Router({ adapters, groupFeatures: { anyLead: true } }).status().lead, null);
  assert.equal(new Router({ adapters }).status().lead, 'claude');
});

test('N3 leadChainQuota: above the soft line lead-chain members only lead; others stop only at the hard line', () => {
  const router = new Router({ adapters: { claude: {}, codex: {}, grok: {} }, groupFeatures: { leadChainQuota: true } });
  router.quota = { claude: 70, codex: 80, grok: 96 };
  const chain = ['claude'];
  assert.equal(router.quotaAllows('claude', 'plan', chain), true);
  assert.equal(router.quotaAllows('claude', 'implement', chain), false);
  assert.equal(router.quotaAllows('codex', 'review', chain), true, 'codex is not in the lead chain: only the hard line applies');
  assert.equal(router.quotaAllows('grok', 'review', chain), false, 'above the hard line nobody works');
  // Switch off: the fixed per-member policy (Codex above 70% keeps only implement).
  const fixed = new Router({ adapters: { claude: {}, codex: {} } });
  fixed.quota = { codex: 80 };
  assert.equal(fixed.quotaAllows('codex', 'review', chain), false);
  assert.equal(fixed.quotaAllows('codex', 'implement', chain), true);
});

function scheduler(features) {
  const models = (...ids) => ({ profiles: { models: Object.fromEntries(ids.map((id) => [id, {}])), defaultModel: ids[0] } });
  const self = {
    features,
    config: { adapters: { claude: models('claude-opus-5-5'), codex: models('gpt-5.5'), grok: models('grok-4.7') } },
    router: { routes: { plan: ['claude'], triage: ['claude'], accept: ['claude'], implement: ['codex'] },
      configured: () => true, canWrite: () => true, available: () => true, quotaAllows: () => true,
      roles: () => ['claude', 'codex', 'grok'], candidates: (capability) => ({ implement: ['codex'] }[capability] || []) },
  };
  for (const name of ['validRouteOrder', 'orderEntries', 'orderModels', 'ordered', 'candidatesFor', 'balanced', 'leadModelFor', 'defaultModelFor']) {
    self[name] = S[name].bind(self);
  }
  return self;
}

test('Q1 in the scheduler: lead chains accept any member@model, Claude can be filled in for member work', () => {
  const off = scheduler({});
  assert.equal(off.validRouteOrder({ plan: ['codex@gpt-5.5'] }), false);
  assert.equal(off.validRouteOrder({ implement: ['claude'] }), false);
  const on = scheduler({ anyLead: true });
  assert.equal(on.validRouteOrder({ plan: ['codex@gpt-5.5', 'claude@claude-opus-5-5'], accept: ['grok'] }), true);
  assert.equal(on.validRouteOrder({ implement: ['claude'] }), true);
  assert.deepEqual(on.candidatesFor({ routeOrder: { plan: ['codex@gpt-5.5'] } }, 'plan', [], false), ['codex']);
  assert.ok(on.candidatesFor({}, 'research', [], true).includes('claude'));
  assert.ok(!off.candidatesFor({}, 'research', [], true).includes('claude'));
  // The lead's model follows the member chosen as lead.
  assert.equal(on.leadModelFor({ routeOrder: { plan: ['codex@gpt-5.5'] } }, 'plan', 'codex'), 'gpt-5.5');
});

test('requirement 4: a failed plan leaves a reason and single chats to try; off adds nothing', () => {
  const events = [];
  const make = (features) => ({
    features, now: () => Date.parse('2026-11-22T00:00:00Z'),
    router: { routes: { implement: ['codex', 'grok'], scout: ['grok'] }, roles: () => ['claude', 'codex', 'grok'], available: () => true },
    defaultModelFor: (role) => ({ codex: 'gpt-5.5', grok: 'grok-4.7', claude: 'claude-opus-5-5' })[role],
    updateMetrics() {}, event: () => ({}), store: { saveTask: (task, event) => events.push(event), put() {} },
  });
  const task = { id: 't', prompt: '把登录页改成两步验证', mode: 'auto', project: 'p', workspace: 'w', steps: [] };
  S.save.call(make({ planFailureAdvice: true }), task, 'awaiting_details', 'plan_failed');
  assert.match(task.directAdvice.reason, /没能给出可用的方案/);
  assert.deepEqual(task.directAdvice.options.map((option) => option.role), ['codex', 'grok', 'claude']);
  assert.equal(task.directAdvice.options[0].access, 'fullAccess');
  assert.equal(task.directAdvice.options[0].model, 'gpt-5.5');
  assert.ok(task.directAdvice.options[0].prompt.startsWith('把登录页改成两步验证'));
  const quiet = { id: 'u', prompt: 'x', steps: [] };
  S.save.call(make({}), quiet, 'failed', 'plan_failed_repeatedly');
  assert.equal(quiet.directAdvice, undefined);
  const other = { id: 'v', prompt: 'x', steps: [] };
  S.save.call(make({ planFailureAdvice: true }), other, 'failed', 'windows_test_failed');
  assert.equal(other.directAdvice, undefined, 'only planning failures');
});

test('O2 applyPause: new commands wait while a patch is applied, at most the limit; off never waits', async () => {
  const self = { features: { applyPause: true } };
  const hold = S.holdApply.bind(self);
  const wait = S.waitForApply.bind(self);
  assert.deepEqual(await wait('w'), { waited: false });
  const release = hold('w');
  let done = null;
  const waiting = wait('w').then((value) => { done = value; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(done, null, 'still waiting');
  release();
  await waiting;
  assert.deepEqual(done, { waited: true, outcome: 'applied' });
  const stuck = hold('w');
  assert.deepEqual(await wait('w', undefined, 40), { waited: true, outcome: 'timeout' });
  stuck();
  const off = { features: {} };
  S.holdApply.call(off, 'w')();
  assert.deepEqual(await S.waitForApply.call(off, 'w'), { waited: false });
});

test('Q4 patch_download: the reviewed patch with its sha256, only for the owner and only when ready', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-v7-patch-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const id = randomUUID();
  fs.mkdirSync(path.join(stateDir, 'worktrees', id), { recursive: true });
  const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n';
  fs.writeFileSync(path.join(stateDir, 'worktrees', id, 'impl.patch'), patch);
  const task = { id, owner: undefined, workspace: 'w', state: 'needs_review', detail: 'patches_ready', base: 'a'.repeat(40),
    steps: [{ id: 'impl', write: true, paths: ['a.txt'] }] };
  const self = { features: { patchDownload: true }, tasks: new Map([[id, task]]), config: { stateDir, workspaces: { w: {} } },
    isProjectMember: () => false };
  const value = await S.control.call(self, { kind: 'task.status', task_id: id, body: { operation: 'patch_download' } }, 'admin');
  assert.equal(Buffer.from(value.patch, 'base64').toString(), patch);
  assert.equal(value.sha256, createHash('sha256').update(patch).digest('hex'));
  assert.equal(value.fileCount, 1);
  task.detail = 'running';
  assert.throws(() => S.control.call(self, { kind: 'task.status', task_id: id, body: { operation: 'patch_download' } }, 'admin'), /patch_not_ready/);
  self.features = {};
  assert.throws(() => S.control.call(self, { kind: 'task.status', task_id: id, body: { operation: 'patch_download' } }, 'admin'), /unsupported_operation/);
});

test('every new operation is on all three allow-lists (service.js, main.js, scheduler)', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['orchestrator/service.js', 'main.js']) assert.match(read(file), /'patch_download'/);
  assert.match(read('orchestrator/scheduler.js'), /body\.operation === 'patch_download'/);
});
