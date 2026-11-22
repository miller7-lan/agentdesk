const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { NativeChannel } = require('../orchestrator/native-channel');
const { workspacePolicy } = require('../orchestrator/windows-native-seat');

test('native channel maintains byte order without interpreting SFTP as RPC', () => {
  const received = new PassThrough();
  const outbound = new PassThrough();
  const encoder = new NativeChannel(new PassThrough(), outbound);
  const decoder = new NativeChannel(received, new PassThrough());
  const chunks = [];
  const collected = [];
  outbound.on('data', (data) => chunks.push(data));
  for (const lane of ['s', 'p', 'c']) decoder.on(lane, (bytes) => collected.push({ lane, bytes }));
  const payload = Buffer.alloc(175000).fill(Buffer.from([0, 1, 255, 90]));
  encoder.send('s', payload);
  encoder.send('p', JSON.stringify({ id: 1, method: 'initialize' }) + '\n');
  encoder.send('c', '{"state":"ready"}');
  const bytes = Buffer.concat(chunks);
  for (let offset = 0; offset < bytes.length; offset += 27) received.write(bytes.subarray(offset, offset + 27));
  assert.deepEqual(Buffer.concat(collected.filter(({ lane }) => lane === 's').map(({ bytes }) => bytes)), payload);
  assert.match(collected.find(({ lane }) => lane === 'p').bytes.toString(), /initialize/);
  assert.deepEqual(collected.map(({ lane }) => lane), ['s', 's', 's', 'p', 'c']);
});

test('native Codex policy keeps project writes scoped; network is on for writing turns only', () => {
  assert.deepEqual(workspacePolicy('/fixture/project', 'write'), {
    type: 'workspaceWrite', writableRoots: ['/fixture/project'], networkAccess: true,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  });
  assert.deepEqual(workspacePolicy('/fixture/project', 'read'), { type: 'readOnly', networkAccess: false });
});
