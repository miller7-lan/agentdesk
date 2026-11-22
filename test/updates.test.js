// Client updates: manifest checks, the loopback feed, the update state machine and the safe-restart gate.
// These are unit and simulation tests with fake updaters and fake channels — they show the logic, not a real
// installation on a real computer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const {
  compareVersions, validateManifest, updateDecision, latestYaml, CONNECTION_FILES,
} = require('../orchestrator/update-manifest');
const { createLoopbackFeed, loopbackFeedUrl, controlChannelReader, parseRange, READ_CHUNK } = require('../update-transport');
const { createUpdateManager, errorCategory } = require('../updates');
const { createUpdateGate, countProbe, groupTasksProbe, idle, busy } = require('../update-gate');
const { MAX_FRAME } = require('../orchestrator/transport');

const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');
const commit = 'a'.repeat(40);

function manifestFor(version, bytes, extra = {}) {
  return {
    version, tag: 'v' + version, commit, signed: false, platform: 'win', arch: 'x64',
    files: [
      { name: `AgentDesk-${version}-setup.exe`, size: bytes.length, sha512: sha512(bytes) },
      { name: `AgentDesk-${version}-setup.exe.blockmap`, size: 4, sha512: sha512(Buffer.from('bmap')) },
    ],
    previousBlockmaps: [], ...extra,
  };
}

