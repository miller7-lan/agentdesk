const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const tui = require('../orchestrator/native-tui');
const { NativeChannel, TUI_TYPES, VERSION } = require('../orchestrator/native-channel');
const { Lines } = require('../orchestrator/transport');
const { openNativeTui } = require('../orchestrator/native-tui-client');

const KEY = 'ab'.repeat(32);
const hex = (text) => Buffer.from(text, 'utf8').toString('hex');

test('native CLI host arguments are validated and the project name is made safe', () => {
  const parsed = tui.parseHostArgs(['claude', 'write', KEY, 'darwin', hex('我的 项目/../x'), '120', '9999']);
  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.name, '我的 项目_.._x');
  assert.equal(parsed.rows, 500);
  for (const bad of [
    ['gemini', 'write', KEY, 'win32', hex('p'), '80', '24'],
    ['claude', 'admin', KEY, 'win32', hex('p'), '80', '24'],
    ['claude', 'write', 'short', 'win32', hex('p'), '80', '24'],
    ['claude', 'write', KEY, 'linux', hex('p'), '80', '24'],
    ['claude', 'write', KEY, 'win32', 'zz', '80', '24'],
    ['claude', 'write', KEY, 'win32', hex('p'), 'wide', '24'],
  ]) assert.throws(() => tui.parseHostArgs(bad));
  assert.equal(tui.projectFolderName('..'), 'project');
  assert.equal(tui.workFolder('claude', 'demo', KEY), '/work/demo');
  assert.equal(tui.workFolder('codex', 'demo', KEY), '/work/abababab/demo');
});

test('native CLI prompt follows the computer and the tools on offer', () => {
  const win = tui.tuiPrompt({ platform: 'win32', writable: true, tools: ['local_shell', 'agentdesk_admin_shell'] });
  assert.match(win, /Windows/);
  assert.match(win, /PowerShell/);
  assert.match(win, /管理员/);
  const mac = tui.tuiPrompt({ platform: 'darwin', writable: true, tools: ['local_shell'] });
  assert.match(mac, /Mac/);
  assert.match(mac, /zsh/);
  assert.doesNotMatch(mac, /管理员/);
  const read = tui.tuiPrompt({ platform: 'darwin', writable: false, tools: [] });
  assert.match(read, /只读/);
  assert.doesNotMatch(read, /local_shell/);
});

