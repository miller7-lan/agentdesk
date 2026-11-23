const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { HIDDEN } = require('./sftp-readonly');
const { setTimeout: delay } = require('node:timers/promises');
const { CommandRuns } = require('./command-runs');

const localShellSpec = {
  type: 'function', name: 'local_shell',
  description: 'Run Windows development commands in the active project. Use PowerShell by default or specify cmd. A long command returns runId. Use status with the saved cursors for new logs, or stop to terminate a run. Check a known run before retrying after a disconnect.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['run', 'status', 'stop', 'list'] },
      shell: { type: 'string', enum: ['powershell', 'cmd'] },
      command: { type: 'string' }, cwd: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
      runId: { type: 'string' }, background: { type: 'boolean' },
      stdoutCursor: { type: 'integer', minimum: 0 }, stderrCursor: { type: 'integer', minimum: 0 },
    },
  },
};
// macOS: the person's own login shell environment (zsh by default, or bash), in the project folder.
const macLocalShellSpec = {
  type: 'function', name: 'local_shell',
  description: 'Run commands on the person\u2019s Mac in the active project, like a terminal there: git, npm, python, make, xcodebuild and so on. Uses zsh by default or specify bash. A long command returns runId. Use status with the saved cursors for new logs, or stop to terminate a run. Check a known run before retrying after a disconnect. Commands have the person\u2019s own access (SSH keys and the keychain included, so git push works); only AgentDesk\u2019s own folders are closed.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['run', 'status', 'stop', 'list'] },
      shell: { type: 'string', enum: ['zsh', 'bash'] },
      command: { type: 'string' }, cwd: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
      runId: { type: 'string' }, background: { type: 'boolean' },
      stdoutCursor: { type: 'integer', minimum: 0 }, stderrCursor: { type: 'integer', minimum: 0 },
    },
  },
};
const shellSpecFor = (platform = process.platform) => platform === 'win32' ? localShellSpec : macLocalShellSpec;


const boundedId = (value) => typeof value === 'string' && value.length <= 256 && value.length > 0 && !/[\x00-\x1f]/.test(value);

function environment(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 48) {
    throw new Error('invalid_local_shell_env');
  }
  const env = Object.create(null);
  for (const [key, content] of Object.entries(value)) {
    if (!/^[a-z_][a-z0-9_]{0,127}$/i.test(key) || (content !== null &&
      (typeof content !== 'string' || content.length > 8192 || content.includes('\0')))) throw new Error('invalid_local_shell_env');
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
    if (Object.hasOwn(env, normalized)) throw new Error('duplicate_local_shell_env');
    env[normalized] = content;
  }
  return env;
}

// macOS: commands run as the person with everything open — SSH keys, the keychain, ~/.npmrc, cloud logins — so
// git push, npm and the like work and the task gets done. Only AgentDesk's own secrets stay closed (sandbox-exec):
// ~/.agentdesk (the Bridge's SSH key to VPS2), the app's data folder (the native-chat worker key) and any extra
// folder the caller names. No task needs them, and with them a model could act as this computer towards VPS2.
// `strict: true` also closes the credential folders the read-only mount hides (sftp-readonly HIDDEN) and the keychain.
function macSandboxProfile({ home = os.homedir(), extra = [], strict = false } = {}) {
  const quote = (value) => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const own = [path.posix.join(home, '.agentdesk'), path.posix.join(home, 'Library', 'Application Support', 'AgentDesk'), ...extra];
  const folders = strict ? [...HIDDEN.map((entry) => path.posix.join(home, entry)), ...own] : own;
  return ['(version 1)', '(allow default)',
    '(deny file-read* file-write* ' + folders.map((folder) => '(subpath ' + quote(folder) + ')').join(' ') + ')',
    // the keychain is reached through this service, not through files
    ...(strict ? ['(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))'] : [])].join('\n');
}

function posixInvocation(shell = 'zsh', script, { profile } = {}) {
  if (!['zsh', 'bash'].includes(shell)) throw new Error('invalid_local_shell');
  const program = shell === 'bash' ? '/bin/bash' : '/bin/zsh';
  // A login shell: the person's PATH (Homebrew, nvm, pyenv) as in their own terminal.
  const command = [program, '-l', '-c', script];
  if (process.platform === 'darwin') return { argv: ['/usr/bin/sandbox-exec', '-p', profile || macSandboxProfile(), ...command] };
  return { argv: command };   // Linux: tests only
}

function invocation(shell, script, options) {
  if (process.platform !== 'win32') return posixInvocation(shell, script, options);
  const system = path.join(process.env.SystemRoot, 'System32');
  if (shell === 'powershell') {
    const command = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' + script;
    return { argv: [path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo',
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] };
  }
  if (shell !== 'cmd') throw new Error('invalid_local_shell');
  return { argv: [path.join(system, 'cmd.exe'), '/d', '/s', '/c', '"chcp 65001 > nul & ' + script + '"'],
    windowsVerbatimArguments: true };
}

