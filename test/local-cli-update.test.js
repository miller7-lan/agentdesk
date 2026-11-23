'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'local-cli-update.js');

test('zoneNow reports the New York day and hour, following DST', () => {
  const { zoneNow } = require(SCRIPT);
  assert.deepEqual(zoneNow(new Date('2026-11-23T17:00:00Z')), { day: '2026-11-23', hour: 12 }); // EST, UTC-5
  assert.deepEqual(zoneNow(new Date('2026-07-01T16:00:00Z')), { day: '2026-07-01', hour: 12 }); // EDT, UTC-4
  assert.deepEqual(zoneNow(new Date('2026-11-24T03:00:00Z')), { day: '2026-11-23', hour: 22 });
});

test('--now updates the installed CLIs, skips missing ones and records the run', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-update-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // codex updates fine, claude's updater fails, grok and agy are not installed.
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n[ "$1" = update ] && { echo updated; exit 0; }\necho codex 1.0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1" = update ] && { echo network down >&2; exit 3; }\necho claude 2.0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, AGENTDESK_CLI_UPDATE_DIR: dir };
  const result = spawnSync(process.execPath, [SCRIPT, '--now'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const logText = fs.readFileSync(path.join(dir, 'cli-update.log'), 'utf8');
  assert.match(logText, /\[codex\] after: codex 1\.0 \(exit 0\)/);
  assert.match(logText, /\[claude\]   network down/);
  assert.match(logText, /\[claude\] update failed/);
  assert.match(logText, /\[grok\] not installed, skipped/);
  assert.match(logText, /\[antigravity\] not installed, skipped/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli-update-state.json'), 'utf8'));
  assert.equal(state.failed, 1);
  assert.equal(fs.existsSync(path.join(dir, 'cli-update.lock')), false);
  // A scheduled start on a day that already ran does nothing.
  fs.writeFileSync(path.join(dir, 'cli-update-state.json'), JSON.stringify({ lastDay: require(SCRIPT).zoneNow().day }));
  const before = fs.statSync(path.join(dir, 'cli-update.log')).size;
  assert.equal(spawnSync(process.execPath, [SCRIPT], { env }).status, 0);
  assert.equal(fs.statSync(path.join(dir, 'cli-update.log')).size, before);
  fs.rmSync(dir, { recursive: true, force: true });
});
