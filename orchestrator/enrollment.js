const { createServer } = require('node:https');
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execute = promisify(execFile);
const derive = promisify(scrypt);
const duration = 8 * 60 * 60;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function publicKey(input) {
  if (typeof input !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(input)) {
    throw new Error('invalid_public_key');
  }
  const key = Buffer.from(input.split(' ')[1], 'base64');
  if (key.length !== 51 || key.subarray(0, 19).toString('hex') !== '0000000b7373682d6564323535313900000020') {
    throw new Error('invalid_public_key');
  }
  return input;
}

async function readBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) throw new Error('invalid_request');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function setupEnrollment(settings, registerPair = registerRelay) {
  const directory = settings.stateDir;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const verifier = JSON.parse(await fs.readFile(settings.passwordFile));
  const salt = Buffer.from(verifier.salt, 'hex');
  const hash = Buffer.from(verifier.hash, 'hex');
  if (salt.length !== 32 || hash.length !== 64) throw new Error('invalid_password_verifier');
  const pending = new Map();
  const attempts = new Map();
  let verifying = 0;
  let issued = 0;
  let bucket = 0;
  let globalAttempts = 0;

  async function activeSessions() {
    const now = Date.now() / 1000;
    const active = [];
    for (const name of await fs.readdir(settings.sessionDir)) {
      if (!/^d[0-9a-f]{14}\.json$/.test(name)) continue;
      const file = path.join(settings.sessionDir, name);
      const session = JSON.parse(await fs.readFile(file));
      if (session.expires > now) active.push(session.id);
    }
    return active;
  }

  async function certificate(folder, filename, key, expires, command) {
    const file = path.join(folder, filename);
    await fs.writeFile(file, key + '\n', { mode: 0o600 });
    const limit = new Date(expires * 1000).toISOString().slice(0, 19).replace(/[-T:]/g, '') + 'Z';
    await execute('ssh-keygen', ['-q', '-s', settings.signingKey, '-I', 'agentdesk-app',
      '-n', 'agentdesk-app', '-V', '-1m:' + limit, '-O', 'clear', '-O', 'force-command=' + command, file],
    { timeout: 5000, maxBuffer: 2048 });
    return fs.readFile(file.slice(0, -4) + '-cert.pub', 'utf8');
  }

  async function enroll(bridgeKey, chatKey, installation) {
    if (typeof installation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(installation)) throw new Error('invalid_installation');
    const id = 'd' + digest(installation + ' ' + bridgeKey + ' ' + chatKey).slice(0, 14);
    if (pending.has(id)) throw new Error('enrollment_busy');
    pending.set(id, true);
    let folder;
    try {
      const active = await activeSessions();
      if (active.length + pending.size > settings.maxDevices && !active.includes(id)) {
        throw new Error('device_capacity');
      }
      folder = await fs.mkdtemp(path.join(directory, 'cert-'));
      const expires = Math.floor(Date.now() / 1000) + duration;
      const bridgeToken = randomBytes(32).toString('base64url');
      const orchestratorToken = randomBytes(32).toString('base64url');
      const socket = path.join(settings.orchestratorStateDir, 'bridge-' + id + '.sock');
      const gateway = '/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/ssh-gateway.js ' + socket;
      const chat = '/opt/agentdesk-orchestrator/expiring-chat.sh ' + expires;
      const [bridgeCert, chatCert] = await Promise.all([
        certificate(folder, 'bridge.pub', bridgeKey, expires, gateway),
        certificate(folder, 'chat.pub', chatKey, expires, chat),
      ]);
      const input = JSON.stringify({ id, expires, bridge: digest(bridgeToken), orchestrator: digest(orchestratorToken) });
      await registerPair(settings, input);
      const session = { id, expires, token: orchestratorToken };
      const record = path.join(settings.sessionDir, id + '.json');
      const staged = record + '.staged';
      await fs.writeFile(staged, JSON.stringify(session), { mode: 0o640 });
      await fs.rename(staged, record);
      return {
        id, expires, bridgeCert, chatCert, bridgeToken,
        bundle: await fs.readFile(settings.seedBundle, 'base64'),
      };
    } finally {
      pending.delete(id);
      if (folder) await fs.rm(folder, { recursive: true, force: true });
    }
  }

  const server = createServer({
    cert: await fs.readFile(settings.cert), key: await fs.readFile(settings.key),
    minVersion: 'TLSv1.2', requestTimeout: 10000, headersTimeout: 5000, connectionsCheckingInterval: 2000,
  });
  server.maxConnections = 32;
  server.on('request', async (req, res) => {
    const reply = (code, payload) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST' || req.url !== '/v1/enroll') return reply(404, { error: 'not_found' });
    const epoch = Math.floor(Date.now() / 300000);
    if (bucket !== epoch) {
      attempts.clear();
      globalAttempts = issued = 0;
      bucket = epoch;
    }
    const address = req.socket.remoteAddress;
    const count = attempts.get(address) || 0;
    if (count >= 6 || globalAttempts >= 48 || verifying >= 2 || issued >= 20) return reply(429, { error: 'try_later' });
    attempts.set(address, count + 1);
    globalAttempts += 1;
    try {
      const { password, bridgeKey, chatKey, installation } = await readBody(req);
      if (typeof password !== 'string' || !password || password.length > 256) return reply(401, { error: 'invalid_password' });
      if (verifying >= 2) return reply(429, { error: 'try_later' });
      verifying += 1;
      let valid;
      try { valid = timingSafeEqual(hash, await derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 })); }
      finally { verifying -= 1; }
      if (!valid) return reply(401, { error: 'invalid_password' });
      if (issued >= 20) return reply(429, { error: 'try_later' });
      issued += 1;
      const result = await enroll(publicKey(bridgeKey), publicKey(chatKey), installation);
      return reply(200, result);
    } catch (error) {
      console.error('enrollment failure:', error.code || 'request_failed');
      if (!res.destroyed) reply(503, { error: 'enrollment_failed' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port ?? 443, settings.bind || '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { server, close: () => server.close() };
}

function registerRelay(settings, input) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const child = spawn('/usr/bin/ssh', ['-F', 'none', '-T', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=5',
      '-o', 'UserKnownHostsFile=' + settings.registrarKnownHosts, '-i', settings.registrarKey,
      'agentdesk-relay-enroll@' + settings.relayHost], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 8000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('relay_registration_failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input + '\n');
  });
}

if (require.main === module) {
  fs.readFile(process.argv[2]).then(JSON.parse).then(setupEnrollment).then(({ close }) => {
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  }).catch((error) => {
    console.error('enrollment startup:', error.code || error.message);
    process.exitCode = 1;
  });
}
module.exports = { setupEnrollment, publicKey };
