const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readBatch, writeBatch } = require('../orchestrator/file-batch');
const { Checkpoints } = require('../checkpoints');

async function setup(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-file-batch-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return (filename) => path.join(folder, filename);
}

test('batch read returns content, pagination and versions and batch write rejects a stale version before any change', async (t) => {
  const resolve = await setup(t);
  await fs.writeFile(resolve('a'), '你好');
  await fs.writeFile(resolve('b'), 'old b');
  const { results } = await readBatch([{ path: 'a', maxBytes: 4 }, { path: 'b' }], resolve);
  assert.equal(results[0].content, '你');
  assert.equal(results[0].nextOffset, 3);
  assert.equal(results[1].content, 'old b');
  await fs.writeFile(resolve('b'), 'external edit');
  const items = [{ path: 'a', version: results[0].version, content: 'new a' },
    { path: 'b', version: results[1].version, content: 'new b' }, { path: 'c', version: null, content: 'new c' }];
  const failed = await writeBatch(items, resolve);
  assert.equal(failed.phase, 'preflight');
  assert.deepEqual(failed.results, [{ status: 'not_run' }, { status: 'failed', error: 'version_conflict' }, { status: 'not_run' }]);
  assert.equal(await fs.readFile(resolve('a'), 'utf8'), '你好');
  await assert.rejects(fs.stat(resolve('c')), { code: 'ENOENT' });
});

test('batch checkpoints undo successful writes and partial failures preserve per-item status', async (t) => {
  const resolve = await setup(t);
  await fs.writeFile(resolve('a'), 'old');
  const { results: [first] } = await readBatch([{ path: 'a' }], resolve);
  const checkpoints = new Checkpoints(resolve('checkpoints'), { trash: (name) => fs.unlink(name) });
  const wrap = (name, run) => checkpoints.around('turn', 'thread', 'windows_file_write', { path: name }, run);
  const changes = [{ path: 'a', version: first.version, content: 'new' },
    { path: 'b', version: null, content: 'new' }];
  const outcome = await writeBatch(changes, resolve, wrap);
  assert.deepEqual(outcome.results.map(({ status }) => status), ['written', 'written']);
  assert.equal((await checkpoints.finish('turn')).files.length, 2);
  assert.equal((await checkpoints.undo('turn')).restored.length, 2);
  assert.equal(await fs.readFile(resolve('a'), 'utf8'), 'old');
  await assert.rejects(fs.stat(resolve('b')), { code: 'ENOENT' });
  const partial = await writeBatch([...changes, { path: 'c', version: null, content: 'new' }], resolve, async (name, run) => {
    if (name === resolve('b')) await fs.writeFile(name, 'external');
    return run();
  });
  assert.deepEqual(partial.results.map(({ status }) => status), ['written', 'failed', 'not_run']);
  assert.equal(await fs.readFile(resolve('b'), 'utf8'), 'external');
});
