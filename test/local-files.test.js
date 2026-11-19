const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const files = require('../local-files');

// local-files.js is the macOS POSIX file tool; Windows uses windows-files.js.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-files-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function output(result) {
  return JSON.parse(result.contentItems[0].text);
}

async function call(tool, args, trash) {
  return files.call(tool, args, trash);
}

test('write, read, list and mkdir under an allowed temporary root', async (t) => {
  const root = temporary(t);
  const file = path.join(root, 'note.txt');

  const created = output(await call('agentdesk_file_write', { path: file, content: 'hello' }));
  assert.equal(created.bytes, 5);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');

  const read = output(await call('agentdesk_file_read', { path: file }));
  assert.equal(read.content, 'hello');
  assert.equal(read.nextOffset, null);

  const folder = path.join(root, 'nested');
  output(await call('agentdesk_file_mkdir', { path: folder }));
  assert.equal(fs.statSync(folder).isDirectory(), true);
  output(await call('agentdesk_file_write', { path: path.join(folder, 'a.txt'), content: 'a' }));
  const listed = output(await call('agentdesk_file_list', { path: folder }));
  assert.deepEqual(listed.entries.map((entry) => entry.name), ['a.txt']);
});

test('overwrite is opt-in and writes atomically', async (t) => {
  const root = temporary(t);
  const file = path.join(root, 'note.txt');
  output(await call('agentdesk_file_write', { path: file, content: 'one' }));
  const refused = await call('agentdesk_file_write', { path: file, content: 'two' });
  assert.equal(refused.success, false);
  assert.match(output(refused).error, /overwrite=true/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one');

  const replaced = await call('agentdesk_file_write', { path: file, content: 'two', overwrite: true });
  assert.equal(replaced.success, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.agentdesk-')), []);
});

test('copy and move reject an existing destination without overwrite', async (t) => {
  const root = temporary(t);
  const source = path.join(root, 'source.txt');
  const copy = path.join(root, 'copy.txt');
  const moved = path.join(root, 'moved.txt');
  output(await call('agentdesk_file_write', { path: source, content: 's' }));
  output(await call('agentdesk_file_copy', { path: source, destination: copy }));
  assert.equal(fs.readFileSync(copy, 'utf8'), 's');
  const duplicate = await call('agentdesk_file_copy', { path: source, destination: copy });
  assert.equal(duplicate.success, false);

  output(await call('agentdesk_file_move', { path: copy, destination: moved }));
  assert.equal(fs.existsSync(copy), false);
  assert.equal(fs.readFileSync(moved, 'utf8'), 's');
  const moveAgain = await call('agentdesk_file_move', { path: moved, destination: moved });
  assert.equal(moveAgain.success, false);
});

test('trash uses the supplied Electron callback', async (t) => {
  const root = temporary(t);
  const file = path.join(root, 'trash.txt');
  output(await call('agentdesk_file_write', { path: file, content: 'x' }));
  const expected = fs.realpathSync.native(file);
  const seen = [];
  const result = output(await call('agentdesk_file_trash', { path: file }, async (target) => {
    seen.push(target);
    await fsp.rm(target);
  }));
  assert.equal(result.recycled, true);
  assert.deepEqual(seen, [expected]);
  assert.equal(fs.existsSync(file), false);
});

test('system and credential locations are refused for read and write', () => {
  assert.throws(() => files.allowedPath('/etc/hosts'), /outside|system/i);
  assert.throws(() => files.allowedPath('/System/Library/CoreServices'), /outside|system/i);
  assert.throws(() => files.allowedPath(path.join(os.homedir(), '.ssh', 'id_ed25519')), /Credential/i);
  assert.throws(() => files.allowedPath(path.join(os.homedir(), '.agentdesk', 'mac-remote.json'), true), /Credential/i);
  assert.throws(() => files.allowedPath(path.join(os.homedir(), 'Library', 'Preferences', 'x')), /Credential/i);
  assert.throws(() => files.allowedPath('/'), /root/i);
  assert.throws(() => files.allowedPath('relative/path'), /absolute/i);
});

test('.git is readable but never writable', async (t) => {
  const root = temporary(t);
  const git = path.join(root, '.git');
  fs.mkdirSync(git);
  fs.writeFileSync(path.join(git, 'config'), 'x');
  assert.equal((await call('agentdesk_file_read', { path: path.join(git, 'config') })).success, true);
  assert.equal((await call('agentdesk_file_write', { path: path.join(git, 'hooks'), content: 'x' })).success, false);
  assert.equal((await call('agentdesk_file_write', { path: path.join(git, 'config'), content: 'y', overwrite: true })).success, false);
  assert.equal((await call('agentdesk_file_move', { path: path.join(git, 'config'), destination: path.join(root, 'config') })).success, false);
});

test('symbolic links cannot escape the allowed roots or serve as write targets', async (t) => {
  const root = temporary(t);
  const link = path.join(root, 'link');
  fs.symlinkSync('/etc/hosts', link);
  // 目标在临时目录外，realpath 后必须被拒绝。
  const read = await call('agentdesk_file_read', { path: link });
  assert.equal(read.success, false);
  const write = await call('agentdesk_file_write', { path: link, content: 'x', overwrite: true });
  assert.equal(write.success, false);
  assert.match(output(write).error, /symbolic link/i);

  const inside = path.join(root, 'inside.txt');
  fs.writeFileSync(inside, 'ok');
  const insideLink = path.join(root, 'inside-link');
  fs.symlinkSync(inside, insideLink);
  const viaLink = await call('agentdesk_file_read', { path: insideLink });
  assert.equal(viaLink.success, true);
  assert.equal(output(viaLink).content, 'ok');
});

test('read and write enforce the 1 MiB per-call limit', async (t) => {
  const root = temporary(t);
  const big = path.join(root, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(files.LIMIT + 10, 0x61));
  const read = output(await call('agentdesk_file_read', { path: big }));
  assert.equal(Buffer.byteLength(read.content), files.READ_PAGE);
  assert.equal(read.nextOffset, files.READ_PAGE);
  const tooBig = await call('agentdesk_file_write', { path: path.join(root, 'too-big.bin'), content: 'x'.repeat(files.LIMIT + 1) });
  assert.equal(tooBig.success, false);
  assert.match(output(tooBig).error, /1 MiB/);
});

test('list paginates after 250 entries', async (t) => {
  const root = temporary(t);
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(root, `f${String(i).padStart(3, '0')}`), '');
  const first = output(await call('agentdesk_file_list', { path: root }));
  assert.equal(first.entries.length, 250);
  assert.equal(first.nextOffset, 250);
  const second = output(await call('agentdesk_file_list', { path: root, offset: first.nextOffset }));
  assert.equal(second.entries.length, 10);
  assert.equal(second.nextOffset, null);
});

test('invalid tool arguments are refused before touching the filesystem', async (t) => {
  const root = temporary(t);
  const file = path.join(root, 'x.txt');
  const missing = await call('agentdesk_file_write', { path: file });
  assert.equal(missing.success, false);
  assert.match(output(missing).error, /Missing/);
  const extra = await call('agentdesk_file_write', { path: file, content: 'x', surprise: true });
  assert.equal(extra.success, false);
  assert.match(output(extra).error, /Invalid argument/);
  const badOffset = await call('agentdesk_file_read', { path: file, offset: -1 });
  assert.equal(badOffset.success, false);
});