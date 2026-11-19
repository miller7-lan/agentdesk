const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { receiptFor, writeReceipt, MUTATIONS } = require('../orchestrator/mcp');

test('write receipts record versions and outcomes but never file content', () => {
  const receipt = receiptFor('write', {
    root: 'computer', path: '/Users/me/report.md', version: 'old-version', content: 'TOP SECRET', encoding: 'utf8',
  }, 7, { type: 'file', version: 'new-version', size: 42 });
  assert.equal(receipt.operation, 'write');
  assert.equal(receipt.requestId, 7);
  assert.equal(receipt.expectedVersion, 'old-version');
  assert.equal(receipt.version, 'new-version');
  assert.equal(receipt.size, 42);
  assert.equal(receipt.ok, true);
  assert.doesNotMatch(JSON.stringify(receipt), /TOP SECRET/);

  const failed = receiptFor('write', { root: 'computer', path: '/Users/me/report.md' }, 8, null, new Error('version_conflict'));
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'version_conflict');
  assert.ok(MUTATIONS.has('write'));
  assert.ok(!MUTATIONS.has('read'));
});

test('write receipts are appended as JSON lines for the controller', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-receipts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'step.receipts.jsonl');
  writeReceipt(file, receiptFor('write', { path: 'a.txt' }, 1, { type: 'file', version: 'v1', size: 1 }));
  writeReceipt(file, receiptFor('write', { path: 'b.txt' }, 2, { type: 'file', version: 'v2', size: 2 }));
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((receipt) => receipt.path), ['a.txt', 'b.txt']);
  assert.deepEqual(lines.map((receipt) => receipt.version), ['v1', 'v2']);
});