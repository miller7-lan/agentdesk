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

// Read-only Windows diagnostics every project gets without configuring anything (a workspace can turn them off
// with "builtinCommands": false). Fixed scripts: they only look (system, processes, network, power, scheduled
// tasks, services, event log), so an agent can check the computer without a shell. The person's own commands
// with the same name win.
function builtinWindowsCommands(env = process.env) {
  const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const ps = (script) => [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & { ' + script + ' } | Out-String -Width 220'];
  return {
    'sys-overview': ps("Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime," +
      "@{n='MemoryFreeGB';e={[math]::Round($_.FreePhysicalMemory/1MB,1)}},@{n='MemoryTotalGB';e={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}} | Format-List; " +
      "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,LoadPercentage | Format-List; " +
      "Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize"),
    'sys-processes': ps("Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 30 Id,ProcessName," +
      "@{n='MemMB';e={[int]($_.WorkingSet64/1MB)}},@{n='CPUs';e={[int]$_.CPU}},StartTime | Format-Table -AutoSize"),
    'net-config': ps('ipconfig /all'),
    'net-listening': ps("Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Select-Object LocalAddress,LocalPort,OwningProcess," +
      "@{n='Process';e={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}} | Format-Table -AutoSize"),
    'net-check': ps("Test-NetConnection github.com -Port 443 -WarningAction SilentlyContinue | Select-Object ComputerName,RemoteAddress,TcpTestSucceeded | Format-List; " +
      "Resolve-DnsName github.com -ErrorAction SilentlyContinue | Select-Object -First 3 Name,IPAddress | Format-Table -AutoSize"),
    'power-settings': ps('powercfg /getactivescheme; powercfg /query SCHEME_CURRENT SUB_SLEEP; powercfg /a'),
    'tasks-list': ps("Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; " +
      "[pscustomobject]@{Name=$_.TaskName;State=$_.State;LastRun=$i.LastRunTime;LastResult=$i.LastTaskResult;NextRun=$i.NextRunTime;Logon=$_.Principal.LogonType} } | Format-Table -AutoSize"),
    'services-problems': ps("Get-CimInstance Win32_Service -Filter \"StartMode='Auto' AND State<>'Running'\" | Select-Object Name,DisplayName,State,ExitCode | Format-Table -AutoSize"),
    'events-errors': ps("Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=(Get-Date).AddHours(-24)} -MaxEvents 40 -ErrorAction SilentlyContinue | " +
      "Select-Object TimeCreated,LogName,Id,ProviderName,@{n='Message';e={($_.Message -split \"`n\")[0]}} | Format-Table -AutoSize -Wrap"),
    'events-power': ps("Get-WinEvent -FilterHashtable @{LogName='System'; Id=1,41,42,107,109,1074,6005,6006,6008; StartTime=(Get-Date).AddHours(-48)} -MaxEvents 40 -ErrorAction SilentlyContinue | " +
      "Select-Object TimeCreated,Id,ProviderName,@{n='Message';e={($_.Message -split \"`n\")[0]}} | Format-Table -AutoSize -Wrap"),
    'startup-apps': ps('Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location | Format-Table -AutoSize -Wrap'),
  };
}

// The project's authorized commands: the Bridge workspace whose root is this chat's project folder, plus the
// built-in read-only diagnostics on Windows.
function catalogue(configFile, localRoot, { platform = process.platform, env = process.env } = {}) {
  if (!localRoot) return [];
  let settings;
  try { settings = configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null; } catch { settings = null; }
  const workspace = Object.values(settings?.workspaces || {}).find((candidate) => candidate?.root && same(candidate.root, localRoot));
  const own = !workspace || !Array.isArray(workspace.agentCommands) ? [] : workspace.agentCommands
    .filter((name) => typeof name === 'string' && Array.isArray(workspace.commands?.[name]) && workspace.commands[name].length &&
      workspace.commands[name].every((part) => typeof part === 'string'))
    .map((name) => ({ name, argv: workspace.commands[name], cwd: workspace.root }));
  if (platform !== 'win32' || workspace?.builtinCommands === false) return own;
  const taken = new Set(own.map(({ name }) => name));
  const builtin = Object.entries(builtinWindowsCommands(env)).filter(([name]) => !taken.has(name))
    .map(([name, argv]) => ({ name, argv, cwd: workspace?.root || localRoot, builtin: true }));
  return [...own, ...builtin];
}

function call(tool, values, { configFile, localRoot, worktree, approved, runs = defaultRuns, scope = 'direct', key, turnId, itemId }) {
  const commands = catalogue(configFile, localRoot);
  if (tool === 'agentdesk_command_list') {
    return Promise.resolve(result(true, { commands: commands.map(({ name, argv, builtin }) => ({ name, program: path.basename(argv[0]),
      args: argv.slice(1, 21), ...(builtin && { builtin: true, readOnly: true }) })),
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

module.exports = { specs, call, catalogue, builtinWindowsCommands, isCommandTool: (name) => NAMES.has(name), isRunTool: (name) => name === 'agentdesk_command_run' };
