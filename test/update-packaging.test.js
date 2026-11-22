// Update packaging rules checked without building: the release workflow's triggers, the generic package without
// connection settings, the artifact verification, and the local copy of connection settings (connection-config.js).
// The real packaging and the Windows upgrade-over-install run only in GitHub Actions (release.yml).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const connection = require('../connection-config');
const { verify, parseLatest } = require('../scripts/verify-update-artifacts');

const root = path.join(__dirname, '..');
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');

test('release workflow: only a plain version tag can hand packages to VPS2; main pushes build nothing', () => {
  const text = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const triggers = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));
  assert.doesNotMatch(triggers, /branches:/);                       // no push: branches: main any more
  assert.match(triggers, /tags:\s*\n\s*- 'v\*'/);
  assert.match(text, /\^refs\/tags\/v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);   // plain vX.Y.Z only
  assert.match(text, /does not match package\.json version/);
  const upload = text.slice(text.indexOf('  upload-vps2:'), text.indexOf('  publish-macos:'));
  assert.match(upload, /if: needs\.meta\.outputs\.pushable == 'true'/);
  assert.match(upload, /environment: vps2-intake/);
  assert.match(upload, /needs: \[meta, build, windows-upgrade-check\]/);
  assert.doesNotMatch(upload, /echo "\$KEY"|cat "\$RUNNER_TEMP\/key"/);
  // Secrets never in step conditions (GitHub does not allow it) — they go through job env.
  assert.doesNotMatch(text, /if: [^\n]*secrets\./);
  // A manual run never becomes pushable (pushable is only set for a push event on a tag).
  assert.match(text, /if \[ "\$EVENT" = push \]/);
});

test('generic package configuration never packs connection settings; the bundle configuration is separate', () => {
  const build = require('../package.json').build;
  const packed = JSON.stringify(build.extraResources) + JSON.stringify(build.files);
  assert.doesNotMatch(packed, /agentdesk-(server|enrollment)\.json/);
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(build.publish[0].provider, 'generic');                // only so app-update.yml is written
  assert.match(build.publish[0].url, /^http:\/\/127\.0\.0\.1\//);   // never a public address
  for (const file of ['update-transport.js', 'update-gate.js', 'connection-config.js', 'updates.js']) assert.ok(build.files.includes(file), file);
  const bundled = require('../build/bundle-connection.config.js');
  assert.match(JSON.stringify(bundled.extraResources), /agentdesk-server\.json/);
  assert.equal(bundled.appId, build.appId);
});

function fakeDist(t, { leak = false, wrongHash = false, noBlockmap = false } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dist-'));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const installer = Buffer.from('setup-bytes');
  fs.writeFileSync(path.join(dist, 'AgentDesk-0.3.0-setup.exe'), installer);
  if (!noBlockmap) fs.writeFileSync(path.join(dist, 'AgentDesk-0.3.0-setup.exe.blockmap'), 'bm');
  fs.writeFileSync(path.join(dist, 'latest.yml'), ['version: 0.3.0', 'files:', '  - url: AgentDesk-0.3.0-setup.exe',
    '    sha512: ' + (wrongHash ? sha512(Buffer.from('other')) : sha512(installer)), '    size: ' + installer.length,
    'path: AgentDesk-0.3.0-setup.exe', "releaseDate: '2026-11-23T00:00:00.000Z'", ''].join('\n'));
  const resources = path.join(dist, 'win-unpacked', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\n');
  if (leak) fs.writeFileSync(path.join(resources, 'agentdesk-server.json'), '{}');
  return dist;
}

test('artifact verification: consistent metadata, block map, app-update.yml, and no connection settings', (t) => {
  assert.deepEqual(verify('windows', fakeDist(t), '0.3.0'), []);
  assert.ok(verify('windows', fakeDist(t), '0.3.1').some((item) => /expected 0\.3\.1/.test(item)));
  assert.ok(verify('windows', fakeDist(t, { wrongHash: true }), '0.3.0').some((item) => /sha512 differs/.test(item)));
  assert.ok(verify('windows', fakeDist(t, { noBlockmap: true }), '0.3.0').some((item) => /blockmap missing/.test(item)));
  assert.ok(verify('windows', fakeDist(t, { leak: true }), '0.3.0').some((item) => /connection settings/.test(item)));
  assert.equal(parseLatest("version: '1.2.3'\n").version, '1.2.3');
});

test('connection settings: copied once to this computer, local copy wins, never overwritten silently', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-connection-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const resourcesDir = path.join(base, 'resources');
  const userDataDir = path.join(base, 'userData');
  fs.mkdirSync(resourcesDir);
  const dirs = { resourcesDir, userDataDir };
  // A generic installer: nothing to copy, nothing resolved locally.
  assert.deepEqual(connection.migrate(dirs), { migrated: [], conflicts: [] });
  assert.equal(connection.resolve('agentdesk-server.json', dirs), path.join(resourcesDir, 'agentdesk-server.json'));
  // The first version with updates, installed from a bundled build: copied.
  fs.writeFileSync(path.join(resourcesDir, 'agentdesk-server.json'), '{"host":"one.example"}');
  assert.deepEqual(connection.migrate(dirs), { migrated: ['agentdesk-server.json'], conflicts: [] });
  const local = path.join(userDataDir, 'bundled-connection', 'agentdesk-server.json');
  assert.equal(fs.readFileSync(local, 'utf8'), '{"host":"one.example"}');
  if (process.platform !== 'win32') assert.equal(fs.statSync(local).mode & 0o777, 0o600);
  assert.equal(connection.resolve('agentdesk-server.json', dirs), local);
  // An update (generic package) removed the install-folder copy: the local copy still answers.
  fs.rmSync(path.join(resourcesDir, 'agentdesk-server.json'));
  assert.deepEqual(connection.migrate(dirs), { migrated: [], conflicts: [] });
  assert.equal(connection.resolve('agentdesk-server.json', dirs), local);
  // An installer with different settings: not copied over the local one — reported as a conflict for the question.
  fs.writeFileSync(path.join(resourcesDir, 'agentdesk-server.json'), '{"host":"two.example"}');
  assert.deepEqual(connection.migrate(dirs), { migrated: [], conflicts: ['agentdesk-server.json'] });
  assert.equal(fs.readFileSync(local, 'utf8'), '{"host":"one.example"}');
  assert.equal(connection.resolve('agentdesk-server.json', dirs), local);
  // The person chose the installer's settings: the local copy is backed up first.
  const { backup } = connection.adopt('agentdesk-server.json', { ...dirs, now: () => new Date('2026-11-23T01:02:03Z') });
  assert.equal(fs.readFileSync(path.join(backup, 'agentdesk-server.json'), 'utf8'), '{"host":"one.example"}');
  assert.equal(fs.readFileSync(local, 'utf8'), '{"host":"two.example"}');
  // Hashes only, for the before/after comparison.
  const snap = connection.snapshot({ a: local, b: path.join(base, 'none'), c: null });
  assert.match(snap.a, /^[0-9a-f]{64}$/);
  assert.equal(snap.b, 'missing');
  assert.equal('c' in snap, false);
  assert.throws(() => connection.resolve('id_ed25519', dirs), /unknown_connection_file/);
});
