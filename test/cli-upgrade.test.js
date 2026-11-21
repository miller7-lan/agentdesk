const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { requestUpgrade, upgradeStatus, isUpgrading, runRequest, runPending } = require('../orchestrator/cli-upgrade');

function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-cli-upgrade-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

const approved = { state: 'approved', deviceId: 'mac-1', label: 'Mac' };

test('Q5: any approved device may ask; others, unknown CLIs and pinned versions are refused; duplicates merge', (t) => {
  const spool = temporary(t);
  assert.throws(() => requestUpgrade({ spool, provider: 'codex', device: { state: 'pending' } }), /device_not_approved/);
  assert.throws(() => requestUpgrade({ spool, provider: 'codex', device: { state: 'revoked' } }), /device_not_approved/);
  assert.throws(() => requestUpgrade({ spool, provider: 'vim', device: approved }), /invalid_cli_provider/);
  assert.throws(() => requestUpgrade({ spool, provider: 'codex', target: '1.2.3', device: approved }), /cli_version_selection_unsupported/);
  const first = requestUpgrade({ spool, provider: 'codex', device: approved });
  const second = requestUpgrade({ spool, provider: 'codex', device: { ...approved, deviceId: 'win-1' } });
  assert.equal(second.merged, true);
  assert.equal(second.requestId, first.requestId);
  const status = upgradeStatus({ spool });
  assert.equal(status.requests.length, 1);
  assert.equal(status.requests[0].state, 'queued');
  assert.equal(status.runnerInstalled, false, 'no root runner is installed (gate G3)');
});

// A stand-in CLI: --version prints its version; `update` replaces itself with the file "next" beside it.
function fakeCli(folder, version) {
  const bin = path.join(folder, 'fakecli');
  const script = (value, broken = false) => `#!/bin/sh\nif [ "$1" = --version ]; then ${broken ? 'exit 3' : `echo "fakecli ${value}"; exit 0`}; fi\n` +
    'if [ "$1" = update ]; then cp "$(dirname "$0")/next" "$0.new" && chmod 755 "$0.new" && mv "$0.new" "$0"; exit 0; fi\nexit 0\n';
  fs.writeFileSync(bin, script(version), { mode: 0o755 });
  return { bin, next: (value, broken) => fs.writeFileSync(path.join(folder, 'next'), script(value, broken), { mode: 0o755 }) };
}

test('runner: backs up, updates, checks without a model call, and records every event', { skip: process.platform === 'win32' }, async (t) => {
  const folder = temporary(t);
  const spool = path.join(folder, 'spool');
  const cli = fakeCli(folder, '1.0');
  cli.next('2.0');
  const request = requestUpgrade({ spool, provider: 'codex', device: approved });
  let markerSeen = false;
  const providers = { codex: { bin: cli.bin, update: ['update'] } };
  const record = await runRequest({ requestId: request.requestId, provider: 'codex' }, { spool, backups: path.join(folder, 'backups'), providers,
    doctor: async () => { markerSeen = isUpgrading('codex', { spool }); return { ok: true }; } });
  assert.equal(record.state, 'succeeded');
  assert.equal(record.fromVersion, 'fakecli 1.0');
  assert.equal(record.toVersion, 'fakecli 2.0');
  assert.ok(markerSeen, 'new turns wait while it runs');
  assert.equal(isUpgrading('codex', { spool }), false, 'marker removed afterwards');
  assert.deepEqual(record.events.map((event) => event.type), ['cli.upgrade.started', 'cli.upgrade.progress', 'cli.upgrade.succeeded']);
  assert.ok(fs.existsSync(path.join(folder, 'backups', 'codex', 'fakecli_1.0')));
  assert.equal(upgradeStatus({ spool }).requests[0].state, 'succeeded');
});

test('runner: a failed check restores the previous version and reports rolledBack', { skip: process.platform === 'win32' }, async (t) => {
  const folder = temporary(t);
  const spool = path.join(folder, 'spool');
  const cli = fakeCli(folder, '1.0');
  const before = createHash('sha256').update(fs.readFileSync(cli.bin)).digest('hex');
  cli.next('2.0', true);   // the new version does not even start
  requestUpgrade({ spool, provider: 'claude', device: approved });
  const [record] = await runPending({ spool, backups: path.join(folder, 'backups'), providers: { claude: { bin: cli.bin, update: ['update'] } } });
  assert.equal(record.state, 'rolledBack');
  assert.equal(record.toVersion, 'fakecli 1.0');
  assert.equal(createHash('sha256').update(fs.readFileSync(cli.bin)).digest('hex'), before);
  assert.equal(record.events.at(-1).type, 'cli.upgrade.rolledBack');
  // Already finished requests are not run again.
  assert.deepEqual(await runPending({ spool, providers: { claude: { bin: cli.bin, update: ['update'] } } }), []);
});

test('a stale upgrading marker (crashed runner) stops blocking turns after 30 minutes', (t) => {
  const spool = temporary(t);
  fs.mkdirSync(path.join(spool, 'state'), { recursive: true });
  const marker = path.join(spool, 'state', 'grok.upgrading');
  fs.writeFileSync(marker, 'x');
  assert.equal(isUpgrading('grok', { spool }), true);
  const old = (Date.now() - 31 * 60_000) / 1000;
  fs.utimesSync(marker, old, old);
  assert.equal(isUpgrading('grok', { spool }), false);
});
