const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { Reader, packet, T, S, u32, u64, str } = require('../orchestrator/sftp-readonly');
const { createProjectSftp } = require('../orchestrator/sftp-project-write');

async function fixture(t, serve = (root, input, output) => createProjectSftp({ root })(input, output)) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesk-project-sftp-'));
  const root = path.join(temporary, 'project');
  await fs.mkdir(root);
  const input = new PassThrough();
  const output = new PassThrough();
  const channel = await serve(root, input, output);
  t.after(async () => {
    channel.close();
    await channel.done;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const replies = output[Symbol.asyncIterator]();
  const reader = new Reader();
  let id = 0;
  const send = async (type, ...args) => {
    input.write(packet(type, type === T.INIT ? args : [u32(++id), ...args]));
    let result;
    while (!(result = reader.next())) reader.push((await replies.next()).value);
    if (type !== T.INIT) assert.equal(result.readUInt32BE(1), id);
    return result;
  };
  const check = async (status, ...args) => {
    const result = await send(...args);
    assert.equal(result[0], T.STATUS);
    assert.equal(result.readUInt32BE(5), status, result.subarray(13).toString());
    return result.subarray(13, 13 + result.readUInt32BE(9)).toString();
  };
  const open = async (filename, flags) => {
    const result = await send(T.OPEN, str(filename), u32(flags), u32(0));
    assert.equal(result[0], T.HANDLE, result.subarray(13).toString());
    return result.subarray(9);
  };
  assert.equal((await send(T.INIT, u32(3)))[0], T.VERSION);
  return { temporary, root, check, open, send, channel };
}

test('project SFTP (Windows and macOS) writes binary chunks, appends, truncates, and replaces a file', {
  skip: false, timeout: 30000,
}, async (t) => {
  const { root, check, open, send } = await fixture(t);
  await check(S.OK, T.MKDIR, str('subdir'), u32(0));
  await fs.writeFile(path.join(root, 'source.bin'), 'original');
  const file = await open('subdir/二进制.bin', 27);
  const data = Buffer.allocUnsafe(3 * 65536);
  data.fill(Buffer.from([0, 255, 33, 128]));
  for (let offset = 0; offset < data.length; offset += 65536) {
    await check(S.OK, T.WRITE, str(file), u64(offset), str(data.subarray(offset, offset + 65536)));
  }
  const reply = await send(T.READ, str(file), u64(65536), u32(65536));
  assert.equal(reply[0], T.DATA);
  assert.deepEqual(reply.subarray(9), data.subarray(65536, 2 * 65536));
  await check(S.OK, T.FSETSTAT, str(file), u32(1), u64(2 * 65536));
  await check(S.OK, T.EXTENDED, str('fsync@openssh.com'), str(file));
  await check(S.OK, T.CLOSE, str(file));
  const append = await open('subdir/二进制.bin', 6);
  await check(S.OK, T.WRITE, str(append), u64(0), str('tail'));
  await check(S.OK, T.CLOSE, str(append));
  const timestamp = 1_700_000_000;
  await check(S.OK, T.SETSTAT, str('subdir/二进制.bin'), u32(8), u32(timestamp), u32(timestamp));
  assert.equal(Math.floor((await fs.stat(path.join(root, 'subdir', '二进制.bin'))).mtimeMs / 1000), timestamp);
  await check(S.FAILURE, T.RENAME, str('subdir/二进制.bin'), str('source.bin'));
  assert.equal(await fs.readFile(path.join(root, 'source.bin'), 'utf8'), 'original');
  await check(S.OK, T.EXTENDED, str('posix-rename@openssh.com'), str('subdir/二进制.bin'), str('source.bin'));
  assert.deepEqual(await fs.readFile(path.join(root, 'source.bin')), Buffer.concat([data.subarray(0, 2 * 65536), Buffer.from('tail')]));
  await check(S.OK, T.RENAME, str('source.bin'), str('subdir/finish.bin'));
  await check(S.OK, T.REMOVE, str('subdir/finish.bin'));
  await check(S.OK, T.RMDIR, str('subdir'));
});

test('suspending a project closes old SFTP handles and an acknowledged recovery rotates the generation', {
  skip: false, timeout: 30000,
}, async (t) => {
  const { WindowsProjectLeases } = require('../orchestrator/windows-project-leases');
  const leases = new WindowsProjectLeases();
  let binding;
  const { root, open, check, channel } = await fixture(t, async (root, input, output) => {
    const identity = { device: 'test', provider: 'codex', threadId: 'thread', projectId: 'project', root, fullAccess: true };
    binding = { ...identity, ...await leases.acquire(identity) };
    return leases.serveSftp(binding, input, output);
  });
  const handle = await open('state.txt', 10);
  await check(S.OK, T.WRITE, str(handle), u64(0), str('before pause'));
  leases.suspend(binding);
  await channel.done;
  assert.equal(await leases.settle(binding, () => true), false);
  assert.equal(await leases.settle(binding, () => true, { acknowledgeFiles: true }), true);
  assert.throws(() => leases.serveSftp(binding, new PassThrough(), new PassThrough()), /native_chat_lease_expired/);
  assert.equal(await fs.readFile(path.join(root, 'state.txt'), 'utf8'), 'before pause');
});

test('Windows project SFTP rejects external changes, project escapes, and junction traversal', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async (t) => {
  const { temporary, root, check, open } = await fixture(t);
  const target = path.join(root, 'write.txt');
  await fs.writeFile(target, 'initial');
  const opened = await open('write.txt', 3);
  await fs.writeFile(target, 'local edits of another length');
  assert.match(await check(S.FAILURE, T.WRITE, str(opened), u64(0), str('replacement')), /project_file_changed: \/write.txt/);
  assert.equal(await fs.readFile(target, 'utf8'), 'local edits of another length');
  await check(S.OK, T.CLOSE, str(opened));
  await check(S.PERMISSION_DENIED, T.OPEN, str('../outside'), u32(1), u32(0));
  await check(S.PERMISSION_DENIED, T.OPEN, str('write.txt:stream'), u32(10), u32(0));
  await fs.symlink(temporary, path.join(root, 'junction'), 'junction');
  await check(S.PERMISSION_DENIED, T.OPEN, str('junction/outside'), u32(10), u32(0));
  await check(S.PERMISSION_DENIED, T.MKDIR, str('junction/created'), u32(0));
  await fs.link(target, path.join(root, 'hard-link'));
  await check(S.PERMISSION_DENIED, T.OPEN, str('hard-link'), u32(2), u32(0));
  await assert.rejects(fs.stat(path.join(temporary, 'outside')), { code: 'ENOENT' });
});

test('on macOS the project SFTP refuses symbolic links on the way, escapes and the project root itself', {
  skip: process.platform === 'win32', timeout: 30000,
}, async (t) => {
  const { temporary, root, check, open } = await fixture(t);
  await fs.writeFile(path.join(temporary, 'outside'), 'secret');
  await fs.mkdir(path.join(temporary, 'elsewhere'));
  await fs.symlink(path.join(temporary, 'elsewhere'), path.join(root, 'link-dir'));
  await fs.symlink(path.join(temporary, 'outside'), path.join(root, 'link-file'));
  await check(S.PERMISSION_DENIED, T.OPEN, str('link-dir/new.txt'), u32(10), u32(0));   // a linked folder on the way
  await check(S.PERMISSION_DENIED, T.MKDIR, str('link-dir/created'), u32(0));
  await check(S.PERMISSION_DENIED, T.OPEN, str('link-file'), u32(1), u32(0));           // a linked file
  await check(S.PERMISSION_DENIED, T.OPEN, str('../outside'), u32(1), u32(0));          // leaving the project
  assert.deepEqual(await fs.readdir(path.join(temporary, 'elsewhere')), []);
  assert.equal(await fs.readFile(path.join(temporary, 'outside'), 'utf8'), 'secret');
  const file = await open('ok.txt', 26);                                                 // an ordinary file still works
  await check(S.OK, T.WRITE, str(file), u64(0), str('hello'));
  await check(S.OK, T.CLOSE, str(file));
  assert.equal(await fs.readFile(path.join(root, 'ok.txt'), 'utf8'), 'hello');
});
