// Group chat v7, second tranche (docs/GROUP-V2.md): G-P1 stage groups, G-P2a–d local stages, local copy,
// credential sandbox, environment fixes, and the lead-written plan-failure advice. Each behind its own switch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { groupFeatures } = require('../orchestrator/group-features');
const { toolsFor } = require('../orchestrator/mcp');
const { Scheduler } = require('../orchestrator/scheduler');
const { diffPaths, checkEnvNames, READ_SLOTS, READ_SLOTS_PER_DEVICE } = require('../orchestrator/group-stages');
const { WindowsOperations } = require('../orchestrator/windows');
const Store = require('../orchestrator/store');
const mac = require('../orchestrator/platform-mac');
const win = require('../orchestrator/platform-win');

const S = Scheduler.prototype;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
const NEW = ['stageGroups', 'localStages', 'writeAnywhere', 'localCopy', 'credentialSandbox', 'envFix', 'leadAdvice'];

test('the second-tranche switches are off unless set, and each can be set alone', () => {
  const off = groupFeatures(undefined);
  for (const name of NEW) assert.equal(off[name], false, name);
  assert.equal(groupFeatures({ envFix: true }).envFix, true);
  assert.equal(groupFeatures({ envFix: true }).localCopy, false);
});

test('MCP scopes: reading steps get any command and environment fixes, writers any command but no fixes', () => {
  const names = (scope) => toolsFor(scope).map((tool) => tool.name);
  assert.ok(names('local').includes('local_shell_run') && names('local').includes('local_env_fix'));
  assert.ok(names('local-write').includes('local_shell_run') && !names('local-write').includes('local_env_fix'));
  for (const scope of [undefined, 'files', 'commands', 'desktop']) {
    assert.ok(!names(scope).includes('local_shell_run') && !names(scope).includes('local_env_fix'), String(scope));
  }
});

test('step access: M1/O1 reading stages in the live project, E3 planning never fixes, Q2/M3 writers, read-only tasks untouched', () => {
  const access = (features, step, task = { snapshot: {} }, granted) => S.stepAccess.call({ features }, task, step, granted);
  assert.deepEqual(access({}, { capability: 'review' }), {});
  const review = access({ localStages: true, envFix: true, credentialSandbox: true }, { capability: 'review' });
  assert.equal(review.localTools, 'local');
  assert.equal(review.anyCommand && review.envFix && review.writeAnywhere && review.credentialSandbox && review.liveProject, true);
  assert.equal(access({ localStages: true, envFix: true }, { capability: 'plan', id: 'planner' }).envFix, false, 'E3');
  assert.equal(access({ localStages: true, envFix: true }, { capability: 'scout' }).envFix, false);
  assert.equal(access({ envFix: true }, { capability: 'scout', envCheck: true }).envFix, true, 'P1 env-check step');
  assert.equal(access({ envFix: true }, { capability: 'accept' }).anyCommand, true, 'R2 acceptance checks and fixes');
  const writer = access({ writeAnywhere: true, localCopy: true }, { write: true, capability: 'implement' });
  assert.deepEqual([writer.localTools, writer.writeAnywhere, writer.localCopy, writer.anyCommand, writer.envFix], ['local-write', true, true, true, undefined]);
  assert.deepEqual(access({ writeAnywhere: true }, { write: true }).anyCommand, false, 'without localCopy the writer gets no shell');
  assert.deepEqual(access({ localStages: true }, { capability: 'review' }, { snapshot: {}, mode: 'review_only' }), {});
  assert.deepEqual(access({ localStages: true }, { capability: 'review' }, {}), {}, 'only tasks with a project snapshot');
  assert.deepEqual(access({ localStages: true }, { capability: 'review' }, { snapshot: {} }, 'desktop'), {});
  assert.match(S.accessNote({ localTools: 'local', anyCommand: true, envFix: true }), /local_env_fix/);
});

