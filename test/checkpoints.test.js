const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Checkpoints, affected } = require('../checkpoints');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-checkpoint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const trashed = [];
  const store = new Checkpoints(path.join(dir, 'store'), {
    trash: async (target) => { trashed.push(target); fs.rmSync(target, { recursive: true, force: true }); },
  });
  return { work, store, trashed };
}

test('the paths each file tool may change', () => {
  const source = path.resolve('a');
  const target = path.resolve('b');
  const file = path.join(source, 'b.txt');
  assert.deepEqual(affected('agentdesk_file_write', { path: file }), [{ path: file, action: 'write' }]);
  assert.deepEqual(affected('windows_file_move', { path: source, destination: target }).map((x) => x.path), [source, target]);
  assert.deepEqual(affected('agentdesk_file_copy', { path: source, destination: target }), [{ path: target, action: 'copy' }]);
  assert.deepEqual(affected('agentdesk_file_read', { path: source }), []);
  assert.deepEqual(affected('agentdesk_file_write', { path: 'relative.txt' }), []);
});

test('undoing a turn restores edited files, removes created ones and brings back a trashed folder', async (t) => {
  const { work, store, trashed } = setup(t);
  const edited = path.join(work, 'notes.md');
  const created = path.join(work, 'new.txt');
  const folder = path.join(work, 'old');
  const moved = path.join(work, 'moved.txt');
  const movedTo = path.join(work, 'renamed.txt');
  fs.writeFileSync(edited, 'original');
  fs.mkdirSync(path.join(folder, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'inner', 'a.txt'), 'kept');
  fs.writeFileSync(moved, 'move me');

  const run = (tool, args, fn) => store.around('turn-1', 'thread-1', tool, args, fn);
  await run('agentdesk_file_write', { path: edited }, () => fs.writeFileSync(edited, 'first edit'));
  await run('agentdesk_file_write', { path: edited }, () => fs.writeFileSync(edited, 'second edit'));   // the first state is kept
  await run('agentdesk_file_write', { path: created }, () => fs.writeFileSync(created, 'hello'));
  await run('agentdesk_file_trash', { path: folder }, () => fs.rmSync(folder, { recursive: true }));
  await run('agentdesk_file_move', { path: moved, destination: movedTo }, () => fs.renameSync(moved, movedTo));
  const summary = await store.finish('turn-1');
  assert.equal(summary.files.length, 5);
  assert.equal(summary.files.find((f) => f.path === created).created, true);

  const result = await store.undo('turn-1');
  assert.deepEqual(result.skipped, []);
  assert.equal(fs.readFileSync(edited, 'utf8'), 'original');
  assert.equal(fs.existsSync(created), false);
  assert.ok(trashed.includes(created));                       // removed files go to the trash
  assert.equal(fs.readFileSync(path.join(folder, 'inner', 'a.txt'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'move me');
  assert.equal(fs.existsSync(movedTo), false);
  await assert.rejects(store.undo('turn-1'), /已经撤销/);
  assert.equal((await store.list('thread-1'))[0].undone, true);
});

test('a file changed again after the turn is skipped unless forced', async (t) => {
  const { work, store } = setup(t);
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'v1');
  await store.around('turn-2', 'thread-2', 'agentdesk_file_write', { path: file }, () => fs.writeFileSync(file, 'v2'));
  await store.finish('turn-2');
  fs.writeFileSync(file, 'v3 by the person');
  const result = await store.undo('turn-2');
  assert.equal(result.restored.length, 0);
  assert.match(result.skipped[0].reason, /之后又被修改/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v3 by the person');
});

test('a turn that changed nothing leaves no checkpoint', async (t) => {
  const { work, store } = setup(t);
  const file = path.join(work, 'same.txt');
  fs.writeFileSync(file, 'same');
  await store.around('turn-3', 'thread-3', 'agentdesk_file_write', { path: file }, () => fs.writeFileSync(file, 'same'));
  assert.equal(await store.finish('turn-3'), null);
  assert.deepEqual(await store.list('thread-3'), []);
});
