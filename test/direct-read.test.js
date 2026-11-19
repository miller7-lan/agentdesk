const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Store = require('../orchestrator/store');
const { git } = require('../orchestrator/git');
const { Scheduler } = require('../orchestrator/scheduler');
const { WindowsOperations } = require('../orchestrator/windows');
const { runAdapter } = require('../orchestrator/adapters');

test('a headless tool denial cannot be reported as a successful reply', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-tool-denial-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'denied.js');
  await fs.writeFile(fixture, `console.error('permission required: agentdesk_windows__windows_list_locations was not run, as a headless run cannot ask for approval'); console.log('我先查看本机目录。');`);
  await assert.rejects(runAdapter({ name: 'fixture',
    config: { bin: process.execPath, env: process.env, template: { args: [fixture], prompt: 'arg', output: 'plain' } },
    cwd: dir, prompt: '看看桌面', readonly: true, timeout: 5000, signal: new AbortController().signal,
    log: path.join(dir, 'result.log'), onSession() {},
  }), /cli_tool_permission_required/);
});

test('named local read locations stay inside their roots and never grant writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-read-roots-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'), desktop = path.join(dir, 'desktop');
  await fs.mkdir(project); await fs.mkdir(desktop);
  await fs.writeFile(path.join(desktop, 'note.txt'), 'private desktop note');
  const ops = new WindowsOperations({ config: { workspaces: { test: { root: project, readRoots: { desktop }, write: true } } } });
  const call = (kind, body) => ops.call({ kind, task_id: randomUUID(), body: { workspace: 'test', ...body } });
  assert.deepEqual((await call('file.read', { operation: 'locations' })).locations.map(({ id }) => id), ['project', 'home', 'desktop']);
  const listing = await call('file.read', { operation: 'list', root: 'desktop', path: '' });
  assert.match(JSON.stringify(listing), /note\.txt/);
  await assert.rejects(call('file.read', { operation: 'list', root: 'other', path: '' }), /read_root_not_authorized/);
  await assert.rejects(call('file.read', { operation: 'read', root: 'desktop', path: '../outside' }), /invalid_path/);
  await assert.rejects(call('file.write', { root: 'desktop', path: 'note.txt' }), /read_root_readonly/);
  assert.equal(await fs.readFile(path.join(desktop, 'note.txt'), 'utf8'), 'private desktop note');
});

test('direct chat reads live files without a clean local Git baseline and cannot run commands', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-read-chat-'));
  const store = new Store(':memory:');
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const local = path.join(dir, 'local'), mirror = path.join(dir, 'mirror.git');
  await fs.mkdir(local);
  const signal = new AbortController().signal;
  await git(local, ['init'], signal);
  await fs.writeFile(path.join(local, 'note.txt'), 'base\n');
  await git(local, ['add', '.'], signal);
  await git(local, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'], signal);
  await git(dir, ['clone', '--bare', local, mirror], signal);
  await fs.writeFile(path.join(local, 'note.txt'), 'uncommitted user content\n');
  const mcp = { socket: 'fixture.sock', capabilities: new Map() };
  const config = { stateDir: path.join(dir, 'state'), quota: false, mcp,
    writeProviders: ['claude'],
    adapters: { codex: { bin: 'fixture' }, claude: { bin: 'fixture' }, grok: { bin: 'fixture' },
      antigravity: { bin: 'fixture', template: {} } }, workspaces: { project: { repository: mirror } } };
  let calls = 0;
  const scheduler = new Scheduler({ config, store,
    files: { call: async () => { throw Error('Chat must not inspect local Git or apply a patch'); } },
    adapter: async options => {
      calls++;
      assert.equal(options.readonly, true);
      assert.equal(options.mcp.socket, 'fixture.sock');
      const scope = mcp.capabilities.get(options.mcp.capability);
      assert.equal(scope.workspace, 'project');
      assert.equal(scope.runCommands, false);
      assert.match(options.prompt, /windows_list_locations/);
      return { output: 'Read-only reply' };
    },
  });
  scheduler.stopped = true;
  scheduler.router.setQuota([{ provider: 'codex', buckets: [{ weekly: { usedPercent: 86 } }] },
    { provider: 'claude', buckets: [{ weekly: { usedPercent: 63 } }] }]);
  for (const provider of Object.keys(config.adapters)) {
    const task = scheduler.submit(randomUUID(), { workspace: 'project', provider, mode: 'chat', tags: ['direct'], prompt: '看看桌面有什么文件' }, true);
    await scheduler.run(task, signal);
    assert.equal(task.state, 'completed', provider);
    assert.equal(task.groupPlan, undefined);
  }
  assert.equal(calls, 4);
  assert.equal(mcp.capabilities.size, 0);
  assert.equal(await fs.readFile(path.join(local, 'note.txt'), 'utf8'), 'uncommitted user content\n');
});

