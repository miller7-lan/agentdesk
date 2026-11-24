const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBridgeRoots } = require('../bridge-root');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-root-'));
  const home = path.join(dir, 'home');
  const old = path.join(home, 'AgentDeskWorkspace');
  const project = path.join(home, 'code', 'hi');
  for (const folder of [old, project, path.join(home, 'Desktop')]) fs.mkdirSync(folder, { recursive: true });
  const file = path.join(dir, 'mac-bridge.json');
  fs.writeFileSync(file, JSON.stringify({ controlWorkspace: 'mac', ssh: { host: 'h', port: 22 },
    workspaces: { mac: { root: old, write: true, desktop: true, commands: { 'git-status': ['/usr/bin/git', 'status'] } } } }), { mode: 0o600 });
  return { dir, home, old, project, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('a bound project moves its workspace Bridge root to the project folder and keeps the rest', () => {
  const t = setup();
  const result = syncBridgeRoots({ file: t.file, activeId: 'g1', options: { home: t.home },
    projects: [{ id: 'g1', kind: 'local', localRoot: t.project, orchestratorWorkspace: 'mac' }] });
  assert.deepEqual(result, { changed: ['mac'], problems: [] });
  const after = t.read();
  assert.equal(after.workspaces.mac.root, fs.realpathSync.native(t.project));
  assert.equal(after.workspaces.mac.write, true);
  assert.deepEqual(after.workspaces.mac.commands, { 'git-status': ['/usr/bin/git', 'status'] });
  assert.equal(after.ssh.host, 'h');
  if (process.platform !== 'win32') assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
  assert.ok(fs.readdirSync(t.dir).some((name) => name.startsWith('mac-bridge.json.bak-root-')));
  // Already aligned: nothing is written again.
  assert.deepEqual(syncBridgeRoots({ file: t.file, activeId: 'g1', options: { home: t.home },
    projects: [{ id: 'g1', kind: 'local', localRoot: t.project, orchestratorWorkspace: 'mac' }] }).changed, []);
});

test('a personal top-level folder (Desktop) or a missing folder is refused and the Bridge is left alone', () => {
  const t = setup();
  for (const localRoot of [path.join(t.home, 'Desktop'), path.join(t.home, 'gone')]) {
    const result = syncBridgeRoots({ file: t.file, activeId: 'g1', options: { home: t.home },
      projects: [{ id: 'g1', kind: 'local', localRoot, orchestratorWorkspace: 'mac' }] });
    assert.deepEqual(result.changed, []);
    assert.equal(result.problems.length, 1);
    assert.equal(t.read().workspaces.mac.root, t.old);
  }
});

test('unbound, remote and foreign-workspace projects do not touch the Bridge; the active project wins a shared workspace', () => {
  const t = setup();
  const other = path.join(t.home, 'code', 'other');
  fs.mkdirSync(other, { recursive: true });
  assert.deepEqual(syncBridgeRoots({ file: t.file, activeId: 'x', options: { home: t.home }, projects: [
    { id: 'a', kind: 'local', localRoot: t.project },
    { id: 'b', kind: 'remote', remoteCwd: '/srv', orchestratorWorkspace: 'mac' },
    { id: 'c', kind: 'local', localRoot: t.project, orchestratorWorkspace: 'windows' },
  ] }).changed, []);
  syncBridgeRoots({ file: t.file, activeId: 'second', options: { home: t.home }, projects: [
    { id: 'first', kind: 'local', localRoot: t.project, orchestratorWorkspace: 'mac' },
    { id: 'second', kind: 'local', localRoot: other, orchestratorWorkspace: 'mac' },
  ] });
  assert.equal(t.read().workspaces.mac.root, fs.realpathSync.native(other));
  assert.deepEqual(syncBridgeRoots({ file: path.join(t.dir, 'none.json'), projects: [] }), { changed: [], problems: [] });
});

test('main.js re-aims the Bridge after a project change and at start; the window shows a refusal and ignores a second delete', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const projects = fs.readFileSync(path.join(__dirname, '..', 'src', 'projects.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('bridge-root.js'));
  assert.match(main, /const bridgeProblems = operation === 'list' \? \[\] : await syncBridgeRoots\(\);/);
  assert.match(main, /pruneOrphanNativeChats\(\);\s*syncBridgeRoots\(\)\.catch/);
  assert.match(main, /launchctl',\s*\['kickstart', '-k', `gui\/\$\{process\.getuid\(\)\}\/local\.agentdesk\.mac-bridge`\]/);
  assert.match(main, /if \(stopBridge\) \{[\s\S]*?startOrchestratorBridge\(\);/);
  assert.match(projects, /if \(result\.bridgeWarning\) window\.alert\(result\.bridgeWarning\);/);
  assert.match(projects, /if \(removing\.has\(id\)\) \{ A\.toast\('正在删除这个项目，请稍候…'\); return; \}/);
});