test('versions: semver order, no downgrade, no prerelease for a stable build', () => {
  assert.equal(compareVersions('0.3.0', '0.2.9'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.0-beta.1', '0.3.0'), -1);
  assert.equal(compareVersions('0.2.9-win.ff5acba', '0.2.9'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('x', '1.0.0'), null);
  const { manifest } = validateManifest(manifestFor('0.3.0', Buffer.from('x')));
  assert.deepEqual(updateDecision('0.2.9', manifest), { update: true });
  assert.equal(updateDecision('0.3.0', manifest).reason, 'current');
  assert.equal(updateDecision('0.4.0', manifest).reason, 'older');
});

test('invalid update metadata is refused as a whole', () => {
  const good = manifestFor('0.3.0', Buffer.from('x'));
  assert.equal(validateManifest(good, { platform: 'win', arch: 'x64' }).ok, true);
  const bad = [
    { ...good, version: '0.3.0-beta.1', tag: 'v0.3.0-beta.1' },      // only plain vX.Y.Z releases
    { ...good, tag: 'v0.3.1' },
    { ...good, commit: 'nothex' },
    { ...good, signed: 'yes' },
    { ...good, withdrawn: true },
    { ...good, files: [{ ...good.files[0], sha512: 'short' }] },
    { ...good, files: [{ ...good.files[0], name: 'agentdesk-server.json' }] },
    { ...good, files: [{ ...good.files[0], name: '../AgentDesk-0.3.0-setup.exe' }] },
    { ...good, files: [{ ...good.files[0], name: 'AgentDesk-0.2.0-setup.exe' }] },   // another version's installer
    { ...good, files: [good.files[1]] },                                                // no installer
    { ...good, files: [{ ...good.files[0], size: 0 }] },
  ];
  for (const value of bad) assert.equal(validateManifest(value).ok, false, JSON.stringify(value).slice(0, 80));
  assert.equal(validateManifest(good, { platform: 'mac' }).error, 'manifest_platform_mismatch');
  assert.equal(validateManifest({ ...good, arch: 'arm64' }, { platform: 'win', arch: 'x64' }).error, 'manifest_arch_mismatch');
  for (const name of ['agentdesk-server.json', 'x/agentdesk-enrollment.json', 'known_hosts', 'id_ed25519', 'a.token', 'remote.json']) {
    assert.match(name, CONNECTION_FILES);
  }
});

test('latest.yml for electron-updater comes only from the validated manifest', () => {
  const { manifest } = validateManifest(manifestFor('0.3.0', Buffer.from('installer')));
  const yaml = latestYaml(manifest, '2026-11-23T00:00:00.000Z');
  assert.match(yaml, /^version: 0\.3\.0\nfiles:\n  - url: AgentDesk-0\.3\.0-setup\.exe\n/);
  assert.ok(!yaml.includes('.blockmap'));
  assert.match(yaml, /path: AgentDesk-0\.3\.0-setup\.exe\n/);
});

test('range parsing for the loopback feed', () => {
  assert.deepEqual(parseRange(undefined, 10), { full: true });
  assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=5-100', 10), { start: 5, end: 9 });
  assert.equal(parseRange('bytes=10-12', 10).invalid, true);
  assert.equal(parseRange('bytes=0-1,4-5', 10).multiple, true);
});

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      const parts = [];
      response.on('data', (chunk) => parts.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
}

test('loopback feed: only listed files, only with its credentials, ranges answered from server reads', async (t) => {
  const bytes = Buffer.alloc(300_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const { manifest } = validateManifest(manifestFor('0.3.0', bytes, {
    previousBlockmaps: [{ name: 'AgentDesk-0.2.9-setup.exe.blockmap', size: 4, sha512: sha512(Buffer.from('old!')) }],
  }));
  const reads = [];
  const content = { 'AgentDesk-0.3.0-setup.exe': bytes, 'AgentDesk-0.2.9-setup.exe.blockmap': Buffer.from('old!'),
    'AgentDesk-0.3.0-setup.exe.blockmap': Buffer.from('bmap') };
  const feed = createLoopbackFeed({ manifest, read: async (name, offset, length) => {
    reads.push([name, offset, length]);
    return content[name].subarray(offset, offset + length);
  } });
  const { url, headers } = await feed.listen();
  t.after(() => feed.close());
  assert.equal(loopbackFeedUrl(url), url);
  assert.equal(loopbackFeedUrl('https://example.com/x/'), null);
  assert.equal(loopbackFeedUrl('http://127.0.0.1:9/notatoken/'), null);
  assert.equal((await get(url + 'latest.yml')).status, 401);                      // no credentials
  assert.equal((await get(url.replace(/[0-9a-f]{32}/, 'f'.repeat(32)) + 'latest.yml', headers)).status, 404);
  assert.equal((await get(url + 'agentdesk-server.json', headers)).status, 404);   // never listed, never served
  assert.equal((await get(url + '..%2Fsecret', headers)).status, 404);
  const yaml = await get(url + 'latest.yml', headers);
  assert.equal(yaml.status, 200);
  assert.match(yaml.body.toString(), /version: 0\.3\.0/);
  const full = await get(url + 'AgentDesk-0.3.0-setup.exe', headers);
  assert.equal(full.status, 200);
  assert.ok(full.body.equals(bytes));
  assert.ok(reads.every(([, , length]) => length <= READ_CHUNK));
  const part = await get(url + 'AgentDesk-0.3.0-setup.exe', { ...headers, Range: 'bytes=1000-1999' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 1000-1999/300000');
  assert.ok(part.body.equals(bytes.subarray(1000, 2000)));
  assert.equal((await get(url + 'AgentDesk-0.3.0-setup.exe', { ...headers, Range: 'bytes=400000-' })).status, 416);
  // Several ranges in one request are not assembled here: the whole file comes back (the updater then downloads in full).
  const multi = await get(url + 'AgentDesk-0.3.0-setup.exe', { ...headers, Range: 'bytes=0-1,5-6' });
  assert.equal(multi.status, 200);
  assert.equal(multi.body.length, bytes.length);
  assert.equal((await get(url + 'AgentDesk-0.2.9-setup.exe.blockmap', headers)).body.toString(), 'old!');
  assert.equal(feed.stats.rangeRequests, 1);
  assert.equal(feed.stats.perFile['AgentDesk-0.3.0-setup.exe'], bytes.length * 2 + 1000);
});

test('client_update_read chunks fit the control channel frame, and a file well over 20 MB is read in full', async () => {
  // The largest chunk, base64-encoded inside its reply, must stay under the frame limit (rpc.js keeps 512 bytes).
  const reply = JSON.stringify({ ok: true, value: { file: 'AgentDesk-10.10.10-arm64-mac.zip.blockmap', offset: 1_073_741_823,
    data: Buffer.alloc(READ_CHUNK).toString('base64') } });
  assert.ok(Buffer.byteLength(reply) + 512 < MAX_FRAME, 'chunk too large for one frame');
  const size = 21 * 1024 * 1024 + 123;
  const file = Buffer.alloc(size, 7);
  let calls = 0;
  const control = async ({ operation, update }) => {
    calls++;
    assert.equal(operation, 'client_update_read');
    assert.ok(update.length <= READ_CHUNK);
    return { ok: true, value: { file: update.file, offset: update.offset,
      data: file.subarray(update.offset, update.offset + update.length).toString('base64') } };
  };
  const read = controlChannelReader(control, { version: '0.3.0' });
  const bytes = await read('AgentDesk-0.3.0-setup.exe', 0, size);
  assert.equal(bytes.length, size);
  assert.equal(sha512(bytes), sha512(file));
  assert.equal(calls, Math.ceil(size / READ_CHUNK));
  // A reply for another offset, or with nothing in it, is refused.
  await assert.rejects(controlChannelReader(async ({ update }) => ({ ok: true, value: { file: update.file, offset: update.offset + 1, data: 'AA==' } }))('f', 0, 4), /invalid_update_chunk/);
  await assert.rejects(controlChannelReader(async ({ update }) => ({ ok: true, value: { file: update.file, offset: update.offset, data: '' } }))('f', 0, 4), /invalid_update_chunk/);
  await assert.rejects(controlChannelReader(async () => ({ ok: false, error: 'bridge_offline' }))('f', 0, 4), /bridge_offline/);
});

// ---- the update state machine with a fake electron-updater ----

class FakeUpdater extends EventEmitter {
  constructor(options, script) {
    super();
    this.options = options;
    this.script = script;
    script.created.push(this);
  }
  async checkForUpdates() {
    return { isUpdateAvailable: true, updateInfo: { version: this.script.feedVersion } };
  }
  async downloadUpdate(token) {
    this.script.downloads++;
    this.token = token;
    if (this.script.downloadError) throw this.script.downloadError;
    if (this.script.hang) {
      while (!token?.cancelled) await new Promise((resolve) => setTimeout(resolve, 5));
      throw Object.assign(new Error('cancelled'), { name: 'CancellationError' });
    }
    for (const percent of [10, 50, 100]) this.emit('download-progress', { percent, transferred: percent, total: 100, bytesPerSecond: 1000 });
    this.logger?.info('Full: 1,000.00 KB, To download: 120.50 KB (12%)');
    if (this.script.serveDuringDownload) await this.script.serveDuringDownload();
    return ['/cache/pending/AgentDesk-setup.exe'];
  }
  quitAndInstall(silent, forceRun) {
    this.script.installs.push([silent, forceRun]);
    if (this.script.installError) setImmediate(() => this.emit('error', this.script.installError));
  }
}

function harness({ version = '0.2.9', signed = false, platform = 'win32', serverVersion = '0.3.0', gateStates = [], manifestFail } = {}) {
  const bytes = Buffer.from('installer-bytes');
  const script = { created: [], downloads: 0, installs: [], feedVersion: serverVersion };
  const states = [];
  const audits = [];
  let manifestCalls = 0;
  let server = serverVersion && manifestFor(serverVersion, bytes, { signed, platform: platform === 'darwin' ? 'mac' : 'win',
    arch: 'x64', files: platform === 'darwin'
      ? [{ name: `AgentDesk-${serverVersion}-mac.zip`, size: bytes.length, sha512: sha512(bytes) }]
      : [{ name: `AgentDesk-${serverVersion}-setup.exe`, size: bytes.length, sha512: sha512(bytes) }] });
  const store = { value: {}, async read() { return this.value; }, async write(value) { this.value = value; } };
  const feedStats = { rangeRequests: 0, bytesFromServer: 0, perFile: {} };
  const transport = {
    async manifest() {
      manifestCalls++;
      if (manifestFail) return { ok: false, error: manifestFail };
      return { ok: true, value: server ? { available: true, manifest: server } : { available: false } };
    },
    async openFeed(manifest) {
      script.serveDuringDownload = async () => {
        feedStats.rangeRequests = 3;
        feedStats.perFile[manifest.installer.name] = 4;
        feedStats.bytesFromServer = 10;
      };
      return { url: 'http://127.0.0.1:4000/' + 'a'.repeat(32) + '/', headers: { Authorization: 'Basic x' }, stats: feedStats, close: async () => {} };
    },
  };
  const gateResults = [...gateStates];
  const gate = { locked: false, evaluate: async () => gateResults.length ? gateResults.shift() : { state: 'idle', reasons: [] },
    lock() { this.locked = true; }, unlock() { this.locked = false; } };
  const prepared = [];
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => version }, platform, arch: 'x64', buildInfo: { signed },
    settings: {}, logger: { audit: (...args) => audits.push(args) }, transport,
    createUpdater: (options) => new FakeUpdater(options, script), gate,
    prepareForQuit: async () => prepared.push('prepare'), abortPrepare: async () => prepared.push('abort'),
    stateStore: store, snapshotData: async () => ({ 'config.json': 'h1' }), reveal: (file) => prepared.push(['reveal', file]),
    newCancellationToken: () => ({ cancelled: false, cancel() { this.cancelled = true; } }),
    onState: (value) => states.push(value),
  });
  return { manager, script, states, audits, gate, prepared, store, setServer: (value) => { server = value; }, manifestCalls: () => manifestCalls, bytes };
}

test('no update / new version: unsigned builds only show it, and never download by themselves', async () => {
  const none = harness({ serverVersion: null });
  assert.equal((await none.manager.check()).status, 'current');
  const same = harness({ version: '0.3.0' });
  assert.equal((await same.manager.check()).status, 'current');
  const unsigned = harness();
  const found = await unsigned.manager.check({ reason: 'server' });
  assert.equal(found.status, 'available');
  assert.equal(found.targetVersion, '0.3.0');
  assert.equal(found.targetSigned, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unsigned.script.downloads, 0);              // Q3: waits for the click
  assert.equal(unsigned.manager.setAutoDownload(true).error, 'unsigned_build');
  unsigned.manager.start();
  assert.equal(unsigned.manager.automaticChecks, false);   // D2: unsigned builds have no timer
});

test('signed build with a signed update downloads in the background on its own', async () => {
  const h = harness({ signed: true });
  h.setServer({ ...manifestFor('0.3.0', h.bytes, { signed: true }) });
  assert.equal(h.manager.automaticChecks, true);
  await h.manager.check({ reason: 'scheduled' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.script.downloads, 1);
  assert.equal(h.manager.state.status, 'ready');
});

test('manual download: progress, measured bytes, differential reported only from what crossed the channel', async () => {
  const h = harness();
  await h.manager.check();
  const result = await h.manager.download();
  assert.deepEqual(result, { ok: true });
  const progress = h.states.filter((state) => state.status === 'downloading').map((state) => state.progress.percent);
  assert.deepEqual(progress, [0, 10, 50, 100]);
  const speeds = h.states.filter((state) => state.status === 'downloading').map((state) => state.progress.bytesPerSecond);
  assert.deepEqual(speeds, [null, null, null, 1000]);       // shown only after enough samples
  const ready = h.manager.state;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.downloaded.differential, true);
  assert.equal(ready.downloaded.installerBytesFromServer, 4);
  assert.deepEqual(ready.downloaded.updaterReport, { fullKB: 1000, downloadKB: 120.5 });
  assert.equal(ready.downloaded.file, undefined);           // no local paths in the window's state
  const options = h.script.created[0].options;
  assert.equal(options.provider, 'generic');
  assert.equal(options.useMultipleRangeRequest, false);
  const updater = h.script.created[0];
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);       // quitting never installs
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
});

test('repeated checks and downloads share one operation', async () => {
  const h = harness();
  const [a, b] = [h.manager.check(), h.manager.check()];
  assert.equal(a, b);
  await a;
  assert.equal(h.manifestCalls(), 1);
  const [x, y] = [h.manager.download(), h.manager.download()];
  assert.equal(x, y);
  await x;
  assert.equal(h.script.downloads, 1);
  assert.deepEqual(await h.manager.download(), { ok: false, error: 'nothing_to_download' });
});

test('network failure: download fails without touching the app, then retry succeeds', async () => {
  const h = harness();
  await h.manager.check();
  h.script.downloadError = Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), {});
  await h.manager.download();
  assert.equal(h.manager.state.status, 'download_failed');
  assert.equal(h.manager.state.error, 'network');
  delete h.script.downloadError;
  await h.manager.retry();
  assert.equal(h.manager.state.status, 'ready');
  const failedCheck = harness({ manifestFail: 'bridge_offline' });
  const state = await failedCheck.manager.check();
  assert.equal(state.status, 'idle');
  assert.equal(state.checkError, 'network');
});

