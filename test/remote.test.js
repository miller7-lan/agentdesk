const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Remote } = require('../remote');
const { resetRoutes } = require('../orchestrator/ssh-route');

async function until(predicate, label = 'condition') {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + label);
    await delay(3);
  }
}

function setup(t, options = {}) {
  const spawned = [];
  const services = [];
  const remote = new Remote({
    config: {
      host: 'vps.example.invalid', codexUser: 'codexdev', tunnelUser: 'windows-tunnel',
      codexKey: '/tmp/codex_ed25519', tunnelKey: '/tmp/tunnel_ed25519', knownHosts: '/tmp/known_hosts',
      remoteForward: '', idleMinutes: 10, manageSshd: false, ...options.config,
    },
    timing: {
      handshake: 200, request: 200, heartbeat: 10000, heartbeatReply: 200,
      tunnel: 200, retry: [10], ...options.timing,
    },
    service: async (...args) => {
      services.push(args);
      return { out: 'SERVICE_NAME: sshd STATE: 4 RUNNING' };
    },
    spawnProcess: (exe, args, spawnOptions) => {
      const child = new EventEmitter();
      child.exe = exe;
      child.spawnOptions = spawnOptions;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.sent = [];
      child.stdin = new Writable({
        write(data, _encoding, callback) {
          child.sent.push(JSON.parse(data.toString()));
          callback();
        },
      });
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => {
          child.emit('exit', null);
          child.emit('close', null);
        });
        return true;
      };
      child.respond = (id, result) => child.stdout.write(JSON.stringify({ id, result }) + '\n');
      child.args = args;
      spawned.push(child);
      return child;
    },
  });
  t.after(() => { remote.stop(); resetRoutes(); });
  return { remote, spawned, services };
}

function jumpFixture(t, mode = 'auto') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-remote-jump-'));
  const key = path.join(dir, 'jump_ed25519');
  const knownHosts = path.join(dir, 'jump_known_hosts');
  fs.writeFileSync(key, 'key');
  fs.writeFileSync(knownHosts, 'host key');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    mode, host: 'relay.example.invalid', port: 22, user: 'agentdesk-jump',
    key, knownHosts, probeMinutes: 10,
  };
}

