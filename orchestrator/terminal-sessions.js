// Interactive terminals for direct chats (D4, spec §5.3). They run in the local Worker on the user's computer,
// through node-pty (Q8: Microsoft's package; ConPTY on Windows, forkpty on macOS). The model drives them with
// the terminal_* tools; the user sees them live and may take one over, which pauses the model's input.
//
// node-pty is a native module that is not bundled yet: its version must be confirmed before the client build
// (gate G2). Until it is present, terminals report pty_unavailable and the capability stays off.
const { randomUUID } = require('node:crypto');
const os = require('node:os');

const MAX_PER_SESSION = 4;
const BUFFER_LIMIT = 1024 * 1024;
const SCREEN_LINES = 60;
const IDLE_CLOSE_MS = 6 * 60 * 60_000;

function loadPty() {
  try { return require('node-pty'); } catch { return null; }
}

// The shell the terminal starts, matching the computer: PowerShell or CMD on Windows, a zsh or bash login shell
// on a Mac (wrapped in the same sandbox-exec profile as local_shell, which only keeps AgentDesk's own keys out).
function terminalLaunch(shell, { platform = process.platform, profile } = {}) {
  if (platform === 'win32') {
    if (!shell || shell === 'powershell') return { file: 'powershell.exe', args: ['-NoLogo'] };
    if (shell === 'pwsh') return { file: 'pwsh.exe', args: ['-NoLogo'] };
    if (shell === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: [] };
    throw new Error('invalid_terminal_shell');
  }
  const name = !shell ? (platform === 'darwin' ? 'zsh' : 'bash') : shell;
  if (!['zsh', 'bash'].includes(name)) throw new Error('invalid_terminal_shell');
  const binary = '/bin/' + name;
  if (platform === 'darwin' && profile) return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, binary, '-l'] };
  return { file: binary, args: ['-l'] };
}

class TerminalSessions {
  constructor({ pty = loadPty(), maxPerSession = MAX_PER_SESSION, bufferLimit = BUFFER_LIMIT, env = () => process.env,
    profile = () => undefined, onEvent = () => {}, now = Date.now } = {}) {
    Object.assign(this, { pty, maxPerSession, bufferLimit, env, profile, onEvent, now });
    this.terminals = new Map();
  }

  get available() { return Boolean(this.pty?.spawn); }

