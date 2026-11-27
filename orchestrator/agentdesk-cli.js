#!/usr/bin/env node
// Native CLI single chats over plain SSH. A device's "cli" key in the agentdesk account's authorized keys forces:
//
//   restrict,pty,command="/usr/bin/env AGENTDESK_DEVICE=<id> AGENTDESK_PLATFORM=<p> /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/agentdesk-cli.js" <key>
//
// and the client runs `ssh -tt agentdesk@vps2 cli <provider> <chatId> <projectId> <nameHex> <write|read>`. This
// program (running as agentdesk, never root) starts the official CLI on the SSH terminal itself: keystrokes and
// screen go straight through sshd, as in the person's own terminal. The CLI works in a folder of this device and
// project on VPS2, in the same bubblewrap sandbox as the other chats, with this device's own conversation history
// (each chat continues its own conversation; /resume lists the device's conversations). Devices never see each
// other's folders or history. Group chat, its CLIs and their state are not touched.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { sandboxCommand } = require('./sandbox');
const cliHistory = require('./cli-history');
const { BINS, HOME_NAMES, projectFolderName } = require('./native-tui');

const STATE = '/var/lib/agentdesk-orchestrator';
const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity'];
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHAT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const BILLING = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
  'GROK_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function parseRequest(original = '', env = process.env) {
  const device = env.AGENTDESK_DEVICE;
  if (!DEVICE.test(device || '')) throw new Error('cli_device_missing');
  if (typeof original !== 'string' || original.length > 600 || /[^\x20-\x7e]/.test(original)) throw new Error('cli_request_invalid');
  const words = original.trim().split(/ +/);
  if (words.length !== 6 || words[0] !== 'cli') throw new Error('cli_request_invalid');
  const [, provider, chatId, projectId, nameHex, mode] = words;
  if (!PROVIDERS.includes(provider)) throw new Error('cli_provider_invalid');
  if (!CHAT.test(chatId) || !CHAT.test(projectId)) throw new Error('cli_chat_invalid');
  if (!/^(?:[a-f0-9]{2}){1,240}$/.test(nameHex)) throw new Error('cli_name_invalid');
  if (!['write', 'read'].includes(mode)) throw new Error('cli_mode_invalid');
  return { device, platform: env.AGENTDESK_PLATFORM === 'darwin' ? 'darwin' : 'win32', provider, chatId, projectId,
    name: projectFolderName(Buffer.from(nameHex, 'hex').toString('utf8')), writable: mode === 'write' };
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  const temp = file + '.' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(temp, file);
}
const list = (folder) => { try { return fs.readdirSync(folder); } catch { return []; } };

function prompt({ platform, writable, cwd }) {
  const computer = platform === 'darwin' ? 'Mac' : 'Windows';
  return [`[AgentDesk 原生 CLI 单聊｜${writable ? '可修改' : '只读规划'}]`,
    `- 你运行在 VPS2 上，工作目录 ${cwd} 是这台设备这个项目在 VPS2 上的文件夹（不是用户电脑）。`,
    `- 需要用户 ${computer} 电脑上的文件、程序或环境时，用 \`ssh pc '<命令>'\` 在用户电脑上执行（已开通反向 ssh 时可用；不可用就告诉用户在 AgentDesk「帮助」里开通）。`,
    '- 是否批准每个操作由用户在你的界面里决定，按你平常的方式请求批准即可。'].join('\n');
}

// The conversation this chat continues: Claude and Grok take an id we choose; Codex and Antigravity name their own,
// found after the first run (newest one in this chat's folder / this device's history, made after it started).
function sessionArgs(provider, record) {
  if (provider === 'claude' || provider === 'grok') {
    return record.started ? ['--resume', record.session] : ['--session-id', record.session];
  }
  if (provider === 'antigravity') return record.session ? ['--conversation', record.session] : [];
  return [];
}

