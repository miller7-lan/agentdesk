const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { readFile } = require('node:fs/promises');

const steps = ['welcome', 'fingerprint', 'login', 'workspace', 'checks', 'appearance', 'complete'];

function matchHost(entry, host) {
  if (!entry.startsWith('|1|')) return entry === host;
  const [, , salt, digest] = entry.split('|');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'base64');
  const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hostRecords(contents, host, port = 22) {
  if (!host) return new Map();
  const lookup = Number(port) === 22 ? host : `[${host}]:${port}`;
  const out = new Map();
  for (const line of String(contents || '').split(/\r?\n/)) {
    const [names, algorithm, data] = line.trim().split(/\s+/);
    if (!names || names.startsWith('#') || algorithm !== 'ssh-ed25519' || !data ||
        !names.split(',').some((entry) => matchHost(entry, lookup))) continue;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11 ||
        bytes.subarray(4, 15).toString('ascii') !== algorithm || bytes.readUInt32BE(15) !== 32) continue;
    const fingerprint = 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
    out.set(fingerprint, `${lookup} ${algorithm} ${data}\n`);
  }
  return out;
}

function hostFingerprints(contents, host, port) {
  return [...hostRecords(contents, host, port).keys()];
}

async function configuredHost(enrollment, config) {
  const host = enrollment?.host || config.host || '';
  if (!host) return { host, fingerprints: [], records: new Map() };
  let contents = enrollment?.knownHosts;
  if (!contents && config.knownHosts) {
    try { contents = await readFile(config.knownHosts, 'utf8'); } catch {}
  }
  const records = hostRecords(contents, host, enrollment ? 22 : config.port);
  return { host, fingerprints: [...records.keys()], records };
}

function verified(trust, confirmation) {
  return Boolean(confirmation && confirmation.host === trust.host && trust.fingerprints.includes(confirmation.fingerprint));
}

module.exports = { steps, configuredHost, hostFingerprints, hostRecords, verified };