test('integrity failures are categorised and the package is not ready', async () => {
  assert.equal(errorCategory(Object.assign(new Error('x'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' })), 'signature_invalid');
  assert.equal(errorCategory(new Error('sha512 checksum mismatch, expected abc')), 'checksum_mismatch');
  const h = harness();
  await h.manager.check();
  h.script.downloadError = new Error('sha512 checksum mismatch, expected x, got y');
  await h.manager.download();
  assert.equal(h.manager.state.status, 'download_failed');
  assert.equal(h.manager.state.error, 'checksum_mismatch');
  assert.deepEqual(await h.manager.install(), { ok: false, error: 'not_ready' });
  // The feed must announce exactly the version VPS2 listed.
  const other = harness();
  await other.manager.check();
  other.script.feedVersion = '9.9.9';
  await other.manager.download();
  assert.equal(other.manager.state.error, 'feed_mismatch');
});

test('a differential failure that falls back to the full package is reported as full', async () => {
  const h = harness();
  await h.manager.check();
  h.script.created.length = 0;
  const original = FakeUpdater.prototype.downloadUpdate;
  FakeUpdater.prototype.downloadUpdate = async function () {
    this.logger.info('Cannot download differentially, fallback to full download: Error: x');
    this.script.serveDuringDownload = null;
    return ['/cache/full.exe'];
  };
  try {
    const transportStats = h.manager;
    await transportStats.download();
  } finally { FakeUpdater.prototype.downloadUpdate = original; }
  // In this fake the feed reported 4 bytes over 3 range requests before the fallback; the fallback flag is kept.
  assert.equal(h.manager.state.downloaded.fallback, true);
});

test('ready but tasks running, unknown state, then all finished: installation only after the gate opens twice', async () => {
  const busyGate = { state: 'busy', reasons: ['Claude 单聊正在执行'] };
  const unknownGate = { state: 'unknown', reasons: ['无法确认：worker'] };
  const h = harness({ gateStates: [busyGate, unknownGate, { state: 'idle', reasons: [] }, busyGate] });
  await h.manager.check();
  await h.manager.download();
  let result = await h.manager.install();
  assert.equal(result.error, 'tasks_running');
  assert.equal(h.manager.state.status, 'deferred_busy');
  assert.deepEqual(h.manager.state.gate.reasons, ['Claude 单聊正在执行']);
  result = await h.manager.install();
  assert.equal(result.error, 'task_state_unknown');          // unknown blocks too, no override
  result = await h.manager.install();                          // first check idle, second (after locking) busy
  assert.equal(result.error, 'tasks_running');
  assert.equal(h.gate.locked, false);
  assert.equal(h.script.installs.length, 0);
  assert.deepEqual(h.prepared, []);
  // All idle now.
  const done = h.manager.install();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.prepared, ['prepare']);                   // non-destructive shutdown runs before the installer
  assert.deepEqual(h.script.installs, [[false, true]]);         // not silent; the app runs again afterwards
  assert.equal(h.manager.state.status, 'installing');
  assert.equal(h.store.value.pending.target, '0.3.0');
  void done;
});

test('installation error: the app keeps running, connections come back, state says install_failed', async () => {
  const h = harness();
  await h.manager.check();
  await h.manager.download();
  h.script.installError = new Error('spawn EACCES');
  const result = await h.manager.install();
  assert.deepEqual(result, { ok: false, error: 'install_failed' });
  assert.deepEqual(h.prepared, ['prepare', 'abort']);
  assert.equal(h.gate.locked, false);
  assert.equal(h.manager.state.status, 'install_failed');
  assert.deepEqual(h.store.value, {});
});

test('a version withdrawn on VPS2 after the download is not installed', async () => {
  const h = harness();
  await h.manager.check();
  await h.manager.download();
  h.setServer(null);
  assert.deepEqual(await h.manager.install(), { ok: false, error: 'update_withdrawn' });
  assert.equal(h.script.installs.length, 0);
});

test('unsigned macOS: download allowed, installation is manual (Squirrel.Mac needs a signature)', async () => {
  const h = harness({ platform: 'darwin' });
  await h.manager.check();
  await h.manager.download();
  assert.equal(h.manager.state.manualInstall, true);
  assert.deepEqual(await h.manager.install(), { ok: false, error: 'manual_install_required' });
  assert.deepEqual(h.manager.revealDownload(), { ok: true });
  assert.deepEqual(h.prepared, [['reveal', '/cache/pending/AgentDesk-setup.exe']]);
});

test('later: defers without installing; during a download it cancels the download', async () => {
  const h = harness();
  await h.manager.check();
  assert.equal(h.manager.later().ok, true);
  assert.equal(h.manager.state.deferred, true);
  assert.equal(h.manager.state.status, 'available');
  h.script.hang = true;
  const pending = h.manager.download();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.manager.state.status, 'downloading');
  assert.equal(h.manager.later().ok, true);
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
  assert.equal(h.manager.state.status, 'available');
  assert.equal(h.script.installs.length, 0);
});

test('after restart: the installed version and the user data are checked', async () => {
  const h = harness({ version: '0.3.0' });
  h.store.value = { pending: { from: '0.2.9', target: '0.3.0', at: 'x', data: { 'config.json': 'h1' } } };
  assert.deepEqual(await h.manager.verifyPreviousInstall(), { ok: true, changed: [] });
  assert.equal(h.manager.state.status, 'updated');
  const failed = harness({ version: '0.2.9' });
  failed.store.value = { pending: { from: '0.2.9', target: '0.3.0', at: 'x' } };
  assert.equal((await failed.manager.verifyPreviousInstall()).ok, false);
  assert.equal(failed.manager.state.status, 'install_failed');
});

test('not packaged, or no update channel: updates are disabled', async () => {
  const manager = createUpdateManager({ app: { isPackaged: false, getVersion: () => '0.3.0' }, platform: 'win32', transport: {} });
  assert.equal(manager.state.status, 'disabled');
  assert.equal((await manager.check()).status, 'disabled');
});

// ---- the gate ----

test('gate: idle only when every probe is idle; errors, timeouts and odd answers are unknown', async () => {
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms > 100 ? 20 : ms), clearTimeout };
  const gate = createUpdateGate({ timers, timeout: 1000 });
  assert.equal((await gate.evaluate()).state, 'unknown');      // nothing registered: cannot confirm
  let turns = 0;
  gate.register('turns', countProbe(() => turns, 'Codex 单聊正在执行'));
  gate.register('group', groupTasksProbe(async () => ({ ok: true, value: [{ state: 'completed' }] })));
  assert.equal((await gate.evaluate()).state, 'idle');
  turns = 2;
  const result = await gate.evaluate();
  assert.equal(result.state, 'busy');
  assert.deepEqual(result.reasons, ['Codex 单聊正在执行（2 项）']);
  turns = 0;
  gate.register('broken', () => { throw new Error('x'); });
  assert.equal((await gate.evaluate()).state, 'unknown');
  gate.register('broken', () => new Promise(() => {}));        // never answers
  assert.equal((await gate.evaluate()).state, 'unknown');
  gate.register('broken', () => ({ state: 'maybe' }));
  assert.equal((await gate.evaluate()).state, 'unknown');
  gate.register('broken', () => idle());
  assert.equal((await gate.evaluate()).state, 'idle');
  gate.register('terminal', () => busy('本机仍有 1 个交互终端在运行'));
  assert.equal((await gate.evaluate()).state, 'busy');
});

