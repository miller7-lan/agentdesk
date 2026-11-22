'use strict';
// A native seat passes a question of its running turn (item/tool/requestUserInput) to the app and the answer back;
// every other server request but the native tools stays refused (orchestrator/windows-native-seat.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeChannel, VERSION } = require('../orchestrator/native-channel');
const { Lines } = require('../orchestrator/transport');
const { openWindowsNativeSeat } = require('../orchestrator/windows-native-seat');

function harness() {
  const remote = new EventEmitter();
  const hostIn = new PassThrough();   // bytes the seat writes (command/exec/write)
  const hostOut = new PassThrough();  // bytes the host prints (outputDelta)
  const host = new NativeChannel(hostIn, hostOut);
  const providerIn = new PassThrough();
  const providerOut = new PassThrough();
  const provider = new Lines(providerIn, providerOut, 1 << 20);
  host.on('p', (data) => providerIn.write(data));
  providerOut.on('data', (data) => host.send('p', data));
  let carrier;
  hostOut.on('data', (data) => remote.emit('notification', { method: 'command/exec/outputDelta',
    params: { processId: carrier, stream: 'stdout', deltaBase64: data.toString('base64') } }));
  remote.request = async (method, params) => {
    if (method === 'command/exec') { carrier = params.processId; setImmediate(() => host.send('c', Buffer.from(JSON.stringify({
      protocolVersion: VERSION, state: 'ready', mountPath: '/var/tmp/agentdesk-native-seat-x/windows-chat-mounts/project-y' })))); return new Promise(() => {}); }
    if (method === 'command/exec/write') { hostIn.write(Buffer.from(params.deltaBase64, 'base64')); return {}; }
    throw new Error('unexpected ' + method);
  };
  const worker = { request: async (operation) => (operation === 'promote' ? {} : null),
    openSftp: async () => { const s = new PassThrough(); s.destroy = () => {}; return s; } };
  // The provider side answers initialize / thread/resume / turn/start like the host would.
  provider.on('frame', (frame) => {
    if (frame.method === 'initialize') provider.send({ id: frame.id, result: {} });
    if (frame.method === 'turn/start') {
      provider.send({ id: frame.id, result: { turn: { id: 'turn-1' } } });
      provider.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    }
  });
  return { remote, worker, provider };
}

test('a native seat forwards its running turn\'s question to the app and returns the answer', async () => {
  const { remote, worker, provider } = harness();
  const asked = [];
  const seat = await openWindowsNativeSeat({ remote, worker, identity: { threadId: 'thread-1', provider: 'codex', fullAccess: true },
    binding: {}, checkpoints: false,
    onServerRequest: async (frame) => { asked.push(frame); return { answers: { q1: { answers: ['蓝'] } } }; } });
  await seat.request('turn/start', { threadId: 'thread-1', input: [], approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reply = (id) => new Promise((resolve) => provider.on('frame', (frame) => { if (frame.id === id && !frame.method) resolve(frame); }));
  const answered = reply(91);
  provider.send({ id: 91, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i', questions: [{ id: 'q1', question: '颜色？' }] } });
  assert.deepEqual((await answered).result, { answers: { q1: { answers: ['蓝'] } } });
  assert.equal(asked.length, 1);

  const foreign = reply(92);
  provider.send({ id: 92, method: 'item/tool/requestUserInput', params: { threadId: 'other', turnId: 'turn-1', questions: [] } });
  assert.match((await foreign).error.message, /native_question_not_authorized/);
  const approval = reply(93);
  provider.send({ id: 93, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  assert.equal((await approval).result.success, false, 'other server requests stay refused');
  assert.equal(asked.length, 1);
  remote.emit('codex-down');   // tear down the way a dropped connection does
  assert.equal(seat.closed, true);
});
