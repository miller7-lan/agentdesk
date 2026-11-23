// VPS2 side of client updates (repository code only — nothing here is deployed): the version store offered over the
// control channel, the intake the release workflow feeds, and the upload stream the workflow writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const { ClientUpdates, clientUpdateControl, READ_CHUNK } = require('../orchestrator/client-updates');
const { receive, validateHeader, githubProvenance } = require('../orchestrator/client-update-intake');
const upload = require('../scripts/client-update-upload');
const { validateManifest } = require('../orchestrator/update-manifest');
const { controlChannelReader } = require('../update-transport');

const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');
const commit = 'b'.repeat(40);

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-client-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function payload(version, { size = 1000, mac = true } = {}) {
  const files = {
    [`AgentDesk-${version}-setup.exe`]: Buffer.alloc(size, 1),
    [`AgentDesk-${version}-setup.exe.blockmap`]: Buffer.from('win-blockmap-' + version),
    ...(mac && {
      [`AgentDesk-${version}-arm64-mac.zip`]: Buffer.alloc(size, 2),
      [`AgentDesk-${version}-arm64-mac.zip.blockmap`]: Buffer.from('mac-blockmap-' + version),
    }),
  };
  const entry = (name) => ({ name, size: files[name].length, sha512: sha512(files[name]) });
  const header = { version, tag: 'v' + version, commit, runId: 42, signed: false, artifacts: [
    { platform: 'win', arch: 'x64', files: [entry(`AgentDesk-${version}-setup.exe`), entry(`AgentDesk-${version}-setup.exe.blockmap`)] },
    ...(mac ? [{ platform: 'mac', arch: 'arm64', files: [entry(`AgentDesk-${version}-arm64-mac.zip`), entry(`AgentDesk-${version}-arm64-mac.zip.blockmap`)] }] : []),
  ] };
  const stream = (mutate = (bytes) => bytes) => Readable.from([Buffer.from(JSON.stringify(header) + '\n'),
    ...header.artifacts.flatMap((artifact) => artifact.files.map((item) => mutate(files[item.name], item.name)))]);
  return { header, files, stream };
}

const trusted = async () => {};

test('intake: accepts one new, higher version and makes it visible in one step', async (t) => {
  const root = tempRoot(t);
  const first = payload('0.3.0', { size: 300_000 });
  assert.deepEqual(await receive({ input: first.stream(), root, verify: trusted }), { ok: true, version: '0.3.0' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'latest.json'))), { version: '0.3.0' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'incoming')), []);
  // Never the same version again, never a lower one: an upload key cannot replace or roll back.
  await assert.rejects(receive({ input: payload('0.3.0').stream(), root, verify: trusted }), /intake_version_exists/);
  await assert.rejects(receive({ input: payload('0.2.9').stream(), root, verify: trusted }), /intake_version_not_newer/);
  assert.equal(fs.readFileSync(path.join(root, 'versions', '0.3.0', 'AgentDesk-0.3.0-setup.exe')).length, 300_000);
});

test('intake: wrong bytes, extra bytes, bad names, connection files, failed provenance — nothing becomes visible', async (t) => {
  const root = tempRoot(t);
  const bad = payload('0.4.0');
  await assert.rejects(receive({ input: bad.stream((bytes, name) => name.endsWith('.exe') ? Buffer.alloc(bytes.length, 9) : bytes), root, verify: trusted }),
    /intake_checksum_mismatch/);
  await assert.rejects(receive({ input: Readable.from([Buffer.from(JSON.stringify(bad.header) + '\n'), Buffer.alloc(10)]), root, verify: trusted }),
    /intake_truncated/);
  const extra = Readable.from([Buffer.from(JSON.stringify(bad.header) + '\n'),
    ...bad.header.artifacts.flatMap((artifact) => artifact.files.map((item) => bad.files[item.name])), Buffer.from('more')]);
  await assert.rejects(receive({ input: extra, root, verify: trusted }), /intake_trailing_data/);
  await assert.rejects(receive({ input: bad.stream(), root, verify: async () => { throw new Error('intake_tag_mismatch'); } }), /intake_tag_mismatch/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'versions')), []);
  assert.equal(fs.existsSync(path.join(root, 'intake.lock')), false);
  const header = bad.header;
  const variants = [
    { ...header, version: '0.4.0-beta.1', tag: 'v0.4.0-beta.1' },
    { ...header, tag: 'v0.4.1' },
    { ...header, commit: 'short' },
    { ...header, runId: 0 },
    { ...header, artifacts: [{ ...header.artifacts[0], files: [{ ...header.artifacts[0].files[0], name: 'agentdesk-server.json' }] }] },
    { ...header, artifacts: [{ ...header.artifacts[0], files: [header.artifacts[0].files[1]] }] },   // no installer
  ];
  for (const value of variants) assert.throws(() => validateHeader(value), /intake_/);
  // A second intake while one runs is refused.
  fs.writeFileSync(path.join(root, 'intake.lock'), '1');
  await assert.rejects(receive({ input: payload('0.5.0').stream(), root, verify: trusted }), /intake_busy/);
});

