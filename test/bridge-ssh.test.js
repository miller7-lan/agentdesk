const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { createBridgeSsh } = require('../orchestrator/bridge-ssh');
const { SshRoute } = require('../orchestrator/ssh-route');
const { normalizeJump } = require('../orchestrator/ssh-options');

const JUMP = normalizeJump({
  mode: 'auto', host: 'relay.example.invalid', port: 22, user: 'agentdesk-jump',
  key: '/tmp/jump_ed25519', knownHosts: '/tmp/jump_known_hosts',
});
const SSH_CONFIG = {
  host: 'vps.example.invalid', port: 22, user: 'agentdesk',
  key: '/tmp/bridge_ed25519', knownHosts: '/tmp/known_hosts', jump: JUMP,
};

function child() {
  const value = new EventEmitter();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.stdin = new PassThrough();
  value.kill = () => {};
  return value;
}

function setup(t, { route = null, spawn } = {}) {
  const spawned = [];
  const spawnSsh = createBridgeSsh({
    ssh: '/usr/bin/ssh',
    route,
    spawnProcess: spawn || ((exe, args, options) => {
      const value = child();
      value.exe = exe;
      value.args = args;
      value.options = options;
      spawned.push(value);
      return value;
    }),
  });
  return { spawnSsh, spawned };
}

test('direct bridge SSH keeps its connect timeout and has no ProxyCommand', (t) => {
  const { spawnSsh, spawned } = setup(t);
  spawnSsh(SSH_CONFIG);
  const args = spawned[0].args;
  assert.equal(spawned[0].exe, '/usr/bin/ssh');
  assert(args.includes('ConnectTimeout=10'));
  assert(!args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.deepEqual(args.slice(-2), ['--', 'agentdesk@vps.example.invalid']);
  assert.equal(spawned[0].options.env.AGENTDESK_SSH_JUMP, undefined);
});

test('the first Bridge byte marks the route healthy', (t) => {
  const calls = [];
  const route = {
    routeForAttempt: () => ({ route: 'jump', generation: 4 }),
    noteSuccess: (line) => calls.push(['success', line]),
    noteFailure: (...args) => calls.push(['failure', ...args]),
  };
  const { spawnSsh, spawned } = setup(t, { route });
  spawnSsh(SSH_CONFIG);
  assert(spawned[0].args.some((arg) => arg.startsWith('ProxyCommand=')));
  spawned[0].stdout.write('{"ok":true}\n');
  assert.deepEqual(calls, [['success', 'jump']]);
});

test('a transport close switches the shared route, so the next spawn uses the jump', (t) => {
  const route = new SshRoute({ jump: JUMP, mode: 'auto' });
  t.after(() => route.stop());
  const { spawnSsh, spawned } = setup(t, { route });
  spawnSsh(SSH_CONFIG);
  assert(!spawned[0].args.some((arg) => arg.startsWith('ProxyCommand=')));
  spawned[0].stderr.write('ssh: connect to host vps.example.invalid port 22: Connection timed out\n');
  spawned[0].emit('close', 255);
  assert.equal(route.snapshot().route, 'jump');

  spawnSsh(SSH_CONFIG);
  assert(spawned[1].args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert(spawned[1].options.env.AGENTDESK_SSH_JUMP);
});

test('a host-key failure does not switch the route', (t) => {
  const route = new SshRoute({ jump: JUMP, mode: 'auto' });
  t.after(() => route.stop());
  const { spawnSsh, spawned } = setup(t, { route });
  spawnSsh(SSH_CONFIG);
  spawned[0].stderr.write('Host key verification failed.\n');
  spawned[0].emit('close', 255);
  assert.equal(route.snapshot().route, 'direct');
  assert.equal(route.snapshot().lastFailure.kind, 'hostkey');
});

test('a failed spawn is reported as a config failure and rethrown', (t) => {
  const calls = [];
  const route = {
    routeForAttempt: () => ({ route: 'direct', generation: 0 }),
    noteSuccess: () => {},
    noteFailure: (...args) => calls.push(args),
  };
  const { spawnSsh } = setup(t, { route, spawn: () => { throw new Error('ENOENT'); } });
  assert.throws(() => spawnSsh(SSH_CONFIG), /ENOENT/);
  assert.deepEqual(calls, [['direct', { kind: 'config' }]]);
});