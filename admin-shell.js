// Administrator PowerShell for chats on Windows (agentdesk_admin_shell).
//
// AgentDesk and its shells run with the person's normal rights, so a model cannot change things that need an
// administrator (scheduled tasks that run without login, services, firewall, machine-wide power settings, installs).
// With this tool it asks for them: AgentDesk first shows the model's reason, then Windows shows its own
// administrator (UAC) prompt. Only when the person accepts both does an elevated helper start; AgentDesk then sends
// it one PowerShell script per call over a private named pipe and returns the output. The helper ends when the chat
// ends, after IDLE_MS without a call, after MAX_MS in all, or when the model ends it.
//
// The pipe: AgentDesk creates it under a random name before the prompt. The helper proves itself with a random
// token, and before sending that token it checks with GetNamedPipeServerProcessId that the pipe really belongs to
// this AgentDesk process, so another program running as the person cannot slip in its own pipe instance and have
// the elevated helper run its commands.
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const IDLE_MS = 10 * 60_000;
const MAX_MS = 60 * 60_000;
const CONNECT_MS = 120_000;           // the person's time to answer the UAC prompt
const DEFAULT_TIMEOUT = 120;          // seconds per script
const MAX_TIMEOUT = 600;
const OUTPUT_LIMIT = 16_000;

const spec = {
  type: 'function', name: 'agentdesk_admin_shell',
  description: 'Run a PowerShell script as administrator on this Windows computer. Use it only for steps that really ' +
    'need administrator rights (for example a scheduled task that runs whether or not the user is logged on, ' +
    'services, firewall rules, machine-wide settings, installing software); use the normal tools for everything ' +
    'else. The first call asks the person: AgentDesk shows your reason, then Windows shows its administrator ' +
    'prompt. If they decline, do not ask again in this turn; tell them what you wanted to do instead. The elevated ' +
    'session then stays open for the following calls of this chat (each may still be confirmed) and ends after ' +
    '10 minutes without a call; use action "end" when you are done. Do not ask for or type passwords. Returns ' +
    'exitCode, stdout and stderr (the last 16000 characters of each).',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['run', 'end'] },
      script: { type: 'string', description: 'PowerShell script to run elevated (Windows PowerShell 5.1)' },
      reason: { type: 'string', description: 'One sentence for the person: why administrator rights are needed' },
      cwd: { type: 'string', description: 'Absolute working folder; defaults to the project folder' },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT },
    },
  },
};

const tail = (text, limit = OUTPUT_LIMIT) => {
  const value = String(text ?? '');
  return value.length > limit ? { text: value.slice(-limit), truncated: true } : { text: value, truncated: false };
};
// PowerShell started with -EncodedCommand writes its error stream as CLIXML; turn that back into plain text.
function plainErrors(text) {
  const value = String(text ?? '');
  if (!value.startsWith('#< CLIXML')) return value;
  const xml = (part) => part.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...value.matchAll(/<S S="(?:Error|Warning)">([\s\S]*?)<\/S>/g)].map((match) => xml(match[1])).join('');
}
const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'";

// The elevated helper (Windows PowerShell 5.1). Kept small: it travels as -EncodedCommand of the elevated process.
function helperScript({ pipeName, token, serverPid }) {
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -Namespace AgentDesk -Name Pipe -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool GetNamedPipeServerProcessId(System.IntPtr h, out uint id);'",
    `$c=New-Object System.IO.Pipes.NamedPipeClientStream('.',${psQuote(pipeName)},[System.IO.Pipes.PipeDirection]::InOut)`,
    '$c.Connect(30000)',
    '[uint32]$sp=0',
    `if(-not [AgentDesk.Pipe]::GetNamedPipeServerProcessId($c.SafePipeHandle.DangerousGetHandle(),[ref]$sp) -or $sp -ne ${Number(serverPid)}){exit 3}`,
    '$u=New-Object System.Text.UTF8Encoding($false)',
    '$r=New-Object System.IO.StreamReader($c,$u);$w=New-Object System.IO.StreamWriter($c,$u);$w.AutoFlush=$true',
    `$w.WriteLine(${psQuote(token)})`,
    "$ps=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    'while($true){',
    ' $l=$r.ReadLine();if($null -eq $l){break}',
    ' $q=$l|ConvertFrom-Json',
    ' $i=New-Object System.Diagnostics.ProcessStartInfo;$i.FileName=$ps',
    " $i.Arguments='-NoLogo -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand '+$q.encoded",
    ' $i.WorkingDirectory=$q.cwd;$i.UseShellExecute=$false;$i.CreateNoWindow=$true',
    ' $i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$i.StandardOutputEncoding=$u;$i.StandardErrorEncoding=$u',
    ' try{',
    '  $p=[System.Diagnostics.Process]::Start($i);$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync()',
    '  $d=$p.WaitForExit([int]$q.timeoutMs)',
    '  if(-not $d){& taskkill.exe /pid $p.Id /t /f 2>&1|Out-Null;$p.WaitForExit()}',
    '  $a=@{id=$q.id;code=$p.ExitCode;stdout=$o.Result;stderr=$e.Result;timedOut=(-not $d)}',
    ' }catch{$a=@{id=$q.id;code=$null;stdout="";stderr=$_.Exception.Message;timedOut=$false}}',
    ' $w.WriteLine(($a|ConvertTo-Json -Compress))',
    '}',
  ].join('\n');
}

