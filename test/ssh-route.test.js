const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { SshRoute, probeTcpBanner, resetRoutes, routeFor } = require('../orchestrator/ssh-route');
const { normalizeJump } = require('../orchestrator/ssh-options');

const JUMP = normalizeJump({
  mode: 'auto', host: 'relay.example.invalid', port: 22, user: 'agentdesk-jump',
  key: '/tmp/jump_ed25519', knownHosts: '/tmp/jump_known_hosts', probeMinutes: 10,
});
const TARGET = { host: 'vps.example.invalid', port: 22 };

function setup(t, options = {}) {
  let now = 1_000_000;
  const timers = [];
  const logs = [];
  const probes = [];
  const route = new SshRoute({
    jump: options.jump === undefined ? JUMP : options.jump,
    mode: options.mode,
    now: () => now,
    log: (event, detail) => logs.push({ event, ...detail }),
    probe: options.probe || (() => new Promise((resolve) => probes.push(resolve))),
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
  });
  t.after(() => route.stop());
  return {
    route, logs, probes,
    timers,
    advance(ms) { now += ms; },
    now: () => now,
  };
}

test('auto starts direct, forced jump starts on the jump and no jump stays direct', (t) => {
  const auto = setup(t);
  assert.deepEqual(auto.route.routeForAttempt(), { route: 'direct', generation: 0 });
  assert.equal(auto.route.snapshot().jumpAvailable, true);

  const forced = setup(t, { mode: 'jump' });
  assert.equal(forced.route.routeForAttempt().route, 'jump');

  const offline = setup(t, { jump: null });
  assert.equal(offline.route.routeForAttempt().route, 'direct');
  assert.equal(offline.route.snapshot().jumpAvailable, false);
});

test('a direct transport or DNS failure switches to the jump; other failures do not', (t) => {
  for (const kind of ['transport', 'dns']) {
    const { route } = setup(t);
    const generation = route.generation;
    route.noteFailure('direct', { kind });
    assert.equal(route.snapshot().route, 'jump', kind);
    assert.equal(route.generation, generation + 1);
    assert.equal(route.snapshot().nextProbeAt, route.now() + 10 * 60_000);
  }
  for (const kind of ['hostkey', 'auth', 'config', 'forward', 'unknown']) {
    const { route } = setup(t);
    route.noteFailure('direct', { kind });
    assert.equal(route.snapshot().route, 'direct', kind);
  }
});

test('mode=direct and a missing jump never switch', (t) => {
  const direct = setup(t, { mode: 'direct' });
  direct.route.noteFailure('direct', { kind: 'transport' });
  assert.equal(direct.route.snapshot().route, 'direct');

  const offline = setup(t, { jump: null });
  offline.route.noteFailure('direct', { kind: 'transport' });
  assert.equal(offline.route.snapshot().route, 'direct');
});

test('a jump success schedules a probe; only one probe runs at a time', async (t) => {
  const harness = setup(t);
  const { route } = harness;
  route.noteFailure('direct', { kind: 'transport' });
  route.noteSuccess('jump');
  assert.equal(route.snapshot().route, 'jump');
  assert.equal(harness.timers.at(-1).delay, 10 * 60_000);

  harness.advance(10 * 60_000);
  assert.equal(route.requestProbe(), true);
  assert.equal(route.requestProbe(), false);
  assert.equal(route.snapshot().probing, true);
  await new Promise(setImmediate);
  harness.probes[0](true);
  await new Promise(setImmediate);
  assert.equal(route.snapshot().route, 'direct');
  assert.equal(route.snapshot().probing, false);
});

test('a failed probe keeps the jump and waits another interval', async (t) => {
  const harness = setup(t);
  const { route } = harness;
  route.noteFailure('direct', { kind: 'transport' });
  harness.advance(10 * 60_000);
  route.requestProbe();
  await new Promise(setImmediate);
  harness.probes[0](false);
  await new Promise(setImmediate);
  const snapshot = route.snapshot();
  assert.equal(snapshot.route, 'jump');
  assert.equal(snapshot.probing, false);
  assert.equal(snapshot.nextProbeAt, harness.now() + 10 * 60_000);
});

test('jump-side auth and host-key failures suspend automatic retries until a manual reconnect', (t) => {
  const { route } = setup(t);
  route.noteFailure('direct', { kind: 'transport' });
  route.noteFailure('jump', { kind: 'auth', jumpSide: true });
  assert.equal(route.snapshot().suspended, true);
  assert.equal(route.snapshot().route, 'jump');
  assert.equal(route.retryDelay(), 10 * 60_000);

  route.manualReconnect();
  assert.equal(route.snapshot().suspended, false);
  assert.equal(route.retryDelay(), null);
  assert.equal(route.snapshot().nextProbeAt, route.now());

  route.noteFailure('jump', { kind: 'hostkey' });
  assert.equal(route.snapshot().suspended, true);
});

test('a successful jump clears a suspension', (t) => {
  const { route } = setup(t, { mode: 'jump' });
  route.noteFailure('jump', { kind: 'auth' });
  assert.equal(route.snapshot().suspended, true);
  route.noteSuccess('jump');
  assert.equal(route.snapshot().suspended, false);
});

test('routeFor shares one route per jump signature and target', (t) => {
  t.after(resetRoutes);
  resetRoutes();
  const first = routeFor(JUMP, TARGET);
  const second = routeFor({ ...JUMP }, { ...TARGET });
  assert.equal(first, second);
  assert.notEqual(routeFor(JUMP, { host: 'other.example.invalid', port: 22 }), first);
  assert.notEqual(routeFor(JUMP, { host: TARGET.host, port: 2222 }), first);
  resetRoutes();
  assert.notEqual(routeFor(JUMP, TARGET), first);
});

test('routeFor degrades an invalid jump to direct and exposes the reason', (t) => {
  t.after(resetRoutes);
  resetRoutes();
  const invalid = normalizeJump({ mode: 'auto', host: 'relay.example.invalid' });
  const route = routeFor(invalid, TARGET);
  assert.equal(route.routeForAttempt().route, 'direct');
  assert.match(route.snapshot().unavailableReason, /缺失/);
});

test('probeTcpBanner accepts only an SSH banner', async (t) => {
  const sockets = [];
  const netModule = {
    connect() {
      const socket = new EventEmitter();
      socket.destroy = () => { socket.destroyed = true; };
      socket.setTimeout = () => {};
      sockets.push(socket);
      return socket;
    },
  };
  const good = probeTcpBanner('vps.example.invalid', 22, { netModule, timeoutMs: 100 });
  sockets[0].emit('data', Buffer.from('SSH-2.0-OpenSSH_9.6\r\n'));
  assert.equal(await good, true);
  assert.equal(sockets[0].destroyed, true);

  const bad = probeTcpBanner('vps.example.invalid', 22, { netModule, timeoutMs: 100 });
  sockets[1].emit('data', Buffer.from('HTTP/1.1 400 Bad Request\r\n'));
  assert.equal(await bad, false);
});