const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile, readFile, stat, symlink } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AppConfig, validateGitRoot } = require('../app-config');
const { Workspace } = require('../workspace');
const { git } = require('../orchestrator/git');

async function sandbox(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'agentdesk-product-'));
  t.after(() => rm(folder, { force: true, recursive: true }));
  return folder;
}

test('migrates workspace metadata and keeps connection credentials in the legacy file', async (t) => {
  const folder = await sandbox(t);
  const legacy = path.join(folder, 'remote.json');
  const local = path.join(folder, 'repo');
  await writeFile(legacy, JSON.stringify({ workspace: '/srv/agentdesk/repo', localWorkspace: local, token: 'secret-value' }));
  const file = path.join(folder, 'app', 'config.json');
  const config = new AppConfig(file, { legacyFiles: [legacy] });
  await config.load();
  assert.equal(config.active.localRoot, local);
  assert.equal(config.active.remoteCwd, '/srv/agentdesk/repo');
  assert.doesNotMatch(await readFile(file, 'utf8'), /secret-value/);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(legacy, 'utf8'), /secret-value/);
});

test('switches two local repositories and one cloud project without exposing files from the old root', async (t) => {
  const folder = await sandbox(t);
  const roots = ['a', 'b'].map((name) => path.join(folder, name));
  for (let index = 0; index < roots.length; index++) {
    await mkdir(roots[index]);
    await git(roots[index], ['init'], new AbortController().signal);
    await writeFile(path.join(roots[index], 'example'), 'project ' + index);
  }
  const config = new AppConfig(path.join(folder, 'config.json'));
  await config.load();
  const { activeProject: a } = await config.saveProject(undefined, { name: 'A', kind: 'local' }, roots[0]);
  const { activeProject: b } = await config.saveProject(undefined, { name: 'B', kind: 'local' }, roots[1]);
  const { activeProject: cloud } = await config.saveProject(undefined, { name: 'Cloud', kind: 'remote', remoteCwd: '/srv/git' });
  const ws = new Workspace();
  for (const [id, contents] of [[a, 'project 0'], [b, 'project 1']]) {
    await config.select(id);
    ws.setRoot(config.active.localRoot);
    assert.equal((await ws.read('example')).text, contents);
    assert.equal(ws.relIfInside(path.join(roots[id === a ? 1 : 0], 'example')), null);
  }
  await config.select(cloud);
  ws.setRoot(config.active.localRoot || null);
  assert.equal(config.active.remoteCwd, '/srv/git');
  assert.equal((await ws.access()).ok, false);
  await assert.rejects(ws.read('example'), /超出工作区/);
});

test('rejects paths outside the local workspace and nested non-root Git directories', async (t) => {
  const folder = await sandbox(t);
  const root = path.join(folder, 'repo');
  await mkdir(root);
  await mkdir(path.join(root, 'nested'));
  await git(root, ['init'], new AbortController().signal);
  const outside = path.join(folder, 'outside');
  await writeFile(outside, 'private');
  const ws = new Workspace(root);
  await assert.rejects(ws.read('../outside'), /超出工作区/);
  await assert.rejects(ws.read(outside), /超出工作区/);
  await assert.rejects(ws.diff('C:\\Windows\\secret'), /超出工作区/);
  await assert.rejects(validateGitRoot(path.join(root, 'nested')), /Git 仓库的根目录/);
  if (process.platform !== 'win32') {
    await symlink(outside, path.join(root, 'escape'));
    await assert.rejects(ws.read('escape'), /超出工作区/);
    assert.equal(ws.relIfInside(path.join(root, 'escape')), null);
  }
});

test('SSH fingerprint confirmation matches the exact pinned host and port', () => {
  const { generateKeyPairSync, createHmac } = require('node:crypto');
  const { hostFingerprints, verified } = require('../onboarding');
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const value = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 32]), raw]).toString('base64');
  const salt = Buffer.alloc(20, 1);
  const hash = createHmac('sha1', salt).update('[test.example]:2222').digest('base64');
  const host = 'test.example';
  const known = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${value}`;
  const fingerprints = hostFingerprints(known, host, 2222);
  assert.equal(fingerprints.length, 1);
  assert.deepEqual(hostFingerprints(known, host, 22), []);
  assert.equal(verified({ host, fingerprints }, { host, fingerprint: 'wrong' }), false);
  assert.equal(verified({ host, fingerprints }, { host, fingerprint: fingerprints[0] }), true);
});

test('logs rotate, audit logs are private, and diagnostics exclude credentials and paths', async (t) => {
  const { createLogger } = require('../logger');
  const { collectDiagnostics, exportDiagnostics } = require('../diagnostics');
  const { gunzipSync } = require('node:zlib');
  const folder = await sandbox(t);
  const logger = createLogger(folder, { limit: 140, now: () => new Date(2026, 10, 17, 12) });
  for (let index = 0; index < 8; index++) {
    await logger.log('remote', { status: 'retry', message: 'private raw output', password: 'not-for-log' });
  }
  await logger.audit('project_change', { operation: 'add', projectId: 'live', apiKey: 'must-not-appear' });
  assert.ok((await stat(path.join(folder, 'agentdesk.log.2'))).size > 0);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(folder, 'audit-20261117.jsonl'))).mode & 0o777, 0o600);
  const diagnostic = await collectDiagnostics({
    version: '1.2.3', config: { projects: [{ id: 'live', kind: 'local', localRoot: '/private/workspace', token: 'token-secret' }] },
    remote: { codex: 'ready', detail: 'private raw output', key: 'private key' }, logger,
    request: async (operation) => ({ ok: true, value: operation === 'diagnostics'
      ? { clis: [{ provider: 'codex', state: 'ready', version: 'Codex 4.5.6', error: 'internal host' }] } : {} }),
  });
  assert.equal(diagnostic.report.orchestrator.cli[0].version, '4.5.6');
  assert.equal(diagnostic.report.config.projects[0].localConfigured, true);
  assert.equal(diagnostic.audit.length, 1);
  const archive = path.join(folder, 'bundle.tar.gz');
  await exportDiagnostics(archive, diagnostic);
  const tar = gunzipSync(await readFile(archive)).toString();
  assert.match(tar, /diagnostics\.json/);
  assert.match(tar, /audit\.jsonl/);
  assert.doesNotMatch(tar, /not-for-log|token-secret|private raw output|private key|private\/workspace|must-not-appear|internal host/);
});
