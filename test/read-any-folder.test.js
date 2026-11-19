const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { WindowsOperations } = require('../orchestrator/windows');

async function setup(t, settings = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-any-folder-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'), outside = path.join(dir, 'outside');
  await fs.mkdir(project); await fs.mkdir(outside);
  await fs.mkdir(path.join(outside, 'folder'));
  await fs.writeFile(path.join(outside, 'folder', 'needle.txt'), 'first line\nsecret value\nlast line\n');
  await fs.mkdir(path.join(outside, '.git'));
  await fs.writeFile(path.join(outside, '.git', 'config'), 'token');
  await fs.writeFile(path.join(outside, '.npmrc'), 'token=secret');
  const ops = new WindowsOperations({ config: { ...settings, workspaces: { test: { root: project, write: true } } } });
  const call = (kind, body) => ops.call({ kind, task_id: randomUUID(), body: { workspace: 'test', ...body } });
  return { dir, project, outside, ops, call };
}

test('the computer location is listed only when the bridge allows it', async (t) => {
  const off = await setup(t);
  const locations = (await off.call('file.read', { operation: 'locations' })).locations;
  assert.deepEqual(locations, [{ id: 'project', label: '项目' }]);
  await assert.rejects(off.call('file.read', {
    operation: 'list', root: 'computer', path: off.outside, anyFolder: true,
  }), /read_root_not_authorized/);

  const on = await setup(t, { readAnyFolder: true });
  assert.deepEqual((await on.call('file.read', { operation: 'locations' })).locations,
    [{ id: 'project', label: '项目' }, { id: 'computer', label: '本机（只读）' }]);
  // The orchestrator must assert the lead-only permission on every request.
  await assert.rejects(on.call('file.read', { operation: 'list', root: 'computer', path: on.outside }), /read_root_not_authorized/);
});

test('the lead can list, search, grep and read folders outside the project read-only', async (t) => {
  const { outside, call } = await setup(t, { readAnyFolder: true });
  const common = { root: 'computer', anyFolder: true };
  const listing = await call('file.read', { ...common, operation: 'list', path: outside });
  assert.deepEqual(listing.items.map(({ path: name, directory }) => ({ name: path.basename(name), directory })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: '.npmrc', directory: false },
    { name: 'folder', directory: true },
  ]);
  const search = await call('file.read', { ...common, operation: 'search', path: outside, query: 'needle' });
  assert.equal(search.items.length, 1);
  assert.equal(path.resolve(search.items[0].path), path.join(outside, 'folder', 'needle.txt'));
  assert.equal(search.items[0].directory, false);
  const grep = await call('file.read', { ...common, operation: 'grep', path: outside, query: 'secret' });
  assert.equal(grep.matches.length, 1);
  assert.equal(grep.matches[0].line, 2);
  assert.equal(grep.matches[0].text, 'secret value');
  const file = path.join(outside, 'folder', 'needle.txt');
  const stat = await call('file.read', { ...common, operation: 'stat', path: file });
  assert.equal(stat.type, 'file');
  const read = await call('file.read', { ...common, operation: 'read', path: file });
  assert.equal(Buffer.from(read.data, 'base64').toString('utf8'), 'first line\nsecret value\nlast line\n');
  // (a root user's home is /root, a system location; CI and people's computers have ordinary home folders)
  if (os.homedir() !== '/root') assert.equal((await call('file.read', { ...common, operation: 'stat', path: '~' })).type, 'directory');
  await assert.rejects(call('file.read', { ...common, operation: 'list', path: 'relative' }), /invalid_path/);
});

test('the computer location never grants writes or commands and blocks system, Git and credential paths', async (t) => {
  const { dir, outside, call } = await setup(t, { readAnyFolder: true });
  const common = { root: 'computer', anyFolder: true };
  await assert.rejects(call('file.write', { ...common, operation: 'write', path: path.join(outside, 'new.txt') }), /read_root_readonly/);
  await assert.rejects(call('command.execute', { ...common, operation: 'run', command: 'git-status' }), /read_root_readonly/);
  await assert.rejects(call('file.read', { ...common, operation: 'read', path: path.join(outside, '.git', 'config') }), /git_path_denied/);
  await assert.rejects(call('file.read', { ...common, operation: 'read', path: path.join(outside, '.npmrc') }), /credential_path_denied/);
  await assert.rejects(call('file.read', {
    ...common, operation: 'read', path: process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts',
  }), /path_not_allowed/);
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'system-link');
    await fs.symlink('/etc', link);
    await assert.rejects(call('file.read', { ...common, operation: 'list', path: link }), /path_not_allowed/);
  }
});