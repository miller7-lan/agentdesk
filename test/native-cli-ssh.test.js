const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseRequest, sessionArgs } = require('../orchestrator/agentdesk-cli');
const { line } = require('../orchestrator/agentdesk-cli-keys');
const { createNativeCli } = require('../orchestrator/native-cli-ssh');

const hex = (text) => Buffer.from(text).toString('hex');

test('VPS2 entry: the device comes from the forced command, the request is checked word by word', () => {
  const env = { AGENTDESK_DEVICE: 'mac', AGENTDESK_PLATFORM: 'darwin' };
  const request = parseRequest(`cli claude C123 p-1 ${hex('作业')} write`, env);
  assert.deepEqual([request.device, request.provider, request.chatId, request.name, request.writable], ['mac', 'claude', 'C123', '作业', true]);
  for (const bad of ['bash', `cli gemini C1 p1 ${hex('x')} write`, `cli claude ../x p1 ${hex('x')} write`, `cli claude C1 p1 zz write`,
    `cli claude C1 p1 ${hex('x')} root`, `cli claude C1 p1 ${hex('x')} write; rm -rf /`]) {
    assert.throws(() => parseRequest(bad, env), undefined, bad);
  }
  assert.throws(() => parseRequest(`cli claude C1 p1 ${hex('x')} write`, {}), /cli_device_missing/);
  assert.equal(parseRequest(`cli codex C1 p1 ${hex('x')} write local`, env).local, true, 'works in the computer\'s own folder');
  assert.equal(parseRequest(`cli codex C1 p1 ${hex('x')} write`, env).local, false, '0.5.0-0.5.2 clients: VPS2 folder');
  assert.throws(() => parseRequest(`cli codex C1 p1 ${hex('x')} write /etc`, env), /cli_place_invalid/);
  const win = { AGENTDESK_DEVICE: 'win', AGENTDESK_PLATFORM: 'win32' };
  const whole = parseRequest(`cli codex C1 p1 ${hex('ICT')} write pc ${hex('C:\\Users\\me\\Desktop\\ICT')}`, win);
  assert.deepEqual([whole.computer, whole.start], [true, '/c/Users/me/Desktop/ICT'], 'the whole computer, starting in the project');
  assert.equal(parseRequest(`cli codex C1 p1 ${hex('p')} write pc ${hex('/Users/me/p')}`, env).start, '/Users/me/p', 'a Mac keeps its own paths');
  for (const bad of ['C:\\..\\Windows', 'relative\\x', '\\\\server\\share']) {
    assert.throws(() => parseRequest(`cli codex C1 p1 ${hex('p')} write pc ${hex(bad)}`, win), /cli_root_invalid/, bad);
  }
  for (const bad of ['/etc/passwd', '/Users/../etc', '/Users/me/../../etc']) {
    assert.throws(() => parseRequest(`cli codex C1 p1 ${hex('p')} write pc ${hex(bad)}`, env), /cli_root_invalid/, bad);
  }
  assert.throws(() => parseRequest(`cli codex C1 p1 ${hex('p')} write pc`, env), /cli_place_invalid/, 'pc needs the folder');
});

test('VPS2 entry: each chat continues its own conversation', () => {
  assert.deepEqual(sessionArgs('claude', { session: 'u1', started: false }), ['--session-id', 'u1']);
  assert.deepEqual(sessionArgs('claude', { session: 'u1', started: true }), ['--resume', 'u1']);
  assert.deepEqual(sessionArgs('antigravity', { session: 'conv' }), ['--conversation', 'conv']);
  assert.deepEqual(sessionArgs('antigravity', {}), []);
});

test('CLI key line: terminal allowed, one forced program, identity fixed, never root', () => {
  const entry = line('mac', 'darwin', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample agentdesk-cli');
  assert.match(entry, /^restrict,pty,command="\/usr\/bin\/env AGENTDESK_DEVICE=mac AGENTDESK_PLATFORM=darwin \/opt\/agentdesk-orchestrator\/node \/opt\/agentdesk-orchestrator\/agentdesk-cli\.js" ssh-ed25519 \S+ agentdesk-mac-cli$/);
  assert.throws(() => line('mac', 'darwin', 'ssh-rsa AAAA'), /invalid_public_key/);
  assert.throws(() => line('../x', 'darwin', 'ssh-ed25519 AAAA'), /invalid_device/);
});

function fakePty() {
  const spawned = [];
  return { spawned, spawn(file, args, options) {
    const events = new EventEmitter();
    const term = { file, args, options, written: [], sizes: [], killed: false,
      onData: (f) => events.on('data', f), onExit: (f) => events.on('exit', f),
      write: (data) => term.written.push(data), resize: (c, r) => term.sizes.push([c, r]), kill: () => { term.killed = true; },
      emit: (name, value) => events.emit(name, value) };
    spawned.push(term);
    return term;
  } };
}

test('client: a terminal ssh (-tt) to agentdesk@vps2, reconnects after a drop, refusal means not enabled', async (t) => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ssh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'cli_ed25519');
  if (require('node:child_process').spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile]).status !== 0) { t.skip('no ssh-keygen'); return; }
  const pty = fakePty();
  const states = [];
  const cli = createNativeCli({ pty, keyFile, loadConfig: () => ({ host: 'vps2.example', port: 22, knownHosts: path.join(dir, 'kh') }),
    onEvent: (event) => { if (event.type === 'state') states.push(event.state); } });
  await cli.call('open', { provider: 'grok', chatId: 'C1', projectId: 'p1', name: '项目', cols: 100, rows: 30 });
  const first = pty.spawned[0];
  assert.ok(first.args.includes('-tt') && !first.args.includes('-T'), 'a terminal session');
  assert.deepEqual(first.args.slice(-8), ['agentdesk@vps2.example', 'cli', 'grok', 'C1', 'p1', hex('项目'), 'write', 'vps']);
  first.emit('data', 'Grok screen');
  assert.equal(states.at(-1), 'ready');
  await cli.call('input', { key: 'grok:p1:C1', data: 'hi\r' });
  assert.deepEqual(first.written, ['hi\r']);
  first.emit('exit', { exitCode: 255 });                       // network drop
  assert.equal(states.at(-1), 'reconnecting');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(pty.spawned.length, 2, 'tried again by itself');
  pty.spawned[1].emit('data', 'Grok screen again');
  assert.equal(states.at(-1), 'ready');
  pty.spawned[1].emit('exit', { exitCode: 0 });                // the CLI itself ended
  assert.equal(states.at(-1), 'exited');

  await cli.call('open', { provider: 'claude', chatId: 'C2', projectId: 'p1', name: 'x' });
  const refused = pty.spawned.at(-1);
  refused.emit('data', 'agentdesk@vps2.example: Permission denied (publickey).\r\n');
  refused.emit('exit', { exitCode: 255 });
  assert.equal(states.at(-1), 'not_enabled');
});
