const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');
const { WindowsOperations, RemoteFiles } = require('../orchestrator/windows');

function setup(t, replies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(workspace, 'init', '-q');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'base');
  const head = git(workspace, 'rev-parse', 'HEAD');
  git(dir, 'clone', '-q', '--bare', workspace, path.join(dir, 'mirror.git'));
  const prompts = [];
  const mcps = [];
  const capabilities = new Map();
  const scheduler = new Scheduler({
    config: {
      stateDir: dir, quota: false, acceptance: { mode: 'off' },
      adapters: Object.fromEntries(['codex', 'claude', 'grok'].map((name) => [name, { bin: name, env: {} }])),
      workspaces: { mac: { repository: path.join(dir, 'mirror.git') } },
      mcp: { socket: path.join(dir, 'mcp.sock'), capabilities },
    },
    store: new Store(':memory:'),
    files: { endpoint: {} },
    adapter: async (options) => {
      const { name, prompt, mcp } = options;
      prompts.push(prompt);
      if (mcp) {
        const scope = capabilities.get(mcp.capability);
        mcps.push({ name, runCommands: scope?.runCommands, readAnyFolder: scope?.readAnyFolder });
      }
      const reply = replies.shift();
      if (typeof reply === 'function') return reply(options);
      if (reply instanceof Error) throw reply;
      return { output: reply ?? '' };
    },
  });
  t.after(() => scheduler.store.close());
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'move my desktop project into the repo' }, true);
  task.groupPlan.base = head;
  return { scheduler, task, prompts, mcps, workspace, git, head };
}

test('a lead reply with text around fenced JSON and long questions still becomes questions', async (t) => {
  const long = '你 Mac 桌面上的目录我们这边读不到，也写不进去：' + '说明'.repeat(300);
  const { scheduler, task, prompts, mcps } = setup(t, [
    '我先看了一下仓库。\n```json\n' + JSON.stringify({ questions: [long, '客户端是哪几个？'] }) + '\n```\n以上。',
  ]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'awaiting_details');
  assert.equal(task.detail, 'plan_questions');
  const round = task.groupPlan.rounds.at(-1);
  assert.equal(round.questions.length, 2);
  assert.ok(round.questions[0].length <= 1200);
  // The lead can read the person's computer while planning, but never run commands there.
  assert.match(prompts[0], /windows_list_locations/);
  assert.deepEqual(mcps, [{ name: 'claude', runCommands: false, readAnyFolder: true }]);
});

test('a reply that cannot be used is sent back once, then becomes a question the person can answer', async (t) => {
  const { scheduler, task, prompts } = setup(t, ['好的，我来规划。', '还是一段话。',
    JSON.stringify({ summary: '按方案修改', steps: [{ id: 'edit', capability: 'implement', prompt: 'do it', dependsOn: [] }] })]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /could not be used/);
  assert.equal(task.state, 'awaiting_details');
  assert.equal(task.detail, 'plan_failed');
  assert.match(task.groupPlan.rounds.at(-1).questions[0], /没能整理成问题或方案/);

  // Answering in the same conversation plans again; this time the lead returns a plan.
  scheduler.updatePlan(task, { operation: 'plan_reply', revision: task.groupPlan.rounds.at(-1).revision, reply: '重试' });
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'awaiting_approval');
  assert.equal(task.groupPlan.rounds.at(-1).summary, '按方案修改');
});

test('a CLI error while planning is explained to the person instead of failing the task', async (t) => {
  const { scheduler, task } = setup(t, [new Error('cli_exit_1')]);
  await scheduler.run(task, new AbortController().signal);
  assert.equal(task.state, 'awaiting_details');
  assert.match(task.groupPlan.rounds.at(-1).questions[0], /规划出错了：cli_exit_1/);
});

