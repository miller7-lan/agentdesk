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
    trashDays: 1, archiveDays: 30, minAgeMinutes: 60,
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

// ---- safety: quarantine, audit, path checks, references, dry run, lock ----

const { AUDIT, TRASH } = require('../orchestrator/cleanup');
const audit = (stateDir) => fs.readFileSync(path.join(stateDir, AUDIT), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const roomy = async () => ({ blocks: 100, bavail: 60 });

function bare(t) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-gc-safe-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-gc-outside-')));
  t.after(() => { fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, 'precious'), 'keep me');
  const folder = (kind, id) => {
    fs.mkdirSync(path.join(stateDir, kind, id), { recursive: true });
    fs.writeFileSync(path.join(stateDir, kind, id, 'file'), 'x');
  };
  return { stateDir, outside, folder, config: { stateDir, workspaces: {} } };
}

test('cleared folders are moved to the trash with an audit trail, then purged after trashDays', async (t) => {
  const { stateDir, folder, config } = bare(t);
  folder('worktrees', 'done'); folder('logs', 'done');
  const tasks = [{ id: 'done', state: 'completed', updatedAt: ago(4) }];
  const first = await cleanup({ tasks, running: new Set(), config, now, statfs: roomy });
  assert.deepEqual(first.cleared, ['done']);
  assert.equal(first.ok, true);
  assert.equal(first.quarantined, 2);
  assert.ok(!fs.existsSync(path.join(stateDir, 'worktrees', 'done')));
  const passes = fs.readdirSync(path.join(stateDir, TRASH));
  assert.equal(passes.length, 1);
  const kept = fs.readdirSync(path.join(stateDir, TRASH, passes[0])).filter((name) => name !== '.pass.json');
  assert.equal(kept.length, 2, 'both folders are recoverable from the trash');
  const lines = audit(stateDir);
  assert.ok(lines.some((line) => line.action === 'quarantine' && line.taskId === 'done' && line.kind === 'worktrees' && line.to));
  assert.ok(lines.some((line) => line.action === 'task_cleared' && line.taskId === 'done'));
  assert.equal(fs.statSync(path.join(stateDir, AUDIT)).mode & 0o777, 0o600);
  // A pass a day later purges that trash.
  const later = await cleanup({ tasks, running: new Set(), config, now: now + 2 * DAY, statfs: roomy });
  assert.equal(later.purged, 1);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, TRASH)), []);
});

test('dry run reports the plan and changes nothing', async (t) => {
  const { stateDir, folder, config } = bare(t);
  folder('worktrees', 'done');
  const tasks = [{ id: 'done', state: 'completed', updatedAt: ago(4) }];
  const result = await cleanup({ tasks, running: new Set(), config, now, statfs: roomy, dryRun: true, onCleared: () => assert.fail('no record change') });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.cleared, ['done']);
  assert.ok(result.planned.some((item) => item.action === 'quarantine' && item.taskId === 'done'));
  assert.ok(fs.existsSync(path.join(stateDir, 'worktrees', 'done', 'file')));
  assert.equal(tasks[0].cleanedAt, undefined);
  assert.ok(!fs.existsSync(path.join(stateDir, AUDIT)));
  assert.ok(!fs.existsSync(path.join(stateDir, TRASH)));
});

test('a symlinked uploads folder or task folder never lets the cleanup reach outside the state directory', async (t) => {
  const { stateDir, outside, config } = bare(t);
  const old = (now - 30 * DAY) / 1000;
  fs.utimesSync(path.join(outside, 'precious'), old, old);
  fs.mkdirSync(path.join(stateDir, 'desktop-workspace'));
  fs.symlinkSync(outside, path.join(stateDir, 'desktop-workspace', '.agentdesk-uploads'));
  // logs/ itself points outside: the task's log folder resolves there and must be refused.
  fs.mkdirSync(path.join(outside, 'linked'));
  fs.writeFileSync(path.join(outside, 'linked', 'file'), 'x');
  fs.symlinkSync(outside, path.join(stateDir, 'logs'));
  // worktrees/<id> is a symlink: only the link is moved, never what it points at.
  fs.mkdirSync(path.join(stateDir, 'worktrees'));
  fs.symlinkSync(path.join(outside, 'linked'), path.join(stateDir, 'worktrees', 'linked'));
  const tasks = [{ id: 'linked', state: 'completed', updatedAt: ago(4) }];
  const result = await cleanup({ tasks, running: new Set(), config, now, statfs: roomy });
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'keep me');
  assert.ok(fs.existsSync(path.join(outside, 'linked', 'file')));
  assert.equal(result.uploadsRemoved, 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.error === 'uploads_not_a_directory'));
  assert.ok(result.errors.some((error) => error.taskId === 'linked' && error.error === 'path_outside_state_dir'));
  assert.deepEqual(result.cleared, [], 'a task whose folders could not be cleared is retried next pass');
  assert.equal(tasks[0].cleanedAt, undefined);
});

