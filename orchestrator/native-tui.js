// Native CLI single chats: the official CLI (Claude Code, Codex, Grok Build, Antigravity) runs in its own TUI
// on VPS2, in a pseudo-terminal, and the person sees and types into exactly that screen in AgentDesk.
//
//   AgentDesk (Windows / Mac)                         VPS2 (root codex app-server carrier, private mount ns)
//   xterm ── 't' keystrokes / screen bytes ────────── native-tui-host.js ── pty-run.py ── [setpriv] ──
//   Worker SFTP ── 's' ──────────────────────────────  sshfs mount of the project      native-tui-launch.js ── bwrap ── CLI
//   local_shell / terminal / admin ── 'm' tool relay ─ unix socket ── chat-mcp.js (MCP server "agentdesk" in the CLI)
//   uploads (drag, paste) ── 'u' ───────────────────── /uploads (read-only in the sandbox)
//
// Everything about the conversation is the CLI's own: its screen, slash commands, model picker, permission prompts
// (approval of its own tools and of the agentdesk tools that reach the person's computer), /resume and history.
// AgentDesk adds the connection, the project mount, the reach back to the computer, uploads and reconnects.
//
// This file holds the pure parts (validation, prompt, per-CLI command line) shared by the host and the launcher.
const fs = require('node:fs');
const path = require('node:path');

const TUI_PROVIDERS = Object.freeze(['claude', 'codex', 'grok', 'antigravity']);
const PLATFORMS = Object.freeze(['win32', 'darwin']);
const MCP_SERVER = 'agentdesk';
const UPLOADS = '/uploads';
const WORK = '/work';
const BINS = { claude: 'claude', codex: 'codex', grok: 'grok', antigravity: 'agy' };
const HOME_NAMES = { claude: 'claude', grok: 'grok-chat', antigravity: 'antigravity' };

// The project folder's name as the CLI shows it (/work/<name>): letters, digits and a few marks; anything else
// becomes "_". Never empty, never "." or "..".
function projectFolderName(raw) {
  const name = String(raw || '').normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  return !name || /^\.+$/.test(name) ? 'project' : name;
}

// Codex keeps every device's sessions in one CODEX_HOME and filters /resume by working folder, so its folder
// carries part of the session key; the others keep a private history per session and get the plain name.
function workFolder(provider, name, sessionKey) {
  const folder = projectFolderName(name);
  return provider === 'codex' ? `${WORK}/${sessionKey.slice(0, 8)}/${folder}` : `${WORK}/${folder}`;
}

function tuiPrompt({ platform = 'win32', writable = true, tools = [] } = {}) {
  const mac = platform === 'darwin';
  const computer = mac ? 'Mac' : 'Windows';
  const names = new Set(tools);
  const lines = [`[AgentDesk 原生 CLI 单聊｜${computer}｜${writable ? '可修改' : '只读规划'}]`,
    `- 当前工作目录是用户 ${computer} 电脑上的项目，经 AgentDesk 挂载到 VPS2 上${writable ? '；改动直接写到用户电脑的磁盘' : '（只读）'}。`,
    '- 你自己的 shell 运行在 VPS2 的沙盒里（可以联网），不是用户电脑；需要用户电脑上的工具链、凭据或程序时用 agentdesk 服务器的工具。'];
  if (names.has('local_shell')) lines.push(`- agentdesk 的 local_shell 在用户电脑上运行命令（${mac ? 'zsh 或 bash' : 'PowerShell 或 CMD'}，工作目录是这个项目）；长命令放后台，用 runId 查看。`);
  if (names.has('terminal')) lines.push('- agentdesk 的 terminal 在用户电脑上开一个持续的交互式终端（REPL、需要输入的程序）。');
  if (names.has('agentdesk_admin_shell')) lines.push('- agentdesk_admin_shell 用管理员 PowerShell 执行；只在确实需要管理员权限时用，写清 reason。用户会先看到 AgentDesk 弹窗再看到 Windows 管理员确认；用户拒绝就停下说明，不要索要密码。');
  lines.push(`- 用户拖进来或粘贴的文件在 ${UPLOADS}/ 下（只读）。`,
    '- 是否批准每个操作由用户在你的界面里决定，按你平常的方式请求批准即可。');
  return lines.join('\n');
}

const tomlString = (value) => JSON.stringify(String(value));