// Starts the helper through the UAC prompt. Resolves 'started', 'declined' or rejects with the launcher's error.
function elevate(encodedHelper, { spawnImpl = spawn } = {}) {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launcher = [
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    'try {',
    `  Start-Process -FilePath ${psQuote(powershell)} -Verb RunAs -WindowStyle Hidden -ArgumentList ` +
      `'-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',${psQuote(encodedHelper)} -ErrorAction Stop | Out-Null`,
    "  'STARTED'",
    '} catch {',
    "  if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.HResult -eq -2147023673) { 'DECLINED' } else { 'ERROR ' + $_.Exception.Message }",
    '}',
  ].join('\n');
  return new Promise((resolve, reject) => {
    // The launcher goes on stdin, so only the helper counts against the command-line limit.
    const child = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', () => {
      const line = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop() || '';
      if (line === 'STARTED') resolve('started');
      else if (line === 'DECLINED') resolve('declined');
      else reject(new Error(line.replace(/^ERROR /, '') || 'admin_launch_failed'));
    });
    child.stdin.end(launcher + '\n');
  });
}

class Session {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        const request = this.pending.get(reply?.id);
        if (!request) continue;
        this.pending.delete(reply.id);
        request.resolve(reply);
      }
    });
    const end = () => this.close();
    socket.once('close', end);
    socket.once('error', end);
  }

  run({ script, cwd, timeoutMs }) {
    if (this.closed) return Promise.reject(new Error('admin_session_closed'));
    const id = randomUUID();
    const command = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'\n" + script;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, encoded, cwd, timeoutMs }) + '\n');
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch {}
    for (const request of this.pending.values()) request.reject(new Error('admin_session_closed'));
    this.pending.clear();
  }
}