test('G-P1: one writer per project at a time; reading slots 6 in all and 4 per computer', async () => {
  const self = { config: {} };
  const first = await S.writeToken.call(self, 'w', undefined, { taskId: 'a' });
  let second = null;
  const waiting = S.writeToken.call(self, 'w', undefined, { taskId: 'b' }).then((release) => { second = release; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(second, null, 'the second writer waits');
  const other = await S.writeToken.call(self, 'x');   // another project is free
  other();
  first();
  await waiting;
  assert.equal(typeof second, 'function');
  await assert.rejects(S.writeToken.call(self, 'w', undefined, {}, 30), /env_fix_project_busy/);
  second();

  const slots = {};
  const take = (owner) => S.readSlot.call(slots, { owner });
  const mine = [];
  for (let index = 0; index < READ_SLOTS_PER_DEVICE; index += 1) mine.push(await take('mac'));
  let fifth = null;
  const pending = take('mac').then((release) => { fifth = release; });
  const theirs = [await take('windows'), await take('windows')];
  assert.equal(READ_SLOTS, 6);
  let seventh = null;
  const full = take('windows').then((release) => { seventh = release; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fifth, null);
  assert.equal(seventh, null, 'six in all');
  mine[0]();
  await pending;
  assert.equal(typeof fifth, 'function');
  theirs[0]();
  await full;
  for (const release of [...mine.slice(1), fifth, theirs[1], seventh]) release();
});

test('G-P1: with stageGroups a writer step holds the project token while it runs', async () => {
  const self = { config: {}, features: { stageGroups: true } };
  self.writeToken = S.writeToken.bind(self);
  self.readSlot = S.readSlot.bind(self);
  let heldDuring = false;
  self.runStepInner = async () => { heldDuring = self.writeTokens.has('w'); };
  await S.runStep.call(self, { workspace: 'w', id: 't' }, { write: true, role: 'codex' }, '', '', new AbortController().signal);
  assert.equal(heldDuring, true);
  assert.equal(self.writeTokens.has('w'), false, 'released afterwards');
});

test('N2 for environment fixes: no .git, credentials, absolute or escaping paths', () => {
  const patch = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x\n+y\n';
  assert.deepEqual(diffPaths(patch), ['src/a.js']);
  checkEnvNames(diffPaths(patch));
  assert.throws(() => checkEnvNames(['.git/config']), /git_path_denied/);
  assert.throws(() => checkEnvNames(['.ssh/config']), /credential_path_denied/);
  assert.throws(() => checkEnvNames(['/etc/hosts']), /path_escape/);
  assert.throws(() => checkEnvNames(['../x']), /path_escape/);
  assert.throws(() => checkEnvNames([]), /env_fix_empty/);
});

test('M2/O3 on a Mac: credential and AgentDesk folders closed, .git open, keychain service open, original closed in the copy', () => {
  const profile = mac.groupProfile({ home: '/Users/p', denyWrite: ['/Users/p/proj'] });
  assert.match(profile, /\/Users\/p\/\.ssh/);
  assert.match(profile, /\/Users\/p\/\.agentdesk/);
  assert.match(profile, /\(deny file-write\* \(subpath "\/Users\/p\/proj"\)\)/);
  assert.doesNotMatch(profile, /\.git"/);
  assert.doesNotMatch(profile, /mach-lookup/);
  assert.deepEqual(win.enforcement, { credentials: 'none', original: 'detect' }, 'Windows: nothing enforced, only detected');
  assert.ok(win.labels.credentials.includes('未强制') && win.labels.copy.includes('未强制'));
});

function project(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-v7b-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  sh(root, 'init', '-q');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, 'u.txt'), 'untracked\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'x\n');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ops = new WindowsOperations({ config: { stateDir, readAnyFolder: true, writeAnyFolder: true, workspaces: { p: { root, write: true } } }, store });
  let n = 0;
  const call = (kind, body) => ops.call({ task_id: 't1', message_id: 'm' + (n += 1), kind, body: { workspace: 'p', ...body } });
  return { base, root: fs.realpathSync(root), stateDir, ops, call };
}

test('Bridge: any command in the live project, the writer\'s local copy, its diff without secrets, Windows-style detection', async (t) => {
  const { root, stateDir, ops, call } = project(t);
  const shell = await call('command.execute', { operation: 'group_shell', script: 'echo hi; cat a.txt', credentialSandbox: true });
  assert.equal(shell.code, 0);
  assert.match(shell.stdout, /hi\none/);
  assert.equal(shell.location, 'project');
  const { head, version } = await ops.projectSnapshot(root, new AbortController().signal);
  const change = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n';
  const { stream_id } = await ops.saveArtifact('t1', Buffer.from(change));
  await assert.rejects(call('command.execute', { operation: 'copy_sync', stepId: 'impl', base: head, snapshotVersion: 'other', stream_id }), /plan_workspace_changed/);
  const synced = await call('command.execute', { operation: 'copy_sync', stepId: 'impl', base: head, snapshotVersion: version, stream_id });
  assert.equal(synced.created, true);
  const copy = path.join(stateDir, 'group-copies', 't1', 'impl');
  assert.equal(fs.readFileSync(path.join(copy, 'a.txt'), 'utf8'), 'two\n');
  assert.ok(fs.existsSync(path.join(copy, '.env')) && fs.existsSync(path.join(copy, 'node_modules', 'dep', 'index.js')), 'ignored files come along (M3)');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n', 'the original is untouched');
  const inCopy = await call('command.execute', { operation: 'group_shell', copy: true, stepId: 'impl', script: 'echo built > out.txt; echo K=1 > .env.local' });
  assert.equal(inCopy.location, 'copy');
  assert.equal(inCopy.originalChanged, undefined);
  assert.ok(inCopy.enforcement.labels.length, 'Linux/Windows say nothing is enforced');
  const diff = await call('command.execute', { operation: 'copy_diff', stepId: 'impl' });
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.kept, ['.env.local']);
  const bytes = fs.readFileSync(ops.streamPath(diff.artifact.stream_id), 'utf8');
  assert.match(bytes, /out\.txt/);
  assert.match(bytes, /\+two/);
  assert.doesNotMatch(bytes, /K=1/, 'secrets stay on the computer');
  // Windows: the original cannot be closed, but a change to it is reported.
  const touched = await call('command.execute', { operation: 'group_shell', copy: true, stepId: 'impl', script: `echo extra >> ${JSON.stringify(path.join(root, 'a.txt'))}` });
  assert.equal(touched.originalChanged, true);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await call('command.execute', { operation: 'copy_remove' });
  assert.equal(fs.existsSync(copy), false);
});

test('Bridge: environment fix with its previous content kept, undo, N2 refusals, and outside-project backups (R1)', async (t) => {
  const { base, root, ops, call } = project(t);
  const signal = new AbortController().signal;
  const before = (await ops.projectSnapshot(root, signal)).version;
  const fix = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+one-fixed\n' +
    'diff --git a/tool.cfg b/tool.cfg\nnew file mode 100644\n--- /dev/null\n+++ b/tool.cfg\n@@ -0,0 +1 @@\n+PATH_FIX=1\n';
  const stream = (text) => ops.saveArtifact('t1', Buffer.from(text)).then((value) => value.stream_id);
  await assert.rejects(call('command.execute', { operation: 'env_fix_apply', fixId: 'f0', stream_id: await stream(fix), expectVersion: 'stale' }), /plan_workspace_changed/);
  const applied = await call('command.execute', { operation: 'env_fix_apply', fixId: 'f1', stream_id: await stream(fix), expectVersion: before });
  assert.deepEqual(applied.files.sort(), ['a.txt', 'tool.cfg']);
  assert.equal(applied.before, before);
  assert.notEqual(applied.after, before);
  assert.equal(fs.readFileSync(path.join(root, 'tool.cfg'), 'utf8'), 'PATH_FIX=1\n');
  const undone = await call('command.execute', { operation: 'env_fix_revert', fixId: 'f1', snapshot: true });
  assert.equal(undone.version, before);
  assert.equal(fs.existsSync(path.join(root, 'tool.cfg')), false);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  await assert.rejects(call('command.execute', { operation: 'env_fix_revert', fixId: 'f1' }), /already_reverted/);
  const credential = 'diff --git a/.npmrc b/.npmrc\nnew file mode 100644\n--- /dev/null\n+++ b/.npmrc\n@@ -0,0 +1 @@\n+x\n';
  await assert.rejects(call('command.execute', { operation: 'env_fix_apply', fixId: 'f2', stream_id: await stream(credential) }), /credential_path_denied/);
  const git = 'diff --git a/.git/hooks/x b/.git/hooks/x\nnew file mode 100644\n--- /dev/null\n+++ b/.git/hooks/x\n@@ -0,0 +1 @@\n+x\n';
  await assert.rejects(call('command.execute', { operation: 'env_fix_apply', fixId: 'f3', stream_id: await stream(git) }), /git_path_denied|env_fix_invalid_patch/);
  // R1: a file outside the project is backed up before it is overwritten, and can be put back.
  const outside = path.join(base, 'settings.ini');
  fs.writeFileSync(outside, 'old\n');
  const written = await call('file.write', { root: 'computer', anyFolder: true, operation: 'write', path: outside, version: sha('old\n'), stream_id: await stream('new\n'), backup: true });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'new\n');
  assert.equal(written.backups.length, 1);
  await call('command.execute', { operation: 'outside_restore', backupId: written.backups[0] });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'old\n');
});

