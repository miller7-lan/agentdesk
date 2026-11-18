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
  assert.deepEqual((await call('file.read', { operation: 'locations' })).locations,
    [{ id: 'project', label: '项目' }, { id: 'desktop', label: '桌面' }]);
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