test('each CLI starts interactively with its own options, continuing when there is a conversation', () => {
  const mcp = { command: '/usr/bin/node', args: ['/opt/chat-mcp.js', '/run/a.sock', 'cap'] };
  const claude = tui.cliArgs('claude', { prompt: 'P', mcp, writable: false, resume: true });
  assert.ok(!claude.includes('-p'), 'interactive, not print mode');
  assert.deepEqual(JSON.parse(claude[1]).mcpServers.agentdesk, mcp);
  assert.ok(claude.includes('--continue'));
  assert.deepEqual(claude.slice(claude.indexOf('--permission-mode'), claude.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  assert.ok(!tui.cliArgs('claude', { prompt: 'P', mcp, writable: true, resume: null }).includes('--permission-mode'),
    'the official default permission mode when editing');
  const codex = tui.cliArgs('codex', { prompt: 'P', mcp, writable: true, resume: '0199-uuid' });
  assert.deepEqual(codex.slice(0, 2), ['resume', '0199-uuid']);
  assert.ok(codex.includes('mcp_servers.agentdesk.command="/usr/bin/node"'));
  assert.ok(codex.includes('workspace-write'));
  assert.ok(!codex.includes('--ask-for-approval') && !codex.includes('-a'), 'Codex keeps its own approval default');
  assert.equal(tui.cliArgs('codex', { prompt: 'P', mcp, writable: false, resume: null })[0], '-c');
  const grok = tui.cliArgs('grok', { prompt: 'P', mcp, writable: true, resume: true, leaderSocket: '/tmp/l.sock' });
  assert.ok(grok.includes('--continue') && grok.includes('--leader-socket') && !grok.includes('-p'));
  assert.deepEqual(tui.cliArgs('antigravity', { prompt: 'P', mcp, writable: false, resume: true }), ['--mode', 'plan', '--continue']);
  assert.match(tui.grokMcpToml(mcp), /\[mcp_servers\.agentdesk\]/);
});

test('a conversation to continue is found in the session history only when it has messages', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const historyRoot = path.join(root, 'h');
  assert.equal(tui.previousConversation('claude', { historyRoot }), null);
  fs.mkdirSync(path.join(historyRoot, '.claude', 'projects', '-work-demo'), { recursive: true });
  fs.writeFileSync(path.join(historyRoot, '.claude', 'projects', '-work-demo', 'a.jsonl'), '{}\n');
  assert.equal(tui.previousConversation('claude', { historyRoot }), true);
  const grokSession = path.join(historyRoot, '.grok', 'sessions', '%2Fwork%2Fdemo', 'id1');
  fs.mkdirSync(grokSession, { recursive: true });
  fs.writeFileSync(path.join(grokSession, 'chat_history.jsonl'), '');
  assert.equal(tui.previousConversation('grok', { historyRoot }), null, 'an empty session made at startup does not count');
  fs.writeFileSync(path.join(grokSession, 'chat_history.jsonl'), '{"role":"user"}\n');
  assert.equal(tui.previousConversation('grok', { historyRoot }), true);
  const codexHome = path.join(root, '.codex');
  const day = path.join(codexHome, 'sessions', '2026', '11', '27');
  fs.mkdirSync(day, { recursive: true });
  const meta = (cwd, id) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n{"x":1}\n';
  fs.writeFileSync(path.join(day, 'rollout-2026-11-27T10-00-00-a.jsonl'), meta('/work/abababab/demo', 'mine'));
  fs.writeFileSync(path.join(day, 'rollout-2026-11-27T11-00-00-b.jsonl'), meta('/work/cdcdcdcd/demo', 'other device'));
  assert.equal(tui.previousConversation('codex', { codexHome, cwd: '/work/abababab/demo' }), 'mine');
  assert.equal(tui.previousConversation('codex', { codexHome, cwd: '/work/eeeeeeee/demo' }), null);
});

// The launcher runs on VPS2 (Linux); its bubblewrap command line is not built on Windows.
test('the launcher runs the CLI in the sandbox with the project at /work and uploads read-only', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  const mountDir = path.join(runtimeDir, 'mount');
  const home = path.join(root, 'home');
  for (const dir of [mountDir, path.join(runtimeDir, 'uploads'), home]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'agentdesk.sock'), '');
  const { plan } = require('../orchestrator/native-tui-launch');
  const launch = plan({ provider: 'claude', writable: true, platform: 'win32', cwd: '/work/demo', mountDir, runtimeDir,
    historyRoot: path.join(root, 'history'), socket: path.join(runtimeDir, 'agentdesk.sock'), capability: 'cap', tools: ['local_shell'], home },
  { env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'x' } });
  const args = launch.args;
  const at = args.indexOf('/work/demo');
  assert.deepEqual(args.slice(at - 2, at + 1), ['--bind', fs.realpathSync(mountDir), '/work/demo']);
  assert.deepEqual(args.slice(args.indexOf('--chdir'), args.indexOf('--chdir') + 2), ['--chdir', '/work/demo']);
  const uploads = args.indexOf('/uploads');
  assert.equal(args[uploads - 2], '--ro-bind');
  assert.ok(args.indexOf('--tmpfs') < at, 'state folders are hidden before the project is bound');
  assert.equal(args[args.indexOf('--') + 1], 'claude');
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined, 'no billing override reaches the CLI');
  assert.equal(launch.env.TERM, 'xterm-256color');
  assert.equal(launch.resume, false);
  const readOnly = plan({ provider: 'antigravity', writable: false, platform: 'darwin', cwd: '/work/demo', mountDir, runtimeDir,
    historyRoot: path.join(root, 'history2'), socket: path.join(runtimeDir, 'agentdesk.sock'), capability: 'cap', tools: [], home }, { env: {} });
  const ro = readOnly.args.indexOf('/work/demo');
  assert.equal(readOnly.args[ro - 2], '--ro-bind');
  assert.ok(readOnly.args.some((arg) => arg.endsWith(path.join('.gemini', 'config', 'mcp_config.json'))), 'agentdesk MCP config bound for agy');
});

// A fake VPS2: the remote's command/exec carrier is played by a NativeChannel peer acting as native-tui-host.js.
function fakeRemote(host) {
  const remote = new EventEmitter();
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const peer = new NativeChannel(toHost, fromHost, TUI_TYPES);
  let processId;
  let end;
  remote.calls = [];
  // The host reads its stdin from the start, as native-tui-host.js does.
  host(peer);
  fromHost.on('data', (data) => remote.emit('notification', { method: 'command/exec/outputDelta',
    params: { processId, stream: 'stdout', deltaBase64: data.toString('base64') } }));
  remote.request = async (method, params) => {
    remote.calls.push({ method, params });
    if (method === 'command/exec') {
      processId = params.processId;
      return new Promise((resolve) => { end = resolve; });
    }
    if (method === 'command/exec/write') { toHost.write(Buffer.from(params.deltaBase64, 'base64')); return {}; }
    if (method === 'command/exec/terminate') { end?.({ exitCode: 0 }); return {}; }
    return {};
  };
  return remote;
}

