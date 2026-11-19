const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SessionWorktrees } = require('../session-worktrees');

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-wt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'app.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.invalid');
  return { dir, root, git, store: new SessionWorktrees(path.join(dir, 'worktrees.json')) };
}

test('a chat works in its own checkout and its changes merge back into the project branch', async (t) => {
  const { root, git, store } = repo(t);
  const record = await store.create('p1', root, 'chat-1');
  assert.equal(record.branch, 'agentdesk/chat-1');
  assert.equal(record.baseBranch, 'main');
  assert.ok(!record.path.split(path.sep).includes('.git'));    // the file tools may write there
  fs.writeFileSync(path.join(record.path, 'app.txt'), 'two\n');
  fs.writeFileSync(path.join(record.path, 'new.txt'), 'new\n');
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'one\n');   // the project is untouched

  const diff = await store.diff('chat-1');
  assert.deepEqual(diff.files.sort(), ['app.txt', 'new.txt']);
  assert.match(diff.text, /\+two/);

  const merged = await store.merge('chat-1');
  assert.equal(merged.merged, true);
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'two\n');
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new\n');
  assert.equal((await store.merge('chat-1')).merged, false);   // nothing new since

  await store.discard('chat-1');
  assert.equal(fs.existsSync(record.path), false);
  assert.equal(git('branch', '--list', 'agentdesk/chat-1'), '');
  assert.equal(store.get('chat-1'), null);
});

test('merging refuses a dirty project and undoes a conflicting merge', async (t) => {
  const { root, git, store } = repo(t);
  const record = await store.create('p1', root, 'chat-2');
  fs.writeFileSync(path.join(record.path, 'app.txt'), 'from chat\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'local edit\n');
  await assert.rejects(store.merge('chat-2'), /未提交的改动/);
  git('commit', '-qam', 'local');
  await assert.rejects(store.merge('chat-2'), /冲突/);
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'local edit\n');
  assert.equal(git('status', '--porcelain'), '');
});

test('a folder that is not a Git repository cannot get a worktree', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-wt-plain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SessionWorktrees(path.join(dir, 'worktrees.json'));
  await assert.rejects(store.create('p1', dir, 'chat-3'));
});
