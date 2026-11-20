const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WindowsOperations } = require('../orchestrator/windows');

function project(t, agentCommands) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'pay.js'), 'const timeout = 30;\nretryWebhook(timeout);\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'RETRYWEBHOOK_LIMIT=5\n');                 // not in Git, still searchable
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'retryWebhook();\n');   // dependencies are skipped
  fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 114, 101, 116, 114, 121]));
  const operations = new WindowsOperations({
    config: { workspaces: { p: { root, commands: {
      probe: [process.execPath, '-e', "console.log('node ' + process.version)"],
      deploy: [process.execPath, '-e', "console.log('deployed')"],
    }, ...(agentCommands && { agentCommands }) } } },
    store: { put() {}, get() {} },
  });
  const call = (kind, body) => operations.call({ task_id: 't', message_id: 'm' + Math.random(), kind, body: { workspace: 'p', ...body } });
  return { call };
}

test('content search finds text in project files, including files outside Git, and skips dependencies and binaries', async (t) => {
  const { call } = project(t);
  const found = await call('file.read', { operation: 'grep', path: '', query: 'RETRYWEBHOOK' });
  assert.deepEqual(found.matches.map(({ path, line }) => `${path}:${line}`).sort(), ['.env.local:1', 'src/pay.js:2']);
  assert.equal(found.matches.find((match) => match.path === 'src/pay.js').text, 'retryWebhook(timeout);');
  assert.equal(found.truncated, false);
  const exact = await call('file.read', { operation: 'grep', path: 'src', query: 'RETRYWEBHOOK', caseSensitive: true });
  assert.deepEqual(exact.matches, []);
  await assert.rejects(call('file.read', { operation: 'grep', path: '../', query: 'x' }), /invalid_path/);
  await assert.rejects(call('file.read', { operation: 'grep', path: '', query: '' }), /invalid_query/);
});

test('agents see and run only the commands listed in agentCommands; none by default', async (t) => {
  const closed = project(t);
  assert.deepEqual(await closed.call('command.execute', { operation: 'list_agent_commands' }), { commands: [] });
  await assert.rejects(closed.call('command.execute', { operation: 'run', command: 'probe', permission: 'agent', timeout_ms: 10000 }),
    /command_not_enabled_for_agents/);
  const open = project(t, ['probe', 'missing']);
  const listed = await open.call('command.execute', { operation: 'list_agent_commands' });
  assert.deepEqual(listed.commands.map((command) => command.name), ['probe']);
  const ran = await open.call('command.execute', { operation: 'run', command: 'probe', permission: 'agent', timeout_ms: 10000 });
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /^node v\d+/);
  await assert.rejects(open.call('command.execute', { operation: 'run', command: 'deploy', permission: 'agent', timeout_ms: 10000 }),
    /command_not_enabled_for_agents/);
  // The task's own test command keeps working through the existing development permission.
  const own = await open.call('command.execute', { operation: 'run', command: 'deploy', permission: 'development', timeout_ms: 10000 });
  assert.match(own.stdout, /deployed/);
});

test('access the person approved on this computer opens exactly that folder or command, for that task only', async (t) => {
  const Store = require('../orchestrator/store');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-grant-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const data = path.join(base, 'data');
  const other = path.join(base, 'other');
  for (const folder of [root, data, other]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(data, 'report.csv'), 'a,b\n');
  fs.writeFileSync(path.join(other, 'secret.txt'), 'no\n');
  const store = new Store(':memory:');
  t.after(() => store.close());
  // A computer that allows nothing beyond its project: no any-folder switches, no agent commands.
  const operations = new WindowsOperations({ config: { workspaces: { p: { root, commands: {} } } }, store });
  const call = (task, kind, body) => operations.call({ task_id: task, message_id: 'm' + Math.random(), kind, body: { workspace: 'p', ...body } });
  const read = (task, file) => call(task, 'file.read', { operation: 'read', root: 'computer', anyFolder: true, path: file });
  await assert.rejects(read('t1', path.join(data, 'report.csv')), /read_root_not_authorized/);
  await operations.addGrant({ kind: 'write', taskId: 't1', group: 'g1', path: data });
  await operations.addGrant({ kind: 'command', taskId: 't1', group: 'g1', argv: [process.execPath, '-e', "console.log('granted ok')"] });
  assert.equal(Buffer.from((await read('t1', path.join(data, 'report.csv'))).data, 'base64').toString(), 'a,b\n');
  await assert.rejects(read('t1', path.join(other, 'secret.txt')), /read_root_not_authorized|path_not_allowed/);   // only that folder
  await assert.rejects(read('t2', path.join(data, 'report.csv')), /read_root_not_authorized/);                     // only that task
  const written = await call('t1', 'file.write', { operation: 'write', root: 'computer', anyFolder: true, path: path.join(data, 'out.txt'), content: 'done' });
  assert.equal(fs.readFileSync(path.join(data, 'out.txt'), 'utf8'), 'done');
  assert.ok(written.version);
  await assert.rejects(call('t1', 'file.write', { operation: 'write', root: 'computer', anyFolder: true, path: path.join(other, 'x.txt'), content: 'x' }), /path_not_allowed/);
  const listed = await call('t1', 'command.execute', { operation: 'list_agent_commands' });
  const name = listed.commands.find((command) => command.temporary).name;
  const ran = await call('t1', 'command.execute', { operation: 'run', command: name, permission: 'agent', timeout_ms: 10000 });
  assert.match(ran.stdout, /granted ok/);
  await assert.rejects(call('t2', 'command.execute', { operation: 'run', command: name, permission: 'agent', timeout_ms: 10000 }), /command_not_enabled_for_agents/);
  // The task ends: VPS2 removes its grants.
  await call('t1', 'command.execute', { operation: 'grants_revoke' });
  await assert.rejects(read('t1', path.join(data, 'report.csv')), /read_root_not_authorized/);
  await assert.rejects(operations.addGrant({ kind: 'read', taskId: 't1', path: path.join(os.homedir(), '.ssh') }), /credential_path_denied|ENOENT/);
});
