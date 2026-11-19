// Commands an agent may run on the person's computer from a direct chat: only those the person listed for the
// project in the Bridge configuration (workspaces.<id>.commands, enabled by workspaces.<id>.agentCommands),
// run as fixed program-and-argument arrays in the project folder, never through a shell. Each run asks the person
// for approval in the chat (agentdesk_command_run is a write-class tool), and read-only turns cannot run them.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { result } = require('./local-files');

const TIMEOUT = 300_000;
const OUTPUT = 8000;

const specs = [
  {
    type: 'function', name: 'agentdesk_command_list',
    description: 'List the commands the person has authorized agents to run on their computer for this project (name, program, arguments).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    type: 'function', name: 'agentdesk_command_run',
    description: 'Run one authorized command, by its name from agentdesk_command_list, in the project folder on the person’s computer, for example to run the tests. The person approves each run; output over 8000 characters keeps its first 2000 and last 6000; the time limit is 5 minutes.',
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

// Long output keeps its start (the command and the first error) and its end (the summary), like pi does.
const tail = (text) => (text.length > OUTPUT ? text.slice(0, 2000) + `\n…（中间省略 ${text.length - OUTPUT} 个字符）…\n` + text.slice(-(OUTPUT - 2000)) : text);

function call(tool, values, { configFile, localRoot }) {
  const commands = catalogue(configFile, localRoot);
  if (tool === 'agentdesk_command_list') {
    return Promise.resolve(result(true, { commands: commands.map(({ name, argv }) => ({ name, program: path.basename(argv[0]), args: argv.slice(1, 21) })),
      ...(commands.length ? {} : { note: 'No commands are authorized for this project. The person lists them in agentCommands of the Bridge configuration.' }) }));
  }
  const command = commands.find(({ name }) => name === values?.name);
  if (!command) return Promise.resolve(result(false, { error: 'command_not_enabled_for_agents' }));
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(command.argv[0], command.argv.slice(1), { cwd: command.cwd, timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, shell: false }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve(result(!error || code !== null, {
        name: command.name, exitCode: code, timedOut: Boolean(error?.killed), durationMs: Date.now() - started,
        stdout: tail(String(stdout || '')), stderr: tail(String(stderr || '')),
        ...(error && code === null && !error.killed ? { error: error.code || error.message } : {}),
      }));
    });
  });
}

module.exports = { specs, call, catalogue, isCommandTool: (name) => NAMES.has(name), isRunTool: (name) => name === 'agentdesk_command_run' };
