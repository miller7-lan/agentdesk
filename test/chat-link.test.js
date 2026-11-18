const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { ChatLink } = require('../chat-link');

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
      host: 'vps.example.invalid', port: 22, knownHosts: '/tmp/known_hosts',
      claudeKey: '/tmp/claude_ed25519', grokKey: '/tmp/grok_ed25519', antigravityKey: '/tmp/antigravity_ed25519',
      chatUser: 'agentdesk', chatScript: '/opt/agentdesk-orchestrator/agent-chat.sh',
      idleMinutes: options.idleMinutes ?? 0,
      ...options.config,
    },
    timing: { handshake: 200, request: 200, retry: [5], ...options.timing },
    spawnProcess: (_exe, args) => {
      const child = new EventEmitter();
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
  t.after(() => link.stop());
  return { link, spawned };
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