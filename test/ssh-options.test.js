const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildSshBase, buildSshInvocation, classifySshFailure, formatTarget, isJumpConfigured,
  jumpArguments, jumpEnvironment, jumpPayload, mergeJump, normalizeJump, proxyCommandFor,
} = require('../orchestrator/ssh-options');

const CFG = { knownHosts: '/tmp/known_hosts' };
const JUMP = {
  mode: 'auto', host: 'relay.example.invalid', port: 2222, user: 'agentdesk-jump',
  key: '/tmp/jump_ed25519', knownHosts: '/tmp/jump_known_hosts', probeMinutes: 10,
};
const RUNTIME = { nodePath: '/usr/bin/node', electron: false };
const HELPER = '/opt/agentdesk/ssh-jump.js';

test('direct SSH arguments stay exactly as the old sshBase', () => {
  assert.deepEqual(buildSshInvocation({
    cfg: CFG, key: '/tmp/codex_ed25519', port: 22, target: 'codexdev@vps.example.invalid',
    targetHost: 'vps.example.invalid', route: 'direct', runtime: RUNTIME, helperPath: HELPER,
  }).args, [
    '-F', 'none', '-T',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile="/tmp/known_hosts"', '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-i', '/tmp/codex_ed25519', '-p', '22', 'codexdev@vps.example.invalid',
  ]);
  assert.deepEqual(buildSshInvocation({
    cfg: CFG, key: '/tmp/codex_ed25519', port: 22, target: 'codexdev@vps.example.invalid',
    targetHost: 'vps.example.invalid', route: 'direct', extraArgs: ['--'],
  }).args.slice(-2), ['--', 'codexdev@vps.example.invalid']);
});

test('direct SSH honours a certificate without leaking it into a jump', () => {
  const direct = buildSshBase(CFG, '/tmp/key', '/tmp/cert.pub', { connectTimeout: 10 });
  assert.equal(direct.at(-2), '-o');
  assert.equal(direct.at(-1), 'CertificateFile="/tmp/cert.pub"');
  const payload = jumpPayload(JUMP, { host: 'vps.example.invalid', port: 22 });
  assert.equal(payload.jump.certificate, undefined);
});

test('jump invocation adds one ProxyCommand and a private environment', () => {
  const invocation = buildSshInvocation({
    cfg: CFG, key: '/tmp/codex_ed25519', port: 2222, target: 'codexdev@vps.example.invalid',
    targetHost: 'vps.example.invalid', route: 'jump', jump: JUMP,
    extraArgs: ['--'], afterTarget: ['/opt/agentdesk-orchestrator/agent-chat.sh claude'],
    runtime: RUNTIME, helperPath: HELPER,
  });
  assert.equal(invocation.args.filter((arg) => arg.startsWith('ProxyCommand=')).length, 1);
  assert(invocation.args.includes(`ProxyCommand='/usr/bin/node' '${HELPER}'`));
  assert.equal(invocation.args[invocation.args.indexOf('-p') + 1], '2222');
  assert.deepEqual(invocation.args.slice(-3), [
    '--', 'codexdev@vps.example.invalid', '/opt/agentdesk-orchestrator/agent-chat.sh claude',
  ]);
  assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, undefined);
  const payload = JSON.parse(Buffer.from(invocation.env.AGENTDESK_SSH_JUMP, 'base64url').toString('utf8'));
  assert.deepEqual(payload.target, { host: 'vps.example.invalid', port: 2222 });
  assert.deepEqual(Object.keys(payload.jump).sort(),
    ['host', 'key', 'knownHosts', 'port', 'user']);
});

test('Electron helper runs as Node and its path is shell quoted', () => {
  const env = jumpEnvironment(jumpPayload(JUMP, { host: 'vps.example.invalid', port: 22 }), {
    nodePath: "/Applications/Agent Desk/AgentDesk", electron: true,
  });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(proxyCommandFor({
    nodePath: "/Applications/Agent Desk/AgentDesk",
    helperPath: "/Applications/Agent Desk/Contents/Resources/ssh-jump.js",
    platform: 'darwin',
  }), "'/Applications/Agent Desk/AgentDesk' '/Applications/Agent Desk/Contents/Resources/ssh-jump.js'");
  assert.equal(proxyCommandFor({ nodePath: '/usr/bin/node', helperPath: '/tmp/100%.js', platform: 'linux' }),
    "'/usr/bin/node' '/tmp/100%%.js'");
});

test('Windows ProxyCommand quotes paths and rejects ssh token characters', () => {
  assert.equal(proxyCommandFor({
    nodePath: 'C:\\Program Files\\AgentDesk\\AgentDesk.exe',
    helperPath: 'C:\\Program Files\\AgentDesk\\resources\\ssh-jump.js',
    platform: 'win32',
  }), '"C:\\Program Files\\AgentDesk\\AgentDesk.exe" "C:\\Program Files\\AgentDesk\\resources\\ssh-jump.js"');
  assert.throws(() => proxyCommandFor({ nodePath: 'C:\\100%\\node.exe', helperPath: 'C:\\ssh-jump.js', platform: 'win32' }), /不支持/);
  assert.throws(() => proxyCommandFor({ nodePath: 'C:\\"x"\\node.exe', helperPath: 'C:\\ssh-jump.js', platform: 'win32' }), /不支持/);
  assert.throws(() => proxyCommandFor({ nodePath: '/usr/bin/node', helperPath: '' }), /运行文件/);
});

