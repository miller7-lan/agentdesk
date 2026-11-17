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
