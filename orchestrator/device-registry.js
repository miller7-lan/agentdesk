// Device registry for direct chat v2 (VPS2).
//
// The registry binds a client-generated deviceId and platform to the SSH key fingerprints an administrator
// approved. It holds no secrets: deviceId, platform, label, key fingerprints, state and a short history.
//
// N1: approving or revoking a device ONLY changes this registry file and returns the authorized_keys lines an
// administrator may add or remove by hand (after a backup). Nothing in this module opens, writes or reloads any
// SSH authorization file or reloads the SSH daemon; the module deliberately knows no SSH file paths.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const DEFAULT_REGISTRY = '/etc/agentdesk-orchestrator/devices.json';
const DEFAULT_STATE = '/var/lib/agentdesk-orchestrator';
const INSTALL = '/opt/agentdesk-orchestrator';
const PLATFORMS = new Set(['darwin', 'win32']);
const STATES = new Set(['pending', 'approved', 'revoked']);
// A client-generated UUID, or one of the legacy tags already used in forced commands (e.g. windows, lenovo_actjm6t3).
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHAT_PROVIDERS = ['claude', 'grok', 'antigravity'];
// 'seat' (the P7 narrow launcher) belongs in root's authorized_keys and is never in the default set (gate G4).
const CHANNELS = new Set([...CHAT_PROVIDERS.map((name) => 'chat-' + name), 'codex', 'bridge', 'seat']);
const DEFAULT_CHANNELS = [...CHAT_PROVIDERS.map((name) => 'chat-' + name), 'codex'];
const KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']);
const HISTORY_LIMIT = 200;

const fail = (code, detail) => Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });

function validDeviceId(value) { return typeof value === 'string' && DEVICE_ID.test(value); }

// Parses one OpenSSH public key line ("type base64 [comment]") and returns its SHA256 fingerprint the way
// `ssh-keygen -lf` prints it. Options in front of the key (authorized_keys style) are refused on purpose: the
// administrator passes the bare public key the client displays.
function parsePublicKey(text) {
  if (typeof text !== 'string') throw fail('invalid_public_key');
  const line = text.trim();
  if (!line || line.length > 16384 || /[\r\n\0]/.test(line)) throw fail('invalid_public_key');
  const [type, blob] = line.split(/\s+/);
  if (!KEY_TYPES.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob || '')) throw fail('invalid_public_key');
  const bytes = Buffer.from(blob, 'base64');
  if (bytes.toString('base64') !== blob || bytes.length < 8) throw fail('invalid_public_key');
  const length = bytes.readUInt32BE(0);
  if (length + 4 > bytes.length || bytes.subarray(4, 4 + length).toString('latin1') !== type) throw fail('invalid_public_key');
  const fingerprint = 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
  return { type, blob, fingerprint, publicKey: `${type} ${blob}` };
}

function emptyRegistry() { return { version: 1, devices: [], history: [] }; }

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.devices)) {
    throw fail('invalid_device_registry');
  }
  for (const device of value.devices) {
    if (!validDeviceId(device?.deviceId) || !PLATFORMS.has(device.platform) || !STATES.has(device.state) ||
        !Array.isArray(device.keys)) throw fail('invalid_device_registry', String(device?.deviceId));
  }
  if (!Array.isArray(value.history)) value.history = [];
  return value;
}

function load(file = DEFAULT_REGISTRY) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyRegistry();
    throw error;
  }
  return normalize(JSON.parse(text));
}

// Atomic replace. The file is not secret; group read lets the agentdesk service account read it.
function save(file, registry) {
  normalize(registry);
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  let mode = 0o640;
  let owner;
  try { const stat = fs.statSync(file); mode = stat.mode & 0o777; owner = { uid: stat.uid, gid: stat.gid }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode });
    if (owner && process.getuid?.() === 0) fs.chownSync(temporary, owner.uid, owner.gid);
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

function find(registry, deviceId) { return registry.devices.find((device) => device.deviceId === deviceId) || null; }

function record(registry, event) {
  registry.history.push({ at: new Date().toISOString(), ...event });
  if (registry.history.length > HISTORY_LIMIT) registry.history.splice(0, registry.history.length - HISTORY_LIMIT);
}