function result(snapshot, args = {}) {
  if (!snapshot) return { state: 'unknown', error: 'command_status_unknown' };
  const { id, state, code, sequence, startedAt, finishedAt, error, cursor, stdout, stderr } = snapshot;
  const output = { runId: id, state, exitCode: code ?? null, sequence, startedAt, finishedAt, ...(error && { error }) };
  for (const [key, text] of [['stdout', stdout], ['stderr', stderr]]) {
    const bytes = Buffer.from(text);
    const end = cursor?.[key] ?? bytes.length;
    const first = end - bytes.length;
    const offset = args[key + 'Cursor'] ?? 0;
    const position = Math.max(0, offset - first);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > end ||
        (position < bytes.length && (bytes[position] & 0xc0) === 0x80)) throw new Error('invalid_local_shell_cursor');
    output[key] = bytes.subarray(position).toString('utf8');
    output[key + 'Cursor'] = end;
    if (offset < first) output[key + 'Truncated'] = true;
  }
  return output;
}

function createWindowsLocalShell({ leases, journal, notify, syncMs = 15_000, stateDir }) {
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('native_chat_platform_unsupported');
  const profile = process.platform === 'darwin' ? macSandboxProfile({ extra: stateDir ? [stateDir] : [] }) : undefined;
  const runs = new CommandRuns((scope, snapshot) => notify?.(scope, result(snapshot)), journal);
  const leaseRuns = (lease) => runs.list(lease.scope);
  return {
    async call(binding, args, { requestId } = {}) {
      if (!args || !['run', 'status', 'stop', 'list'].includes(args.action)) throw new Error('invalid_local_shell_action');
      const lease = leases.get(binding, { writable: true, allowSuspended: args.action !== 'run' });
      if (args.action === 'list') return { runs: leaseRuns(lease).map(snapshot => result(snapshot)) };
      if (args.action !== 'run') {
        if (!boundedId(args.runId)) throw new Error('invalid_local_shell_run');
        const snapshot = args.action === 'stop' ? runs.cancel(lease.scope, args.runId) : runs.status(lease.scope, args.runId);
        return result(snapshot, args);
      }
      const shell = args.shell ?? (process.platform === 'win32' ? 'powershell' : 'zsh');
      if (!boundedId(requestId) || typeof args.command !== 'string' || !args.command.trim() ||
        args.command.includes('\0') || args.command.length > (shell === 'cmd' ? 7500 : 10_000)) {
        throw new Error('invalid_local_shell_command');
      }
      if (args.cwd !== undefined && (typeof args.cwd !== 'string' || args.cwd.length > 1000 || args.cwd.includes('\0'))) {
        throw new Error('invalid_local_shell_directory');
      }
      const cwd = path.resolve(lease.directory, args.cwd || '.');
      const env = environment(args.env);
      // PowerShell 7 can put its incompatible modules first when launching Windows PowerShell 5.
      if (shell === 'powershell' && !Object.hasOwn(env, 'PSMODULEPATH')) {
        const systemModules = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
        env.PSMODULEPATH = [systemModules, process.env.PSModulePath].filter(Boolean).join(path.delimiter);
      }
      const launch = invocation(shell, args.command, { profile });
      const fingerprint = createHash('sha256').update(JSON.stringify([cwd, launch, Object.entries(env).sort()])).digest('hex');
      const key = JSON.stringify([lease.scope, requestId]);
      const run = runs.start({ scope: lease.scope, key, name: 'local_shell', cwd, argv: launch.argv, timeout: null,
        limit: 16_000, native: { env, fingerprint, windowsVerbatimArguments: launch.windowsVerbatimArguments } });
      if (args.background === true) return result(runs.byKey(lease.scope, key));
      const timer = new AbortController();
      try {
        return await Promise.race([run.then(snapshot => result(snapshot)), delay(syncMs, undefined, { signal: timer.signal })
          .then(() => result(runs.byKey(lease.scope, key)))]);
      } finally { timer.abort(); }
    },
    // For the update gate (idleStatus): commands still running anywhere in this Worker, and finished ones whose
    // outcome is unknown and not yet acknowledged.
    activity() {
      let running = 0;
      let unknown = 0;
      for (const run of runs.listAllScopes()) {
        if (!run.finishedAt) running++;
        else if (run.state === 'unknown') unknown++;
      }
      return { running, unknown };
    },
    canResume(lease, { acknowledgeUnknown = false } = {}) {
      return runs.listAll(lease.scope).every((run) => run.finishedAt && (acknowledgeUnknown || run.state !== 'unknown'));
    },
  };
}

const createLocalShell = createWindowsLocalShell;

module.exports = { localShellSpec, macLocalShellSpec, shellSpecFor, macSandboxProfile, createWindowsLocalShell, createLocalShell };