// confirmStart({ agent, reason, script }) → boolean; confirmRun({ agent, script, cwd }) → boolean (policy 'ask').
function createAdminShell({ confirmStart, confirmRun, audit = () => {}, platform = process.platform,
  serverPid = process.pid, launch = elevate, now = Date.now, idleMs = IDLE_MS, maxMs = MAX_MS, connectMs = CONNECT_MS,
  pipePath = (name) => process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(os.tmpdir(), name + '.sock') } = {}) {
  const sessions = new Map();   // scope → { session, startedAt, idle }
  const starting = new Map();   // scope → Promise

  function end(scope, why = 'ended') {
    const entry = sessions.get(scope);
    if (!entry) return false;
    sessions.delete(scope);
    clearTimeout(entry.idle);
    entry.session.close();
    audit('admin_shell', { status: why });
    return true;
  }

  function touch(scope) {
    const entry = sessions.get(scope);
    if (!entry) return;
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => end(scope, 'idle'), idleMs);
    entry.idle.unref?.();
  }

  async function open(scope) {
    const pipeName = 'agentdesk-admin-' + randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const server = net.createServer();
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('admin_prompt_timeout')), connectMs);
      timer.unref?.();
      server.on('connection', (socket) => {
        let first = '';
        socket.setEncoding('utf8');
        const onData = (chunk) => {
          first += chunk;
          const index = first.indexOf('\n');
          if (index < 0) { if (first.length > 200) socket.destroy(); return; }
          socket.off('data', onData);
          if (first.slice(0, index).trim() !== token) { socket.destroy(); return; }
          clearTimeout(timer);
          const rest = first.slice(index + 1);
          const session = new Session(socket);
          if (rest) socket.emit('data', rest);
          resolve(session);
        };
        socket.on('data', onData);
        socket.on('error', () => {});
      });
    });
    connected.catch(() => {});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath(pipeName), resolve); });
    try {
      const helper = helperScript({ pipeName, token, serverPid });
      const outcome = await launch(Buffer.from(helper, 'utf16le').toString('base64'));
      if (outcome === 'declined') return null;
      const session = await connected;
      sessions.set(scope, { session, startedAt: now() });
      session.socket.once('close', () => { if (sessions.get(scope)?.session === session) end(scope, 'helper_exited'); });
      touch(scope);
      return session;
    } finally {
      server.close();
    }
  }

  async function call({ scope, agent = 'AI', policy, args, defaultCwd }) {
    const fail = (error) => ({ ok: false, error });
    if (platform !== 'win32') return fail('admin_shell_windows_only');
    if (!scope || !args || typeof args !== 'object') return fail('invalid_admin_shell_request');
    if (policy === 'read') return fail('只读轮次不能使用管理员权限');
    if (args.action === 'end') return { ok: true, ended: end(scope) };
    if (args.action !== 'run') return fail('invalid_admin_shell_action');
    const script = args.script;
    if (typeof script !== 'string' || !script.trim() || script.includes('\0') || script.length > 20_000) {
      return fail('invalid_admin_shell_script');
    }
    const cwd = typeof args.cwd === 'string' && path.win32.isAbsolute(args.cwd) && !args.cwd.includes('\0') ? args.cwd
      : defaultCwd || process.env.USERPROFILE || 'C:\\';
    const timeout = Number.isInteger(args.timeoutSeconds) ? Math.min(Math.max(args.timeoutSeconds, 1), MAX_TIMEOUT) : DEFAULT_TIMEOUT;
    let entry = sessions.get(scope);
    if (entry && now() - entry.startedAt > maxMs) { end(scope, 'expired'); entry = undefined; }
    let fresh = false;
    if (!entry) {
      const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
      if (!starting.has(scope)) {
        starting.set(scope, (async () => {
          if (!await confirmStart({ agent, reason, script, policy })) { audit('admin_shell', { status: 'declined_app' }); return 'declined_app'; }
          const session = await open(scope);
          if (!session) { audit('admin_shell', { status: 'declined_uac' }); return 'declined_uac'; }
          audit('admin_shell', { status: 'started' });
          return 'started';
        })().finally(() => starting.delete(scope)));
      }
      let started;
      try { started = await starting.get(scope); } catch (error) {
        audit('admin_shell', { status: 'failed', error: error.message });
        return fail(error.message === 'admin_prompt_timeout' ? '管理员确认超时（2 分钟内没有在 Windows 弹窗里选择）' : '无法启动管理员会话：' + error.message);
      }
      if (started === 'declined_app') return fail('用户拒绝了管理员权限请求');
      if (started === 'declined_uac') return fail('用户在 Windows 管理员确认里选择了“否”');
      entry = sessions.get(scope);
      if (!entry) return fail('admin_session_closed');
      fresh = true;
    }
    if (policy !== 'full' && !fresh && !await confirmRun({ agent, script, cwd })) {
      return fail('这条管理员命令未获批准');
    }
    touch(scope);
    try {
      const reply = await entry.session.run({ script, cwd, timeoutMs: timeout * 1000 });
      touch(scope);
      const stdout = tail(reply.stdout);
      const stderr = tail(plainErrors(reply.stderr));
      audit('admin_shell', { status: 'ran', exitCode: reply.code ?? null, timedOut: reply.timedOut === true });
      return { ok: reply.code === 0, exitCode: reply.code ?? null, timedOut: reply.timedOut === true,
        stdout: stdout.text, stderr: stderr.text, ...((stdout.truncated || stderr.truncated) && { truncated: true }) };
    } catch (error) {
      return fail(error.message);
    }
  }

  return {
    spec,
    call,
    end,
    endAll() { for (const scope of [...sessions.keys()]) end(scope); },
    active: (scope) => sessions.has(scope),
  };
}

module.exports = { createAdminShell, helperScript, elevate, plainErrors, spec };
