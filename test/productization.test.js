const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile, readFile, stat, symlink } = require('node:fs/promises');
const path = require('node:path');
const fs = require('node:fs');
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

test('binds a group project once and keeps its identity across restarts', async (t) => {
  const folder = await sandbox(t);
  const repo = path.join(folder, 'repo');
  await mkdir(repo);
  await git(repo, ['init'], new AbortController().signal);
  const file = path.join(folder, 'config.json');
  const config = new AppConfig(file);
  await config.load();
  const id = 'group-' + require('node:crypto').randomUUID();
  const fields = { name: 'Example', kind: 'local' };
  await config.saveProject(undefined, fields, repo, id);
  await assert.rejects(config.saveProject(undefined, fields, repo, id));
  await assert.rejects(config.saveProject(undefined, fields, repo, 'live'));
  const restored = new AppConfig(file);
  await restored.load();
  assert.equal(restored.active.id, id);
  assert.equal(restored.active.localRoot, await validateGitRoot(repo));
});

test('binding a plain directory initializes Git once and keeps existing files uncommitted', async (t) => {
  const folder = await sandbox(t);
  const root = path.join(folder, 'plain folder');
  await mkdir(root);
  await writeFile(path.join(root, 'notes.txt'), 'original');
  const config = new AppConfig(path.join(folder, 'config.json'));
  await config.load();
  const fields = { name: 'Notes', kind: 'local' };
  await config.saveProject(undefined, fields, root);
  assert.equal(await validateGitRoot(root), config.active.localRoot);
  const changes = await new Workspace(root).changes();
  assert.equal(changes.repo, true, JSON.stringify(changes));
  assert.deepEqual(changes.files.map(file => [file.path, file.untracked]), [['notes.txt', true]], JSON.stringify(changes));
  await assert.rejects(git(root, ['rev-parse', '--verify', 'HEAD']));
  const nested = path.join(root, 'subfolder');
  await mkdir(nested);
  await config.saveProject(undefined, fields, nested);
  await assert.rejects(stat(path.join(nested, '.git')), { code: 'ENOENT' });
  assert.equal((await new Workspace(nested).changes()).repo, false);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'original');
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
  const { hostFingerprints, hostRecords, verified } = require('../onboarding');
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
  assert.equal(hostRecords(known, host, 2222).get(fingerprints[0]), `[test.example]:2222 ssh-ed25519 ${value}\n`);
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
    remote: {
      codex: 'ready', detail: 'private raw output', key: 'private key',
      route: { route: 'jump', host: 'relay.example.invalid', key: 'jump-private-key', suspended: false },
    }, logger,
    request: async (operation) => ({ ok: true, value: operation === 'diagnostics'
      ? { clis: [{ provider: 'codex', state: 'ready', version: 'Codex 4.5.6', error: 'internal host' }] } : {} }),
  });
  assert.equal(diagnostic.report.orchestrator.cli[0].version, '4.5.6');
  assert.equal(diagnostic.report.config.projects[0].localConfigured, true);
  assert.equal(diagnostic.report.remote.route, 'jump');
  assert.equal(diagnostic.audit.length, 1);
  const archive = path.join(folder, 'bundle.tar.gz');
  await exportDiagnostics(archive, diagnostic);
  const tar = gunzipSync(await readFile(archive)).toString();
  assert.match(tar, /diagnostics\.json/);
  assert.match(tar, /audit\.jsonl/);
  assert.doesNotMatch(tar, /not-for-log|token-secret|private raw output|private key|private\/workspace|must-not-appear|internal host|relay\.example|jump-private-key/);
});