test('the whole user folder can be read and changed, but not credentials, app data or the project itself', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-home-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), project = path.join(home, 'code', 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(path.join(home, 'Desktop', 'proxy'), { recursive: true });
  await fs.mkdir(path.join(home, '.ssh'));
  await fs.writeFile(path.join(home, '.ssh', 'id_ed25519'), 'secret');
  await fs.writeFile(path.join(home, 'Desktop', 'proxy', 'config.yaml'), 'port: 1\n');
  const store = new Store(':memory:');
  t.after(() => store.close());
  const ops = new WindowsOperations({ store, config: { stateDir: path.join(dir, 'state'), home, workspaces: { test: { root: project, write: true } } } });
  const taskId = randomUUID();
  const call = (kind, body) => ops.call({ kind, task_id: taskId, body: { workspace: 'test', ...body } });
  assert.match(JSON.stringify(await call('file.read', { operation: 'list', root: 'home', path: 'Desktop/proxy' })), /config\.yaml/);
  await assert.rejects(call('file.read', { operation: 'read', root: 'home', path: '.ssh/id_ed25519' }), /home_path_denied/);
  await assert.rejects(call('file.read', { operation: 'list', root: 'home', path: 'Library' }), /home_path_denied/);

  // write through a stream, as the orchestrator does: a new file, then an overwrite with its version
  const send = async (text) => {
    const bytes = Buffer.from(text); const id = randomUUID();
    const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    await ops.call({ kind: 'stream.open', task_id: taskId, body: { stream_id: id, size: bytes.length } });
    await ops.call({ kind: 'stream.chunk', task_id: taskId, body: { stream_id: id, offset: 0, data: bytes.toString('base64'), sha256: sha } });
    await ops.call({ kind: 'stream.end', task_id: taskId, body: { stream_id: id, size: bytes.length, sha256: sha } });
    return id;
  };
  await call('file.write', { root: 'home', operation: 'write', path: 'Desktop/proxy/README.md', stream_id: await send('hello'), version: null });
  assert.equal(await fs.readFile(path.join(home, 'Desktop', 'proxy', 'README.md'), 'utf8'), 'hello');
  const { version } = await call('file.read', { operation: 'stat', root: 'home', path: 'Desktop/proxy/config.yaml' });
  await call('file.write', { root: 'home', operation: 'write', path: 'Desktop/proxy/config.yaml', stream_id: await send('port: 2\n'), version });
  assert.equal(await fs.readFile(path.join(home, 'Desktop', 'proxy', 'config.yaml'), 'utf8'), 'port: 2\n');
  await call('file.write', { root: 'home', operation: 'mkdir', path: 'Desktop/proxy/out', version: null });
  assert.ok((await fs.stat(path.join(home, 'Desktop', 'proxy', 'out'))).isDirectory());

  await assert.rejects(call('file.write', { root: 'home', operation: 'mkdir', path: '.ssh/keys', version: null }), /home_path_denied/);
  await assert.rejects(call('file.write', { root: 'home', operation: 'mkdir', path: 'code/project/new', version: null }), /home_write_in_project/);
  const off = new WindowsOperations({ config: { home, workspaces: { test: { root: project, anyFolder: false } } } });
  await assert.rejects(off.call({ kind: 'file.read', task_id: taskId, body: { workspace: 'test', operation: 'list', root: 'home', path: '' } }), /read_root_not_authorized/);
});