function shellQuote(value) { return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`; }

// The lines an administrator may add to the AgentDesk authorized keys file by hand. Identity is injected by
// the forced command, so the client cannot choose it. `restrict` turns off forwarding, PTY and agent use.
function suggestedKeyLines(device, publicKey, channels = DEFAULT_CHANNELS, { bridge } = {}) {
  const env = `/usr/bin/env AGENTDESK_DEVICE=${device.deviceId} AGENTDESK_PLATFORM=${device.platform}`;
  const lines = [];
  for (const channel of channels) {
    if (!CHANNELS.has(channel)) throw fail('invalid_channel', channel);
    let command;
    if (channel.startsWith('chat-')) command = `${env} ${INSTALL}/agent-chat.sh ${channel.slice(5)}`;
    else if (channel === 'codex') command = `${env} ${INSTALL}/codex-desktop.sh`;
    else if (channel === 'seat') command = `${env} ${INSTALL}/node ${INSTALL}/agentdesk-seat.js`;
    else {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(bridge || '')) throw fail('bridge_name_required');
      command = `${env} ${INSTALL}/node ${INSTALL}/ssh-gateway.js ${DEFAULT_STATE}/bridge-${bridge}.sock ${DEFAULT_STATE}/bridge-${bridge}-mount.sock`;
    }
    lines.push({ channel, target: channel === 'seat' ? 'root 账户的 authorized_keys（G4，需另行确认）' : 'agentdesk 账户的 AgentDesk authorized keys 文件',
      line: `restrict,command="${command}" ${publicKey} agentdesk-${device.deviceId}-${channel}` });
  }
  return lines;
}

function parseChannels(value) {
  if (value === undefined || value === '') return [...DEFAULT_CHANNELS];
  const list = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (!list.length || list.some((item) => !CHANNELS.has(item))) throw fail('invalid_channel', String(value));
  return [...new Set(list)];
}

function approve(file, { deviceId, platform, label, pubkey, channels, bridge, by = 'admin', legacyTag } = {}) {
  if (!validDeviceId(deviceId)) throw fail('invalid_device_id');
  if (!PLATFORMS.has(platform)) throw fail('invalid_platform');
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw fail('invalid_label');
  if (legacyTag !== undefined && !(legacyTag === 'default' || /^[a-z0-9_]{1,20}$/.test(legacyTag))) throw fail('invalid_legacy_tag');
  const key = parsePublicKey(pubkey);
  const wanted = parseChannels(channels);
  const registry = load(file);
  for (const other of registry.devices) {
    if (other.deviceId !== deviceId && other.keys.some((item) => item.fingerprint === key.fingerprint)) {
      throw fail('fingerprint_in_use', other.deviceId);
    }
  }
  let device = find(registry, deviceId);
  if (device) {
    if (device.state === 'revoked') throw fail('device_revoked', deviceId);
    if (device.platform !== platform) throw fail('device_platform_conflict', `${deviceId} is ${device.platform}`);
  } else {
    device = { deviceId, platform, label: name, state: 'pending', keys: [], directChatV2: false, createdAt: new Date().toISOString() };
    registry.devices.push(device);
  }
  const existing = device.keys.find((item) => item.fingerprint === key.fingerprint);
  if (existing) existing.channels = [...new Set([...existing.channels, ...wanted])];
  else device.keys.push({ fingerprint: key.fingerprint, type: key.type, channels: wanted });
  Object.assign(device, { label: name, state: 'approved', approvedAt: new Date().toISOString(), approvedBy: String(by).slice(0, 64),
    ...(legacyTag !== undefined && { legacyTag }) });
  // The Bridge name lets the orchestrator recognise this device's control requests (e.g. a CLI upgrade, Q5).
  if (wanted.includes('bridge') && bridge) device.bridges = [...new Set([...(device.bridges || []), bridge])];
  record(registry, { action: 'approve', deviceId, platform, fingerprint: key.fingerprint, channels: wanted, by: device.approvedBy });
  save(file, registry);
  return { device: structuredClone(device), suggestedKeyLines: suggestedKeyLines(device, key.publicKey, wanted, { bridge }) };
}

function revoke(file, deviceId, { by = 'admin' } = {}) {
  const registry = load(file);
  const device = find(registry, deviceId);
  if (!device) throw fail('device_not_found', deviceId);
  device.state = 'revoked';
  device.revokedAt = new Date().toISOString();
  device.directChatV2 = false;
  record(registry, { action: 'revoke', deviceId, fingerprints: device.keys.map((item) => item.fingerprint), by: String(by).slice(0, 64) });
  save(file, registry);
  return {
    device: structuredClone(device),
    // The key text is not stored, so the administrator removes the lines carrying these fingerprints by hand.
    removeKeyLinesWithFingerprints: device.keys.map((item) => item.fingerprint),
  };
}

function rename(file, deviceId, label) {
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw fail('invalid_label');
  const registry = load(file);
  const device = find(registry, deviceId);
  if (!device) throw fail('device_not_found', deviceId);
  device.label = name;
  record(registry, { action: 'rename', deviceId });
  save(file, registry);
  return structuredClone(device);
}

// directChatV2 is switched per device (spec §13). Only approved devices may be switched on.
function setDirectChatV2(file, deviceId, enabled) {
  const registry = load(file);
  const device = find(registry, deviceId);
  if (!device) throw fail('device_not_found', deviceId);
  if (enabled && device.state !== 'approved') throw fail('device_not_approved', deviceId);
  device.directChatV2 = Boolean(enabled);
  record(registry, { action: enabled ? 'v2_on' : 'v2_off', deviceId });
  save(file, registry);
  return structuredClone(device);
}

// The approved device a named Bridge belongs to, if any.
function deviceForBridge(file, bridge) {
  if (typeof bridge !== 'string' || !bridge) return null;
  try { return load(file).devices.find((device) => device.state === 'approved' && (device.bridges || []).includes(bridge)) || null; }
  catch { return null; }
}

function list(file) {
  return load(file).devices.map((device) => structuredClone(device));
}

// Checked on every request so a revocation applies at once, without waiting for the key line to be removed.
function lookup(file, deviceId) {
  if (!validDeviceId(deviceId)) return null;
  try { return find(load(file), deviceId); } catch { return null; }
}

// Resolves the server-side identity of a connection from what the forced command injected.
// Returns { deviceId, platform, device, state, v2 } or { legacy: true } for keys without AGENTDESK_DEVICE.
function identityFromEnv(env = process.env, file = env.AGENTDESK_DEVICES || DEFAULT_REGISTRY) {
  const deviceId = env.AGENTDESK_DEVICE || '';
  if (!deviceId) return { legacy: true, legacyTag: env.AGENTDESK_CHAT_DEVICE || '' };
  if (!validDeviceId(deviceId)) return { deviceId, state: 'invalid', error: 'invalid_device_id' };
  const device = lookup(file, deviceId);
  if (!device) return { deviceId, state: 'unregistered', error: 'DEVICE_NOT_APPROVED' };
  const platform = env.AGENTDESK_PLATFORM || '';
  if (platform && platform !== device.platform) return { deviceId, state: 'invalid', error: 'DEVICE_MISMATCH' };
  if (device.state !== 'approved') {
    return { deviceId, platform: device.platform, state: device.state, error: device.state === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_NOT_APPROVED' };
  }
  return { deviceId, platform: device.platform, label: device.label, state: 'approved', v2: device.directChatV2 === true, legacyTag: device.legacyTag, device };
}

function deviceStateDir(stateRoot, deviceId) {
  if (!validDeviceId(deviceId)) throw fail('invalid_device_id');
  return path.join(stateRoot, 'direct-chat', deviceId);
}

// codex-desktop.sh asks for the Codex working directory of a device: the device's own rebuilt workspace when
// the device is approved and switched to v2 (D13), otherwise the old shared folder, which is left as it is.
function codexWorkspace({ env = process.env, stateRoot = env.AGENTDESK_STATE || DEFAULT_STATE } = {}) {
  const identity = identityFromEnv(env);
  if (identity.state === 'approved' && identity.v2) {
    const folder = path.join(deviceStateDir(stateRoot, identity.deviceId), 'codex-workspace');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return folder;
  }
  if (!identity.legacy && identity.error) throw fail(identity.error);
  return path.join(stateRoot, 'desktop-workspace');
}

module.exports = {
  DEFAULT_REGISTRY, PLATFORMS, CHANNELS, validDeviceId, parsePublicKey, load, save, approve, revoke, rename,
  setDirectChatV2, list, lookup, deviceForBridge, identityFromEnv, suggestedKeyLines, deviceStateDir, codexWorkspace, parseChannels,
};

if (require.main === module) {
  // Used by codex-desktop.sh: prints the working directory for this connection, or exits non-zero.
  if (process.argv[2] === 'codex-workspace') {
    try { process.stdout.write(codexWorkspace() + '\n'); }
    catch (error) { process.stderr.write('agentdesk: ' + error.message + '\n'); process.exitCode = 1; }
  } else {
    process.stderr.write('usage: device-registry.js codex-workspace\n');
    process.exitCode = 2;
  }
}