test('an unsafe task id is refused and does not stop the other tasks', async (t) => {
  const { stateDir, folder, config } = bare(t);
  folder('worktrees', 'good');
  fs.mkdirSync(path.join(stateDir, 'victim'));
  const tasks = [
    { id: '../victim', state: 'completed', updatedAt: ago(9) },
    { id: 'good', state: 'completed', updatedAt: ago(4) },
  ];
  const result = await cleanup({ tasks, running: new Set(), config, now, statfs: roomy });
  assert.deepEqual(result.cleared, ['good']);
  assert.ok(fs.existsSync(path.join(stateDir, 'victim')));
  assert.ok(result.errors.some((error) => error.error === 'unsafe_task_id'));
  assert.ok(audit(stateDir).some((line) => line.action === 'error' && line.error === 'unsafe_task_id'));
});

test('a task an unfinished review still reads, or one that starts again mid-pass, keeps its files', async (t) => {
  const { stateDir, folder, config } = bare(t);
  for (const id of ['source', 'first', 'second']) folder('worktrees', id);
  const running = new Set();
  const tasks = [
    { id: 'source', state: 'completed', updatedAt: ago(10) },
    { id: 'review', state: 'queued', mode: 'review_only', reviewOf: 'source', updatedAt: ago(0) },
    { id: 'first', state: 'completed', updatedAt: ago(9) },
    { id: 'second', state: 'failed', updatedAt: ago(8) },
  ];
  // While "first" is being cleared, the person retries "second".
  const result = await cleanup({ tasks, running, config, now, statfs: roomy, onCleared: (task) => { if (task.id === 'first') running.add('second'); } });
  assert.deepEqual(result.cleared, ['first']);
  assert.ok(fs.existsSync(path.join(stateDir, 'worktrees', 'source')));
  assert.ok(fs.existsSync(path.join(stateDir, 'worktrees', 'second')));
});

test('low disk empties the trash and clears early, but not a task that finished minutes ago', async (t) => {
  const { stateDir, folder, config } = bare(t);
  for (const id of ['day-old', 'just-done']) folder('worktrees', id);
  const tasks = [
    { id: 'day-old', state: 'completed', updatedAt: ago(1) },
    { id: 'just-done', state: 'completed', updatedAt: new Date(now - 10 * 60_000).toISOString() },
  ];
  const result = await cleanup({ tasks, running: new Set(), config, now, statfs: async () => ({ blocks: 100, bavail: 5 }) });
  assert.deepEqual(result.cleared, ['day-old']);
  assert.ok(fs.existsSync(path.join(stateDir, 'worktrees', 'just-done')));
  // Low disk deletes at once instead of keeping a trash copy.
  const passes = fs.existsSync(path.join(stateDir, TRASH)) ? fs.readdirSync(path.join(stateDir, TRASH)) : [];
  for (const pass of passes) assert.deepEqual(fs.readdirSync(path.join(stateDir, TRASH, pass)).filter((name) => name !== '.pass.json'), []);
  assert.ok(audit(stateDir).some((line) => line.action === 'purge' && line.reason === 'low_disk'));
});

test('deleted branches are logged with their commit, and nothing is orphaned when there are no task records', async (t) => {
  const { stateDir, repo, tasks, config, git } = setup(t);
  await cleanup({ tasks, running: new Set(), config, now, statfs: roomy });
  const line = audit(stateDir).find((entry) => entry.action === 'delete_branch');
  assert.equal(line.branch, 'agentdesk/old-done/edit');
  assert.match(line.commit, /^[0-9a-f]{40}$/);
  git(repo, 'branch', line.branch, line.commit);   // restorable from the log
  // An empty task list (fresh or unreadable database) must not turn every folder or branch into an orphan.
  const orphanId = '33333333-3333-4333-8333-333333333333';
  fs.mkdirSync(path.join(stateDir, 'worktrees', orphanId));
  const old = (now - 90 * DAY) / 1000;
  fs.utimesSync(path.join(stateDir, 'worktrees', orphanId), old, old);
  const empty = await cleanup({ tasks: [], running: new Set(), config, now, statfs: roomy });
  assert.equal(empty.orphanGuard, 'no_task_records');
  assert.equal(empty.orphansRemoved, 0);
  assert.equal(empty.branchesRemoved, 0);
  assert.ok(fs.existsSync(path.join(stateDir, 'worktrees', orphanId)));
  assert.match(git(repo, 'branch', '--list', 'agentdesk/*'), /old-done/);
});

test('a second pass while one holds the lock is refused; a stale lock is taken over', async (t) => {
  const { stateDir, config } = bare(t);
  const lock = path.join(stateDir, '.cleanup.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(cleanup({ tasks: [], running: new Set(), config, now, statfs: roomy }), /cleanup_locked/);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
  const result = await cleanup({ tasks: [], running: new Set(), config, now, statfs: roomy });
  assert.equal(result.dryRun, false);
  assert.ok(!fs.existsSync(lock), 'the lock is released after the pass');
});

test('the state directory must be a real, deep, absolute path', async () => {
  for (const stateDir of ['/', '/var', 'relative/dir', '/var/lib/../lib/x']) {
    await assert.rejects(cleanup({ tasks: [], running: new Set(), config: { stateDir }, now, statfs: roomy }), /unsafe_state_dir/);
  }
});