test('updater: disabled outside packaged apps; quitting never installs and nothing installs without the gate', async () => {
  // The full behaviour is in test/updates.test.js; this keeps the old guarantees visible next to the other product checks.
  const { createUpdateManager } = require('../updates');
  const off = createUpdateManager({ app: { isPackaged: false, getVersion: () => '0.3.0' }, platform: 'win32', transport: {} });
  assert.equal(off.state.status, 'disabled');
  const linux = createUpdateManager({ app: { isPackaged: true, getVersion: () => '0.3.0' }, platform: 'linux', transport: {} });
  assert.equal(linux.state.status, 'disabled');
  const source = require('node:fs').readFileSync(require.resolve('../updates'), 'utf8');
  assert.match(source, /updater\.autoInstallOnAppQuit = false;/);
  assert.match(source, /updater\.autoDownload = false;/);
  assert.match(source, /updater\.allowDowngrade = false;/);
});

// "主控创建能不能新建一个项目自动建好，否则不能上传附件": a group project created from the orchestrator is registered
// straight away as a cloud project bound to the orchestrator workspace — no folder to pick, nothing existing touched —
// which is what attachments and single chats need (they only accept registered projects).
test('a group project created from the orchestrator is registered without a folder and keeps the other projects', async (t) => {
  const folder = await sandbox(t);
  const repo = path.join(folder, 'repo');
  await mkdir(repo);
  await git(repo, ['init'], new AbortController().signal);
  const file = path.join(folder, 'config.json');
  const config = new AppConfig(file);
  await config.load();
  const { activeProject: existing } = await config.saveProject(undefined, { name: 'Mine', kind: 'local' }, repo);
  const id = 'group-' + require('node:crypto').randomUUID();
  await config.saveProject(undefined, { name: '新项目', kind: 'remote', orchestratorWorkspace: 'mac' }, undefined, id);
  const restored = new AppConfig(file);
  await restored.load();
  const record = restored.value.projects.find((project) => project.id === id);
  assert.deepEqual({ ...record }, { id, name: '新项目', kind: 'remote', orchestratorWorkspace: 'mac' });
  assert.ok(restored.value.projects.some((project) => project.id === existing && project.localRoot), 'the existing project is kept');
  // Registering the same group project again is refused, so a second click cannot duplicate or replace it.
  await assert.rejects(restored.saveProject(undefined, { name: '新项目', kind: 'remote', orchestratorWorkspace: 'mac' }, undefined, id));
});

test('group and single chats set up an orchestrator-bound project automatically instead of refusing attachments', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
  const projects = read('projects.js');
  assert.match(projects, /api\.add\(\{ groupId: project\.id, name: project\.name, kind: 'remote', orchestratorWorkspace: project\.serverProject \}\)/);
  assert.match(read('orchestrator.js'), /ensureRegistered\?\.\(project\)/, 'on creation');
  assert.match(read('orchestrator.js'), /ensureRegistered\?\.\(entry\)/, 'before adding attachments in an older group project');
  // A single chat in such a project picks its local folder (and Git) first, keeping the orchestrator binding.
  assert.match(read('app.js'), /const ready = await window\.AgentDeskProjects\?\.bindForDirect\(p\);/, 'before a single chat');
});

test('a new project picks its local folder and becomes a Git repository before it is created', async (t) => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
  const orchestrator = read('orchestrator.js');
  const submit = orchestrator.slice(orchestrator.indexOf("$('#groupProjectForm').addEventListener('submit'"));
  // The folder (and git init) comes first; cancelling the picker leaves no project behind.
  assert.ok(submit.indexOf('bindForDirect(project)') < submit.indexOf('createGroup(project.id)'));
  assert.match(submit, /if \(!made\) \{[\s\S]*?A\.D\.projects\.splice\(at, 1\)[\s\S]*?return;/);
  assert.match(read('projects.js'), /api\.add\(\{ groupId: project\.id, name: project\.name, kind: 'local',\s*orchestratorWorkspace: project\.serverProject \|\| '', \.\.\.\(folderToken && \{ folderToken \}\) \}\)/);
  // Binding the folder keeps the orchestrator workspace (group chat) and initializes Git.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-new-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'work');
  fs.mkdirSync(folder);
  const config = new AppConfig(path.join(dir, 'config.json'));
  await config.load();
  const id = 'group-' + require('node:crypto').randomUUID();
  await config.saveProject(undefined, { name: '新项目', kind: 'local', orchestratorWorkspace: 'mac' }, folder, id);
  const record = config.value.projects.find((project) => project.id === id);
  assert.equal(record.orchestratorWorkspace, 'mac');
  assert.equal(fs.realpathSync.native(record.localRoot), fs.realpathSync.native(folder));
  assert.ok(fs.existsSync(path.join(folder, '.git')), 'git init ran');
});