function cloud(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-v7b-cloud-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const repo = path.join(stateDir, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  sh(repo, 'init', '-q');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  const head = sh(repo, 'rev-parse', 'HEAD').trim();
  const root = path.join(stateDir, 'worktrees', 'T');
  fs.mkdirSync(root, { recursive: true });
  sh(repo, 'worktree', 'add', '-q', '-b', 'impl', path.join(root, 'impl'), head);
  fs.writeFileSync(path.join(root, 'impl', 'b.txt'), 'b changed\n');
  fs.writeFileSync(path.join(root, 'impl.patch'), 'old');
  const task = { id: 'T', workspace: 'w', base: head, snapshot: { head, version: 'v1', base: head }, groupPlan: { base: head }, owner: 'mac',
    steps: [{ id: 'impl', role: 'codex', write: true, state: 'completed', paths: ['b.txt'] }, { id: 'rev', role: 'grok', capability: 'review', state: 'running' }] };
  const saved = [];
  const self = Object.create(S);
  Object.assign(self, { config: { stateDir, workspaces: { w: { repository: repo } } }, features: { envFix: true }, now: () => Date.parse('2026-11-22T05:00:00Z'),
    tasks: new Map([['T', task]]), running: new Map(), save: (item, state, detail) => saved.push(detail), bridgeRoute: () => 'route' });
  return { self, task, root, repo, saved };
}

const ENV = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+one-fixed\n';

test('P1/E8: an environment fix reaches the person\'s project and the cloud; the writer\'s patch no longer carries it', async (t) => {
  const { self, task, root, saved } = cloud(t);
  const sent = [];
  self.files = {
    upload: async (route, id, bytes) => { sent.push(bytes.toString()); return 'stream-1'; },
    call: async (route, id, kind, body) => { sent.push(body); return { applied: true, files: ['a.txt'], before: 'v1', after: 'v2' }; },
  };
  const value = await self.envFix({ taskId: 'T', stepId: 'rev', workspace: 'w' }, { patch: ENV, reason: '本机缺少配置', platformSource: true });
  assert.equal(value.applied, true);
  assert.equal(value.cloud, 'synced');
  const body = sent.find((item) => item.operation === 'env_fix_apply');
  assert.equal(body.expectVersion, 'v1');
  const fix = task.envFixes[0];
  assert.deepEqual([fix.state, fix.stage, fix.platformSource, fix.cloud], ['applied', 'review', true, 'synced']);
  assert.equal(task.snapshot.version, 'v2', 'apply() now expects the fixed project');
  assert.notEqual(task.base, task.snapshot.head, 'a new snapshot commit carries the fix');
  assert.equal(fs.readFileSync(path.join(root, 'project-snapshot', 'a.txt'), 'utf8'), 'one-fixed\n');
  assert.equal(fs.readFileSync(path.join(root, 'impl', 'a.txt'), 'utf8'), 'one-fixed\n');
  const patch = fs.readFileSync(path.join(root, 'impl.patch'), 'utf8');
  assert.match(patch, /b changed/);
  assert.doesNotMatch(patch, /one-fixed/);
  assert.ok(saved.some((detail) => /^env_fix_cloud_synced/.test(detail)));
  // Undo: the project and the cloud go back.
  self.files.call = async () => ({ reverted: true, version: 'v1' });
  const undone = await self.revertEnvFix(task, fix.id);
  assert.equal(undone.reverted, true);
  assert.equal(task.snapshot.version, 'v1');
  assert.equal(fs.readFileSync(path.join(root, 'impl', 'a.txt'), 'utf8'), 'one\n');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'impl.patch'), 'utf8'), /one/);
});

