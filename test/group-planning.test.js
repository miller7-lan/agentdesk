const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

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
    adapter: async ({ name, prompt, mcp }) => {
      prompts.push(prompt);
      if (mcp) {
        const scope = capabilities.get(mcp.capability);
        mcps.push({ name, runCommands: scope?.runCommands, readAnyFolder: scope?.readAnyFolder });
      }
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return { output: reply ?? '' };
    },
  });
  t.after(() => scheduler.store.close());
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'move my desktop project into the repo' }, true);
  task.groupPlan.base = head;
  return { scheduler, task, prompts, mcps };
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
