const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const registry = require('../orchestrator/device-registry');
const { parseRequest, launchPlan } = require('../orchestrator/agentdesk-seat');

const SEAT = path.resolve(__dirname, '..', 'orchestrator', 'agentdesk-seat.js');
const KEY = 'a'.repeat(64);

function key() {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const encode = (buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(buffer.length); return Buffer.concat([length, buffer]); };
  return `ssh-ed25519 ${Buffer.concat([encode(Buffer.from('ssh-ed25519')), encode(raw)]).toString('base64')}`;
}

function setup(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-seat-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'devices.json');
  registry.approve(file, { deviceId: 'mac-1', platform: 'darwin', label: 'Mac', pubkey: key() });
  return { file, env: { AGENTDESK_DEVICES: file, AGENTDESK_DEVICE: 'mac-1', AGENTDESK_PLATFORM: 'darwin' } };
}

test('A9: the launcher accepts exactly provider, mode and session key and nothing else', () => {
  assert.deepEqual(parseRequest(`agentdesk-seat claude write ${KEY}`), { provider: 'claude', mode: 'write', sessionKey: KEY });
  for (const bad of [undefined, '', 'bash', `agentdesk-seat claude write ${KEY} extra`, `agentdesk-seat sh write ${KEY}`,
    `agentdesk-seat claude admin ${KEY}`, 'agentdesk-seat claude write short', `agentdesk-seat claude write ${KEY};id`,
    `agentdesk-seat codex write ${KEY.toUpperCase()}`, `/usr/bin/codex app-server`]) {
    assert.throws(() => parseRequest(bad), /seat_/, String(bad));
  }
});

test('A9: identity comes only from the forced command, and must be an approved device with the same platform', (t) => {
  const { file, env } = setup(t);
  const plan = launchPlan({ ...env, SSH_ORIGINAL_COMMAND: `agentdesk-seat codex read ${KEY}` }, { node: '/opt/agentdesk-orchestrator/node' });
  assert.equal(plan.command, '/usr/bin/unshare');
  assert.deepEqual(plan.args.slice(0, 3), ['--mount', '--propagation', 'private']);
  assert.deepEqual(plan.args.slice(-3), ['codex', 'read', KEY]);
  assert.equal(plan.env.AGENTDESK_DEVICE, 'mac-1');
  assert.equal(plan.env.AGENTDESK_SEAT_LIMITS, 'on');
  assert.equal(Object.keys(plan.env).some((name) => /TOKEN|KEY|SECRET/i.test(name)), false, 'no inherited secrets');
  assert.throws(() => launchPlan({ SSH_ORIGINAL_COMMAND: `agentdesk-seat codex read ${KEY}` }), /seat_device_identity_missing/);
  assert.throws(() => launchPlan({ ...env, AGENTDESK_PLATFORM: 'win32', SSH_ORIGINAL_COMMAND: `agentdesk-seat codex read ${KEY}` }), /DEVICE_MISMATCH/);
  registry.revoke(file, 'mac-1');
  assert.throws(() => launchPlan({ ...env, SSH_ORIGINAL_COMMAND: `agentdesk-seat codex read ${KEY}` }), /DEVICE_REVOKED/);
});

test('the launcher refuses to start anything when not root, and the dry run shows exactly what would run', { skip: process.platform === 'win32' }, (t) => {
  const { env } = setup(t);
  const dry = spawnSync(process.execPath, [SEAT], { env: { ...env, AGENTDESK_SEAT_DRY_RUN: '1', SSH_ORIGINAL_COMMAND: `agentdesk-seat grok write ${KEY}` } });
  assert.equal(dry.status, 0, dry.stderr.toString());
  assert.deepEqual(JSON.parse(dry.stdout).args.slice(-3), ['grok', 'write', KEY]);
  const refused = spawnSync(process.execPath, [SEAT], { env: { ...env, SSH_ORIGINAL_COMMAND: 'bash -i' } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr.toString(), /seat_request_invalid/);
});

test('the seat key line is never suggested by default and points at root (gate G4)', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-seat-lines-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'devices.json');
  const plain = registry.approve(file, { deviceId: 'w-1', platform: 'win32', label: 'W', pubkey: key() });
  assert.equal(plain.suggestedKeyLines.some((line) => line.channel === 'seat'), false);
  const seat = registry.approve(file, { deviceId: 'w-2', platform: 'win32', label: 'W2', pubkey: key(), channels: 'seat' });
  assert.match(seat.suggestedKeyLines[0].line, /agentdesk-seat\.js"/);
  assert.match(seat.suggestedKeyLines[0].target, /root/);
});