test('E10 and old Bridges: a lost reply is asked for again; an old Bridge says it needs an update', async (t) => {
  const { self, task } = cloud(t);
  self.files = { upload: async () => 'stream', call: async () => { throw new Error('relay_timeout'); } };
  await assert.rejects(self.envFix({ taskId: 'T', stepId: 'rev', workspace: 'w' }, { patch: ENV, reason: 'r' }), /relay_timeout/);
  assert.equal(task.envFixes[0].state, 'unknown');
  self.files.call = async (route, id, kind, body) => {
    assert.equal(body.operation, 'operation_status');
    return { state: 'finished', kind: 'value', outcome: { value: { applied: true, files: ['a.txt'], after: 'v2' } } };
  };
  await self.reconcileEnvFixes();
  assert.deepEqual([task.envFixes[0].state, task.envFixes[0].cloud, task.snapshot.version], ['applied', 'synced', 'v2']);
  self.files.call = async () => { throw Object.assign(new Error('command_not_authorized'), { remoteConfirmed: true }); };
  await assert.rejects(self.envFix({ taskId: 'T', stepId: 'rev', workspace: 'w' }, { patch: ENV.replace('one-fixed', 'two'), reason: 'r' }), /bridge_update_required/);
  assert.equal(task.envFixes[1].state, 'failed');
  await assert.rejects(self.envFix({ taskId: 'T', stepId: 'rev', workspace: 'w' }, { patch: ENV, reason: '' }), /env_fix_reason_required/);
  await assert.rejects(self.groupShell({ taskId: 'T', stepId: 'rev', workspace: 'w' }, { script: 'ls' },
    async () => { throw Object.assign(new Error('command_not_authorized'), { remoteConfirmed: true }); }), /bridge_update_required/);
});

