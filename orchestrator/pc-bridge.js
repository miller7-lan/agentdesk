// `pc` for native CLI single chats (0.5.0), the computer's side. A CLI on VPS2 runs `pc '<command>'` in its sandbox;
// VPS2's bridge (agentdesk-cli.js pcbridge, reached through a plain `ssh agentdesk@vps2 pcbridge` of this device's
// CLI key) hands the request here as a JSON line, and it runs in that chat's shared terminal: the person sees it,
// can type into the same terminal, interrupt it and take it over. Output and exit code go back to the CLI.
//
// Rules (from the person):
// - the AI's commands appear in its avatar colour, the person's own typing in white on black (set in the shell's
//   own line editor: PSReadLine / zle — nothing is inserted into the terminal stream, which would throw ConPTY's
//   screen out of step);
// - taking over first interrupts the AI's running command, and the AI's input is refused until it is handed back;
// - the AI may ask the person to take over (`pc --ask`), without anything being interrupted; handing back lets the
//   AI continue, with what the terminal shows;
// - Windows always runs PowerShell, the Mac zsh; one main terminal per chat, more (up to 4) for long-running ones.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { TerminalSessions } = require('./terminal-sessions');

const COLORS = {
  claude: { name: 'Claude', rgb: [217, 119, 87] },
  codex: { name: 'Codex', rgb: [16, 163, 127] },
  grok: { name: 'Grok', ansi: 30 },          // black like its avatar; the panel theme keeps it readable on dark
  antigravity: { name: 'Antigravity', rgb: [66, 133, 244] },
};
const HUMAN = '\x1b[48;2;17;17;17;38;2;255;255;255m';
const RETRY = [1000, 2000, 5000, 10_000, 20_000, 30_000];
const strip = (text) => String(text).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][A-Za-z0-9]/g, '').replace(/\x1b[=>78]/g, '').replace(/\r(?!\n)/g, '');

function colorOf(provider) {
  const color = COLORS[provider] || COLORS.codex;
  return { name: color.name, sgr: color.rgb ? `\x1b[1;38;2;${color.rgb.join(';')}m` : `\x1b[1;${color.ansi}m` };
}