test('gate: group tasks not finished, or not readable, block', async () => {
  assert.equal((await groupTasksProbe(async () => ({ ok: true, value: [{ state: 'running' }, { state: 'failed' }] }))()).state, 'busy');
  assert.equal((await groupTasksProbe(async () => ({ ok: true, value: [{ state: 'awaiting_approval' }] }))()).state, 'busy');
  assert.equal((await groupTasksProbe(async () => ({ ok: false, error: 'bridge_offline' }))()).state, 'unknown');
  assert.equal((await groupTasksProbe(async () => ({ ok: true, value: [{}] }))()).state, 'unknown');
  assert.equal((await groupTasksProbe(async () => null)()).state, 'idle');   // no group orchestration configured
});

// ---- the native-chat Worker probe ----

const { probeWorker, legacyWorkerEvidence, sideEvidence } = require('../orchestrator/worker-idle');

test('worker probe: no answer is not idle without side evidence', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-worker-idle-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const absent = () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }));
  // Process list cannot be read: unknown.
  let result = await probeWorker({ stateDir, connect: absent, listProcesses: async () => { throw new Error('denied'); } });
  assert.equal(result.state, 'unknown');
  // A Worker process for this folder is still there (hung, or socket gone): unknown.
  result = await probeWorker({ stateDir, connect: absent, listProcesses: async () => [`/Applications/AgentDesk.app/x/windows-chat-worker.js ${stateDir}`] });
  assert.equal(result.state, 'unknown');
  // A command left running when the Worker ended: unknown.
  fs.writeFileSync(path.join(stateDir, 'runs.json'), JSON.stringify([{ snapshot: { id: '1', state: 'running' } }]));
  result = await probeWorker({ stateDir, connect: absent, listProcesses: async () => [] });
  assert.equal(result.state, 'unknown');
  fs.writeFileSync(path.join(stateDir, 'runs.json'), JSON.stringify([{ snapshot: { id: '1', state: 'unknown', finishedAt: 1 } }]));
  assert.equal((await probeWorker({ stateDir, connect: absent, listProcesses: async () => [] })).state, 'unknown');
  fs.writeFileSync(path.join(stateDir, 'runs.json'), '{broken');
  assert.equal((await probeWorker({ stateDir, connect: absent, listProcesses: async () => [] })).state, 'unknown');
  // A file write left open: unknown.
  fs.writeFileSync(path.join(stateDir, 'runs.json'), JSON.stringify([{ snapshot: { id: '1', state: 'completed', finishedAt: 1 } }]));
  fs.writeFileSync(path.join(stateDir, 'leases.json'), JSON.stringify([{ id: 'l', fileOperation: true }]));
  assert.equal((await probeWorker({ stateDir, connect: absent, listProcesses: async () => [] })).state, 'unknown');
  // All three kinds of evidence agree: idle.
  fs.writeFileSync(path.join(stateDir, 'leases.json'), JSON.stringify([{ id: 'l', fileOperation: false }]));
  result = await probeWorker({ stateDir, connect: absent, listProcesses: async () => ['/usr/bin/other'] });
  assert.deepEqual(result, { state: 'idle', reasons: [], detail: 'no_worker_process' });
  // Any other connection error: unknown.
  result = await probeWorker({ stateDir, connect: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })), listProcesses: async () => [] });
  assert.equal(result.state, 'unknown');
  assert.deepEqual(sideEvidence({ stateDir: 'C:\\Users\\Me\\State', platform: 'win32', processes: ['"c:\\x\\agentdesk.exe" C:\\app\\windows-chat-worker.js c:\\users\\me\\state'] }).length >= 1, true);
});