test('E9: a fix waits for the task\'s running writer; one that would wait for its own CLI is refused', async (t) => {
  const { self, task } = cloud(t);
  task.steps[0].state = 'running';
  task.steps[0].role = 'grok';
  await assert.rejects(self.waitWriters(task, task.steps[1], undefined), /env_fix_wait_writer/);
  task.steps[0].role = 'codex';
  setTimeout(() => { task.steps[0].state = 'completed'; }, 50);
  await self.waitWriters(task, task.steps[1], undefined);
});

test('P1: a failed local test first gets an env-check step; with the switch off it goes back to the writer as before', () => {
  const make = (features) => ({ features, now: () => 0, save() {}, pickForTask: () => 'grok', orderModels: () => [], defaultModelFor: () => 'grok-4.7' });
  const task = { steps: [] };
  const evidence = {};
  assert.equal(S.scheduleEnvCheck.call(make({ envFix: true }), task, evidence, 'ENOENT /usr/local/bin/tool'), true);
  assert.equal(task.steps[0].envCheck, true);
  assert.match(task.steps[0].prompt, /ENOENT/);
  assert.equal(S.scheduleEnvCheck.call(make({ envFix: true }), task, evidence, 'again'), false, 'once per failed result');
  assert.equal(S.scheduleEnvCheck.call(make({}), { steps: [] }, {}, 'x'), false);
});