test('jump hop uses its own key and known_hosts, never the target certificate', () => {
  const args = jumpArguments({
    v: 1,
    ssh: '/usr/bin/ssh',
    jump: { ...JUMP, certificate: '/tmp/jump_cert.pub' },
    target: { host: 'vps.example.invalid', port: 22 },
  });
  assert(args.includes('IdentityAgent=none'));
  assert(args.includes('UserKnownHostsFile="/tmp/jump_known_hosts"'));
  assert(args.includes('CertificateFile="/tmp/jump_cert.pub"'));
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/jump_ed25519');
  assert.equal(args[args.indexOf('-W') + 1], 'vps.example.invalid:22');
  assert.deepEqual(args.slice(-2), ['--', 'agentdesk-jump@relay.example.invalid']);
  assert(args.includes('BatchMode=yes'));
});

test('IPv6 targets are bracketed', () => {
  assert.equal(formatTarget('vps.example.invalid', 22), 'vps.example.invalid:22');
  assert.equal(formatTarget('2001:db8::1', 22), '[2001:db8::1]:22');
  assert.equal(formatTarget('[2001:db8::1]', 2222), '[2001:db8::1]:2222');
});

test('normalizeJump validates mode, ports and files', () => {
  assert.equal(normalizeJump(undefined), null);
  assert.equal(normalizeJump({ mode: 'direct' }).mode, 'direct');
  const ok = normalizeJump({ ...JUMP, key: '~/jump', knownHosts: '~/.agentdesk/jump_known_hosts' }, { home: '/home/me' });
  assert.equal(ok.key, '/home/me/jump');
  assert.equal(ok.knownHosts, '/home/me/.agentdesk/jump_known_hosts');
  assert.equal(isJumpConfigured(ok), true);

  for (const raw of [
    { ...JUMP, mode: 'sometimes' },
    { ...JUMP, host: 'bad host' },
    { ...JUMP, user: '-oProxyCommand=x' },
    { ...JUMP, port: 0 },
    { ...JUMP, port: 70000 },
    { ...JUMP, probeMinutes: 0 },
    { ...JUMP, key: '' },
    { ...JUMP, knownHosts: '' },
  ]) {
    const jump = normalizeJump(raw);
    assert.equal(jump.unavailable, true, JSON.stringify(raw));
    assert.equal(isJumpConfigured(jump), false);
  }
  const missing = normalizeJump({ ...JUMP, key: '/definitely/missing/key' }, { checkFiles: true });
  assert.equal(missing.unavailable, true);
  assert.match(missing.unavailableReason, /密钥/);
});

test('mergeJump keeps public endpoint from the installer and secrets locally', () => {
  const merged = mergeJump(
    { mode: 'direct', host: 'old.example.invalid', key: '/tmp/local_key', knownHosts: '/tmp/local_kh', probeMinutes: 3 },
    { host: 'relay.example.invalid', port: 2222, user: 'agentdesk-jump', mode: 'auto' },
  );
  assert.equal(merged.host, 'relay.example.invalid');
  assert.equal(merged.port, 2222);
  assert.equal(merged.user, 'agentdesk-jump');
  assert.equal(merged.mode, 'direct');
  assert.equal(merged.key, '/tmp/local_key');
  assert.equal(merged.knownHosts, '/tmp/local_kh');
  assert.equal(merged.probeMinutes, 3);
  assert.equal(mergeJump(null, null), null);
  assert.equal(mergeJump(undefined, { host: 'relay.example.invalid' }).mode, 'auto');
});

test('failure classification separates transport from auth, host keys and config', () => {
  const kind = (stderr, code) => classifySshFailure({ stderr, code }).kind;
  assert.equal(kind('ssh: connect to host vps port 22: Connection timed out'), 'transport');
  assert.equal(kind('ssh: Could not resolve hostname vps: Name or service not known'), 'dns');
  assert.equal(kind('Host key verification failed.'), 'hostkey');
  assert.equal(kind('Warning: Permanently added the ED25519 host key'), 'unknown');
  assert.equal(kind('Permission denied (publickey).'), 'auth');
  assert.equal(kind('no such identity: /tmp/key'), 'config');
  assert.equal(kind('Bad configuration option: ProxyCommand'), 'config');
  assert.equal(kind('remote port forwarding failed for listen port 2222'), 'forward');
  assert.equal(kind('', 255), 'unknown');
  assert.equal(kind('some application error', 255), 'unknown');
});

test('jump-side errors keep their kind and are marked', () => {
  const info = classifySshFailure({
    stderr: 'jump: ssh: connect to host relay port 22: Connection refused',
  });
  assert.equal(info.kind, 'transport');
  assert.equal(info.jumpSide, true);
  assert.equal(classifySshFailure({ stderr: 'Permission denied (publickey).' }).jumpSide, false);
});

test('normalizeJump rejects control characters and a malformed certificate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-jump-'));
  const key = path.join(dir, 'jump_ed25519');
  const knownHosts = path.join(dir, 'jump_known_hosts');
  fs.writeFileSync(key, 'key');
  fs.writeFileSync(knownHosts, 'host key');
  try {
    const good = normalizeJump({ ...JUMP, key, knownHosts }, { checkFiles: true });
    assert.equal(isJumpConfigured(good), true);
    assert.equal(normalizeJump({ ...JUMP, key, knownHosts, host: 'relay\nHost *' }).unavailable, true);
    assert.equal(normalizeJump({ ...JUMP, key, knownHosts, certificate: '' }).unavailable, true);
    assert.equal(normalizeJump({ ...JUMP, key, knownHosts, certificate: 42 }).unavailable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});