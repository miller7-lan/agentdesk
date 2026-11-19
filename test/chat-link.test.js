const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { ChatLink } = require('../chat-link');
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
  const link = new ChatLink({
    agent: options.agent || 'claude',
    config: {
      configError: undefined,
      host: 'vps.example.invalid', port: 22, knownHosts: '/tmp/known_hosts', jump: undefined,
      claudeKey: '/tmp/claude_ed25519', grokKey: '/tmp/grok_ed25519', antigravityKey: '/tmp/antigravity_ed25519',
      chatUser: 'agentdesk', chatScript: '/opt/agentdesk-orchestrator/agent-chat.sh',
      idleMinutes: options.idleMinutes ?? 0,
      ...options.config,
    },
    timing: { handshake: 200, request: 200, retry: [5], ...options.timing },
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
      child.reply = (id, method, params = {}) => child.stdout.write(JSON.stringify({ id, method, params }) + '\n');
      child.args = args;
      spawned.push(child);
      return child;
    },
  });
  t.after(() => { link.stop(); resetRoutes(); });
  return { link, spawned };
}

function jumpFixture(t, mode = 'auto') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-chat-jump-'));
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

async function connect(link, child) {
  const init = child.sent.find((request) => request.method === 'initialize');
  assert(init);
  child.respond(init.id, { serverInfo: { name: 'fake-chat' } });
  await until(() => link.state === 'ready', 'ready');
}

test('handshake, requests, notifications and server requests use one connection', async (t) => {
  const { link, spawned } = setup(t);
  const events = [];
  const requests = [];
  link.on('event', (event) => events.push(event));
  link.on('server-request', (request) => requests.push(request));

  const wake = link.wake();
  await until(() => spawned.length === 1);
  assert.equal(link.state, 'connecting');
  assert(spawned[0].args.some((arg) => arg.endsWith('agent-chat.sh claude')));
  await connect(link, spawned[0]);
  assert.equal(await wake, true);

  const request = link.request('thread/resume', { threadId: 'claude-abc' });
  const sent = spawned[0].sent.at(-1);
  assert.equal(sent.method, 'thread/resume');
  spawned[0].respond(sent.id, { thread: { id: 'claude-abc' } });
  assert.deepEqual(await request, { thread: { id: 'claude-abc' } });

  spawned[0].stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'claude-abc', delta: 'hi' } }) + '\n');
  spawned[0].reply(7, 'item/tool/requestApproval', { threadId: 'claude-abc', tool: 'agentdesk_file_write' });
  await until(() => events.length === 1 && requests.length === 1, 'events');
  assert.equal(events[0].agent, 'claude');
  assert.equal(requests[0].id, 7);
  assert.equal(link.respond(7, { decision: 'accept' }), true);
  assert.deepEqual(spawned[0].sent.at(-1), { id: 7, result: { decision: 'accept' } });
  assert.equal(link.respond(7, { decision: 'accept' }), false);
});

test('a dropped connection rejects pending requests, ignores stale output and retries', async (t) => {
  const { link, spawned } = setup(t);
  link.auto = true;
  const ready = link.wake();
  await until(() => spawned.length === 1);
  await connect(link, spawned[0]);
  await ready;

  const pending = link.request('turn/start', { threadId: 'claude-a' });
  const rejected = assert.rejects(pending, /断开|关闭/);
  const old = spawned[0];
  old.emit('exit', 255);
  old.emit('close', 255);
  await rejected;
  assert.equal(link.state, 'retry');
  await until(() => spawned.length === 2, 'reconnect');
  await connect(link, spawned[1]);

  const next = link.request('thread/list', {});
  const id = spawned[1].sent.at(-1).id;
  old.respond(id, { stale: true });
  assert(link.pending.has(id));
  spawned[1].respond(id, { data: [] });
  assert.deepEqual(await next, { data: [] });
});