test('the new-project dialog picks the local folder itself; the window only ever holds a one-time token', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('projects:pickFolder'/);
  assert.match(main, /localRoot = pickedFolders\.get\(pickedToken\);\s*pickedFolders\.delete\(pickedToken\);/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.match(html, /id="groupProjectFolderPick"/);
  const orchestrator = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator.js'), 'utf8');
  assert.match(orchestrator, /bindForDirect\(project, pickedFolder\?\.token\)/);
});

test('attachments show a progress bar while they upload', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const live = read('src/live.js');
  assert.match(live, /uploading" style="--upload:/, 'direct chat v2 pills fill with the bytes the server took');
  assert.match(live, /attach-pill uploading busy/, 'Codex uploads show which file of how many');
  assert.match(read('src/styles.css'), /\.attach-pill\.uploading/);
  // The floating panel goes to the top layer: inside the open modal dialog, else the page.
  assert.match(live, /function renderUploadPanel\(\)[\s\S]*?dialog\[open\][\s\S]*?const host = modal \|\| document\.body;/);
  assert.match(read('src/styles.css'), /\.upload-panel \{ position: fixed; z-index: 1001;/);
  const main = read('main.js');
  assert.match(main, /toUi\('files:uploadProgress'/);
  assert.equal((main.match(/finally \{ progress\(\); \}/g) || []).length, 3, 'every Codex upload path ends its batch');
});

test('native chats of a project that no longer exists are pruned after a clean configuration load', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /activateProject\(\);\n  pruneOrphanNativeChats\(\);/);
  assert.match(main, /if \(!native\?\.orphanProjects \|\| configError \|\| !appConfig\?\.value\.projects\.length\) return;/, 'never on a broken or empty configuration');
});

test('composer has a refresh-models button for Codex and every single-chat provider', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const live = fs.readFileSync(path.join(__dirname, '..', 'src', 'live.js'), 'utf8');
  assert.match(html, /id="modelRefresh"[^>]*aria-label="刷新模型列表"/);
  assert.match(live, /\$\('#modelRefresh'\)\?\.addEventListener\('click', refreshModels\)/);
  assert.match(live, /agyProfiles\.delete\(s\)/);
  assert.match(live, /chatProfiles\.delete\(s\.project\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'provider-direct.js'), 'utf8'), /'modelSelect', 'modelRefresh'/);
});

test('deleting a project in a shared remote folder keeps the other projects\' history instead of failing', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /多个项目共用这个远程目录/);
  assert.match(main, /if \(directory === cwd && sharedCwd\) continue;/);
});

test('quota: offline shows 离线, never example numbers or an old snapshot', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'quota-view.js'), 'utf8');
  const group = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator.js'), 'utf8');
  const live = fs.readFileSync(path.join(__dirname, '..', 'src', 'live.js'), 'utf8');
  assert.doesNotMatch(view, /const sample = \{|下面是示例/);
  assert.match(view, /data = \{ offline: true \}/);
  assert.match(view, /const stale = found\?\.source === 'snapshot'/);
  assert.doesNotMatch(group, /'快照'/);
  assert.match(group, /!staleQuota\(quota\) && Number\.isFinite\(quota\.used\)/);
  assert.match(live, /if \(!sleep\) \{ usageOffline = true; renderUsage\(\); \}/);
  assert.match(live, /usage: \(\) => usageOffline \? null : usage/);
});
