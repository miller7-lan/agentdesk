const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { git } = require('../orchestrator/git');
const { collectSnapshot, encodeSnapshot, decodeSnapshot, installSnapshot, buildCopy, digest } = require('../orchestrator/test-snapshot');

test('snapshot deltas preserve binary files, drop deletions and verify inherited bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-test-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  await git(repo, ['init']);
  await fs.writeFile(path.join(repo, 'keep.bin'), Buffer.from([0, 255, 2]));
  await fs.writeFile(path.join(repo, 'remove.txt'), 'gone');
  await fs.writeFile(path.join(repo, '.env'), 'fixture-only');
  const taskId = randomUUID();
  const base = 'a'.repeat(40);
  const first = await collectSnapshot(repo, base);
  assert.deepEqual(first.entries.map((entry) => entry.path), ['keep.bin', 'remove.txt']);
  await installSnapshot(root, taskId, encodeSnapshot(first));
  await fs.rename(path.join(repo, 'remove.txt'), path.join(repo, 'renamed.txt'));
  const second = await collectSnapshot(repo, base);
  const delta = encodeSnapshot(second, first);
  assert.deepEqual([...decodeSnapshot(delta).files.keys()], ['renamed.txt']);
  const inherited = path.join(root, 'isolated-tests', taskId, first.version, 'files', 'keep.bin');
  await fs.writeFile(inherited, Buffer.from([1, 255, 2]));
  await assert.rejects(installSnapshot(root, taskId, delta), /test_snapshot_parent_invalid/);
  await installSnapshot(root, taskId, encodeSnapshot(second));
  const copy = await buildCopy(root, taskId, second.version);
  assert.deepEqual((await fs.readdir(copy)).sort(), ['keep.bin', 'renamed.txt']);
  assert.deepEqual(await fs.readFile(path.join(copy, 'keep.bin')), Buffer.from([0, 255, 2]));
});

test('Windows snapshot decoding rejects aliases, reserved paths and escapes', () => {
  const entry = (path) => ({ path, size: 0, sha256: digest(''), executable: false });
  const decode = (entries) => decodeSnapshot(gzipSync(JSON.stringify({
    base: 'b'.repeat(40), entries, previous: null, files: [],
  })));
  assert.throws(() => decode([entry('A/x'), entry('a/y')]), /test_snapshot_path_conflict/);
  for (const file of ['../outside', 'A/NUL.txt', 'report.txt:stream', '.ssh/list']) {
    assert.throws(() => decode([entry(file)]), /invalid_test_manifest/);
  }
});