function findNewSession(provider, { home, historyRoot, cwd, since }) {
  if (provider === 'codex') {
    const root = path.join(home, '.codex', 'sessions');
    const desc = (items) => items.filter((item) => /^\d+$/.test(item)).sort().reverse();
    for (const year of desc(list(root)).slice(0, 2)) for (const month of desc(list(path.join(root, year))).slice(0, 2)) {
      for (const day of desc(list(path.join(root, year, month))).slice(0, 3)) {
        const folder = path.join(root, year, month, day);
        for (const file of list(folder).filter((item) => item.endsWith('.jsonl')).sort().reverse()) {
          const full = path.join(folder, file);
          try {
            if (fs.statSync(full).mtimeMs < since) continue;
            const fd = fs.openSync(full, 'r');
            const buffer = Buffer.alloc(65536);
            const text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
            fs.closeSync(fd);
            const meta = JSON.parse(text.slice(0, text.indexOf('\n') >>> 0));
            if (meta?.payload?.cwd === cwd && typeof meta.payload.id === 'string') return meta.payload.id;
          } catch {}
        }
      }
    }
  }
  if (provider === 'antigravity') {
    const folder = path.join(historyRoot, '.gemini', 'antigravity-cli', 'conversations');
    const fresh = list(folder).filter((file) => file.endsWith('.db'))
      .map((file) => ({ id: file.slice(0, -3), at: (() => { try { return fs.statSync(path.join(folder, file)).birthtimeMs || fs.statSync(path.join(folder, file)).mtimeMs; } catch { return 0; } })() }))
      .filter((item) => item.at >= since).sort((a, b) => b.at - a.at);
    return fresh[0]?.id || null;
  }
  return null;
}

function plan(request, { record, fresh = false, env = process.env } = {}) {
  const { device, provider, projectId, name, writable, platform } = request;
  const home = path.join(STATE, 'homes', provider === 'codex' ? 'codex' : HOME_NAMES[provider]);
  const deviceRoot = path.join(STATE, 'cli-chats', device);
  const workspace = path.join(deviceRoot, 'work', projectId);
  const historyRoot = path.join(deviceRoot, 'history');
  const runtime = fs.mkdtempSync(path.join('/var/tmp', 'agentdesk-cli-'));
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
  const cwd = `/work/${name}`;
  const text = prompt({ platform, writable, cwd });
  const args = [];
  const roBinds = [];
  const extraWritable = [];
  if (provider === 'claude') {
    args.push('--append-system-prompt', text, ...(writable ? [] : ['--permission-mode', 'plan']));
  } else if (provider === 'codex') {
    args.push('-c', `developer_instructions=${JSON.stringify(text)}`, '-c', 'web_search="live"',
      '--sandbox', writable ? 'workspace-write' : 'read-only');
  } else if (provider === 'grok') {
    const source = path.join(STATE, 'homes', 'grok', '.grok', 'auth.json');
    const target = path.join(home, '.grok', 'auth.json');
    try { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(source, target); fs.chmodSync(target, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const leader = fs.mkdtempSync(path.join(runtime, 'grok-leader-'));
    extraWritable.push(leader);
    args.push('--no-auto-update', '--rules', text, '--leader-socket', path.join(leader, 'grok.sock'),
      ...(writable ? [] : ['--permission-mode', 'plan']));
  } else {
    args.push(...(writable ? [] : ['--mode', 'plan']));
  }
  if (!fresh) args.push(...sessionArgs(provider, record));
  else if (provider === 'claude' || provider === 'grok') args.push('--session-id', record.session);
  if (provider === 'codex' && !fresh && record.session) args.unshift('resume', record.session);
  const history = provider === 'codex' ? [] : cliHistory.binds(provider, home, historyRoot);
  const launch = sandboxCommand(BINS[provider], args, { cwd: workspace, home, writable, hide: [STATE], extraWritable });
  const chdir = launch.args.indexOf('--chdir');
  launch.args.splice(chdir - 3, 5, writable ? '--bind' : '--ro-bind', fs.realpathSync(workspace), cwd, '--chdir', cwd);
  launch.args.splice(launch.args.indexOf('--chdir'), 0, ...cliHistory.bwrapArgs(history),
    ...roBinds.flatMap(([source, target]) => ['--ro-bind', source, target]));
  const childEnv = { ...env, HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', COLORTERM: env.COLORTERM || 'truecolor',
    TERM: /^[\w.-]{1,40}$/.test(env.TERM || '') ? env.TERM : 'xterm-256color', AGENTDESK_NATIVE_CLI: '1',
    PATH: '/opt/agentdesk-orchestrator:/usr/local/bin:/usr/bin:/bin' };
  if (provider === 'codex') childEnv.CODEX_HOME = path.join(home, '.codex');
  for (const key of [...BILLING, 'SSH_ORIGINAL_COMMAND', 'SSH_CONNECTION', 'SSH_CLIENT', 'GROK_HOME', 'NO_COLOR']) delete childEnv[key];
  return { command: launch.command, args: launch.args, env: childEnv, runtime, home, historyRoot, cwd };
}

// `upload <projectId> <nameHex>`: the file on stdin goes to .uploads/ in this device's project folder (no terminal),
// and the path the CLI sees is printed. 25 MB at most.
function upload(original, env = process.env) {
  const device = env.AGENTDESK_DEVICE;
  const words = String(original || '').trim().split(/ +/);
  if (!DEVICE.test(device || '') || words.length !== 4 || words[0] !== 'upload' || !CHAT.test(words[1]) ||
      !/^(?:[a-f0-9]{2}){1,240}$/.test(words[2]) || !/^(?:[a-f0-9]{2}){1,240}$/.test(words[3])) {
    process.stderr.write('upload_request_invalid\n'); process.exit(2);
  }
  const project = projectFolderName(Buffer.from(words[2], 'hex').toString('utf8'));
  const base = path.basename(Buffer.from(words[3], 'hex').toString('utf8')).normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(-80) || 'file';
  const folder = path.join(STATE, 'cli-chats', device, 'work', words[1], '.uploads');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  let target = path.join(folder, base);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(folder, base.replace(/(\.[^.]*)?$/, `-${n}$1`));
  const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
  let size = 0;
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) { out.destroy(); fs.rmSync(target, { force: true }); process.stderr.write('upload_too_large\n'); process.exit(3); }
    out.write(chunk);
  });
  process.stdin.on('end', () => out.end(() => process.stdout.write(`/work/${project}/.uploads/${path.basename(target)}\n`)));
}