test('requirement 4: the next lead-chain member writes the advice; the member whose plan failed is skipped', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-v7b-advice-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let asked;
  const self = Object.create(S);
  Object.assign(self, {
    features: { leadAdvice: true }, config: { stateDir, adapters: { claude: {}, codex: {}, grok: {} } }, now: () => 0, save() {},
    router: { routes: { plan: ['claude', 'codex'] }, roles: () => ['claude', 'codex', 'grok'], available: () => true, configured: () => true, quotaAllows: () => true },
    orderEntries: () => [], orderModels: () => [], defaultModelFor: (role) => role + '-default', acquireCli: async () => () => {},
    adapter: async (call) => { asked = call; return { output: '说明如下```json\n{"reason":"需求太大","options":[{"role":"grok","access":"readOnly","prompt":"先列出要改的文件","why":"先摸清"},{"role":"nobody","prompt":"x"}]}\n```' }; },
  });
  const task = { id: 'T', prompt: '重构登录', cliCalls: [{ capability: 'plan', provider: 'claude' }], directAdvice: { reason: '规则', options: [], detail: 'plan_failed' } };
  await self.adviseByLead(task, 'plan_failed');
  assert.equal(asked.name, 'codex');
  assert.equal(asked.readonly, true);
  assert.deepEqual([task.directAdvice.source, task.directAdvice.by, task.directAdvice.reason], ['lead', 'codex', '需求太大']);
  assert.deepEqual(task.directAdvice.options.map((option) => [option.role, option.model, option.access]), [['grok', 'grok-default', 'readOnly']]);
  // A reply that is not usable leaves the rule-based advice in place.
  const kept = { id: 'U', prompt: 'x', directAdvice: { reason: '规则', options: [] } };
  self.adapter = async () => ({ output: 'no json' });
  await self.adviseByLead(kept, 'plan_failed');
  assert.equal(kept.directAdvice.source, undefined);
});

test('the new control operations are on all allow-lists', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['orchestrator/service.js', 'main.js']) {
    assert.match(read(file), /'env_fix_revert'/);
    assert.match(read(file), /'outside_restore'/);
  }
  assert.match(read('orchestrator/scheduler.js'), /body\.operation === 'env_fix_revert'/);
});