test('provenance: the tag must point to the commit and the run must be the release workflow on that tag', async () => {
  const replies = {
    '/git/ref/tags/v0.3.0': { object: { type: 'tag', sha: 't1' } },
    '/git/tags/t1': { object: { type: 'commit', sha: commit } },
    '/actions/runs/42': { head_sha: commit, path: '.github/workflows/release.yml', event: 'push', head_branch: 'v0.3.0',
      repository: { full_name: 'miller7-lan/agentdesk' }, conclusion: null },
  };
  const fetch = async (url) => {
    const route = url.replace('https://api.github.com/repos/miller7-lan/agentdesk', '');
    return { ok: Boolean(replies[route]), json: async () => replies[route] };
  };
  await githubProvenance({ tag: 'v0.3.0', commit, runId: 42 }, { fetch });
  await assert.rejects(githubProvenance({ tag: 'v0.3.0', commit: 'c'.repeat(40), runId: 42 }, { fetch }), /intake_tag_mismatch/);
  replies['/actions/runs/42'].event = 'workflow_dispatch';
  await assert.rejects(githubProvenance({ tag: 'v0.3.0', commit, runId: 42 }, { fetch }), /intake_run_mismatch/);
  replies['/actions/runs/42'].event = 'push';
  replies['/actions/runs/42'].repository.full_name = 'someone/fork';
  await assert.rejects(githubProvenance({ tag: 'v0.3.0', commit, runId: 42 }, { fetch }), /intake_run_mismatch/);
  await assert.rejects(githubProvenance({ tag: 'v9.9.9', commit, runId: 42 }, { fetch }), /intake_provenance_failed/);
});

test('store: newest offered version per device and platform, holds, targets, withdrawals, earlier block maps', async (t) => {
  const root = tempRoot(t);
  await receive({ input: payload('0.3.0').stream(), root, verify: trusted });
  await receive({ input: payload('0.3.1').stream(), root, verify: trusted });
  await receive({ input: payload('0.3.2', { mac: false }).stream(), root, verify: trusted });
  const store = new ClientUpdates({ root });
  const win = store.latestFor({ device: 'windows', platform: 'win', arch: 'x64' });
  assert.equal(win.version, '0.3.2');
  assert.deepEqual(win.previousBlockmaps.map((item) => item.name), ['AgentDesk-0.3.1-setup.exe.blockmap', 'AgentDesk-0.3.0-setup.exe.blockmap']);
  assert.equal(validateManifest(win, { platform: 'win', arch: 'x64' }).ok, true);   // the client accepts what the server builds
  const mac = store.latestFor({ device: 'mac', platform: 'mac', arch: 'arm64' });
  assert.equal(mac.version, '0.3.1');                                                // 0.3.2 has no Mac build
  assert.equal(store.latestFor({ device: 'mac', platform: 'mac', arch: 'x64' }), null);
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ versions: { '0.3.2': { devices: ['windows-2'] } } }));
  assert.equal(store.latestFor({ device: 'windows', platform: 'win', arch: 'x64' }).version, '0.3.1');
  assert.equal(store.latestFor({ device: 'windows-2', platform: 'win', arch: 'x64' }).version, '0.3.2');
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ hold: { platforms: ['win'] } }));
  assert.equal(store.latestFor({ device: 'windows', platform: 'win', arch: 'x64' }), null);
  fs.writeFileSync(path.join(root, 'policy.json'), '{}');
  fs.writeFileSync(path.join(root, 'withdrawn.json'), JSON.stringify(['0.3.2']));
  assert.equal(store.latestFor({ device: 'windows', platform: 'win', arch: 'x64' }).version, '0.3.1');
  assert.deepEqual(clientUpdateControl(store, 'client_update', { platform: 'win', arch: 'x64', appVersion: '0.3.1' }, 'windows'), { available: false });
  assert.equal(clientUpdateControl(store, 'client_update', { platform: 'win', arch: 'x64', appVersion: '0.3.0' }, 'windows').available, true);
  assert.throws(() => clientUpdateControl(store, 'client_update', { platform: 'linux', arch: 'x64' }, 'windows'), /invalid_client_platform/);
});