// What the shell runs for one AI command: a coloured line naming the AI over the line that invoked it, the command,
// and an invisible end marker (OSC 633) carrying the exit code. The command is read from its own file, so a syntax
// error in it cannot stop the marker.
function scripts({ platform, token, provider, command, dir }) {
  const { name, sgr } = colorOf(provider);
  const shown = command.split(/\r?\n/)[0].slice(0, 300) + (command.includes('\n') ? ' …' : '');
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const commandFile = join(dir, token + '.cmd.txt');
  const header = `\x1b[1A\r\x1b[2K${sgr}● ${name} › ${shown}\x1b[0m`;
  if (platform === 'win32') {
    const file = join(dir, token + '.ps1.txt');
    const q = (value) => "'" + String(value).replace(/'/g, "''") + "'";
    const text = [
      `[Console]::Out.Write(${q(header)} + [Environment]::NewLine)`,
      `[Console]::Out.Write([char]27 + ']633;A;${token}' + [char]7)`,
      '$global:LASTEXITCODE = 0; $__agentdeskOk = $true',
      `try { Invoke-Expression ([IO.File]::ReadAllText(${q(commandFile)}, [Text.Encoding]::UTF8)) } catch { Write-Host $_ -ForegroundColor Red; $__agentdeskOk = $false }`,
      '$__agentdeskCode = if ($__agentdeskOk) { [int]$LASTEXITCODE } else { 1 }',
      `[Console]::Out.Write([char]27 + ']633;D;${token};' + $__agentdeskCode + [char]7)`,
    ].join('\r\n');
    return { files: [[commandFile, command], [file, text]], line: ` Invoke-Expression ([IO.File]::ReadAllText(${q(file)}))\r` };
  }
  const file = join(dir, token + '.sh');
  const q = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const text = [
    `printf '%s\\n' ${q(header)}`,
    `printf '\\033]633;A;${token}\\007'`,
    `eval "$(cat ${q(commandFile)})"`,
    `printf '\\033]633;D;${token};%s\\007' "$?"`,
  ].join('\n');
  return { files: [[commandFile, command], [file, text]], line: ` . ${q(file)}\r` };
}

// Typed once into a new terminal: the person's typing in white on black, then a clean screen.
function shellSetup(platform) {
  if (platform === 'win32') {
    const colors = ['Command', 'Comment', 'ContinuationPrompt', 'Default', 'Emphasis', 'Keyword', 'Member', 'Number', 'Operator',
      'Parameter', 'String', 'Type', 'Variable'].map((key) => `${key}=$__h`).join(';');
    return ` $__h=[char]27+'${HUMAN.slice(1)}'; try { Set-PSReadLineOption -Colors @{${colors}} } catch {}; Clear-Host\r`;
  }
  return ' zle_highlight=(default:fg=#ffffff,bg=#111111 paste:none); clear\r';
}

// protection: { get() → boolean, set(on), profile() → sandbox profile } — the panel's 保护 switch (Mac): new terminals
// run inside it (AgentDesk's own keys hidden; tools that sandbox themselves fail there). Absent where unsupported.
function createPcBridge({ spawnBridge, platform = process.platform, profile, protection = null, onTerminalEvent = () => {}, now = Date.now,
  pty, retry = RETRY, shell = platform === 'win32' ? 'powershell' : 'zsh' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-pc-'));
  const terminals = new TerminalSessions({ ...(pty ? { pty } : {}), now,
    profile: () => (protection?.get() ? protection.profile() : profile?.()),
    onEvent: (event) => { watch(event); emitTerminal(event); } });
  const running = new Map();      // terminalId -> the AI command in it
  const asks = new Map();         // terminalId -> pending `pc --ask`
  let bridge = null;
  let wanted = false;
  let attempt = 0;
  let timer = null;

  const scopeOf = (chat) => 'cli:' + chat;                 // chat: "<provider>:<chatId>"
  const chatOf = (scope) => scope.slice(4);
  function emitTerminal(event) {
    const [provider, chatId] = chatOf(event.scope || '').split(':');
    onTerminalEvent({ ...event, provider, threadId: 'cli:' + chatId });
  }

  // ---- the terminals ----
  function mainTerminal(scope, fresh) {
    const live = terminals.list(scope).filter((item) => item.state !== 'exited');
    if (!fresh && live[0]) return live[0].terminalId;
    const info = terminals.open(scope, { shell, cwd: os.homedir() });
    terminals.write(scope, info.terminalId, shellSetup(platform));
    return info.terminalId;
  }

  function watch(event) {
    const job = running.get(event.terminalId);
    if (event.type === 'takenOver' && job && !asks.has(event.terminalId)) {
      // Taking over interrupts the AI's command first.
      try { terminals.signal(job.scope, event.terminalId, 'SIGINT'); } catch {}
      finish(job, 130, '\n[用户接管了终端，命令已中断。等用户交还后再继续。]\n');
    }
    if (event.type === 'handedBack') {
      const ask = asks.get(event.terminalId);
      if (ask) {
        asks.delete(event.terminalId);
        const screen = strip(terminals.read(ask.scope, event.terminalId).screen).trim();
        answer(ask.id, { type: 'done', code: 0, text: `[用户已交还终端]\n终端当前内容：\n${screen.slice(-8000)}\n` });
        queues.get(event.terminalId)?.shift()?.();
      }
    }
    if (event.type === 'exited' && job) finish(job, 1, '\n[终端已退出]\n');
    if (event.type === 'output' && job) collect(job);
  }

  function collect(job) {
    const { data } = terminals.read(job.scope, job.terminalId, job.cursor);
    job.cursor += data.length;
    job.pending += data;
    if (!job.started) {
      const start = job.pending.indexOf(`\x1b]633;A;${job.token}\x07`);
      if (start < 0) { job.pending = job.pending.slice(-200); return; }
      job.started = true;
      job.pending = job.pending.slice(start + `\x1b]633;A;${job.token}\x07`.length);
    }
    const end = job.pending.match(new RegExp(`\\x1b\\]633;D;${job.token};(-?\\d+)\\x07`));
    const body = end ? job.pending.slice(0, end.index) : job.pending.slice(0, Math.max(0, job.pending.length - 80));
    if (body) {
      const text = strip(body);
      if (text) answer(job.id, { type: 'out', data: text });
      job.pending = job.pending.slice(body.length);
    }
    if (end) finish(job, Number(end[1]) & 255, '');
  }

  function finish(job, code, text) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    running.delete(job.terminalId);
    for (const [file] of job.files) fs.rm(file, { force: true }, () => {});
    answer(job.id, { type: 'done', code, text });
    const queue = job.queue.shift();
    if (queue) queue();
  }

  const queues = new Map();       // terminalId -> waiting AI commands
  async function run(message) {
    const scope = scopeOf(message.chat);
    const terminalId = mainTerminal(scope, message.newTerminal);
    const queue = queues.get(terminalId) || [];
    queues.set(terminalId, queue);
    if (running.has(terminalId) || asks.has(terminalId)) {
      answer(message.id, { type: 'note', text: '终端里还有命令在运行，排队等待…' });
      await new Promise((resolve) => queue.push(resolve));
    }
    // Taken over by the person: wait for them to hand it back.
    for (let info = terminals.read(scope, terminalId); info.takenOver; info = terminals.read(scope, terminalId)) {
      answer(message.id, { type: 'note', text: '用户正在操作这个终端，等用户交还后再运行…' });
      await new Promise((resolve) => {
        const check = setInterval(() => { try { if (!terminals.read(scope, terminalId).takenOver) { clearInterval(check); resolve(); } } catch { clearInterval(check); resolve(); } }, 500);
      });
    }
    const token = randomUUID().replace(/-/g, '').slice(0, 16);
    const built = scripts({ platform, token, provider: message.chat.split(':')[0], command: message.command, dir });
    for (const [file, text] of built.files) fs.writeFileSync(file, text, { mode: 0o600 });
    const info = terminals.read(scope, terminalId);
    const job = { id: message.id, scope, terminalId, token, files: built.files, cursor: info.cursor, pending: '', started: false, done: false, queue };
    running.set(terminalId, job);
    job.timer = setTimeout(() => {
      try { terminals.signal(scope, terminalId, 'SIGINT'); } catch {}
      finish(job, 124, `\n[超过 ${message.timeout} 秒，已中断]\n`);
    }, (message.timeout || 600) * 1000);
    terminals.write(scope, terminalId, built.line);
  }

  function ask(message) {
    const scope = scopeOf(message.chat);
    const terminalId = mainTerminal(scope, false);
    // Asked by the AI: nothing is interrupted (set before the takeover event is seen).
    asks.set(terminalId, { id: message.id, scope });
    terminals.takeover(scope, terminalId, true);
    emitTerminal({ type: 'askTakeover', scope, terminalId, message: message.message });
  }

  function cancel(id) {
    for (const job of running.values()) {
      if (job.id === id) { try { terminals.signal(job.scope, job.terminalId, 'SIGINT'); } catch {} finish(job, 130, ''); }
    }
    for (const [terminalId, item] of asks) if (item.id === id) asks.delete(terminalId);
  }

  // ---- the connection to VPS2 ----
  function answer(id, value) {
    if (!bridge?.stdin.writable) return;
    try { bridge.stdin.write(JSON.stringify({ id, ...value }) + '\n'); } catch {}
  }

  function handle(message) {
    try {
      if (message.op === 'ready' || message.op === 'ping') { attempt = 0; return; }
      if (message.op === 'cancel') { cancel(message.id); return; }
      if (!/^(claude|codex|grok|antigravity):[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(message.chat || '')) return;
      if (!terminals.available) { answer(message.id, { type: 'done', code: 69, text: '用户电脑缺少终端组件，无法运行。\n' }); return; }
      if (message.op === 'run' && typeof message.command === 'string' && message.command.trim()) {
        run(message).catch((error) => answer(message.id, { type: 'done', code: 1, text: `pc: ${error.message}\n` }));
      } else if (message.op === 'ask') ask(message);
      else if (message.op === 'screen') {
        const scope = scopeOf(message.chat);
        const terminalId = mainTerminal(scope, false);
        answer(message.id, { type: 'done', code: 0, text: strip(terminals.read(scope, terminalId).screen).trim().slice(-8000) + '\n' });
      }
    } catch (error) { answer(message.id, { type: 'done', code: 1, text: `pc: ${error.message}\n` }); }
  }

  function connect() {
    if (!wanted || bridge) return;
    let child;
    try { child = spawnBridge(); } catch { schedule(); return; }
    bridge = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try { handle(JSON.parse(line)); } catch {}
      }
    });
    child.stderr?.on('data', () => {});
    child.on('error', () => {});
    child.on('close', () => {
      if (bridge === child) bridge = null;
      // Commands waiting for an answer cannot get one through this connection any more.
      for (const job of [...running.values()]) { job.done = true; clearTimeout(job.timer); running.delete(job.terminalId); job.queue.shift()?.(); }
      asks.clear();
      schedule();
    });
  }
  function schedule() {
    if (!wanted || timer) return;
    const delay = retry[Math.min(attempt++, retry.length - 1)];
    timer = setTimeout(() => { timer = null; connect(); }, delay);
  }

  // ---- the panel (terminal:call for chats whose thread is "cli:<chatId>") ----
  function call(provider, threadId, op, fields = {}) {
    const scope = scopeOf(provider + ':' + threadId.slice(4));
    const id = typeof fields.terminalId === 'string' ? fields.terminalId : undefined;
    switch (op) {
      case 'capabilities': return { pty: terminals.available, protection: protection ? { on: protection.get() } : null };
      case 'protect': {
        if (!protection) throw new Error('terminal_protection_unavailable');
        protection.set(fields.on === true);
        return { on: protection.get() };
      }
      case 'list': return { terminals: terminals.list(scope) };
      case 'read': return terminals.read(scope, id, fields.cursor);
      case 'open': {
        const info = terminals.open(scope, { shell, cwd: os.homedir(), cols: fields.cols, rows: fields.rows });
        terminals.write(scope, info.terminalId, shellSetup(platform));
        return info;
      }
      case 'input': return terminals.write(scope, id, String(fields.data ?? ''), { byUser: true });
      case 'takeover': return terminals.takeover(scope, id, fields.on === true);
      case 'resize': return terminals.resize(scope, id, fields.cols, fields.rows);
      case 'signal': return terminals.signal(scope, id, fields.signal || 'SIGINT');
      case 'close': return terminals.close(scope, id);
      default: throw new Error('invalid_terminal_operation');
    }
  }

  return {
    call,
    // Connected while any CLI chat is open; the bridge on VPS2 ends when this connection does.
    start() { wanted = true; connect(); },
    stop() { wanted = false; clearTimeout(timer); timer = null; try { bridge?.kill(); } catch {} bridge = null; },
    closeAll() { this.stop(); terminals.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); },
    get connected() { return Boolean(bridge); },
    _test: { handle, terminals },
  };
}

module.exports = { createPcBridge, scripts, shellSetup, strip, colorOf };
