// Native CLI single chats, the computer's side (0.5.0): a plain `ssh -tt agentdesk@vps2 cli …` in a local pseudo-
// terminal, exactly what the person would type in their own terminal. Keystrokes and screen go straight through
// SSH; resizing the local terminal resizes the remote one (SSH window-change). VPS2 runs agentdesk-cli.js for this
// device's "cli" key (never root), which starts the official CLI in this device's project folder there.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadPty } = require('./terminal-sessions');
const { SSH, buildSshInvocation, normalizeJump, classifySshFailure } = require('./ssh-options');
const { routeFor } = require('./ssh-route');

const run = promisify(execFile);
const win = process.platform === 'win32';
const bundledKeygen = process.resourcesPath && path.join(process.resourcesPath, 'desktop-backend', 'openssh', 'ssh-keygen.exe');
const KEYGEN = win
  ? bundledKeygen && fs.existsSync(bundledKeygen) ? bundledKeygen : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')
  : '/usr/bin/ssh-keygen';
const BUFFER = 768 * 1024;
const hex = (text) => Buffer.from(String(text || 'project'), 'utf8').toString('hex').slice(0, 480);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const PROVIDERS = new Set(['claude', 'codex', 'grok', 'antigravity']);
// A dropped connection is tried again after these pauses; the CLI keeps running on VPS2 meanwhile (dtach).
const RETRY = [1000, 2000, 5000, 10_000, 20_000, 30_000];

