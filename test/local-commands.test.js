const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const localCommands = require('../local-commands');

const payload = (value) => JSON.parse(value.contentItems[0].text);

test('a direct chat runs only the commands authorized for its project, in the project folder', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-cmd-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const configFile = path.join(project, 'bridge.json');
  await fs.writeFile(configFile, JSON.stringify({ workspaces: { project: { root: project,
    commands: { hello: [process.execPath, '-e', 'console.log(process.cwd())'], wipe: [process.execPath, '-e', 'process.exit(9)'] },
    agentCommands: ['hello'] } } }));
  const list = payload(await localCommands.call('agentdesk_command_list', {}, { configFile, localRoot: project }));
  // Built-in Windows diagnostics (builtin: true) are listed too on Windows; only the project's own count here.
  const own = (commands) => commands.filter((command) => !command.builtin);
  assert.deepEqual(own(list.commands).map((command) => command.name), ['hello']);   // wipe is defined but not for agents
  const run = await localCommands.call('agentdesk_command_run', { name: 'hello' }, { configFile, localRoot: project });
  assert.equal(run.success, true);
  assert.equal(payload(run).exitCode, 0);
  assert.equal(await fs.realpath(payload(run).stdout.trim()), await fs.realpath(project));
  const refused = await localCommands.call('agentdesk_command_run', { name: 'wipe' }, { configFile, localRoot: project });
  assert.equal(refused.success, false);
  assert.equal(payload(refused).error, 'command_not_enabled_for_agents');
  const elsewhere = payload(await localCommands.call('agentdesk_command_list', {}, { configFile, localRoot: os.tmpdir() }));
  assert.deepEqual(own(elsewhere.commands), []);   // another folder gets none of the project's commands
  assert.ok(localCommands.isRunTool('agentdesk_command_run') && !localCommands.isRunTool('agentdesk_command_list'));
});
