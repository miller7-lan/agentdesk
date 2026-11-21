const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Reader, packet, T, S, u32, u64, str } = require('../orchestrator/sftp-readonly');
const { createProjectSftp } = require('../orchestrator/sftp-project-write');
const { FileLockManager, WAIT_MS, IDLE_MS, MAX_HOLD_MS } = require('../orchestrator/file-locks');

// Manual clock: timers fire when the test advances time.
function clock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) { const timer = { at: now + ms, fn }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now && timers.has(timer)) { timers.delete(timer); timer.fn(); }
      }
    },
  };
}

test('Q1/Q2 constants are the decided values', () => {
  assert.equal(WAIT_MS, 120_000);
  assert.equal(IDLE_MS, 30_000);
  assert.equal(MAX_HOLD_MS, 600_000);
});

test('a later session waits for the holder and gets the lock in arrival order when it is released', async () => {
  const time = clock();
  const locks = new FileLockManager(time);
  const events = [];
  locks.on('event', (event) => events.push(event.type + ':' + event.owner));
  await locks.acquire('claude', 'Claude', ['/p/a.js']);
  const order = [];
  const codex = locks.acquire('codex', 'Codex', ['/p/a.js']).then(() => order.push('codex'));
  const grok = locks.acquire('grok', 'Grok', ['/p/a.js']).then(() => order.push('grok'));
  await new Promise(setImmediate);
  assert.deepEqual(order, []);
  assert.equal(locks.holder('/p/a.js').owner, 'claude');
  assert.deepEqual(locks.status().waiting.map((item) => item.owner), ['codex', 'grok']);
  locks.release('claude', 'turn_end');
  await codex;
  assert.deepEqual(order, ['codex']);
  locks.release('codex', 'turn_end');
  await grok;
  assert.deepEqual(order, ['codex', 'grok']);
  assert.ok(events.includes('waiting:codex') && events.includes('released:claude'));
});

test('Q1: waiting ends after 120 seconds with a retryable error naming the holder', async () => {
  const time = clock();
  const locks = new FileLockManager(time);
  await locks.acquire('claude', 'Claude', ['/p/a.js']);
  locks.touch('claude');
  const waiting = locks.acquire('codex', 'Codex', ['/p/a.js']);
  // The holder keeps writing, so its idle window never runs out before the wait limit.
  for (let elapsed = 0; elapsed < 119_000; elapsed += 20_000) { time.advance(20_000); locks.touch('claude'); }
  time.advance(1_000);
  await assert.rejects(waiting, (error) => error.code === 'ELOCKTIMEOUT' && error.retryable === true && /Claude/.test(error.message));
});

test('Q2: the lock ends 30 seconds after the last write, with the turn, or after 10 minutes at most', async () => {
  const time = clock();
  const locks = new FileLockManager(time);
  await locks.acquire('a', 'A', ['/p/x']);
  time.advance(29_000);
  assert.ok(locks.holder('/p/x'));
  locks.touch('a', ['/p/x']);
  time.advance(29_000);
  assert.ok(locks.holder('/p/x'), 'a write restarts the idle window');
  time.advance(2_000);
  assert.equal(locks.holder('/p/x'), null, 'idle 30 s');

  await locks.acquire('b', 'B', ['/p/y']);
  locks.release('b', 'turn_end');
  assert.equal(locks.holder('/p/y'), null, 'turn end');

  await locks.acquire('c', 'C', ['/p/z']);
  for (let elapsed = 0; elapsed < MAX_HOLD_MS - 20_000; elapsed += 20_000) { time.advance(20_000); locks.touch('c'); }
  assert.ok(locks.holder('/p/z'));
  time.advance(20_000);
  locks.touch('c');
  assert.equal(locks.holder('/p/z'), null, 'ten minutes at most');
});

test('A11: a change to a locked file that did not come through AgentDesk is reported as bypassed', async () => {
  const time = clock();
  const locks = new FileLockManager(time);
  const bypassed = [];
  locks.on('bypassed', (event) => bypassed.push(event));
  await locks.acquire('a', 'A', ['/p/locked.txt']);
  locks.touch('a', ['/p/locked.txt']);
  assert.equal(locks.noteChange('/p/locked.txt'), null, 'its own write');
  time.advance(5_000);
  locks.touch('a');
  assert.ok(locks.noteChange('/p/locked.txt'));
  assert.equal(locks.noteChange('/p/other.txt'), null, 'unlocked files are not reported');
  assert.equal(bypassed.length, 1);
  assert.equal(bypassed[0].owner, 'a');
});

test('watchProject reports a write made outside AgentDesk (fs.watch)', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesk-lock-watch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.txt');
  await fs.writeFile(file, 'one');
  const locks = new FileLockManager();
  const seen = new Promise((resolve) => locks.once('bypassed', resolve));
  const stop = locks.watchProject(root);
  t.after(stop);
  await locks.acquire('a', 'A', [file]);
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  await fs.writeFile(file, 'changed by another program');
  const event = await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('no bypass event')), 5_000))]);
  assert.equal(event.owner, 'a');
  locks.release('a');
});