test('store: reads only listed files of the offered version, in frame-sized chunks, and a file over 20 MB reads in full', async (t) => {
  const root = tempRoot(t);
  const size = 21 * 1024 * 1024 + 17;
  await receive({ input: payload('0.3.0', { size: 1000, mac: false }).stream(), root, verify: trusted });
  const big = payload('0.3.1', { size, mac: false });
  await receive({ input: big.stream(), root, verify: trusted });
  const store = new ClientUpdates({ root });
  const device = { device: 'windows', platform: 'win', arch: 'x64' };
  const chunk = store.read({ ...device, version: '0.3.1', file: 'AgentDesk-0.3.1-setup.exe', offset: 0, length: 10 * 1024 * 1024 });
  assert.equal(Buffer.from(chunk.data, 'base64').length, READ_CHUNK);                 // never more than one frame's worth
  assert.equal(store.read({ ...device, version: '0.3.1', file: 'AgentDesk-0.3.0-setup.exe.blockmap', offset: 0, length: 100 }).size,
    'win-blockmap-0.3.0'.length);                                                     // the old version's block map
  assert.throws(() => store.read({ ...device, version: '0.3.1', file: 'AgentDesk-0.3.0-setup.exe', offset: 0, length: 1 }), /invalid_update_file/);
  assert.throws(() => store.read({ ...device, version: '0.3.0', file: 'AgentDesk-0.3.0-setup.exe', offset: 0, length: 1 }), /update_version_not_offered/);
  assert.throws(() => store.read({ ...device, version: '0.3.1', file: '../../etc/passwd', offset: 0, length: 1 }), /invalid_update_file/);
  assert.throws(() => store.read({ ...device, version: '0.3.1', file: 'manifest.json', offset: 0, length: 1 }), /invalid_update_file/);
  assert.throws(() => store.read({ ...device, version: '0.3.1', file: 'AgentDesk-0.3.1-setup.exe', offset: size, length: 1 }), /invalid_update_range/);
  // End to end through the client's reader: the whole 21 MB installer, checked against the manifest's sha512.
  const control = async ({ operation, update }) => ({ ok: true, value: clientUpdateControl(store, operation, update, 'windows') });
  const bytes = await controlChannelReader(control, { version: '0.3.1', platform: 'win', arch: 'x64' })('AgentDesk-0.3.1-setup.exe', 0, size);
  assert.equal(bytes.length, size);
  assert.equal(sha512(bytes), big.header.artifacts[0].files[0].sha512);
  // A file changed on disk after the intake is not served.
  fs.appendFileSync(path.join(root, 'versions', '0.3.1', 'AgentDesk-0.3.1-setup.exe'), 'x');
  assert.throws(() => store.read({ ...device, version: '0.3.1', file: 'AgentDesk-0.3.1-setup.exe', offset: 0, length: 1 }), /update_file_changed/);
});

test('upload stream: only update files, refuses artifacts holding connection settings, round-trips through the intake', async (t) => {
  const root = tempRoot(t);
  const dist = path.join(root, 'dist-win');
  fs.mkdirSync(path.join(dist, 'win-unpacked', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'AgentDesk-0.3.0-setup.exe'), Buffer.alloc(5000, 3));
  fs.writeFileSync(path.join(dist, 'AgentDesk-0.3.0-setup.exe.blockmap'), 'bm');
  fs.writeFileSync(path.join(dist, 'AgentDesk-0.3.0-portable.exe'), 'not uploaded');
  const options = { version: '0.3.0', commit, 'run-id': '7', signed: 'false', artifacts: ['win:x64:' + dist] };
  const plan = upload.build(options);
  assert.deepEqual(plan.files.map((item) => item.name), ['AgentDesk-0.3.0-setup.exe', 'AgentDesk-0.3.0-setup.exe.blockmap']);
  const pipe = new PassThrough();
  const done = receive({ input: pipe, root: path.join(root, 'store'), verify: trusted });
  await upload.write(pipe, plan);
  assert.deepEqual(await done, { ok: true, version: '0.3.0' });
  fs.writeFileSync(path.join(dist, 'win-unpacked', 'resources', 'agentdesk-server.json'), '{}');
  assert.throws(() => upload.build(options), /connection settings/);
  assert.throws(() => upload.build({ ...options, version: '0.3.0-beta.1' }), /plain/);
});

test('upload stream: an artifact folder with a colon (a Windows drive path) is kept whole', (t) => {
  const root = tempRoot(t);
  // On Windows the temporary folder already starts with a drive (C:\\…); elsewhere a folder named D: stands in.
  const dist = process.platform === 'win32' ? path.join(root, 'dist-win') : path.join(root, 'D:', 'a', 'dist-win');
  assert.match(dist, /:/);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'AgentDesk-0.3.0-setup.exe'), Buffer.alloc(10, 1));
  fs.writeFileSync(path.join(dist, 'AgentDesk-0.3.0-setup.exe.blockmap'), 'bm');
  const plan = upload.build({ version: '0.3.0', commit, 'run-id': '7', signed: 'false', artifacts: ['win:x64:' + dist] });
  assert.equal(plan.files[0].file, path.join(dist, 'AgentDesk-0.3.0-setup.exe'));
});
