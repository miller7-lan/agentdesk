const path = require('node:path');
const { createHash } = require('node:crypto');
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
    const normalized = key.toUpperCase();
    if (Object.hasOwn(env, normalized)) throw new Error('duplicate_local_shell_env');
    env[normalized] = content;
  }
  return env;
}

function invocation(shell, script) {
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

function createWindowsLocalShell({ leases, journal, notify, syncMs = 15_000 }) {
  if (process.platform !== 'win32') throw new Error('windows_native_chat_required');
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
      const shell = args.shell ?? 'powershell';
      if (!boundedId(requestId) || typeof args.command !== 'string' || !args.command.trim() ||
        args.command.includes('\0') || args.command.length > (shell === 'cmd' ? 7500 : 10_000)) {
        throw new Error('invalid_local_shell_command');
      }
      if (args.cwd !== undefined && (typeof args.cwd !== 'string' || args.cwd.length > 1000 || args.cwd.includes('\0'))) {
        throw new Error('invalid_local_shell_directory');
      }
      const cwd = path.resolve(lease.directory, args.cwd || '.');
      const env = environment(args.env);
      const launch = invocation(shell, args.command);
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
    canResume(lease, { acknowledgeUnknown = false } = {}) {
      return runs.listAll(lease.scope).every((run) => run.finishedAt && (acknowledgeUnknown || run.state !== 'unknown'));
    },
  };
}

module.exports = { localShellSpec, createWindowsLocalShell };