  owned(scope, id) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.scope !== scope) throw new Error('terminal_not_found');
    return terminal;
  }

  view(terminal) {
    return { terminalId: terminal.id, shell: terminal.shell, cols: terminal.cols, rows: terminal.rows, state: terminal.exited ? 'exited' : 'running',
      exitCode: terminal.exitCode ?? null, cursor: terminal.base + terminal.buffer.length, takenOver: terminal.takenOver,
      startedAt: new Date(terminal.startedAt).toISOString() };
  }

  // scope: the session's lease scope; cwd: the project folder on this computer.
  open(scope, { cwd, shell, cols = 120, rows = 32 } = {}) {
    if (!this.available) throw new Error('pty_unavailable');
    const mine = [...this.terminals.values()].filter((item) => item.scope === scope && !item.exited);
    if (mine.length >= this.maxPerSession) throw new Error('too_many_terminals');
    const size = (value, low, high, fallback) => Number.isSafeInteger(value) && value >= low && value <= high ? value : fallback;
    const launch = terminalLaunch(shell, { profile: this.profile() });
    const child = this.pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color', cols: size(cols, 20, 400, 120), rows: size(rows, 5, 200, 32), cwd: cwd || os.homedir(), env: this.env(),
      useConpty: true,
    });
    const terminal = { id: randomUUID(), scope, shell: shell || null, cols: size(cols, 20, 400, 120), rows: size(rows, 5, 200, 32), process: child,
      buffer: '', base: 0, truncated: false, exited: false, exitCode: null, takenOver: false, startedAt: this.now(), lastUsed: this.now() };
    child.onData((data) => {
      terminal.buffer += data;
      if (terminal.buffer.length > this.bufferLimit) {
        const drop = terminal.buffer.length - this.bufferLimit;
        terminal.buffer = terminal.buffer.slice(drop);
        terminal.base += drop;
        terminal.truncated = true;
      }
      // The chunk travels with the event so the window can show it at once; `cursor` is the offset after it, so a
      // window that missed a chunk notices the gap and reads from its own cursor instead.
      this.onEvent({ type: 'output', scope, terminalId: terminal.id, cursor: terminal.base + terminal.buffer.length,
        data: data.length <= 64 * 1024 ? data : undefined });
    });
    child.onExit(({ exitCode }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      this.onEvent({ type: 'exited', scope, terminalId: terminal.id, exitCode });
    });
    this.terminals.set(terminal.id, terminal);
    this.onEvent({ type: 'opened', scope, terminalId: terminal.id });
    return this.view(terminal);
  }

  // The model's keystrokes. Refused while the user has taken the terminal over.
  write(scope, id, data, { byUser = false } = {}) {
    const terminal = this.owned(scope, id);
    if (terminal.exited) throw new Error('terminal_exited');
    if (terminal.takenOver && !byUser) throw new Error('terminal_taken_over: 用户正在操作这个终端，请等用户交还后再输入');
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new Error('invalid_terminal_input');
    terminal.process.write(data);
    terminal.lastUsed = this.now();
    return this.view(terminal);
  }

  // Output since cursor (a character offset into the stream), plus the last screenful for orientation.
  read(scope, id, cursor = 0) {
    const terminal = this.owned(scope, id);
    terminal.lastUsed = this.now();
    const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const truncated = start < terminal.base;
    const data = terminal.buffer.slice(Math.max(0, start - terminal.base));
    const screen = terminal.buffer.split(/\r?\n/).slice(-SCREEN_LINES).join('\n');
    return { ...this.view(terminal), data: data.slice(-256 * 1024), truncated: truncated || data.length > 256 * 1024, screen };
  }

  resize(scope, id, cols, rows) {
    const terminal = this.owned(scope, id);
    if (![cols, rows].every((value) => Number.isSafeInteger(value) && value > 4 && value <= 400)) throw new Error('invalid_terminal_size');
    terminal.process.resize(cols, rows);
    Object.assign(terminal, { cols, rows });
    return this.view(terminal);
  }

  signal(scope, id, name = 'SIGINT') {
    const terminal = this.owned(scope, id);
    if (!['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'].includes(name)) throw new Error('invalid_terminal_signal');
    // Ctrl+C works everywhere, including ConPTY where POSIX signals do not exist.
    if (name === 'SIGINT') terminal.process.write('\x03');
    else terminal.process.kill(process.platform === 'win32' ? undefined : name);
    return this.view(terminal);
  }

  takeover(scope, id, on) {
    const terminal = this.owned(scope, id);
    terminal.takenOver = Boolean(on);
    this.onEvent({ type: on ? 'takenOver' : 'handedBack', scope, terminalId: id });
    return this.view(terminal);
  }

  close(scope, id) {
    const terminal = this.owned(scope, id);
    if (!terminal.exited) { try { terminal.process.kill(); } catch {} }
    this.terminals.delete(id);
    this.onEvent({ type: 'closed', scope, terminalId: id });
    return { terminalId: id, state: 'closed' };
  }

  list(scope) { return [...this.terminals.values()].filter((item) => item.scope === scope).map((item) => this.view(item)); }

  // Terminals nobody used for hours are closed; exited ones are forgotten after the same time.
  sweep() {
    for (const terminal of [...this.terminals.values()]) {
      if (this.now() - terminal.lastUsed > IDLE_CLOSE_MS) this.close(terminal.scope, terminal.id);
    }
  }

  // The model's tool call: { action: open|write|read|resize|signal|close|list, ... }.
  call(scope, args = {}, defaults = {}) {
    switch (args.action) {
      case 'open': return this.open(scope, { cwd: defaults.cwd, shell: args.shell, cols: args.cols, rows: args.rows });
      case 'write': return this.write(scope, args.terminalId, args.data);
      case 'read': return this.read(scope, args.terminalId, args.cursor);
      case 'resize': return this.resize(scope, args.terminalId, args.cols, args.rows);
      case 'signal': return this.signal(scope, args.terminalId, args.signal);
      case 'close': return this.close(scope, args.terminalId);
      case 'list': return { terminals: this.list(scope) };
      default: throw new Error('invalid_terminal_action');
    }
  }
}

// What the model sees. One tool keeps the tool list stable (prompt caching), like local_shell.
function terminalSpec(platform = process.platform) {
  const shells = platform === 'win32' ? ['powershell', 'pwsh', 'cmd'] : ['zsh', 'bash'];
  return {
    type: 'function', name: 'terminal',
    description: `An interactive terminal on the user's ${platform === 'win32' ? 'Windows' : 'Mac'} computer that stays open between calls ` +
      '(REPLs, prompts, long-running programs). action=open starts one in the project folder; write sends keystrokes (use \\r for Enter); ' +
      'read returns output after a cursor plus the current screen; signal SIGINT sends Ctrl+C. Writes to files from here are not covered ' +
      'by AgentDesk file locks: call file_lock_acquire first for files another session may be editing.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['open', 'write', 'read', 'resize', 'signal', 'close', 'list'] },
      terminalId: { type: 'string' }, data: { type: 'string' }, cursor: { type: 'integer', minimum: 0 },
      shell: { type: 'string', enum: shells }, cols: { type: 'integer' }, rows: { type: 'integer' },
      signal: { type: 'string', enum: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'] },
    } },
  };
}

const lockSpec = {
  type: 'function', name: 'file_lock_acquire',
  description: 'Lock project files before changing them with local_shell or the terminal, whose writes AgentDesk cannot see. ' +
    'Waits up to 120 s if another session holds them; the lock ends 30 s after your last write or with this turn. Paths are relative to the project.',
  parameters: { type: 'object', additionalProperties: false, required: ['paths'], properties: {
    paths: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' } },
  } },
};

module.exports = { TerminalSessions, terminalSpec, terminalLaunch, lockSpec, loadPty, MAX_PER_SESSION };
