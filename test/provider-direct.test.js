const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');
const { providers } = require('../orchestrator/adapters');
const { Router } = require('../orchestrator/routing');
const roles = ['codex', 'claude', 'grok', 'gemini', 'antigravity'];

test('each enabled provider can generate a direct-edit patch; the local file changes only on apply', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-direct-'));
  const root = path.join(dir, 'local');
  const mirror = path.join(dir, 'mirror.git');
  await fs.mkdir(root);
  const git = (cwd, args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  git(root, ['init']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(root, 'note.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','base']);
  const head = git(root, ['rev-parse','HEAD']);
  git(dir, ['clone','--bare',root,mirror]);
  const store = new Store(':memory:');
  const config = { stateDir: path.join(dir, 'server'), quota: false, writeProviders: roles,
    adapters: Object.fromEntries(roles.map(role => [role, { bin: role, env: {} }])),
    workspaces: { project: { repository: mirror } } };
  const calls = [];
  const scheduler = new Scheduler({ config, store,
    files: { endpoint: {}, call: async () => ({ head, clean: true }),
      patch: async (_route, _id, _workspace, base, patch) => {
        assert.equal(base, head); git(root, ['apply','--binary','-'], patch); return { applied: true };
      } },
    adapter: async ({ name, cwd, readonly }) => {
      calls.push(name); assert.equal(readonly, false);
      await fs.writeFile(path.join(cwd, 'note.txt'), name + '\n');
      return { output: 'edited by ' + name };
    } });
  scheduler.stopped = true;
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  for (const provider of roles) {
    const task = scheduler.submit(randomUUID(), { workspace: 'project', provider, mode: 'edit', prompt: 'edit note.txt' }, true);
    assert.equal(task.groupPlan, undefined);
    await scheduler.run(task, new AbortController().signal);
    assert.equal(task.detail, 'patches_ready', provider);
    assert.equal(await fs.readFile(path.join(root,'note.txt'),'utf8'), 'base\n');
    assert.equal(task.steps.length, 1);
    assert.equal(task.steps[0].role, provider);
    assert.equal(task.steps[0].write, true);
    await scheduler.apply(task);
    assert.equal(await fs.readFile(path.join(root,'note.txt'),'utf8'), provider + '\n');
    await fs.writeFile(path.join(root,'note.txt'),'base\n');
  }
  assert.deepEqual(calls, roles);
});

test('Gemini edit permission does not change its read-only invocation', () => {
  const read = providers.gemini.args('hello', true);
  const write = providers.gemini.args('hello', false);
  assert.equal(read[read.indexOf('--approval-mode') + 1], 'default');
  assert.equal(write[write.indexOf('--approval-mode') + 1], 'auto_edit');
});

test('Gemini policies allow web reading in every step and writing only when the step may write', async (t) => {
  const { providerSettings } = require('../orchestrator/service');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-gemini-policy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settings = { bin: process.execPath, sandbox: true, allowWrites: true };
  const adapter = providerSettings(settings, 'gemini', path.join(dir, 'home'));
  const review = await fs.readFile(adapter.reviewPolicy, 'utf8');
  const write = await fs.readFile(adapter.writePolicy, 'utf8');
  for (const policy of [review, write]) {
    for (const tool of ['google_web_search', 'web_fetch', 'read_file', 'read_many_files', 'run_shell_command']) {
      assert.ok(policy.includes('"' + tool + '"'), tool);
    }
  }
  assert.ok(!review.includes('"write_file"'));
  assert.ok(write.includes('"write_file"') && write.includes('"replace"'));
});

test('Codex enables live web search before exec for fresh and resumed, read and write steps', () => {
  for (const readonly of [true, false]) {
    for (const session of [undefined, 'session']) {
      const args = providers.codex.args('hello', readonly, session);
      assert.equal(args[0], '--search');
      assert.equal(args[1], 'exec');
      if (session) assert.equal(args[2], 'resume');
    }
  }
});

test('Claude steps can search and fetch the web while read-only steps still deny editing tools', () => {
  for (const readonly of [true, false]) {
    const args = providers.claude.args('hello', readonly);
    const allowed = args[args.indexOf('--allowedTools') + 1].split(',');
    for (const tool of ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']) assert.ok(allowed.includes(tool), tool);
    if (readonly) {
      const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
      for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit']) assert.ok(denied.includes(tool), tool);
    }
  }
});

test('Grok headless edits receive an explicit Edit allow rule while read-only mode denies it', () => {
  const read = providers.grok.args('hello', true, 'session');
  const write = providers.grok.args('hello', false, 'session');
  assert.ok(read.some((arg, i) => arg === '--deny' && read[i + 1] === 'Edit'));
  assert.ok(write.some((arg, i) => arg === '--allow' && write[i + 1] === 'Edit'));
  assert.ok(write.some((arg, i) => arg === '--deny' && write[i + 1] === 'Bash'));
  for (const args of [read, write]) {
    assert.ok(args.some((arg, i) => arg === '--allow' && args[i + 1] === 'WebSearch'));
    assert.ok(args.some((arg, i) => arg === '--allow' && args[i + 1] === 'WebFetch'));
    assert.ok(args.some((arg, i) => arg === '--allow' && args[i + 1] === 'Fetch'));
  }
});

test('explicit direct edits can use reserved Claude quota but cannot bypass the hard quota limit', () => {
  const router = new Router({ adapters: { claude: {} }, writeProviders: ['claude'] });
  router.setQuota([{ provider: 'claude', buckets: [{ weekly: { usedPercent: 63 } }] }]);
  assert.equal(router.quotaAllows('claude', 'implement'), false);
  assert.equal(router.quotaAllowsDirect('claude'), true);
  router.setQuota([{ provider: 'claude', buckets: [{ fiveHour: { usedPercent: 100 } }] }]);
  assert.equal(router.quotaAllowsDirect('claude'), false);
});