// Each chat's CLI lives in a dtach session on VPS2: a dropped connection detaches it instead of ending it, and the
// next connection attaches to the same running CLI (-r winch makes it redraw for the new window). dtach passes the
// terminal through untouched (unlike tmux), so the screen stays the CLI's own. -E: no detach key; -z: no suspend key.
const DTACH = '/usr/bin/dtach';
const socketFor = (request) => path.join(STATE, 'cli-chats', request.device, 'sessions', `${request.provider}-${request.chatId}.sock`);
const metaFor = (request) => socketFor(request).replace(/\.sock$/, '.json');

function alive(socket) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socket)) { resolve(false); return; }
    const probe = require('node:net').connect(socket);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => { try { fs.unlinkSync(socket); } catch {} resolve(false); });
  });
}

function stopSession(request) {
  const meta = readJson(metaFor(request), null);
  if (meta?.pid) { try { process.kill(meta.pid, 'SIGTERM'); } catch {} }
  setTimeout(() => { try { if (meta?.pid) process.kill(meta.pid, 'SIGKILL'); } catch {} }, 3000).unref?.();
  try { fs.unlinkSync(metaFor(request)); } catch {}
}

// `stop <provider> <chatId>`: ends that chat's running CLI (结束, switching mode, deleting the chat).
async function stop(original, env) {
  const words = String(original).trim().split(/ +/);
  if (words.length !== 3 || !PROVIDERS.includes(words[1]) || !CHAT.test(words[2]) || !DEVICE.test(env.AGENTDESK_DEVICE || '')) {
    process.stderr.write('stop_request_invalid\n'); process.exit(2);
  }
  stopSession({ device: env.AGENTDESK_DEVICE, provider: words[1], chatId: words[2] });
  process.stdout.write('stopped\n');
}

