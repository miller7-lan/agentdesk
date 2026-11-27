const test = require('node:test');
const assert = require('node:assert/strict');
const { createCarrierWriter } = require('../orchestrator/carrier-writer');

test('carrier writer: one write in flight, everything that arrived meanwhile goes in the next one, in order', async () => {
  const writes = [];
  let release;
  const writer = createCarrierWriter({ write: (chunk) => { writes.push(chunk.toString()); return new Promise((resolve) => { release = resolve; }); },
    onError: (error) => { throw error; } });
  writer.push(Buffer.from('a'));
  for (const key of 'bcdefghij') writer.push(Buffer.from(key));   // typed while the first write is on its way
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['a'], 'nothing else is sent while a write is in flight');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ['a', 'bcdefghij'], 'nine keystrokes cost one more round trip, not nine');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writer.pending, 0);
});

test('carrier writer: large bursts are split, and too much backlog fails the carrier', async () => {
  const sizes = [];
  const writer = createCarrierWriter({ write: async (chunk) => { sizes.push(chunk.length); }, onError: () => {}, maxChunk: 100 });
  for (let i = 0; i < 5; i++) writer.push(Buffer.alloc(60));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(sizes.every((size) => size <= 100) && sizes.reduce((a, b) => a + b, 0) === 300);
  const errors = [];
  const stuck = createCarrierWriter({ write: () => new Promise(() => {}), onError: (error) => errors.push(error.message), limit: 50 });
  stuck.push(Buffer.alloc(30));
  stuck.push(Buffer.alloc(30));
  assert.deepEqual(errors, ['native_channel_backpressure']);
});