test('automatic SSH routing probes the direct host when reconnecting from a jump', async (t) => {
  const server = net.createServer((socket) => socket.end('SSH-2.0-AgentDesk-Test\r\n'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { remote } = setup(t, { config: {
    host: '127.0.0.1', port: server.address().port, jump: jumpFixture(t),
  } });
  for (const reset of [false, true]) {
    const route = reset ? remote.resetRoute() : remote.route;
    route.switchTo('jump', 'test');
    route.manualReconnect();
    await until(() => route.snapshot().route === 'direct', 'direct SSH recovery');
  }
});

async function connect(remote, child) {
  const init = child.sent.find((request) => request.method === 'initialize');
  assert(init);
  child.respond(init.id, { userAgent: 'fake-server' });
  await until(() => remote.state.codex === 'ready', 'ready');
}

test('exit and close only schedule one reconnect; stale output cannot settle new requests', async (t) => {
  const { remote, spawned } = setup(t);
  await remote.start();
  const old = spawned[0];
  await connect(remote, old);
  const pending = remote.request('fs/writeFile', { path: '/tmp/test' });
  const rejected = assert.rejects(pending, /断开|关闭/);
  old.emit('exit', 255);
  old.emit('close', 255);
  await rejected;
  await until(() => spawned.length === 2);
  const fresh = spawned[1];
  old.emit('exit', 255);
  await connect(remote, fresh);
  const next = remote.request('thread/list', {});
  const id = fresh.sent.at(-1).id;
  old.respond(id, { stale: true });
  assert(remote.pending.has(id));
  fresh.respond(id, { data: [] });
  assert.deepEqual(await next, { data: [] });
  assert.equal(fresh.sent.filter((request) => request.method === 'fs/writeFile').length, 0);
});

test('failed initialize disposes the old child and retries instead of staying in error', async (t) => {
  const { remote, spawned } = setup(t);
  await remote.start();
  const old = spawned[0];
  old.stdout.write(JSON.stringify({ id: old.sent[0].id, error: { message: 'temporarily unavailable' } }) + '\n');
  await until(() => spawned.length === 2);
  assert(old.killed);
  await connect(remote, spawned[1]);
});

test('handshake timeout retries even if the OS never emits exit', async (t) => {
  const { remote, spawned } = setup(t, { timing: { handshake: 30 } });
  await remote.start();
  await until(() => spawned.length === 2);
  assert(spawned[0].killed);
  await connect(remote, spawned[1]);
});

test('spawn errors retry without an exit event or unhandled EPIPE', async (t) => {
  const { remote, spawned } = setup(t);
  await remote.start();
  spawned[0].emit('error', new Error('ENOENT'));
  await until(() => spawned.length === 2);
  await connect(remote, spawned[1]);
  spawned[1].stdin.emit('error', new Error('EPIPE'));
  await until(() => spawned.length === 3);
  await connect(remote, spawned[2]);
});

test('an unanswered mutation rejects and reconnects without replay', async (t) => {
  const { remote, spawned } = setup(t, { timing: { request: 25 } });
  await remote.start();
  await connect(remote, spawned[0]);
  await assert.rejects(remote.request('fs/writeFile', {}), /请求超时/);
  await until(() => spawned.length === 2);
  await connect(remote, spawned[1]);
  assert(!spawned[1].sent.some((request) => request.method === 'fs/writeFile'));
  assert.equal(remote.pending.size, 0);
});

test('ready SSH with a stalled App Server is detected by the heartbeat', async (t) => {
  const { remote, spawned } = setup(t, { timing: { heartbeat: 15, heartbeatReply: 20 } });
  await remote.start();
  await connect(remote, spawned[0]);
  await until(() => spawned.length === 2);
  assert(spawned[0].killed);
  await connect(remote, spawned[1]);
});

test('heartbeat does not prevent idle sleep; wake ignores delayed old close', async (t) => {
  const { remote, spawned } = setup(t);
  await remote.start();
  const old = spawned[0];
  await connect(remote, old);
  remote.heartbeat(remote.codexConnection);
  remote.lastActivity = Date.now() - 11 * 60000;
  remote.idleCheck();
  assert.equal(remote.state.codex, 'sleeping');
  assert.equal(remote.codexProc, null);
  const awakened = remote.wake();
  await until(() => spawned.length === 2, 'wake spawn');
  await connect(remote, spawned[1]);
  assert.equal(await awakened, true);
  assert.equal(remote.pending.size, 0);
  assert.equal(old.killed, true);
});

test('manual reconnect cancels backoff and rejects old requests immediately', async (t) => {
  const { remote, spawned, services } = setup(t, {
    config: { manageSshd: true, stopSshdOnExit: false },
    timing: { retry: [100] },
  });
  await remote.start();
  await connect(remote, spawned[0]);
  spawned[0].emit('exit', 255);
  await remote.reconnect();
  assert.equal(spawned.length, 2);
  await connect(remote, spawned[1]);
  await delay(110);
  assert.equal(spawned.length, 2);
  const rejected = assert.rejects(remote.request('thread/list', {}), /重新连接/);
  await remote.reconnect();
  await rejected;
  assert.equal(spawned.length, 3);
  await connect(remote, spawned[2]);
  assert.equal(services.filter(([command]) => command === 'query').length, 3);
});

test('tunnel is ready only after forwarding is acknowledged; stale close cannot break replacement', async (t) => {
  const { remote, spawned } = setup(t, { config: { remoteForward: '127.0.0.1:2222:127.0.0.1:22' } });
  await remote.start();
  const oldTunnel = spawned[0];
  assert(oldTunnel.args.includes('-v'));
  assert.equal(remote.state.tunnel, 'connecting');
  oldTunnel.stderr.write('debug1: remote forward success for: listen 127.0.0.1:2222, connect 127.0.0.1:22\n');
  assert.equal(remote.state.tunnel, 'up');
  oldTunnel.emit('exit', 255);
  await until(() => spawned.length === 3);
  const fresh = spawned[2];
  oldTunnel.emit('close', 255);
  fresh.stderr.write('debug1: remote forward success for: listen 127.0.0.1:2222\n');
  assert.equal(remote.state.tunnel, 'up');
  assert.equal(remote.tunnelProc, fresh);
});

test('a stalled tunnel is replaced without waiting for a process exit', async (t) => {
  const { remote, spawned } = setup(t, {
    config: { remoteForward: '127.0.0.1:2222:127.0.0.1:22' }, timing: { tunnel: 25 },
  });
  await remote.start();
  await connect(remote, spawned[1]);
  await until(() => spawned.length === 3);
  assert(spawned[0].killed);
  assert.equal(remote.state.tunnel, 'connecting');
  spawned[2].stderr.write('debug1: remote forward success for: listen 127.0.0.1:2222\n');
  assert.equal(remote.state.tunnel, 'up');
});

test('stop cancels retries and resolves waiters, including connection failures without exit', async (t) => {
  const { remote, spawned } = setup(t);
  await remote.start();
  const waiter = remote.wake(20);
  assert.equal(await waiter, false);
  assert.equal(remote.readyWaiters.size, 0);
  spawned[0].emit('exit', 255);
  await remote.stop();
  await delay(30);
  assert.equal(spawned.length, 1);
  assert.equal(remote.pending.size, 0);
  assert.equal(remote.retryTimers.size, 0);
});

test('a broken remote.json is reported and never overwritten; a missing one gets a template', async (t) => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const { loadConfig } = require('../remote');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdesk-config-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const broken = path.join(dir, 'remote.json');
  const text = '{ "host": "vps.example.invalid", }';
  await fsp.writeFile(broken, text);
  const loaded = loadConfig(broken);
  assert.match(loaded.configError, /无法解析/);
  assert.equal(loaded.host, '');
  assert.equal(await fsp.readFile(broken, 'utf8'), text);
  const fresh = path.join(dir, 'new', 'remote.json');
  assert.equal(loadConfig(fresh).configError, undefined);
  assert.equal(JSON.parse(await fsp.readFile(fresh, 'utf8')).host, '');
  await fsp.writeFile(broken, '{"host":"vps.example.invalid"}');
  assert.equal(loadConfig(broken).host, 'vps.example.invalid');
});

test('server settings bundled in the installer override a stale remote.json; keys stay local', async (t) => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const { loadConfig, bundledServer } = require('../remote');
  const { configuredHost } = require('../onboarding');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdesk-bundle-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'remote.json');
  await fsp.writeFile(local, JSON.stringify({ host: '198.51.100.1', tunnelKey: 'C:/keys/tunnel', idleMinutes: 5 }));
  const bundle = path.join(dir, 'agentdesk-server.json');
  const key = 'AAAAC3NzaC1lZDI1NTE5AAAAI' + 'A'.repeat(43);
  await fsp.writeFile(bundle, JSON.stringify({ host: '203.0.113.10', port: 2222, knownHosts: '[203.0.113.10]:2222 ssh-ed25519 ' + key }));

  assert.equal(bundledServer(path.join(dir, 'missing.json')), null);
  const config = loadConfig(local, bundledServer(bundle));
  assert.equal(config.host, '203.0.113.10');           // the new server wins over the old install's host
  assert.equal(config.port, 2222);
  assert.equal(config.tunnelKey, 'C:/keys/tunnel');    // keys and personal settings stay as the person set them
  assert.equal(config.idleMinutes, 5);
  const trusted = await configuredHost(null, config);
  assert.equal(trusted.host, '203.0.113.10');
  assert.equal(trusted.fingerprints.length, 1);        // the bundled host key is offered for confirmation

  assert.equal(loadConfig(local, null).host, '198.51.100.1');
  await fsp.writeFile(bundle, JSON.stringify({ host: 'bad host; rm -rf /' }));
  const rejected = loadConfig(local, bundledServer(bundle));
  assert.match(rejected.configError, /格式不对/);
  assert.equal(rejected.host, '198.51.100.1');
});

