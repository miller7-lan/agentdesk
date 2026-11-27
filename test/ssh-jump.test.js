const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { buildJumpArgs, decodePayload, main } = require('../orchestrator/ssh-jump');
const { jumpArguments } = require('../orchestrator/ssh-options');

const PAYLOAD = {
  v: 1,
  ssh: '/usr/bin/ssh',
  jump: {
    host: 'relay.example.invalid', port: 2222, user: 'agentdesk-jump',
    key: '/tmp/jump_ed25519', knownHosts: '/tmp/jump_known_hosts',
  },
  target: { host: 'vps.example.invalid', port: 22 },
};
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('payload round-trips through base64url with strict types', () => {
  assert.deepEqual(decodePayload(encoded(PAYLOAD)), PAYLOAD);
  assert.equal(decodePayload(encoded({
    ...PAYLOAD,
    jump: { ...PAYLOAD.jump, certificate: '/tmp/jump_cert.pub' },
  })).jump.certificate, '/tmp/jump_cert.pub');
});

test('malformed or unsafe payloads are refused without echoing them', () => {
  for (const value of [
    undefined, '', 'not json', encoded({ ...PAYLOAD, v: 2 }), encoded({ ...PAYLOAD, jump: null }),
    encoded({ ...PAYLOAD, target: [] }), encoded({ ...PAYLOAD, ssh: '' }),
    encoded({ ...PAYLOAD, jump: { ...PAYLOAD.jump, host: 'relay\nHost *' } }),
    encoded({ ...PAYLOAD, jump: { ...PAYLOAD.jump, port: 0 } }),
    encoded({ ...PAYLOAD, target: { ...PAYLOAD.target, port: '22' } }),
  ]) {
    assert.throws(() => decodePayload(value), Error, String(value).slice(0, 40));
  }
  try {
    decodePayload(encoded({ ...PAYLOAD, jump: { ...PAYLOAD.jump, user: 'bad\nuser' } }));
    assert.fail('expected rejection');
  } catch (error) {
    assert.doesNotMatch(error.message, /bad/);
  }
});

test('jump arguments are built from the payload, not process state', () => {
  const args = buildJumpArgs(PAYLOAD);
  assert.equal(args[args.indexOf('-p') + 1], '2222');
  assert.equal(args[args.indexOf('-W') + 1], 'vps.example.invalid:22');
  assert.deepEqual(args.slice(-2), ['--', 'agentdesk-jump@relay.example.invalid']);
  assert.deepEqual(args, jumpArguments(PAYLOAD), 'packaged helper must stay in sync with ssh-options');
});

function harness(t, payload = PAYLOAD) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); };
  const spawned = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => { out += chunk; });
  stderr.on('data', (chunk) => { err += chunk; });
  const exits = [];
  const result = main({ AGENTDESK_SSH_JUMP: payload === null ? undefined : encoded(payload) }, {
    spawnProcess: (exe, args, options) => {
      spawned.push({ exe, args, options });
      return child;
    },
    stdin, stdout, stderr, onExit: (code) => exits.push(code),
  });
  return { child, spawned, stdin, stdout, out: () => out, err: () => err, exits, result };
}

test('the helper pipes stdio and prefixes jump-side stderr', async (t) => {
  const h = harness(t);
  assert(h.result);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].exe, '/usr/bin/ssh');
  assert.equal(h.spawned[0].options.stdio[0], 'pipe');

  h.stdin.write('client-data');
  h.child.stdout.write('server-data');
  h.child.stderr.write('line one\npartial');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.child.stdin.read()?.toString() || '', /client-data/);
  assert.match(h.out(), /server-data/);
  assert.match(h.err(), /jump: line one\n/);

  h.child.emit('close', 7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.exits, [7]);
  assert.match(h.err(), /jump: partial\n/);
});

test('a missing payload exits 1 with a jump-prefixed message and spawns nothing', async (t) => {
  const h = harness(t, null);
  assert.equal(h.result, null);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.exits, [1]);
  assert.match(h.err(), /^jump: /);
});

test('spawn failures exit 1 and never throw from the helper', async (t) => {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (chunk) => { err += chunk; });
  const exits = [];
  const result = main({ AGENTDESK_SSH_JUMP: encoded(PAYLOAD) }, {
    spawnProcess: () => { throw new Error('ENOENT'); },
    stdin, stdout: new PassThrough(), stderr, onExit: (code) => exits.push(code),
  });
  assert.equal(result, null);
  assert.deepEqual(exits, [1]);
  assert.match(err, /无法启动跳板 SSH/);
});
test('the helper ends its inner ssh when the outer ssh is gone (no leftover helpers on Windows)', async (t) => {
  const h = harness(t);
  h.child.kill = (signal) => { h.child.killed.push(signal ?? 'default'); setImmediate(() => h.child.emit('close', 255)); };
  h.stdin.end();                                   // the outer ssh closed its end; the inner one is still connecting
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal(h.child.killed.length, 1);
  assert.deepEqual(h.exits, [255]);
});

test('a normal end does not kill the inner ssh', async (t) => {
  const h = harness(t);
  h.stdin.end();
  h.child.emit('close', 0);
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal(h.child.killed.length, 0);
  assert.deepEqual(h.exits, [0]);
});