function createNativeCli({ loadConfig, keyFile = path.join(os.homedir(), '.agentdesk', 'keys', 'cli_ed25519'), publicCopy,
  onEvent = () => {}, pty = loadPty() } = {}) {
  const sessions = new Map();     // key -> { term, buffer, size, state, mode, error, output }
  const emit = (key, event) => { try { onEvent({ key, ...event }); } catch {} };
  const view = (key) => {
    const entry = sessions.get(key);
    return { key, state: entry?.state || 'closed', mode: entry?.mode || null, error: entry?.error || null, exitCode: entry?.exitCode ?? null };
  };
  const setState = (key, entry, state, extra = {}) => { Object.assign(entry, { state, ...extra }); emit(key, { type: 'state', ...view(key) }); };

  async function publicKey() {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(keyFile)) {
      await run(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'agentdesk-cli', '-f', keyFile], { timeout: 10_000, windowsHide: true });
    }
    const { stdout } = await run(KEYGEN, ['-y', '-f', keyFile], { timeout: 10_000, windowsHide: true });
    const key = stdout.trim().split(/\s+/).slice(0, 2).join(' ') + ' agentdesk-cli';
    // A copy of the public half where the person (or an administrator) can find it; the private key stays put.
    if (publicCopy) { try { fs.writeFileSync(publicCopy, key + '\n', { mode: 0o644 }); } catch {} }
    return key;
  }

  function invocation(afterTarget, terminal) {
    const cfg = loadConfig();
    if (!cfg.host) throw new Error('VPS 连接还没配置好。');
    const jump = normalizeJump(cfg.jump, { checkFiles: true });
    const port = cfg.port || 22;
    // The same route record as the other VPS2 connections: direct, or through VPS1 when direct fails.
    const route = routeFor(jump, { host: cfg.host, port });
    const choice = route.routeForAttempt();
    const result = buildSshInvocation({ cfg: { knownHosts: cfg.knownHosts, jump }, key: keyFile, port,
      target: 'agentdesk@' + cfg.host, targetHost: cfg.host, route: choice.route, jump, afterTarget });
    if (terminal) result.args[result.args.indexOf('-T')] = '-tt';
    return { ...result, route, choice };
  }

  async function open({ provider, chatId, projectId, name, mode = 'write', cols = 120, rows = 32 }) {
    if (!PROVIDERS.has(provider) || !ID.test(chatId || '') || !ID.test(projectId || '')) throw new Error('cli_request_invalid');
    if (!['write', 'read'].includes(mode)) throw new Error('cli_mode_invalid');
    if (!pty) throw new Error('这台电脑缺少终端组件（node-pty），请安装完整版 AgentDesk。');
    const key = provider + ':' + projectId + ':' + chatId;
    const current = sessions.get(key);
    if (current && ['connecting', 'ready', 'reconnecting'].includes(current.state)) return { ...view(key), replay: Buffer.concat(current.buffer) };
    await publicKey();
    const entry = current && !current.closing ? current : { buffer: [], size: 0 };
    Object.assign(entry, { mode, state: 'connecting', output: '', attempt: 0, closing: false,
      request: ['cli', provider, chatId, projectId, hex(name), mode], cols, rows });
    sessions.set(key, entry);
    setState(key, entry, 'connecting');
    connect(key, entry);
    return { ...view(key), replay: null };
  }

  function connect(key, entry) {
    let call;
    try { call = invocation(entry.request, true); }
    catch (error) { setState(key, entry, 'failed', { error: error.message }); return; }
    const term = pty.spawn(SSH, call.args, { name: 'xterm-256color', cols: entry.cols, rows: entry.rows, cwd: os.homedir(),
      env: { ...process.env, ...call.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' } });
    entry.term = term;
    entry.output = '';
    let ready = false;
    term.onData((text) => {
      const data = Buffer.from(text, 'utf8');
      if (!ready) {
        entry.output = (entry.output + text).slice(-2000);
        // ssh's own refusal arrives on the terminal too: this computer's key is not opened on VPS2 yet.
        if (/Permission denied \(publickey/.test(entry.output)) { entry.notEnabled = true; return; }
        if (/^\s*$/.test(entry.output) || /^(ssh|kex_exchange|Connection |Host key|Warning:)/m.test(entry.output.trim())) return;
        ready = true;
        entry.attempt = 0;
        call.route.noteSuccess(call.choice.route);
        setState(key, entry, 'ready');
      }
      entry.buffer.push(data);
      entry.size += data.length;
      while (entry.size > BUFFER && entry.buffer.length > 1) entry.size -= entry.buffer.shift().length;
      emit(key, { type: 'data', data });
    });
    term.onExit(({ exitCode }) => {
      if (entry.term === term) entry.term = null;
      if (entry.closing) return;
      if (entry.notEnabled) { setState(key, entry, 'not_enabled'); return; }
      // 255 is ssh's own failure (network, route); anything else is the CLI ending on VPS2.
      if (exitCode === 255) {
        if (!ready) call.route.noteFailure(call.choice.route, classifySshFailure({ stderr: entry.output, code: exitCode, route: call.choice.route }));
        if (entry.attempt < RETRY.length) {
          const delay = RETRY[entry.attempt++];
          setState(key, entry, 'reconnecting', { error: entry.output.trim().split('\n').pop()?.slice(0, 200) || null });
          entry.timer = setTimeout(() => { if (!entry.closing) connect(key, entry); }, delay);
          return;
        }
        setState(key, entry, 'disconnected', { error: entry.output.trim().split('\n').pop()?.slice(0, 200) || 'ssh_failed' });
        return;
      }
      setState(key, entry, ready ? 'exited' : 'failed', { exitCode, ...(ready ? {} : { error: entry.output.trim().split('\n').pop()?.slice(0, 200) || null }) });
    });
  }

  const live = (key) => {
    const entry = sessions.get(key);
    if (!entry?.term) throw new Error('原生 CLI 未连接。');
    return entry;
  };

  function stopRemote(provider, chatId) {
    if (!PROVIDERS.has(provider) || !ID.test(chatId || '')) return Promise.resolve();
    const call = invocation(['stop', provider, chatId], false);
    return new Promise((resolve) => {
      const child = spawn(SSH, call.args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, ...call.env } });
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 15_000);
      child.on('close', () => { clearTimeout(timer); resolve(); });
      child.on('error', () => { clearTimeout(timer); resolve(); });
    });
  }

  function upload({ projectId, name, fileName, bytes }) {
    if (!ID.test(projectId || '')) return Promise.reject(new Error('cli_request_invalid'));
    const call = invocation(['upload', projectId, hex(name), hex(fileName)], false);
    return new Promise((resolve, reject) => {
      const child = spawn(SSH, call.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...call.env } });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-1000); });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 && out.trim().startsWith('/work/') ? resolve(out.trim()) : reject(new Error(err.trim().split('\n').pop() || 'upload_failed'))));
      child.stdin.end(Buffer.from(bytes));
    });
  }

  // The `pc` bridge (orchestrator/pc-bridge.js): a plain ssh without a terminal, JSON lines both ways.
  function bridgeProcess() {
    const call = invocation(['pcbridge'], false);
    return spawn(SSH, call.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...call.env } });
  }

  return {
    publicKey,
    bridgeProcess,
    async call(op, fields = {}) {
      const key = typeof fields.key === 'string' ? fields.key : fields.provider + ':' + fields.projectId + ':' + fields.chatId;
      switch (op) {
        case 'status': {
          const entry = sessions.get(key);
          return { ...view(key), replay: entry?.buffer.length ? Buffer.concat(entry.buffer) : null };
        }
        case 'open': return open(fields);
        case 'input': live(key).term.write(String(fields.data ?? '')); return true;
        case 'resize': {
          const cols = Math.max(10, Math.min(1000, Number(fields.cols) | 0));
          const rows = Math.max(4, Math.min(500, Number(fields.rows) | 0));
          const entry = sessions.get(key);
          if (entry) { entry.cols = cols; entry.rows = rows; }
          live(key).term.resize(cols, rows);
          return true;
        }
        case 'upload': {
          const bytes = Buffer.from(fields.bytes || []);
          if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('文件为空或超过 25 MB。');
          return upload({ projectId: fields.projectId, name: fields.name, fileName: String(fields.fileName || 'file'), bytes });
        }
        case 'key': return publicKey();
        case 'close':
        case 'forget': {
          // 结束 / deleting the chat: the CLI on VPS2 ends too (its conversation stays and is continued next time).
          const entry = sessions.get(key);
          if (entry) { entry.closing = true; clearTimeout(entry.timer); try { entry.term?.kill(); } catch {} }
          sessions.delete(key);
          const [provider, , chatId] = key.split(':');
          await stopRemote(provider, chatId).catch(() => {});
          emit(key, { type: 'state', ...view(key) });
          return true;
        }
        default: throw new Error('invalid_cli_operation');
      }
    },
    // Quitting AgentDesk only disconnects: the CLIs keep running on VPS2 and are attached again next time.
    closeAll() { for (const entry of sessions.values()) { entry.closing = true; clearTimeout(entry.timer); try { entry.term?.kill(); } catch {} } },
  };
}

module.exports = { createNativeCli };