test('native CLI client: terminal bytes, resize, tool calls and uploads travel over one carrier', async () => {
  const seen = { input: '', resize: null, upload: null, tool: null };
  const remote = fakeRemote((peer) => {
    const mIn = new PassThrough();
    const mOut = new PassThrough();
    const relay = new Lines(mIn, mOut);
    mOut.on('data', (data) => peer.send('m', data));
    peer.on('m', (data) => mIn.write(data));
    const uIn = new PassThrough();
    const uploads = new Lines(uIn, new PassThrough());
    peer.on('u', (data) => uIn.write(data));
    const control = (value) => peer.send('c', JSON.stringify({ protocolVersion: VERSION, ...value }));
    let bytes = [];
    uploads.on('frame', (frame) => {
      bytes.push(Buffer.from(frame.data, 'base64'));
      if (frame.last) { seen.upload = { name: frame.name, size: Buffer.concat(bytes).length }; bytes = []; control({ state: 'uploaded', id: frame.id, path: '/uploads/' + frame.name }); }
    });
    relay.on('frame', (frame) => {
      if (frame.type === 'tools') {
        seen.tools = frame.tools.map((tool) => tool.name);
        control({ state: 'ready', cwd: '/work/demo' });
        relay.send({ type: 'call', id: 7, name: 'local_shell', arguments: { action: 'run', command: 'git status' } });
        relay.send({ type: 'call', id: 8, name: 'not_offered', arguments: {} });
      } else if (frame.type === 'result') seen[frame.id === 7 ? 'tool' : 'refused'] = frame;
    });
    peer.on('t', (data) => { seen.input += data.toString(); peer.send('t', Buffer.from('echo:' + data.toString())); });
    peer.on('c', (data) => { const message = JSON.parse(data); if (message.op === 'resize') seen.resize = [message.cols, message.rows]; });
  });
  const sftp = new PassThrough();
  const output = [];
  const session = await openNativeTui({ remote, worker: { openSftp: async () => sftp }, binding: {}, provider: 'claude', mode: 'write',
    sessionKey: KEY, platform: 'win32', name: '项目', cols: 100, rows: 30,
    tools: [{ name: 'local_shell', description: 'run', inputSchema: { type: 'object' } }],
    callTool: async (name, args) => ({ content: [{ type: 'text', text: `${name}:${args.command}` }] }),
    onData: (data) => output.push(data.toString()) });
  assert.equal(session.info.cwd, '/work/demo');
  const exec = remote.calls.find((call) => call.method === 'command/exec').params.command;
  assert.deepEqual(exec.slice(0, 4), ['/usr/bin/unshare', '--mount', '--propagation', 'private']);
  assert.deepEqual(exec.slice(-7), ['claude', 'write', KEY, 'win32', hex('项目'), '100', '30']);
  assert.deepEqual(seen.tools, ['local_shell']);
  session.input('/help\r');
  session.resize(132, 40);
  const saved = await session.upload('shot.png', Buffer.alloc(120_000, 7));
  assert.equal(saved, '/uploads/shot.png');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(seen.input, '/help\r');
  assert.deepEqual(seen.resize, [132, 40]);
  assert.deepEqual(seen.upload, { name: 'shot.png', size: 120_000 });
  assert.equal(output.join(''), 'echo:/help\r');
  assert.equal(seen.tool.ok, true);
  assert.equal(seen.tool.value.content[0].text, 'local_shell:git status');
  assert.equal(seen.refused.ok, false, 'a tool that was not offered is refused on this computer too');
  await session.close();
  assert.equal(session.closed, true);
});

test('native CLI client: a failed start is reported with the host code', async () => {
  const remote = fakeRemote((peer) => {
    peer.send('c', JSON.stringify({ protocolVersion: VERSION, state: 'failed', code: 'native_codex_profile_unavailable' }));
  });
  await assert.rejects(openNativeTui({ remote, worker: { openSftp: async () => new PassThrough() }, binding: {}, provider: 'codex',
    mode: 'read', sessionKey: KEY, name: 'p', tools: [], callTool: async () => ({}) }), /native_codex_profile_unavailable/);
});

test('native CLI host upload names stay inside /uploads', () => {
  const { uploadName } = require('../orchestrator/native-tui-host');
  assert.equal(uploadName('../../etc/passwd'), 'passwd');
  assert.equal(uploadName('截图 1.png'), '截图 1.png');
  assert.equal(uploadName('..'), 'file');
  assert.equal(uploadName('a\u0000b;rm.txt'), 'a_b_rm.txt');
});