async function main() {
  const original = String(process.env.SSH_ORIGINAL_COMMAND || '');
  if (original.startsWith('upload ')) { upload(original); return; }
  if (original.startsWith('stop ')) { await stop(original, process.env); return; }
  let request;
  try { request = parseRequest(original, process.env); }
  catch (error) { process.stderr.write(`AgentDesk：原生 CLI 请求无效（${error.message}）\r\n`); process.exit(2); }
  if (process.env.AGENTDESK_CLI_INNER !== '1') {
    const socket = socketFor(request);
    fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    if (await alive(socket)) {
      // A CLI started in another mode is restarted in the one asked for (its conversation continues).
      if (readJson(metaFor(request), {}).mode !== (request.writable ? 'write' : 'read')) {
        stopSession(request);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    const attach = await alive(socket);
    const args = attach ? ['-a', socket, '-r', 'winch', '-E', '-z'] : ['-A', socket, '-r', 'winch', '-E', '-z', process.execPath, __filename];
    const child = spawn(DTACH, args, { stdio: 'inherit', env: { ...process.env, AGENTDESK_CLI_INNER: '1' } });
    child.on('exit', (code) => process.exit(code ?? 0));
    for (const name of ['SIGINT', 'SIGQUIT', 'SIGTSTP']) process.on(name, () => {});
    return;
  }
  // Inside the dtach session: the CLI itself.
  try { writeJson(metaFor(request), { pid: process.pid, mode: request.writable ? 'write' : 'read', at: new Date().toISOString() }); } catch {}
  const chatsFile = path.join(STATE, 'cli-chats', request.device, 'chats.json');
  fs.mkdirSync(path.dirname(chatsFile), { recursive: true, mode: 0o700 });
  const chats = readJson(chatsFile, {});
  const key = request.provider + ':' + request.chatId;
  const record = chats[key] || { session: randomUUID(), started: false };
  let child;
  let stopping = false;
  const run = (fresh) => {
    const started = Date.now();
    const resuming = !fresh && ((request.provider === 'claude' || request.provider === 'grok') ? record.started : Boolean(record.session));
    const launch = plan(request, { record, fresh });
    child = spawn(launch.command, launch.args, { stdio: 'inherit', env: launch.env, cwd: '/' });
    child.on('error', (error) => { process.stderr.write(`AgentDesk：启动失败（${error.code || error.message}）\r\n`); process.exit(70); });
    child.on('exit', (code, signal) => {
      const quick = Date.now() - started < 10_000;
      if (!stopping && resuming && quick && code) {
        process.stdout.write('\x1b[?1049l\x1b[2J\x1b[H\x1b[2mAgentDesk：上次的对话无法继续，正在开始新对话…\x1b[0m\r\n');
        if (request.provider === 'codex' || request.provider === 'antigravity') record.session = null;
        else record.session = randomUUID();
        record.started = false;
        run(true);
        return;
      }
      // Remember the conversation so the chat continues it next time.
      if (request.provider === 'claude' || request.provider === 'grok') {
        record.started = record.started || !quick || code === 0;
      } else if (!record.session) {
        record.session = findNewSession(request.provider, { home: launch.home, historyRoot: launch.historyRoot, cwd: launch.cwd, since: started - 1000 });
      }
      const latest = readJson(chatsFile, {});
      latest[key] = { ...record, at: new Date().toISOString() };
      try { writeJson(chatsFile, latest); } catch {}
      fs.rmSync(launch.runtime, { recursive: true, force: true });
      try { if (readJson(metaFor(request), {}).pid === process.pid) fs.unlinkSync(metaFor(request)); } catch {}
      process.exit(signal ? 128 + 1 : code ?? 1);
    });
  };
  run(false);
  for (const name of ['SIGHUP', 'SIGTERM']) process.on(name, () => { stopping = true; try { child.kill(name); } catch {} });
  for (const name of ['SIGINT', 'SIGQUIT', 'SIGTSTP']) process.on(name, () => {});
}

if (require.main === module) main().catch((error) => { process.stderr.write(`AgentDesk：${error.message}\r\n`); process.exit(1); });

module.exports = { parseRequest, plan, sessionArgs, findNewSession, socketFor };
