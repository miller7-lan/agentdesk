const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { createPcBridge, scripts, shellSetup } = require('../orchestrator/pc-bridge');

// node-pty is built for Electron; under plain node a Python pseudo-terminal stands in (same surface).
const ptyRun = path.join(__dirname, '..', 'orchestrator', 'pty-run.py');
const pythonPty = { spawn(file, args, { cols, rows, env, cwd }) {
  const child = spawn('python3', ['-I', ptyRun, String(cols), String(rows), '--', file, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const data = []; const exit = [];
  child.stdout.on('data', (d) => data.forEach((f) => f(d.toString('utf8'))));
  child.on('exit', (code) => exit.forEach((f) => f({ exitCode: code })));
  return { onData: (f) => data.push(f), onExit: (f) => exit.push(f), write: (s) => child.stdin.write(s),
    resize: (c, r) => child.stdio[3].write(`${c} ${r}\n`), kill: () => child.kill('SIGHUP'), pid: child.pid };
} };
const usable = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty']).status === 0 && spawnSync('bash', ['-c', 'true']).status === 0;

test('Windows: PowerShell runs the command from its own file, shows the AI in its colour and reports the exit code', () => {
  const built = scripts({ platform: 'win32', token: 'abc123', provider: 'codex', command: "Get-ChildItem 'C:\\x'\nexit 3", dir: 'C:\\T' });
  const [[commandFile, command], [, script]] = built.files;
  assert.equal(command, "Get-ChildItem 'C:\\x'\nexit 3");
  assert.match(script, /\x1b\[1;38;2;16;163;127m● Codex › Get-ChildItem ''C:\\x'' …/);
  assert.ok(script.includes(`[IO.File]::ReadAllText('${commandFile}', [Text.Encoding]::UTF8)`));
  assert.match(script, /633;D;abc123;' \+ \$__agentdeskCode/);
  assert.match(built.line, /^ Invoke-Expression \(\[IO\.File\]::ReadAllText\('C:\\T\\abc123\.ps1\.txt'\)\)\r$/);
  assert.match(shellSetup('win32'), /Set-PSReadLineOption -Colors/);
});

test('pc: runs in the chat terminal, keeps the shell, takeover interrupts, ask waits for hand-back', { skip: !usable && 'needs python3 pty and bash' }, async (t) => {
  const replies = [];
  const events = [];
  const fake = new EventEmitter();
  Object.assign(fake, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  let buffer = '';
  fake.stdin.on('data', (chunk) => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const bridge = createPcBridge({ spawnBridge: () => fake, platform: 'darwin', shell: 'bash', pty: pythonPty, onTerminalEvent: (event) => events.push(event) });
  t.after(() => bridge.closeAll());
  const send = (message) => fake.stdout.write(JSON.stringify(message) + '\n');
  const done = async (id) => { for (let i = 0; i < 100; i++) { const found = replies.find((r) => r.id === id && r.type === 'done'); if (found) return found; await new Promise((r) => setTimeout(r, 100)); } return null; };
  const output = (id) => replies.filter((r) => r.id === id && r.type === 'out').map((r) => r.data).join('');
  bridge.start();

  send({ id: 1, op: 'run', chat: 'claude:C1', command: 'cd / && echo "hi $(pwd)"; false', timeout: 20 });
  assert.equal((await done(1)).code, 1);
  assert.match(output(1), /hi \//);
  send({ id: 2, op: 'run', chat: 'claude:C1', command: 'pwd; (exit 7)', timeout: 20 });
  assert.equal((await done(2)).code, 7);
  assert.match(output(2), /^\s*\/\s*$/m, 'the same shell: cd carried over');

  const scope = 'cli:claude:C1';
  const terminalId = bridge._test.terminals.list(scope)[0].terminalId;
  assert.ok(events.some((event) => event.provider === 'claude' && event.threadId === 'cli:C1'), 'the panel sees it as this chat');
  send({ id: 3, op: 'run', chat: 'claude:C1', command: 'sleep 30', timeout: 60 });
  await new Promise((r) => setTimeout(r, 800));
  bridge.call('claude', 'cli:C1', 'takeover', { terminalId, on: true });
  assert.equal((await done(3)).code, 130, 'taking over interrupts the AI command first');
  assert.throws(() => bridge._test.terminals.write(scope, terminalId, 'x'), /terminal_taken_over/);
  bridge.call('claude', 'cli:C1', 'takeover', { terminalId, on: false });

  send({ id: 4, op: 'ask', chat: 'claude:C1', message: '输入密码' });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(events.some((event) => event.type === 'askTakeover' && event.message === '输入密码'));
  bridge.call('claude', 'cli:C1', 'input', { terminalId, data: 'echo typed-by-person\r' });
  await new Promise((r) => setTimeout(r, 600));
  bridge.call('claude', 'cli:C1', 'takeover', { terminalId, on: false });
  const handed = await done(4);
  assert.equal(handed.code, 0);
  assert.match(handed.text, /typed-by-person/);
});

test('保护 switch: new terminals use the protected profile only when it is on; absent where unsupported', () => {
  let on = false;
  const profiles = [];
  const fakePty = { spawn() { return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; } };
  // The shell is this test machine's (terminals start with the host's launcher; Windows CI has no zsh).
  const bridge = createPcBridge({ spawnBridge: () => { throw new Error('offline'); }, platform: 'darwin', shell: process.platform === 'win32' ? 'powershell' : 'zsh', pty: fakePty,
    protection: { get: () => on, set: (value) => { on = value; }, profile: () => { profiles.push('sandboxed'); return '(version 1)'; } } });
  assert.deepEqual(bridge.call('claude', 'cli:C1', 'capabilities').protection, { on: false });
  bridge.call('claude', 'cli:C1', 'open', {});
  assert.deepEqual(profiles, [], 'off: a normal terminal');
  assert.deepEqual(bridge.call('claude', 'cli:C1', 'protect', { on: true }), { on: true });
  bridge.call('claude', 'cli:C1', 'open', {});
  assert.deepEqual(profiles, ['sandboxed'], 'on: the next terminal is sandboxed');
  const windows = createPcBridge({ spawnBridge: () => { throw new Error('offline'); }, platform: 'win32', pty: fakePty });
  assert.equal(windows.call('codex', 'cli:C2', 'capabilities').protection, null);
  assert.throws(() => windows.call('codex', 'cli:C2', 'protect', { on: true }), /terminal_protection_unavailable/);
  bridge.closeAll(); windows.closeAll();
});
