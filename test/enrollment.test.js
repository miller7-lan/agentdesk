const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes, scryptSync } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setupEnrollment } = require('../orchestrator/enrollment');
const { signIn } = require('../orchestrator/enrollment-client');

test('TLS enrollment rejects wrong passwords and issues scoped, expiring per-device credentials', {
  skip: process.platform === 'win32',
}, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-enroll-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const filename = (value) => path.join(folder, value);
  const createKey = async (name) => {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', filename(name)]);
    return (await fs.readFile(filename(name + '.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  };
  await createKey('ssh-ca');
  const bridgeKey = await createKey('bridge');
  const chatKey = await createKey('chat');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', filename('tls.key'), '-out', filename('tls.crt'),
  ], { stdio: 'ignore' });
  const password = 'fixture-password';
  const salt = randomBytes(32);
  const hash = scryptSync(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
  await fs.writeFile(filename('verifier.json'), JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex') }));
  await fs.mkdir(filename('sessions'));
  await fs.writeFile(filename('seed.bundle'), 'fixture seed');
  const registrations = [];
  const { server, close } = await setupEnrollment({
    stateDir: filename('state'), sessionDir: filename('sessions'), maxDevices: 2,
    bind: '127.0.0.1', port: 0, cert: filename('tls.crt'), key: filename('tls.key'),
    passwordFile: filename('verifier.json'), signingKey: filename('ssh-ca'),
    seedBundle: filename('seed.bundle'), orchestratorStateDir: '/var/lib/agentdesk-orchestrator',
  }, async (_settings, input) => registrations.push(JSON.parse(input)));
  t.after(async () => { const closed = once(server, 'close'); close(); await closed; });
  const bootstrap = { url: 'https://127.0.0.1:' + server.address().port, ca: await fs.readFile(filename('tls.crt')) };
  const identity = { installation: randomBytes(32).toString('base64url'), bridgeKey, chatKey };
  await assert.rejects(signIn(bootstrap, { ...identity, password: 'incorrect' }), /invalid_password/);
  assert.equal(registrations.length, 0);
  const session = await signIn(bootstrap, { ...identity, password });
  assert.match(session.id, /^d[0-9a-f]{14}$/);
  assert.match(session.bridgeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(registrations[0].id, session.id);
  assert.notEqual(registrations[0].bridge, session.bridgeToken);
  assert.equal(Buffer.from(session.bundle, 'base64').toString(), 'fixture seed');
  const record = JSON.parse(await fs.readFile(filename('sessions/' + session.id + '.json')));
  assert.equal(record.expires, session.expires);
  assert.ok(session.expires <= Math.floor(Date.now() / 1000) + 28800);
  await fs.writeFile(filename('bridge-cert.pub'), session.bridgeCert);
  await fs.writeFile(filename('chat-cert.pub'), session.chatCert);
  const sshCert = (name) => execFileSync('ssh-keygen', ['-L', '-f', filename(name)], { encoding: 'utf8' });
  assert.match(sshCert('bridge-cert.pub'), new RegExp('bridge-' + session.id + '\\.sock'));
  assert.match(sshCert('chat-cert.pub'), /expiring-chat\.sh/);
  const renewed = await signIn(bootstrap, { ...identity, password });
  assert.equal(renewed.id, session.id);
  assert.notEqual(renewed.bridgeToken, session.bridgeToken);
});
