// Native CLI single chats, step 1 of 2 (see native-tui.js). Started by the client through the root codex
// app-server carrier, in a private mount namespace, exactly like native-project-session-host.js:
//
//   unshare --mount --propagation private node native-tui-host.js <provider> <read|write> <sessionKey> <win32|darwin> <nameHex> <cols> <rows>
//
// stdin/stdout carry NativeChannel frames: 's' SFTP of the project, 't' terminal bytes, 'c' control (JSON),
// 'm' the agentdesk tool relay (JSON lines), 'u' uploads (JSON lines). The host mounts the project, serves the
// agentdesk MCP socket, and runs pty-run.py -> [setpriv] -> native-tui-launch.js -> bwrap -> the official CLI.
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { NativeChannel, VERSION, TUI_TYPES } = require('./native-channel');
const { Lines } = require('./transport');
const { mountProject } = require('./project-mount');
const { HOME_NAMES, parseHostArgs, workFolder } = require('./native-tui');

const HOST_STATE = '/var/lib/agentdesk-orchestrator';
const UPLOAD_LIMIT = 25 * 1024 * 1024;
const UPLOAD_TOTAL = 200 * 1024 * 1024;

const uploadName = (raw) => {
  const base = path.basename(String(raw || '')).normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(-80);
  return !base || /^\.+$/.test(base) ? 'file' : base;
};

async function privateNamespace() {
  if (process.getuid?.() !== 0 || await fs.readlink('/proc/self/ns/mnt') === await fs.readlink('/proc/1/ns/mnt')) return false;
  const mountInfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
  return !mountInfo.split('\n').some((line) => line.split(' - ')[0].split(' ').some((tag) => tag.startsWith('shared:')));
}

