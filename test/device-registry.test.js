const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../orchestrator/device-registry');

const ADMIN = path.resolve(__dirname, '..', 'orchestrator', 'admin.js');

function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-devices-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function key(comment = 'k') {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const encode = (buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(buffer.length); return Buffer.concat([length, buffer]); };
  return `ssh-ed25519 ${Buffer.concat([encode(Buffer.from('ssh-ed25519')), encode(raw)]).toString('base64')} ${comment}`;
}

const MAC = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('fingerprints match the OpenSSH SHA256 format and malformed keys are refused', () => {
  const text = key();
  const blob = Buffer.from(text.split(' ')[1], 'base64');
  assert.equal(registry.parsePublicKey(text).fingerprint, 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''));
  for (const bad of ['', 'ssh-ed25519', 'ssh-ed25519 !!!', 'restrict ' + text, 'ssh-rsa ' + text.split(' ')[1], text + '\nssh-ed25519 AAAA']) {
    assert.throws(() => registry.parsePublicKey(bad), /invalid_public_key/);
  }
  const ssh = spawnSync('ssh-keygen', ['-lf', '-'], { input: text });
  if (ssh.status === 0) assert.ok(ssh.stdout.toString().includes(registry.parsePublicKey(text).fingerprint));
});

test('approve records the device and prints key lines with injected identity; conflicts are refused', (t) => {
  const file = path.join(temporary(t), 'devices.json');
  const pub = key();
  const { device, suggestedKeyLines } = registry.approve(file, { deviceId: MAC, platform: 'darwin', label: 'MacBook', pubkey: pub });
  assert.equal(device.state, 'approved');
  assert.equal(device.directChatV2, false);
  assert.deepEqual(suggestedKeyLines.map((line) => line.channel), ['chat-claude', 'chat-grok', 'chat-antigravity', 'codex']);
  for (const { line } of suggestedKeyLines) {
    assert.match(line, new RegExp(`^restrict,command="/usr/bin/env AGENTDESK_DEVICE=${MAC} AGENTDESK_PLATFORM=darwin `));
    assert.ok(line.includes(pub.split(' ').slice(0, 2).join(' ')));
  }
  // Same fingerprint for another device, another platform for the same id, a bad id: all refused.
  assert.throws(() => registry.approve(file, { deviceId: 'other', platform: 'win32', label: 'W', pubkey: pub }), /fingerprint_in_use/);
  assert.throws(() => registry.approve(file, { deviceId: MAC, platform: 'win32', label: 'M', pubkey: key() }), /device_platform_conflict/);
  assert.throws(() => registry.approve(file, { deviceId: 'bad id', platform: 'darwin', label: 'x', pubkey: key() }), /invalid_device_id/);
  assert.throws(() => registry.approve(file, { deviceId: 'w1', platform: 'linux', label: 'x', pubkey: key() }), /invalid_platform/);
  // Bridge lines need a bridge name.
  assert.throws(() => registry.approve(file, { deviceId: 'w2', platform: 'win32', label: 'x', pubkey: key(), channels: 'bridge' }), /bridge_name_required/);
  const bridge = registry.approve(file, { deviceId: 'w3', platform: 'win32', label: 'x', pubkey: key(), channels: 'bridge', bridge: 'windows' });
  assert.match(bridge.suggestedKeyLines[0].line, /ssh-gateway\.js \/var\/lib\/agentdesk-orchestrator\/bridge-windows\.sock/);
});

test('revoke takes effect for identity checks at once and v2 can only be switched on for approved devices', (t) => {
  const file = path.join(temporary(t), 'devices.json');
  registry.approve(file, { deviceId: MAC, platform: 'darwin', label: 'Mac', pubkey: key() });
  registry.setDirectChatV2(file, MAC, true);
  const env = { AGENTDESK_DEVICES: file, AGENTDESK_DEVICE: MAC, AGENTDESK_PLATFORM: 'darwin' };
  assert.equal(registry.identityFromEnv(env).v2, true);
  assert.equal(registry.identityFromEnv({ ...env, AGENTDESK_PLATFORM: 'win32' }).error, 'DEVICE_MISMATCH');
  assert.equal(registry.identityFromEnv({ ...env, AGENTDESK_DEVICE: 'nobody' }).error, 'DEVICE_NOT_APPROVED');
  assert.equal(registry.identityFromEnv({ AGENTDESK_CHAT_DEVICE: 'windows' }).legacy, true);
  const revoked = registry.revoke(file, MAC);
  assert.equal(revoked.device.state, 'revoked');
  assert.equal(revoked.removeKeyLinesWithFingerprints.length, 1);
  assert.equal(registry.identityFromEnv(env).error, 'DEVICE_REVOKED');
  assert.throws(() => registry.setDirectChatV2(file, MAC, true), /device_not_approved/);
  assert.throws(() => registry.approve(file, { deviceId: MAC, platform: 'darwin', label: 'Mac', pubkey: key() }), /device_revoked/);
  const history = registry.load(file).history.map((entry) => entry.action);
  assert.deepEqual(history, ['approve', 'v2_on', 'revoke']);
});

test('A17: ad device approve/revoke change only the registry file; no SSH file is touched', (t) => {
  const folder = temporary(t);
  const file = path.join(folder, 'devices.json');
  // Fingerprint every file under /etc/ssh and root's authorized_keys, plus everything in the sandbox, before and after.
  const targets = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) targets.push(full);
    }
  };
  walk('/etc/ssh');
  targets.push('/root/.ssh/authorized_keys');
  const snapshot = () => Object.fromEntries(targets.map((name) => {
    try {
      const stat = fs.statSync(name);
      let digest = 'unreadable';
      try { digest = createHash('sha256').update(fs.readFileSync(name)).digest('hex'); } catch {}
      return [name, `${digest}:${stat.mtimeMs}:${stat.size}`];
    } catch { return [name, 'absent']; }
  }));
  const before = snapshot();
  const listing = () => fs.readdirSync(folder).sort();
  const env = { ...process.env, AGENTDESK_DEVICES: file };
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [ADMIN, '-', 'device', ...args], { env }).toString()).value;
  const approved = run('approve', MAC, '--platform', 'darwin', '--label', 'Mac', '--pubkey', key());
  assert.ok(approved.suggestedKeyLines.length);
  assert.match(approved.notice, /未改动任何 SSH 授权文件/);
  assert.deepEqual(listing(), ['devices.json']);
  run('v2', MAC, 'on');
  run('rename', MAC, 'Work', 'Mac');
  assert.equal(run('list').devices[0].label, 'Work Mac');
  const revoked = run('revoke', MAC);
  assert.equal(revoked.device.state, 'revoked');
  assert.deepEqual(listing(), ['devices.json']);
  assert.deepEqual(snapshot(), before);
  // The modules that implement it know no SSH authorization path at all.
  for (const source of ['device-registry.js', 'admin.js']) {
    const text = fs.readFileSync(path.resolve(__dirname, '..', 'orchestrator', source), 'utf8');
    assert.doesNotMatch(text, /\/etc\/ssh|\.ssh\/|sshd|systemctl/);
  }
});