test('worker probe: an old Worker is never confirmed idle, and the probe only reads', async () => {
  const calls = [];
  const connection = {
    closed: false,
    close() { this.closed = true; },
    async request(operation, fields) {
      calls.push(operation);
      if (operation === 'idleStatus') throw new Error('invalid_windows_chat_worker_operation');
      if (operation === 'lookup') return fields.binding.threadId === 't1' ? { id: 'lease', generation: 1 } : null;
      if (operation === 'shell') return { runs: Array.from({ length: 16 }, (_, i) => ({ state: i ? 'completed' : 'running' })) };
      if (operation === 'terminalRead') return { terminals: [{ state: 'running' }] };
      throw new Error('unexpected ' + operation);
    },
  };
  const result = await probeWorker({ stateDir: '/x', connect: async () => connection, listProcesses: async () => [],
    legacyEvidence: (c) => legacyWorkerEvidence(c, [{ threadId: 't1' }, { threadId: 't2' }]) });
  assert.equal(result.state, 'unknown');
  assert.equal(result.detail, 'legacy_worker');
  assert.ok(result.reasons.some((item) => /后台命令未结束/.test(item)));
  assert.ok(result.reasons.some((item) => /最近 16 条/.test(item)));
  assert.ok(result.reasons.some((item) => /交互终端/.test(item)));
  assert.ok(calls.every((name) => ['idleStatus', 'lookup', 'shell', 'terminalRead'].includes(name)));
  assert.equal(connection.closed, true);
  // Even an old Worker with nothing to report stays unknown.
  const quiet = { close() {}, async request(operation) {
    if (operation === 'idleStatus') throw new Error('invalid_windows_chat_worker_operation');
    return null;
  } };
  assert.equal((await probeWorker({ stateDir: '/x', connect: async () => quiet, listProcesses: async () => [],
    legacyEvidence: (c) => legacyWorkerEvidence(c, [{ threadId: 't9' }]) })).state, 'unknown');
});

