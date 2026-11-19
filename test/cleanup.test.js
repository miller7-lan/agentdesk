const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup, retention, historyCandidates } = require('../orchestrator/cleanup');

const DAY = 86400_000;
const now = Date.parse('2026-11-20T12:00:00Z');
const ago = (days) => new Date(now - days * DAY).toISOString();

function setup(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-gc-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  // A mirror with a registered worktree and branch, as a task step leaves behind.
  const repo = path.join(stateDir, 'mirror');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const tasks = [
    { id: 'old-done', state: 'completed', updatedAt: ago(4) },
    { id: 'new-done', state: 'completed', updatedAt: ago(1) },
    { id: 'old-failed', state: 'failed', updatedAt: ago(5) },
    { id: 'older-failed', state: 'failed', updatedAt: ago(8) },
    { id: 'review', state: 'needs_review', updatedAt: ago(30) },
    { id: 'running', state: 'completed', updatedAt: ago(10) },
  ];
  for (const task of tasks) {
    task.workspace = 'p';
    for (const dir of ['worktrees', 'logs']) {
      fs.mkdirSync(path.join(stateDir, dir, task.id), { recursive: true });
      fs.writeFileSync(path.join(stateDir, dir, task.id, 'file'), 'x'.repeat(100));
    }
  }
  git(repo, 'worktree', 'add', '-q', '-b', 'agentdesk/old-done/edit', path.join(stateDir, 'worktrees', 'old-done', 'edit'));
  const config = { stateDir, workspaces: { p: { repository: repo } } };
  return { stateDir, repo, tasks, config, git };
}

test('finished tasks are cleared after 3 days (failed after 7); review, running and recent tasks are kept', async (t) => {
  const { stateDir, repo, tasks, config, git } = setup(t);
  const result = await cleanup({ tasks, running: new Set(['running']), config, now, statfs: async () => ({ blocks: 100, bavail: 60 }) });
  assert.deepEqual(result.cleared.sort(), ['old-done', 'older-failed']);
  for (const id of ['old-done', 'older-failed']) assert.ok(!fs.existsSync(path.join(stateDir, 'worktrees', id)));
  for (const id of ['new-done', 'old-failed', 'review', 'running']) assert.ok(fs.existsSync(path.join(stateDir, 'worktrees', id)));
  assert.equal(git(repo, 'branch', '--list', 'agentdesk/*'), '', 'the step branch was deleted');
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /old-done/, 'the worktree registration was pruned');
  assert.ok(tasks.find((task) => task.id === 'old-done').cleanedAt);
  assert.equal(result.pendingReview, 1);
  assert.ok(result.freedBytes >= 400);
  // A second pass has nothing left to do for the same tasks.
  assert.deepEqual((await cleanup({ tasks, running: new Set(), config, now, statfs: async () => ({ blocks: 100, bavail: 60 }) })).cleared, ['running']);
});

test('low on disk: the oldest finished tasks go early, but never one awaiting review', async (t) => {
  const { tasks, config } = setup(t);
  let free = 5;   // each cleared task frees 2% in this test
  const result = await cleanup({ tasks, running: new Set(), config, now,
    statfs: async () => ({ blocks: 100, bavail: free }), onCleared: () => { free += 2; } });
  // The age-based pass clears three tasks (to 11% free); still below 15%, so the oldest remaining finished
  // tasks go early, oldest first: old-failed (5 days), then new-done (1 day). The review task stays.
  assert.deepEqual(result.cleared, ['running', 'older-failed', 'old-done', 'old-failed', 'new-done']);
  assert.ok(!result.cleared.includes('review'));
  assert.equal(result.freePercent, 15);
  assert.equal(result.lowDisk, false);
});

test('retention settings are checked', () => {
  assert.deepEqual(retention({ completedDays: 1 }), {
    completedDays: 1, failedDays: 7, minFreePercent: 15, historyDays: 60, uploadDays: 7,
  });
  assert.throws(() => retention({ failedDays: -1 }), /invalid_retention:failedDays/);
  assert.throws(() => retention({ minFreePercent: 95 }), /invalid_retention:minFreePercent/);
  assert.throws(() => retention({ historyDays: -1 }), /invalid_retention:historyDays/);
  assert.throws(() => retention({ uploadDays: 'soon' }), /invalid_retention:uploadDays/);
});

test('history candidates exclude running, review and referenced tasks', () => {
  const tasks = [
    { id: 'old', state: 'completed', updatedAt: ago(61) },
    { id: 'recent', state: 'completed', updatedAt: ago(59) },
    { id: 'review', state: 'needs_review', updatedAt: ago(90) },
    { id: 'running', state: 'completed', updatedAt: ago(90) },
    { id: 'referenced', state: 'failed', updatedAt: ago(90) },
  ];
  const got = historyCandidates(tasks, new Set(['running']), now, retention({}), { referenced: new Set(['referenced']) });
  assert.deepEqual(got.map((task) => task.id), ['old']);
});

test('old uploads and orphan worktree/log folders are removed after the history window', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-gc-uploads-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const uploads = path.join(stateDir, 'desktop-workspace', '.agentdesk-uploads');
  fs.mkdirSync(uploads, { recursive: true });
  for (const [name, at] of [['old.txt', now - 61 * DAY], ['new.txt', now - DAY]]) {
    const file = path.join(uploads, name);
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at / 1000, at / 1000);
  }
  const knownId = '11111111-1111-4111-8111-111111111111';
  const orphanId = '22222222-2222-4222-8222-222222222222';
  for (const kind of ['worktrees', 'logs']) {
    for (const [id, at] of [[knownId, now - 61 * DAY], [orphanId, now - 61 * DAY]]) {
      const folder = path.join(stateDir, kind, id);
      fs.mkdirSync(folder, { recursive: true });
      fs.utimesSync(folder, at / 1000, at / 1000);
    }
  }
  const tasks = [{ id: knownId, state: 'completed', workspace: 'p', updatedAt: new Date(now).toISOString() }];
  const result = await cleanup({
    tasks, running: new Set(), config: { stateDir, workspaces: {} }, now,
    statfs: async () => ({ blocks: 100, bavail: 60 }),
  });
  assert.equal(result.uploadsRemoved, 1);
  assert.equal(result.orphansRemoved, 2);
  assert.ok(!fs.existsSync(path.join(uploads, 'old.txt')));
  assert.ok(fs.existsSync(path.join(uploads, 'new.txt')));
  assert.ok(fs.existsSync(path.join(stateDir, 'worktrees', knownId)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'worktrees', orphanId)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'logs', orphanId)));
});