// Has this session a conversation to continue? Looked up in the session's own history (Codex: its rollouts).
function readHead(file, size = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, size, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function previousConversation(provider, { historyRoot, codexHome, cwd, readdir = fs.readdirSync, head = readHead } = {}) {
  const list = (folder) => { try { return readdir(folder); } catch { return []; } };
  if (provider === 'claude') {
    const projects = path.join(historyRoot, '.claude', 'projects');
    return list(projects).some((folder) => list(path.join(projects, folder)).some((file) => file.endsWith('.jsonl'))) ? true : null;
  }
  if (provider === 'grok') {
    // Grok makes a session folder at startup; only one with messages can be continued.
    const sessions = path.join(historyRoot, '.grok', 'sessions');
    const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
    return list(sessions).some((folder) => list(path.join(sessions, folder))
      .some((id) => size(path.join(sessions, folder, id, 'chat_history.jsonl')) > 0)) ? true : null;
  }
  if (provider === 'antigravity') {
    return list(path.join(historyRoot, '.gemini', 'antigravity-cli', 'conversations')).some((file) => file.endsWith('.db')) ? true : null;
  }
  if (provider === 'codex') {
    // Newest first: sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl, the first line is session_meta with the cwd.
    const root = path.join(codexHome, 'sessions');
    const desc = (items) => items.filter((item) => /^\d+$/.test(item)).sort().reverse();
    let scanned = 0;
    for (const year of desc(list(root))) for (const month of desc(list(path.join(root, year)))) {
      for (const day of desc(list(path.join(root, year, month)))) {
        const folder = path.join(root, year, month, day);
        for (const file of list(folder).filter((item) => /^rollout-.*\.jsonl$/.test(item)).sort().reverse()) {
          if (++scanned > 4000) return null;
          let first = '';
          try {
            const text = head(path.join(folder, file));
            first = text.includes('\n') ? text.slice(0, text.indexOf('\n')) : text;
          } catch { continue; }
          try {
            const meta = JSON.parse(first);
            if (meta?.payload?.cwd === cwd && typeof meta.payload.id === 'string') return meta.payload.id;
          } catch {}
        }
      }
    }
    return null;
  }
  return null;
}

// The CLI's own command line for an interactive session. `resume` is true / a session id (Codex) / null.
function cliArgs(provider, { prompt, mcp, writable, resume, model, leaderSocket } = {}) {
  if (provider === 'claude') {
    return ['--mcp-config', JSON.stringify({ mcpServers: { [MCP_SERVER]: mcp } }), '--append-system-prompt', prompt,
      ...(writable ? [] : ['--permission-mode', 'plan']), ...(model ? ['--model', model] : []), ...(resume ? ['--continue'] : [])];
  }
  if (provider === 'codex') {
    const config = ['-c', `mcp_servers.${MCP_SERVER}.command=${tomlString(mcp.command)}`,
      '-c', `mcp_servers.${MCP_SERVER}.args=[${mcp.args.map(tomlString).join(', ')}]`,
      '-c', `mcp_servers.${MCP_SERVER}.tool_timeout_sec=900`,
      '-c', `developer_instructions=${tomlString(prompt)}`, '-c', 'web_search="live"',
      '--sandbox', writable ? 'workspace-write' : 'read-only', ...(model ? ['--model', model] : [])];
    return typeof resume === 'string' ? ['resume', resume, ...config] : config;
  }
  if (provider === 'grok') {
    return ['--no-auto-update', '--rules', prompt, ...(leaderSocket ? ['--leader-socket', leaderSocket] : []),
      ...(writable ? [] : ['--permission-mode', 'plan']), ...(model ? ['--model', model] : []), ...(resume ? ['--continue'] : [])];
  }
  if (provider === 'antigravity') {
    return [...(writable ? [] : ['--mode', 'plan']), ...(model ? ['--model', model] : []), ...(resume ? ['--continue'] : [])];
  }
  throw new Error('tui_provider_invalid');
}

function grokMcpToml(mcp) {
  return `[mcp_servers.${MCP_SERVER}]\ncommand = ${tomlString(mcp.command)}\nargs = [\n`
    + mcp.args.map((arg) => `    ${tomlString(arg)},\n`).join('') + ']\nenabled = true\n';
}

// Validates the host's command line: provider mode sessionKey platform nameHex cols rows.
function parseHostArgs(argv) {
  const [provider, mode, sessionKey, platform, nameHex, cols, rows] = argv;
  if (!TUI_PROVIDERS.includes(provider)) throw new Error('tui_provider_invalid');
  if (!['read', 'write'].includes(mode)) throw new Error('tui_mode_invalid');
  if (!/^[a-f0-9]{64}$/.test(sessionKey || '')) throw new Error('tui_session_key_invalid');
  if (!PLATFORMS.includes(platform)) throw new Error('tui_platform_invalid');
  if (!/^(?:[a-f0-9]{2}){1,240}$/.test(nameHex || '')) throw new Error('tui_name_invalid');
  const size = (value, low, high) => {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error('tui_size_invalid');
    return Math.max(low, Math.min(high, number));
  };
  return { provider, mode, sessionKey, platform, name: projectFolderName(Buffer.from(nameHex, 'hex').toString('utf8')),
    cols: size(cols, 10, 1000), rows: size(rows, 4, 500) };
}

module.exports = { TUI_PROVIDERS, PLATFORMS, MCP_SERVER, UPLOADS, WORK, BINS, HOME_NAMES, projectFolderName, workFolder,
  tuiPrompt, previousConversation, cliArgs, grokMcpToml, parseHostArgs };