test('a new group pins the working project, resumes a stalled writer and checks the version on apply', async (t) => {
  let writerModel;
  const content = (cwd, name) => fs.readFileSync(path.join(cwd, name), 'utf8').replace(/\r\n/g, '\n');
  const { scheduler, task, workspace, git, head, mcps } = setup(t, [
    ({ cwd, mcp }) => {
      // The lead reads the project from the snapshot and keeps read tools for files outside it only.
      assert.equal(mcp.scope, 'files');
      assert.equal(content(cwd, 'README.md'), 'working\n');
      assert.equal(content(cwd, '加入.txt'), 'new\n');
      // New files come along unless .gitignore excludes them; secret-looking files never do.
      assert.equal(content(cwd, 'private.txt'), 'untracked\n');
      assert.equal(fs.existsSync(path.join(cwd, 'build.log')), false);
      assert.equal(fs.existsSync(path.join(cwd, '.env')), false);
      return { output: JSON.stringify({ summary: '修改项目', steps: [
        { id: 'edit', capability: 'implement', prompt: 'edit readme' },
      ] }) };
    },
    ({ cwd, model, onSession }) => {
      writerModel = model;
      fs.writeFileSync(path.join(cwd, 'README.md'), 'working\nagent\n');
      onSession('writer-session');
      throw new Error('cli_stalled: quiet');
    },
    ({ cwd, model, session, prompt }) => {
      assert.equal(session, 'writer-session');
      assert.equal(model, writerModel);
      assert.equal(fs.readFileSync(path.join(cwd, 'README.md'), 'utf8'), 'working\nagent\n');
      assert.match(prompt, /Continue only unfinished work/);
      return { output: 'done' };
    },
  ]);
  delete task.groupPlan.base;
  const readme = path.join(workspace, 'README.md');
  fs.writeFileSync(readme, 'staged\n');
  git(workspace, 'add', 'README.md');
  fs.writeFileSync(readme, 'working\n');
  fs.writeFileSync(path.join(workspace, '加入.txt'), 'new\n');
  git(workspace, 'add', '-N', '加入.txt');
  fs.writeFileSync(path.join(workspace, 'private.txt'), 'untracked\n');
  fs.writeFileSync(path.join(workspace, '.git', 'info', 'exclude'), 'build.log\n');
  fs.writeFileSync(path.join(workspace, 'build.log'), 'ignored\n');
  fs.writeFileSync(path.join(workspace, '.env'), 'TOKEN=secret\n');
  const bridge = new WindowsOperations({ store: scheduler.store,
    config: { stateDir: path.join(path.dirname(workspace), 'bridge'), workspaces: { mac: { root: workspace, write: true } } } });
  scheduler.files = new RemoteFiles({ request: (_route, taskId, kind, body, _timeout, requestId) =>
    bridge.call({ task_id: taskId, kind, body, id: requestId }) });
  const signal = new AbortController().signal;
  await scheduler.run(task, signal);
  assert.equal(task.state, 'awaiting_approval', JSON.stringify(task.groupPlan.rounds.at(-1)));
  assert.equal(task.snapshot.head, head);
  assert.deepEqual(task.snapshotSkipped, ['.env']);
  assert.notEqual(task.snapshot.base, head);
  scheduler.approveRound(task, task.groupPlan.rounds.at(-1));
  await scheduler.run(task, signal);
  // Only the lead's planning had the (read, outside the project) tools; the writer worked on the snapshot alone.
  assert.deepEqual(mcps.map((entry) => entry.name), ['claude']);
  assert.equal(task.steps[0].state, 'completed');
  assert.equal(task.steps[0].attempts, 2);
  assert.equal(task.detail, 'patches_ready');
  assert.equal(fs.readFileSync(readme, 'utf8'), 'working\n');
  const delta = fs.readFileSync(path.join(scheduler.config.stateDir, 'worktrees', task.id, 'edit.patch'));
  fs.appendFileSync(readme, 'changed after planning\n');
  await assert.rejects(scheduler.files.patch('unused', task.id, 'mac', task.snapshot.head,
    delta, randomUUID(), signal, task.snapshot.version), /plan_workspace_changed/);
  assert.equal(fs.readFileSync(readme, 'utf8'), 'working\nchanged after planning\n');
  fs.writeFileSync(readme, 'working\n');
  await scheduler.apply(task);
  assert.equal(task.state, 'completed');
  assert.equal(content(workspace, 'README.md'), 'working\nagent\n');
  assert.equal(git(workspace, 'show', ':README.md'), 'staged');
  assert.equal(fs.readFileSync(path.join(workspace, 'private.txt'), 'utf8'), 'untracked\n');
});