/* ---------- through the project mount (SFTP), as the CLIs reach it ---------- */
async function session(t, root, locks, owner) {
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = createProjectSftp({ root, locks: {
    acquire: (files) => locks.acquire(owner, owner, files),
    touched: (files) => locks.touch(owner, files),
    stale: (file) => locks.staleWrite(owner, owner, file),
  } })(input, output);
  t.after(async () => { channel.close(); await channel.done; });
  const replies = output[Symbol.asyncIterator]();
  const reader = new Reader();
  let id = 0;
  const send = async (type, ...args) => {
    input.write(packet(type, type === T.INIT ? args : [u32(++id), ...args]));
    let result;
    while (!(result = reader.next())) reader.push((await replies.next()).value);
    return result;
  };
  const statusOf = (result) => ({ code: result.readUInt32BE(5), text: result.subarray(13, 13 + result.readUInt32BE(9)).toString() });
  const open = async (name, flags) => {
    const result = await send(T.OPEN, str(name), u32(flags), u32(0));
    if (result[0] !== T.HANDLE) return { error: statusOf(result) };
    return { handle: result.subarray(9) };
  };
  const write = async (handle, offset, data) => statusOf(await send(T.WRITE, str(handle), u64(offset), str(Buffer.from(data))));
  const close = async (handle) => statusOf(await send(T.CLOSE, str(handle)));
  await send(T.INIT, u32(3));
  return { open, write, close, send };
}

const READ = 1;
const WRITE = 2;
const CREATE = 8;
const TRUNCATE = 16;

test('A4: three sessions write different files of one project at the same time', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesk-shared-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const locks = new FileLockManager();
  const sessions = await Promise.all(['claude', 'codex', 'grok'].map((owner) => session(t, root, locks, owner)));
  await Promise.all(sessions.map(async (one, index) => {
    const { handle } = await one.open(`file-${index}.txt`, WRITE | CREATE | TRUNCATE);
    assert.equal((await one.write(handle, 0, 'from ' + index)).code, S.OK);
    assert.equal((await one.close(handle)).code, S.OK);
  }));
  for (let index = 0; index < 3; index++) assert.equal(await fs.readFile(path.join(root, `file-${index}.txt`), 'utf8'), 'from ' + index);
});

test('A5: the second writer of a file waits; when the first is done and the file changed, its write is refused and must re-read', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesk-lock-sftp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app.js'), 'v1');
  const locks = new FileLockManager();
  const events = [];
  locks.on('event', (event) => events.push(event.type + ':' + event.owner));
  const claude = await session(t, root, locks, 'claude');
  const codex = await session(t, root, locks, 'codex');
  // Codex reads the file first (it now knows revision v1).
  const read = await codex.open('app.js', READ);
  await codex.close(read.handle);
  // Claude starts writing and holds the lock.
  const claudeFile = await claude.open('app.js', WRITE | TRUNCATE);
  assert.ok(claudeFile.handle);
  // Codex tries to write: it waits.
  let codexDone = false;
  const codexWrite = codex.open('app.js', WRITE | TRUNCATE).then((result) => { codexDone = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(codexDone, false);
  assert.ok(events.includes('waiting:codex'));
  assert.equal((await claude.write(claudeFile.handle, 0, 'v2 by claude')).code, S.OK);
  await claude.close(claudeFile.handle);
  locks.release('claude', 'turn_end');
  const result = await codexWrite;
  assert.ok(result.error, 'stale write refused');
  assert.match(result.error.text, /project_file_changed: \/app\.js/);
  assert.ok(events.includes('staleWriteRejected:codex'));
  assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'v2 by claude');
  // After reading again, Codex may write.
  const again = await codex.open('app.js', READ);
  await codex.close(again.handle);
  const ok = await codex.open('app.js', WRITE | TRUNCATE);
  assert.ok(ok.handle);
  assert.equal((await codex.write(ok.handle, 0, 'v3 by codex')).code, S.OK);
  await codex.close(ok.handle);
  assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'v3 by codex');
});

test('leases: shared writers by default, exclusive on request, locks released when the turn ends', { skip: process.platform === 'win32' }, async (t) => {
  const { WindowsProjectLeases } = require('../orchestrator/windows-project-leases');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesk-leases-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const leases = new WindowsProjectLeases(path.join(root, 'leases.json'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const base = { device: 'd', root: project, fullAccess: true, projectId: 'p' };
  const one = { ...base, provider: 'claude', threadId: 'one' };
  const first = { ...one, ...await leases.acquire(one) };
  const second = { ...base, provider: 'codex', threadId: 'two' };
  assert.equal((await leases.acquire(second)).state, 'active');
  await assert.rejects(leases.acquire({ ...base, provider: 'grok', threadId: 'three', exclusive: true }), /native_project_writer_busy/);
  await leases.lockFiles(first, ['src/a.js']);
  assert.equal(leases.lockStatus(first).locks[0].path, path.join('src', 'a.js'));
  await assert.rejects(leases.lockFiles(first, ['../outside.txt']), /lock_path_outside_project/);
  assert.equal(leases.endTurn(first).released, 1);
  assert.deepEqual(leases.lockStatus(first).locks, []);
  void EventEmitter;
});