const posix = process.platform !== 'win32';
test('worker idleStatus / shutdownIfIdle on a real Worker: busy while a command runs, ends itself only when idle', { skip: !posix, timeout: 30_000 }, async (t) => {
  const { serveWorker, connectWorker, createSecret } = require('../orchestrator/windows-chat-worker');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-worker-shutdown-'));
  const root = path.join(state, 'project');
  fs.mkdirSync(root);
  const secret = createSecret(state);
  let shutdowns = 0;
  const server = serveWorker(state, { onShutdown: () => { shutdowns++; } });
  t.after(() => { try { server.close(); } catch {} fs.rmSync(state, { recursive: true, force: true }); });
  await new Promise((resolve) => server.once('listening', resolve));
  const worker = await connectWorker(state, secret);
  t.after(() => worker.close());
  const idleStatus = await worker.request('idleStatus', {});
  assert.equal(idleStatus.idle, true);
  assert.equal(idleStatus.protocol, 1);
  const identity = { device: 'mac', provider: 'claude', threadId: 'pending-1', root, fullAccess: true };
  const binding = { ...identity, ...await worker.request('acquire', { binding: identity }) };
  await worker.request('shell', { binding, args: { action: 'run', shell: 'bash', command: 'sleep 3', background: true }, requestId: 'sleep' });
  const running = await worker.request('idleStatus', {});
  assert.equal(running.idle, false);
  assert.equal(running.runningCommands, 1);
  const refused = await worker.request('shutdownIfIdle', {});
  assert.equal(refused.shutdown, false);                 // nothing was stopped
  const still = await worker.request('shell', { binding, args: { action: 'list' } });
  assert.equal(still.runs[0].state, 'running');
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const done = await worker.request('shutdownIfIdle', {});
  assert.equal(done.shutdown, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdowns, 1);
  const probe = await probeWorker({ stateDir: state, connect: () => connectWorker(state, secret), listProcesses: async () => [] });
  assert.equal(probe.state, 'idle');                     // gone, and runs.json / leases.json agree
});