test('end to end with every switch on: the writer runs in its local copy, review fixes the environment, the patch still applies', async (t) => {
  const { Scheduler: Sched } = require('../orchestrator/scheduler');
  const { RemoteFiles } = require('../orchestrator/windows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-v7b-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'base\n');
  sh(workspace, 'init', '-q');
  sh(workspace, 'add', '.');
  sh(workspace, 'commit', '-qm', 'base');
  execFileSync('git', ['clone', '-q', '--bare', workspace, path.join(dir, 'mirror.git')]);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'working\n');   // an uncommitted change rides in the snapshot
  const capabilities = new Map();
  const scopes = {};
  let scheduler;
  const replies = [
    () => ({ output: JSON.stringify({ summary: '改 README', steps: [
      { id: 'edit', capability: 'implement', prompt: 'edit readme' },
      { id: 'rev', capability: 'review', prompt: 'review', dependsOn: ['edit'] }] }) }),
    async ({ cwd, mcp }) => {
      const scope = capabilities.get(mcp.capability);
      scopes.writer = { mcpScope: mcp.scope, writeFiles: scope.writeFiles, localCopy: scope.localCopy, envFix: scope.envFix };
      fs.writeFileSync(path.join(cwd, 'README.md'), 'working\nagent\n');
      // A local tool in the copy sees the writer's change, and what it writes comes back to the working tree.
      const run = (body) => scheduler.files.runCommand(() => 'r', scope.taskId, body, { signal: scope.signal });
      scopes.shell = await scheduler.groupShell(scope, { script: 'cp README.md seen.txt' }, run);
      scopes.seen = fs.readFileSync(path.join(cwd, 'seen.txt'), 'utf8');
      return { output: 'done' };
    },
    async ({ mcp }) => {
      const scope = capabilities.get(mcp.capability);
      scopes.review = { mcpScope: mcp.scope, envFix: scope.envFix, anyCommand: scope.anyCommand, writeFiles: scope.writeFiles };
      scopes.fix = await scheduler.envFix(scope, { reason: '本机缺少工具配置',
        patch: 'diff --git a/tool.cfg b/tool.cfg\nnew file mode 100644\n--- /dev/null\n+++ b/tool.cfg\n@@ -0,0 +1 @@\n+LOCAL=1\n' });
      return { output: 'VERDICT: pass' };
    },
  ];
  scheduler = new Sched({
    config: {
      stateDir: dir, quota: false, acceptance: { mode: 'off' }, groupFeatures: Object.fromEntries(NEW.map((name) => [name, true])),
      adapters: Object.fromEntries(['codex', 'claude', 'grok'].map((name) => [name, { bin: name, env: {} }])),
      workspaces: { mac: { repository: path.join(dir, 'mirror.git') } },
      mcp: { socket: path.join(dir, 'mcp.sock'), capabilities },
    },
    store: new Store(':memory:'), files: { endpoint: {} },
    adapter: async (options) => replies.shift()(options),
  });
  t.after(() => scheduler.store.close());
  const bridge = new WindowsOperations({ store: scheduler.store,
    config: { stateDir: path.join(dir, 'bridge'), readAnyFolder: true, writeAnyFolder: true, workspaces: { mac: { root: workspace, write: true } } } });
  scheduler.files = new RemoteFiles({ request: (_route, taskId, kind, body, _timeout, requestId) =>
    bridge.call({ task_id: taskId, kind, body, message_id: requestId }) });
  const task = scheduler.submit(require('node:crypto').randomUUID(), { workspace: 'mac', prompt: 'edit readme' }, true);
  const signal = new AbortController().signal;
  await scheduler.run(task, signal);
  assert.equal(task.state, 'awaiting_approval', JSON.stringify(task.groupPlan?.rounds?.at(-1)));
  scheduler.approveRound(task, task.groupPlan.rounds.at(-1));
  await scheduler.run(task, signal);
  assert.equal(task.detail, 'patches_ready', task.detail);
  assert.deepEqual(scopes.writer, { mcpScope: 'local-write', writeFiles: true, localCopy: true, envFix: false });
  assert.equal(scopes.shell.location, 'copy');
  assert.equal(scopes.shell.copy.taken, true);
  assert.equal(scopes.seen, 'working\nagent\n');
  assert.deepEqual(scopes.review, { mcpScope: 'local', envFix: true, anyCommand: true, writeFiles: true });
  assert.equal(scopes.fix.cloud, 'synced');
  assert.equal(fs.readFileSync(path.join(workspace, 'tool.cfg'), 'utf8'), 'LOCAL=1\n');
  const patch = fs.readFileSync(path.join(dir, 'worktrees', task.id, 'edit.patch'), 'utf8');
  assert.match(patch, /seen\.txt/);
  assert.doesNotMatch(patch, /tool\.cfg/, 'the environment fix is part of the new base, not of the writer\'s patch');
  await scheduler.apply(task);
  assert.equal(task.state, 'completed', task.detail);
  assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), 'working\nagent\n');
  assert.equal(fs.readFileSync(path.join(workspace, 'tool.cfg'), 'utf8'), 'LOCAL=1\n');
  assert.equal(fs.existsSync(path.join(dir, 'bridge', 'group-copies', task.id)), false, 'the copy goes when the task ends');
});