test('an unanswered request reconnects without replaying the mutation', async (t) => {
  const { link, spawned } = setup(t, { timing: { request: 40 } });
  link.auto = true;
  const ready = link.wake();
  await until(() => spawned.length === 1);
  await connect(link, spawned[0]);
  await ready;

  await assert.rejects(link.request('turn/start', { threadId: 'claude-a' }), /超时/);
  await until(() => spawned.length === 2, 'reconnect');
  await connect(link, spawned[1]);
  assert.equal(spawned[1].sent.filter((request) => request.method === 'turn/start').length, 0);
});

test('idle sleep keeps active turns connected and wakes on demand', async (t) => {
  const { link, spawned } = setup(t);
  const states = [];
  link.on('status', (status) => states.push(status.state));
  const ready = link.wake();
  await until(() => spawned.length === 1);
  await connect(link, spawned[0]);
  await ready;

  spawned[0].stdout.write(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-1' } } }) + '\n');
  await until(() => link.activeTurns.has('turn-1'), 'turn started');
  link.sleep();
  assert.equal(link.state, 'ready');
  assert.equal(spawned[0].killed, undefined);

  spawned[0].stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } }) + '\n');
  await until(() => !link.activeTurns.has('turn-1'), 'turn completed');
  link.sleep();
  await until(() => link.state === 'sleeping', 'sleeping');
  assert(spawned[0].killed);
  assert(states.includes('sleeping'));

  const again = link.wake();
  await until(() => spawned.length === 2, 'wake');
  await connect(link, spawned[1]);
  assert.equal(await again, true);
});

test('a missing key is reported without spawning SSH', async (t) => {
  const { link, spawned } = setup(t, { config: { claudeKey: '' } });
  assert.equal(await link.wake(), false);
  assert.equal(spawned.length, 0);
  assert.equal(link.state, 'error');
  assert.match(link.detail, /密钥/);
});
test('status exposes the shared route state', (t) => {
  const { link } = setup(t);
  const status = link.status();
  assert.equal(status.route.route, 'direct');
  assert.equal(status.route.mode, 'direct');
  assert.equal(status.route.jumpAvailable, false);
});

test('a transport failure moves a single chat to the jump on the next retry', async (t) => {
  const jump = jumpFixture(t);
  const { link, spawned } = setup(t, { config: { jump } });
  link.wake();
  await until(() => spawned.length === 1, 'first spawn');
  assert(!spawned[0].args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.equal(link.status().route.route, 'direct');

  spawned[0].stderr.write('ssh: connect to host vps.example.invalid port 22: Connection timed out\n');
  spawned[0].emit('exit', 255);
  await until(() => spawned.length === 2, 'jump retry');

  assert(spawned[1].args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.equal(spawned[1].args.at(-1), '/opt/agentdesk-orchestrator/agent-chat.sh claude');
  assert(spawned[1].spawnOptions.env.AGENTDESK_SSH_JUMP);
  assert.equal(link.status().route.route, 'jump');
});

test('a host-key failure in a single chat never switches to the jump', async (t) => {
  const jump = jumpFixture(t);
  const { link, spawned } = setup(t, { config: { jump } });
  link.wake();
  await until(() => spawned.length === 1, 'first spawn');
  spawned[0].stderr.write('Host key verification failed.\n');
  spawned[0].emit('exit', 255);
  await until(() => spawned.length === 2, 'direct retry');
  assert(!spawned[1].args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.equal(link.status().route.route, 'direct');
  assert.equal(link.status().route.lastFailure.kind, 'hostkey');
});

test('forcing the jump leaves the chat command as the last argument', async (t) => {
  const jump = jumpFixture(t, 'jump');
  const { link, spawned } = setup(t, { config: { jump } });
  link.wake();
  await until(() => spawned.length === 1, 'first spawn');
  assert(spawned[0].args.some((arg) => arg.startsWith('ProxyCommand=')));
  assert.equal(spawned[0].args.at(-1), '/opt/agentdesk-orchestrator/agent-chat.sh claude');
  assert.equal(link.status().route.route, 'jump');
  const payload = JSON.parse(Buffer.from(spawned[0].spawnOptions.env.AGENTDESK_SSH_JUMP, 'base64url').toString('utf8'));
  assert.deepEqual(payload.target, { host: 'vps.example.invalid', port: 22 });
});
