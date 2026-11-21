// The client side of the direct chat v2 device contract (D6, docs/DIRECT-CHAT-V2-API.md).
// deviceId is a random UUID made on first use and kept in ~/.agentdesk/device-id. It is not a secret and grants
// nothing by itself: VPS2 trusts the identity its forced command injects for this computer's SSH key, which an
// administrator approved with `ad device approve`; the hello only lets the server check that they agree.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const PROTOCOL_VERSION = 2;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function directory(home = os.homedir()) { return path.join(home, '.agentdesk'); }

function deviceId({ home } = {}) {
  const file = path.join(directory(home), 'device-id');
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (ID.test(value)) return value;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(directory(home), { recursive: true, mode: 0o700 });
  const value = randomUUID();
  try { fs.writeFileSync(file, value + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return fs.readFileSync(file, 'utf8').trim();
  }
  return value;
}

// Only macOS and Windows are client platforms; anything else sends no hello and stays on v1.
function hello({ home, platform = process.platform, appVersion, capabilities = [] } = {}) {
  if (!['darwin', 'win32'].includes(platform)) return null;
  return { deviceId: deviceId({ home }), platform, protocolVersion: PROTOCOL_VERSION,
    osVersion: typeof os.version === 'function' ? os.version().slice(0, 120) : os.release(), appVersion, capabilities };
}

// What the person shows the administrator for `ad device approve`: id, platform and the public half of each key.
function registrationInfo(keyFiles, options = {}) {
  const keys = [];
  for (const [channel, file] of Object.entries(keyFiles)) {
    if (!file) continue;
    try {
      const publicKey = fs.readFileSync(file + '.pub', 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
      const blob = Buffer.from(publicKey.split(' ')[1] || '', 'base64');
      keys.push({ channel, publicKey, fingerprint: 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '') });
    } catch {}
  }
  const value = hello(options);
  return { deviceId: deviceId(options), platform: options.platform || process.platform, keys, supported: Boolean(value) };
}

module.exports = { deviceId, hello, registrationInfo, PROTOCOL_VERSION };