async function serveNativeTui({ argv, input = process.stdin, output = process.stdout, mount = mountProject }) {
  const request = parseHostArgs(argv);
  if (!await privateNamespace()) throw new Error('native_session_requires_private_namespace');
  const { provider, mode, sessionKey, platform } = request;
  const writable = mode === 'write';
  const stateDir = await fs.mkdtemp('/var/tmp/agentdesk-native-tui-');
  const pipe = new NativeChannel(input, output, TUI_TYPES);
  const sftpIn = new PassThrough();
  const sftpOut = new PassThrough();
  const relayIn = new PassThrough();
  const relayOut = new PassThrough();
  const uploadIn = new PassThrough();
  const relay = new Lines(relayIn, relayOut, 8 * 1024 * 1024);
  const uploads = new Lines(uploadIn, new PassThrough(), 1024 * 1024);
  const stop = new AbortController();
  let child;
  let mounted;
  let server;
  let offered = [];
  let nextCall = 0;
  const calls = new Map();
  const abort = () => stop.abort(new Error('native_channel_closed'));
  const send = (type, data) => { try { pipe.send(type, data); } catch { abort(); } };
  const control = (value) => send('c', JSON.stringify({ protocolVersion: VERSION, ...value }));
  const feed = (stream, limit) => (data) => {
    if (stream.writableLength + data.length > limit) abort();
    else if (!stop.signal.aborted) stream.write(data);
  };
  pipe.on('failure', abort);
  pipe.on('end', abort);
  // The carrier being terminated (or VPS2 shutting down) ends the session the normal way, so cleanup runs.
  for (const name of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.once(name, abort);
  pipe.on('s', feed(sftpIn, 8 * 1024 * 1024));
  pipe.on('m', feed(relayIn, 8 * 1024 * 1024));
  pipe.on('u', feed(uploadIn, 2 * 1024 * 1024));
  pipe.on('t', (data) => {
    if (!child || child.stdin.writableLength + data.length > 4 * 1024 * 1024) return;
    child.stdin.write(data);
  });
  pipe.on('c', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.op === 'resize' && child && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
      child.stdio[3].write(`${Math.max(10, Math.min(1000, message.cols))} ${Math.max(4, Math.min(500, message.rows))}\n`);
    }
    if (message.op === 'close') abort();
  });
  sftpOut.on('data', (data) => send('s', data));
  relayOut.on('data', (data) => send('m', data));
  relay.on('fault', abort);
  relay.on('frame', (frame) => {
    if (frame?.type === 'tools' && Array.isArray(frame.tools)) { offered = frame.tools.slice(0, 20); return; }
    if (frame?.type !== 'result') return;
    const call = calls.get(frame.id);
    if (!call) return;
    calls.delete(frame.id);
    call(frame);
  });

  // Uploads: { id, name, data (base64), last } lines; the file appears read-only under /uploads in the sandbox.
  let uploadDir;
  let uploadedTotal = 0;
  const open = new Map();
  uploads.on('fault', abort);
  uploads.on('frame', async (frame) => {
    const id = typeof frame?.id === 'string' && /^[\w-]{1,64}$/.test(frame.id) ? frame.id : null;
    if (!id || !uploadDir) return;
    try {
      let entry = open.get(id);
      if (!entry) {
        const name = uploadName(frame.name);
        let target = path.join(uploadDir, name);
        for (let n = 2; fss.existsSync(target); n++) target = path.join(uploadDir, name.replace(/(\.[^.]*)?$/, `-${n}$1`));
        entry = { target, size: 0, handle: fss.openSync(target, 'wx', 0o644) };
        open.set(id, entry);
      }
      const bytes = Buffer.from(String(frame.data || ''), 'base64');
      entry.size += bytes.length;
      uploadedTotal += bytes.length;
      if (entry.size > UPLOAD_LIMIT || uploadedTotal > UPLOAD_TOTAL) throw new Error('upload_too_large');
      fss.writeSync(entry.handle, bytes);
      if (frame.last) {
        fss.closeSync(entry.handle);
        open.delete(id);
        control({ state: 'uploaded', id, path: '/uploads/' + path.basename(entry.target) });
      }
    } catch (error) {
      const entry = open.get(id);
      if (entry) { try { fss.closeSync(entry.handle); fss.rmSync(entry.target, { force: true }); } catch {} open.delete(id); }
      control({ state: 'upload_failed', id, code: /^[a-z_]+$/.test(error.message) ? error.message : 'upload_failed' });
    }
  });

  try {
    let account;
    let home;
    if (provider === 'codex') {
      home = await fs.realpath(process.env.CODEX_HOME || path.join(process.env.HOME || '/root', '.codex'));
      if (path.basename(home) !== '.codex' || !(await fs.stat(home)).isDirectory()) throw new Error('native_codex_profile_unavailable');
    } else {
      home = path.join(HOST_STATE, 'homes', HOME_NAMES[provider]);
      const { uid, gid } = await fs.stat(home);
      if (!uid || !gid) throw new Error('native_provider_profile_requires_service_account');
      account = { uid, gid };
    }
    const owner = account || { uid: 0, gid: 0 };
    await fs.chown(stateDir, owner.uid, owner.gid);
    uploadDir = path.join(stateDir, 'uploads');
    await fs.mkdir(uploadDir, { mode: 0o755 });
    await fs.chown(uploadDir, 0, 0);
    mounted = await mount({ stateDir, input: sftpIn, output: sftpOut, account, readOnly: !writable, signal: stop.signal });
    // This session's own CLI history (the same root the native chat seats use, under its own key).
    const persistent = path.join(HOST_STATE, 'windows-native-chat');
    await fs.mkdir(persistent, { recursive: true, mode: 0o700 });
    await fs.chown(persistent, 0, owner.gid);
    await fs.chmod(persistent, 0o710);
    const historyRoot = path.join(persistent, sessionKey);
    await fs.mkdir(historyRoot, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await fs.lstat(historyRoot)).isDirectory()) throw new Error('invalid_native_provider_state');
    await fs.chown(historyRoot, owner.uid, owner.gid);

    // The agentdesk MCP server (chat-mcp.js inside the CLI) reaches this socket; calls go to the client.
    const capability = randomBytes(24).toString('hex');
    const socket = path.join(stateDir, 'agentdesk.sock');
    server = net.createServer((connection) => {
      const wire = new Lines(connection, connection, 8 * 1024 * 1024);
      wire.on('fault', () => connection.destroy());
      connection.on('error', () => {});
      wire.once('frame', (frame) => {
        const reply = (value) => { try { wire.send(value); } catch {} connection.end(); };
        if (frame?.capability !== capability) return reply({ ok: false, error: 'capability_invalid' });
        if (frame.operation === 'tools') return reply({ ok: true, value: { tools: offered } });
        if (frame.operation !== 'call' || !offered.some((tool) => tool.name === frame.name)) {
          return reply({ ok: false, error: 'tool_not_offered' });
        }
        const id = ++nextCall;
        calls.set(id, (answer) => reply(answer.ok ? { ok: true, value: answer.value } : { ok: false, error: String(answer.error || 'tool_failed') }));
        connection.once('close', () => calls.delete(id));
        try { relay.send({ type: 'call', id, name: frame.name, arguments: frame.arguments || {} }); }
        catch { calls.delete(id); reply({ ok: false, error: 'relay_closed' }); }
      });
    });
    server.listen(socket);
    await once(server, 'listening');
    await fs.chown(socket, owner.uid, owner.gid);
    await fs.chmod(socket, 0o600);

    const cwd = workFolder(provider, request.name, sessionKey);
    const launcher = path.join(__dirname, 'native-tui-launch.js');
    const program = [...(account ? ['/usr/bin/setpriv', '--reuid', String(account.uid), '--regid', String(account.gid), '--clear-groups', '--'] : []),
      process.execPath, launcher];
    // The client sends its tool list first on 'm'; give it a moment so the prompt names the tools that exist.
    if (!offered.length) await new Promise((resolve) => setTimeout(resolve, 300));
    const env = {
      PATH: '/opt/agentdesk-orchestrator:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color', HOME: home,
      AGENTDESK_TUI: JSON.stringify({ provider, writable, platform, cwd, mountDir: mounted.directory, runtimeDir: stateDir,
        historyRoot, socket, capability, tools: offered.map((tool) => tool.name), home }),
    };
    child = spawn('/usr/bin/python3', ['-I', path.join(__dirname, 'pty-run.py'), String(request.cols), String(request.rows), '--', ...program],
      { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
    child.stdin.on('error', abort);
    child.stdout.on('data', (data) => send('t', data));
    await once(child, 'spawn');
    control({ state: 'ready', cwd, provider, mode });
    const exited = once(child, 'exit');
    stop.signal.addEventListener('abort', () => child.kill('SIGHUP'), { once: true });
    mounted.signal.addEventListener('abort', abort, { once: true });
    if (stop.signal.aborted || mounted.signal.aborted) child.kill('SIGHUP');
    const [code] = await exited;
    control({ state: 'exited', code, detail: stderr.replace(/[^\x20-\x7e\n一-鿿]/g, '').slice(-600) });
  } catch (error) {
    control({ state: 'failed', code: String(error.message || 'failed').split(':')[0].slice(0, 80) });
    throw error;
  } finally {
    for (const entry of open.values()) { try { fss.closeSync(entry.handle); } catch {} }
    server?.close();
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await mounted?.close().catch(() => {});
    // Never recurse into a project that is still mounted (it is the person's own folder).
    const table = await fs.readFile('/proc/self/mountinfo', 'utf8').catch(() => stateDir);
    if (!table.includes(stateDir)) await fs.rm(stateDir, { recursive: true, force: true });
    input.destroy();
  }
}

if (require.main === module) {
  serveNativeTui({ argv: process.argv.slice(2) }).catch(() => { process.exitCode = 1; });
}

module.exports = { serveNativeTui, uploadName };
