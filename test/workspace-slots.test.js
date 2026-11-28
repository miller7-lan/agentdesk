const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncBridgeRoots } = require('../bridge-root');
const { Scheduler } = require('../orchestrator/scheduler');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-slots-'));
  const home = path.join(dir, 'home');
  const first = path.join(home, 'code', 'seed');
  const second = path.join(home, 'code', 'agentdesk');
  for (const folder of [first, second]) fs.mkdirSync(folder, { recursive: true });
  const file = path.join(dir, 'mac-bridge.json');
  fs.writeFileSync(file, JSON.stringify({ controlWorkspace: 'mac', workspaces: { mac: { root: first, write: true, desktop: true,
    commands: { 'git-status': ['/usr/bin/git', 'status'] }, agentCommands: ['git-status'] } } }), { mode: 0o600 });
  return { dir, home, first, second, file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('binding a project to an extra slot (mac-2) adds that workspace to the Bridge as a copy rooted at the project', () => {
  const t = setup();
  const projects = [
    { id: 'g1', kind: 'local', localRoot: t.first, orchestratorWorkspace: 'mac' },
    { id: 'g2', kind: 'local', localRoot: t.second, orchestratorWorkspace: 'mac-2' },
  ];
  const result = syncBridgeRoots({ file: t.file, activeId: 'g2', options: { home: t.home }, projects });
  assert.deepEqual(result, { changed: ['mac-2'], problems: [] });
  const after = t.read();
  assert.equal(after.workspaces.mac.root, t.first);
  assert.equal(after.workspaces['mac-2'].root, fs.realpathSync.native(t.second));
  assert.equal(after.workspaces['mac-2'].write, true);
  assert.deepEqual(after.workspaces['mac-2'].agentCommands, ['git-status']);
  assert.equal(after.controlWorkspace, 'mac');
  assert.deepEqual(syncBridgeRoots({ file: t.file, activeId: 'g2', options: { home: t.home }, projects }).changed, []);
});

test('only <workspace>-<n> names of a workspace this Bridge serves become slots', () => {
  const t = setup();
  for (const name of ['windows-2', 'mac2', 'mac-x', 'other']) {
    assert.deepEqual(syncBridgeRoots({ file: t.file, activeId: 'g', options: { home: t.home },
      projects: [{ id: 'g', kind: 'local', localRoot: t.second, orchestratorWorkspace: name }] }).changed, []);
  }
  assert.deepEqual(Object.keys(t.read().workspaces), ['mac']);
});

test('a slot is not added for a refused folder', () => {
  const t = setup();
  const result = syncBridgeRoots({ file: t.file, activeId: 'g', options: { home: t.home },
    projects: [{ id: 'g', kind: 'local', localRoot: path.join(t.home, 'missing'), orchestratorWorkspace: 'mac-2' }] });
  assert.equal(result.problems.length, 1);
  assert.deepEqual(Object.keys(t.read().workspaces), ['mac']);
});

test('VPS2 builds the mirror of a workspace that has none yet from the Bridge baseline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mirror-'));
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(source, 'init', '-q');
  fs.writeFileSync(path.join(source, 'a.txt'), 'hi');
  git(source, 'add', '.');
  git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const head = git(source, 'rev-parse', 'HEAD');
  const repo = path.join(dir, 'repos', 'mac-2.git');
  const calls = [];
  const self = {
    store: { get: () => undefined, delete: () => calls.push('delete') },
    files: { call: async (route, taskId, kind, body) => { calls.push(body.operation + ':' + body.workspace); return { head }; } },
    bridgeRoute: () => 'ssh:mac',
    ensureCommit: async (task, target) => { git(target, 'fetch', '-q', source, head); },
  };
  const task = { id: 't1', workspace: 'mac-2' };
  await Scheduler.prototype.restoreDeletedRepository.call(self, task, repo);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(calls, ['git_baseline:mac-2']);
  // An existing mirror is left alone.
  await Scheduler.prototype.restoreDeletedRepository.call(self, task, repo);
  assert.deepEqual(calls, ['git_baseline:mac-2']);
});

test('the Bridge control socket uses a workspace named like the project; Windows picks up a new slot live', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'orchestrator', 'service.js'), 'utf8');
  assert.match(service, /Object\.hasOwn\(config\.workspaces \|\| \{\}, body\.project\) \? body\.project : config\.controlWorkspace/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /localBridgeSettings\.workspaces\[name\] = saved\.workspaces\[name\];/);
});
