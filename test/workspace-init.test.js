const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AppConfig, initializeWorkspace, retryInitialCommit, refusedRoot } = require('../app-config');

const gitAvailable = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

// Every test runs with its own empty global config, so the outcome does not depend on this machine's identity.
function sandbox(t, { identity }) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-init-')));
  const globalConfig = path.join(folder, 'global.gitconfig');
  fs.writeFileSync(globalConfig, identity ? `[user]\n\tname = Person\n\temail = person@example.invalid\n[init]\n\tdefaultBranch = main\n` : '[init]\n\tdefaultBranch = main\n');
  const saved = {};
  const env = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', HOME: folder, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return { folder, globalConfig };
}

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { env: process.env }).toString().trim();

test('A6: a brand-new empty folder gets git init, .gitignore and one commit with only .gitignore; no remote, no config change', { skip: !gitAvailable }, async (t) => {
  const { folder, globalConfig } = sandbox(t, { identity: true });
  const root = path.join(folder, 'new');
  fs.mkdirSync(root);
  const before = fs.readFileSync(globalConfig, 'utf8');
  const result = await initializeWorkspace(root);
  assert.deepEqual({ kind: result.kind, gitignore: result.gitignore, committed: result.committed }, { kind: 'empty', gitignore: true, committed: true });
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(root, 'show', '--name-only', '--format=', 'HEAD'), '.gitignore');
  assert.equal(git(root, 'log', '-1', '--format=%an <%ae>'), 'Person <person@example.invalid>');
  assert.equal(git(root, 'remote'), '');
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.DS_Store$/m);
  assert.equal(fs.readFileSync(globalConfig, 'utf8'), before);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), /\[user\]/);
});

test('A6b (Q3): a folder that only holds .DS_Store, Thumbs.db or desktop.ini is not new: git init only', { skip: !gitAvailable }, async (t) => {
  const { folder } = sandbox(t, { identity: true });
  for (const junk of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) {
    const root = path.join(folder, 'junk-' + junk.replace(/\W/g, ''));
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, junk), 'x');
    const result = await initializeWorkspace(root);
    assert.equal(result.kind, 'existing', junk);
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false, junk);
    assert.throws(() => git(root, 'rev-parse', '--verify', '-q', 'HEAD'), junk);
    assert.ok(fs.existsSync(path.join(root, '.git')), junk);
  }
});

test('A6c (Q4): without a Git identity nothing is committed and no gitconfig is written; retry commits once it exists', { skip: !gitAvailable }, async (t) => {
  const { folder, globalConfig } = sandbox(t, { identity: false });
  const root = path.join(folder, 'fresh');
  fs.mkdirSync(root);
  const before = fs.readFileSync(globalConfig, 'utf8');
  const result = await initializeWorkspace(root);
  assert.equal(result.kind, 'empty');
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'missing_identity');
  assert.ok(fs.existsSync(path.join(root, '.gitignore')));
  assert.throws(() => git(root, 'rev-parse', '--verify', '-q', 'HEAD'));
  assert.equal(fs.readFileSync(globalConfig, 'utf8'), before, 'global config unchanged');
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), /\[user\]|AgentDesk/);
  assert.equal((await retryInitialCommit(root)).reason, 'missing_identity');
  // The person sets their identity themselves; then the retry commits under their name.
  fs.writeFileSync(globalConfig, before + '[user]\n\tname = Person\n\temail = person@example.invalid\n');
  assert.equal((await retryInitialCommit(root)).committed, true);
  assert.equal(git(root, 'log', '-1', '--format=%an'), 'Person');
  assert.equal((await retryInitialCommit(root)).reason, 'already_has_commits');
});

test('D7: a folder inside a repository uses the parent repository; existing files are never committed; a broken .git is refused', { skip: !gitAvailable }, async (t) => {
  const { folder } = sandbox(t, { identity: true });
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
  git(repo, 'init', '-q');
  const sub = await initializeWorkspace(path.join(repo, 'packages', 'app'));
  assert.deepEqual(sub, { kind: 'subdirectory', gitRoot: repo, subdirectory: path.join('packages', 'app') });
  assert.equal(fs.existsSync(path.join(repo, 'packages', 'app', '.git')), false);
  assert.equal((await initializeWorkspace(repo)).kind, 'repository');

  const notes = path.join(folder, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'a.txt'), 'mine');
  assert.equal((await initializeWorkspace(notes)).kind, 'existing');
  assert.equal(git(notes, 'status', '--porcelain'), '?? a.txt');

  const broken = path.join(folder, 'broken');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
  await assert.rejects(initializeWorkspace(broken), /\.git 已损坏/);

  // The project records the parent repository as its root and the chosen folder as its working folder.
  const config = new AppConfig(path.join(folder, 'config.json'));
  await config.load();
  await config.saveProject(undefined, { name: 'App', kind: 'local' }, path.join(repo, 'packages', 'app'));
  assert.equal(config.active.localRoot, repo);
  assert.equal(config.active.workdir, path.join('packages', 'app'));
});

test('system folders, the disk root and the home folder are refused as projects', { skip: process.platform === 'win32' }, () => {
  assert.equal(refusedRoot('/', { platform: 'linux', home: '/home/me' }), true);
  assert.equal(refusedRoot('/home/me', { platform: 'linux', home: '/home/me' }), true);
  assert.equal(refusedRoot('/usr/local/src', { platform: 'linux', home: '/home/me' }), true);
  assert.equal(refusedRoot('/home/me/code', { platform: 'linux', home: '/home/me' }), false);
  assert.equal(refusedRoot('/Users/Me', { platform: 'darwin', home: '/Users/me' }), true);
});