test('a direct transport failure makes the next Codex spawn use the jump', async (t) => {
  const jump = jumpFixture(t);
  const { remote, spawned } = setup(t, { config: { jump } });
  await remote.start();
  const first = spawned[0];
  assert(!first.args.some((arg) => arg.startsWith('ProxyCommand=')));
  first.stderr.write('ssh: connect to host vps.example.invalid port 22: Connection timed out\n');
  first.emit('exit', 255);
  await until(() => spawned.length === 2, 'jump retry');

  const second = spawned[1];
  assert(second.args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.equal(second.args[second.args.indexOf('-p') + 1], '22');
  const payload = JSON.parse(Buffer.from(second.spawnOptions.env.AGENTDESK_SSH_JUMP, 'base64url').toString('utf8'));
  assert.deepEqual(payload.target, { host: 'vps.example.invalid', port: 22 });
  assert.equal(payload.jump.host, 'relay.example.invalid');
  assert.equal(remote.state.route.route, 'jump');
  assert.equal(remote.state.route.jumpAvailable, true);
});

test('a host-key failure is surfaced and never switches to the jump', async (t) => {
  const jump = jumpFixture(t);
  const { remote, spawned } = setup(t, { config: { jump } });
  await remote.start();
  spawned[0].stderr.write('Host key verification failed.\n');
  spawned[0].emit('exit', 255);
  await until(() => spawned.length === 2, 'direct retry');
  assert(!spawned[1].args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.equal(remote.state.route.route, 'direct');
  assert.equal(remote.state.route.lastFailure.kind, 'hostkey');
});

test('openBridge falls back to the remote jump and lets a session jump override it', async (t) => {
  const jump = jumpFixture(t, 'jump');
  const other = jumpFixture(t, 'jump');
  other.host = 'relay2.example.invalid';
  const { remote, spawned } = setup(t, { config: { jump } });
  const bridge = {
    host: 'vps.example.invalid', port: 22, user: 'agentdesk',
    key: '/tmp/bridge_ed25519', knownHosts: '/tmp/known_hosts',
  };
  remote.openBridge(bridge);
  const inherited = JSON.parse(Buffer.from(spawned[0].spawnOptions.env.AGENTDESK_SSH_JUMP, 'base64url').toString('utf8'));
  assert.equal(inherited.jump.host, 'relay.example.invalid');

  remote.openBridge({ ...bridge, jump: other });
  const overridden = JSON.parse(Buffer.from(spawned[1].spawnOptions.env.AGENTDESK_SSH_JUMP, 'base64url').toString('utf8'));
  assert.equal(overridden.jump.host, 'relay2.example.invalid');
});

test('the reverse tunnel still omits -p and follows the jump when forced', async (t) => {
  const jump = jumpFixture(t, 'jump');
  const { remote, spawned } = setup(t, {
    config: { jump, remoteForward: '127.0.0.1:2222:127.0.0.1:22' },
  });
  await remote.start();
  const tunnel = spawned[0];
  const codex = spawned[1];
  assert(tunnel.args.includes('-R'));
  assert(!tunnel.args.includes('-p'));
  assert(tunnel.args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.equal(codex.args[codex.args.indexOf('-p') + 1], '22');
  assert(codex.args.some((arg) => arg.startsWith('ProxyCommand=')));
});

test('bundled jump settings expose only the public endpoint and merge with local secrets', async (t) => {
  const fsp = require('fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdesk-jump-bundle-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { loadConfig, bundledServer } = require('../remote');
  const local = path.join(dir, 'remote.json');
  await fsp.writeFile(local, JSON.stringify({
    host: '198.51.100.1',
    jump: { mode: 'direct', key: 'C:/keys/jump', knownHosts: 'C:/keys/jump_known_hosts', probeMinutes: 3 },
  }));
  const bundle = path.join(dir, 'agentdesk-server.json');
  await fsp.writeFile(bundle, JSON.stringify({
    host: '203.0.113.10',
    jump: { host: 'relay.example.invalid', port: 2222, user: 'agentdesk-jump', mode: 'auto' },
  }));
  const config = loadConfig(local, bundledServer(bundle));
  assert.equal(config.jump.host, 'relay.example.invalid');
  assert.equal(config.jump.port, 2222);
  assert.equal(config.jump.user, 'agentdesk-jump');
  assert.equal(config.jump.mode, 'direct');            // the local switch wins for rollback
  assert.equal(config.jump.key, 'C:/keys/jump');       // secrets never come from the installer
  assert.equal(config.jump.knownHosts, 'C:/keys/jump_known_hosts');
  assert.equal(config.jump.probeMinutes, 3);

  await fsp.writeFile(bundle, JSON.stringify({
    host: '203.0.113.10',
    jump: { host: 'relay.example.invalid', key: 'C:/secret' },
  }));
  const rejected = loadConfig(local, bundledServer(bundle));
  assert.match(rejected.configError, /只能包含/);
  assert.equal(rejected.jump.mode, 'direct');
  assert.equal(rejected.jump.key, 'C:/keys/jump');
});
