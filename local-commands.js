// Commands an agent may run on the person's computer from a direct chat: only those the person listed for the
// project in the Bridge configuration (workspaces.<id>.commands, enabled by workspaces.<id>.agentCommands),
// run as fixed program-and-argument arrays in the project folder without a shell. The chat's approval policy
// governs agentdesk_command_run, and read-only turns cannot run it.
const fs = require('node:fs');
const path = require('node:path');
const { result } = require('./local-files');
const { CommandRuns } = require('./orchestrator/command-runs');
const { randomUUID } = require('node:crypto');
const defaultRuns = new CommandRuns();

const specs = [
  {
    type: 'function', name: 'agentdesk_command_list',
    description: 'List the commands the person has authorized agents to run on their computer for this project (name, program, arguments).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    type: 'function', name: 'agentdesk_command_run',
    description: 'Run one authorized command, by its name from agentdesk_command_list, in the project folder on the person’s computer, for example to run the tests. The current chat policy controls approval. Returns the last 8000 characters of each output stream and the exit status. The time limit is 5 minutes.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'],
      properties: { name: { type: 'string', description: 'Command name from agentdesk_command_list' } } },
  },
];
const NAMES = new Set(specs.map((spec) => spec.name));

const same = (a, b) => {
  const norm = (value) => path.resolve(String(value || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// The project's authorized commands: the Bridge workspace whose root is this chat's project folder.
function catalogue(configFile, localRoot) {
  if (!configFile || !localRoot) return [];
  let settings;
  try { settings = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return []; }
  const workspace = Object.values(settings?.workspaces || {}).find((candidate) => candidate?.root && same(candidate.root, localRoot));
  if (!workspace || !Array.isArray(workspace.agentCommands)) return [];
  return workspace.agentCommands
    .filter((name) => typeof name === 'string' && Array.isArray(workspace.commands?.[name]) && workspace.commands[name].length &&
      workspace.commands[name].every((part) => typeof part === 'string'))
    .map((name) => ({ name, argv: workspace.commands[name], cwd: workspace.root }));
}

function call(tool, values, { configFile, localRoot, worktree, approved, runs = defaultRuns, scope = 'direct', key, turnId, itemId }) {
  const commands = catalogue(configFile, localRoot);
  if (tool === 'agentdesk_command_list') {
    return Promise.resolve(result(true, { commands: commands.map(({ name, argv }) => ({ name, program: path.basename(argv[0]), args: argv.slice(1, 21) })),
      ...(commands.length ? {} : { note: 'No commands are authorized for this project. The person lists them in agentCommands of the Bridge configuration.' }) }));
  }
  const command = commands.find(({ name }) => name === values?.name);
  if (!command) return Promise.resolve(result(false, { error: 'command_not_enabled_for_agents' }));
  const cwd = worktree || command.cwd;
  if (approved && (cwd !== approved.cwd || JSON.stringify(command.argv) !== JSON.stringify(approved.argv))) {
    return Promise.resolve(result(false, { error: 'command_changed_after_approval' }));
  }
  return runs.start({ scope, key: key || randomUUID(), turnId, itemId, name: command.name, argv: command.argv,
    cwd, limit: 8000 }).then((run) => result(run.code !== null, {
    id: run.id, name: run.name, exitCode: run.code, state: run.state, timedOut: run.state === 'timed_out',
    durationMs: run.finishedAt - run.startedAt, stdout: run.stdout, stderr: run.stderr,
    ...(run.error && { error: run.error }), ...(run.truncated && { truncated: true }),
  }));
}

module.exports = { specs, call, catalogue, isCommandTool: (name) => NAMES.has(name), isRunTool: (name) => name === 'agentdesk_command_run' };
