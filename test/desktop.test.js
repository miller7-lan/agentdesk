const test = require('node:test');
const assert = require('node:assert/strict');
const { Desktop } = require('../desktop');

function fake() {
  const desktop = new Desktop('unused');
  desktop.timeoutMs = 20;
  const writes = [];
  desktop.child = { stdin: { write: (line) => writes.push(JSON.parse(line)) }, kill() {} };
  return { desktop, writes };
}

test('one slow desktop call fails on its own without stopping the backend', async () => {
  const { desktop } = fake();
  await assert.rejects(desktop.send('tools/call', {}), /timed out/);
  assert.ok(desktop.child, 'backend kept running after a single timeout');
  assert.equal(desktop.pending.size, 0);
});

test('three consecutive timeouts restart the desktop backend', async () => {
  const { desktop } = fake();
  for (let i = 0; i < 3; i++) await assert.rejects(desktop.send('tools/call', {}), /timed out/);
  assert.equal(desktop.child, null);
});