// ---- the update dialog: what is clickable in each state (D5) ----

const { buttonsFor, describe } = require('../src/updates-ui');

test('update dialog: no update → install not clickable; ready and idle → clickable; busy or unknown → not, with reasons', () => {
  const clickable = (state) => Object.entries(buttonsFor(state)).filter(([, on]) => on).map(([name]) => name).sort().join(',');
  assert.equal(clickable({ status: 'current' }), 'check');
  assert.equal(clickable({ status: 'idle' }), 'check');
  assert.equal(clickable({ status: 'checking' }), '');
  assert.equal(clickable({ status: 'available' }), 'check,download,later');
  assert.equal(clickable({ status: 'downloading' }), 'later');
  assert.equal(clickable({ status: 'download_failed' }), 'check,later,retry');
  assert.equal(clickable({ status: 'ready' }), 'check,install,later');
  assert.equal(clickable({ status: 'ready', manualInstall: true }), 'check,later,reveal');   // unsigned macOS
  assert.equal(clickable({ status: 'deferred_busy', gate: { state: 'busy' } }), 'check,later,watch');
  assert.equal(clickable({ status: 'deferred_busy', gate: { state: 'unknown' } }), 'check,later,watch');
  assert.equal(clickable({ status: 'installing' }), '');
  assert.equal(clickable({ status: 'install_failed' }), 'check,later');
  assert.equal(clickable({ status: 'updated' }), 'check');
  assert.equal(clickable({ status: 'disabled' }), '');
  for (const status of ['current', 'available', 'downloading', 'download_failed', 'deferred_busy', 'installing', 'install_failed', 'disabled']) {
    assert.equal(buttonsFor({ status }).install, false, status);
  }
  const busyView = describe({ status: 'deferred_busy', gate: { state: 'busy', reasons: ['Claude 单聊正在执行'] } });
  assert.deepEqual(busyView.reasons, ['Claude 单聊正在执行']);
  assert.match(busyView.notice, /仍在运行/);
  assert.match(describe({ status: 'deferred_busy', gate: { state: 'unknown', reasons: ['x'] } }).notice, /无法确认/);
  const downloading = describe({ status: 'downloading', progress: { percent: 40, transferred: 4 * 1048576, total: 10 * 1048576, bytesPerSecond: 1048576, etaSeconds: 6 } });
  assert.equal(downloading.percent, 40);
  assert.equal(downloading.progressText, '40%，4.0 MB / 10.0 MB，1.0 MB/s，约剩 6 秒');
  assert.equal(describe({ status: 'downloading', progress: { percent: 5, transferred: 1, total: 2, bytesPerSecond: null, etaSeconds: null } }).progressText,
    '5%，1 B / 2 B');                                                                     // no speed or ETA until reliable
  const ready = describe({ status: 'ready', targetVersion: '0.3.0', targetSigned: false, size: 1048576,
    downloaded: { differential: 'unknown', installerBytesFromServer: null, fullSize: 1048576 } });
  assert.ok(ready.lines.includes('下载方式未知：经主控线路传输 未知，完整包 1.0 MB'));
  assert.match(ready.notice, /未签名/);
  assert.equal(describe({ status: 'ready', autoDownload: false, signedBuild: false }).autoDownloadAvailable, false);
});
