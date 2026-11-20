#!/usr/bin/env node
// 单聊服务：对 Electron 提供 Codex app-server 的兼容子集，每轮在 VPS 上 spawn 一次 CLI。
// 本机文件工具不在 VPS 执行：CLI 通过 chat-mcp.js -> Unix socket 请求，再由 App 在主进程执行。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { Lines } = require('./transport');
const { sandboxCommand } = require('./sandbox');
const { captureClaudeRateLimitEvent } = require('./quotas');
const { validAttachments, attachmentLimit, maxAttachments, idPattern, attachmentNote } = require('./attachments');
const { writeTextCopy } = require('./extract');
const { pruneThreads } = require('./chat-retention');

// Attachments are read through this tool, served here on the VPS, so every chat can read them whether or not
// the CLI runs in the sandbox with its own file tools. Images come back as images the model can look at.
const ATTACHMENT_TOOL = {
  name: 'agentdesk_attachment_read',
  description: 'Read a file the user attached to this message (any type). Images are returned as images; text, ' +
    'code, Office documents, PDFs and archive listings as text, in pages of up to 60000 characters (use offset for the next page); ' +
    'other binary files as a short description.',
  inputSchema: { type: 'object', properties: {
    file: { type: 'string', description: 'The attachment name, as listed in the message' },
    offset: { type: 'integer', minimum: 0, description: 'Character offset of the text page to read (default 0)' },
  }, required: ['file'], additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const PAGE = 60000;

function pdfText(file) {
  try {
    return require('node:child_process').execFileSync('pdftotext', ['-layout', '-q', file, '-'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  } catch { return undefined; }
}

// Returns MCP content for one attachment of this turn.
function readAttachmentContent(turn, args) {
  const files = turn.attachments || [];
  const wanted = String(args.file ?? '');
  const file = files.find((item) => item.name === wanted) || files.find((item) => path.basename(item.path) === wanted) ||
    (files.length === 1 ? files[0] : undefined);
  if (!file) throw new Error('没有这个附件。本条消息的附件：' + (files.map((item) => item.name).join('、') || '无'));
  const extension = path.extname(file.name).toLowerCase();
  const bytes = fs.readFileSync(file.path);
  const image = IMAGE_TYPES[extension];
  if (image && bytes.length <= 8 * 1024 * 1024) {
    return [{ type: 'text', text: `${file.name}（图片，${bytes.length} 字节）` }, { type: 'image', data: bytes.toString('base64'), mimeType: image }];
  }
  let text;
  if (file.text) text = fs.readFileSync(file.text, 'utf8');
  else if (extension === '.pdf') text = pdfText(file.path) ?? `${file.name} 是 PDF，这台 VPS 上没有 pdftotext，无法提取文字。`;
  else if (!bytes.subarray(0, 8192).includes(0)) text = bytes.toString('utf8');
  else {
    return [{ type: 'text', text: `${file.name}：二进制文件，${bytes.length} 字节，sha256 ${createHash('sha256').update(bytes).digest('hex')}，` +
      `开头 32 字节 ${bytes.subarray(0, 32).toString('hex')}。${SANDBOX ? '可以在 VPS 工作目录用 shell 处理它：' + file.path : '无法以文本显示。'}` }];
  }
  const offset = Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 0;
  const page = text.slice(offset, offset + PAGE);
  const more = offset + PAGE < text.length ? `\n\n[还有 ${text.length - offset - PAGE} 个字符，用 offset=${offset + PAGE} 继续读]` : '';
  return [{ type: 'text', text: `${file.name}${offset ? `（从第 ${offset} 个字符起）` : ''}：\n${page}${more}` }];
}

const PROVIDER = String(process.argv[2] || '');
const PROVIDERS = new Set(['claude', 'grok', 'antigravity']);
if (!PROVIDERS.has(PROVIDER)) {
  process.stderr.write('chat-server: provider must be claude, grok or antigravity\n');
  process.exit(2);
}

const STATE_DIR = process.env.AGENTDESK_CHAT_STATE || '/var/lib/agentdesk-orchestrator';
const THREADS_DIR = path.join(STATE_DIR, 'chat-workspace', 'threads');
const incoming = new Map();
const device = process.env.AGENTDESK_CHAT_DEVICE || '';
if (device && !/^[a-z0-9_]{1,20}$/.test(device)) throw new Error('invalid chat device');
const instance = device ? `chat-${PROVIDER}-${device}` : `chat-${PROVIDER}`;
const SOCKET = path.join(STATE_DIR, `${instance}.sock`);
const STATE_FILE = path.join(STATE_DIR, `${instance}.json`);
// Claude Code reports the account's rate limits on every headless turn. The direct chat writes them where
// quota_status already reads them (adapters.claude.quotaFile), so the 5-hour and weekly windows stay current.
const CLAUDE_QUOTA_FILE = process.env.AGENTDESK_CHAT_CLAUDE_QUOTA || path.join(STATE_DIR, 'claude-quotas.json');
const MCP_JS = path.join(__dirname, 'chat-mcp.js');
const TURN_TIMEOUT = Number(process.env.AGENTDESK_CHAT_TURN_TIMEOUT || 30 * 60_000);
const OUTPUT_LIMIT = Number(process.env.AGENTDESK_CHAT_OUTPUT_LIMIT || 4 * 1024 * 1024);
const TOOL_TIMEOUT = Number(process.env.AGENTDESK_CHAT_TOOL_TIMEOUT || 65_000);
const APPROVAL_TIMEOUT = Number(process.env.AGENTDESK_CHAT_APPROVAL_TIMEOUT || 60_000);
const READ_ONLY_TOOLS = new Set(['agentdesk_file_list', 'agentdesk_file_read', 'agentdesk_command_list']);
// Running one of the person's authorized commands on their computer asks for approval, like a file change.
const WRITE_TOOLS = new Set([
  'agentdesk_file_write', 'agentdesk_file_mkdir', 'agentdesk_file_copy', 'agentdesk_file_move', 'agentdesk_file_trash',
  'agentdesk_command_run',
]);
const CHAT_TOOL = /^(?:agentdesk_(?:file|command)_[a-z]+|desktop_[a-z_]+)$/;
// 实测各 CLI 接受的推理强度：Claude/Antigravity 还接受 max，Grok 最高为 xhigh。
const EFFORTS = {
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  grok: new Set(['low', 'medium', 'high', 'xhigh']),
  antigravity: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
}[PROVIDER];
// AGENTDESK_CHAT_SANDBOX (path of bwrap): the CLI runs inside bubblewrap and may use its own shell and file tools
// in this conversation's VPS workspace, as Codex does in its sandbox. Without it those stay off.
const SANDBOX = process.env.AGENTDESK_CHAT_SANDBOX || '';
const BIN = {
  claude: process.env.AGENTDESK_CHAT_CLAUDE_BIN || 'claude',
  grok: process.env.AGENTDESK_CHAT_GROK_BIN || 'grok',
  antigravity: process.env.AGENTDESK_CHAT_ANTIGRAVITY_BIN || 'agy',
}[PROVIDER];

const HOME = {
  claude: process.env.AGENTDESK_CHAT_HOME_CLAUDE || path.join(STATE_DIR, 'homes', 'claude'),
  grok: process.env.AGENTDESK_CHAT_HOME_GROK || path.join(STATE_DIR, 'homes', 'grok-chat'),
  antigravity: process.env.AGENTDESK_CHAT_HOME_ANTIGRAVITY || path.join(STATE_DIR, 'homes', 'antigravity'),
}[PROVIDER];

// Web search and fetch are on for every provider, as for Codex. Shell and the CLI's own file tools are on only
// in the sandbox; editing ones only when the turn may write.
const CLAUDE_WEB = ['WebSearch', 'WebFetch'];
const CLAUDE_SHELL_READ = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep'];
const CLAUDE_SHELL_WRITE = ['Edit', 'Write', 'NotebookEdit'];
const CLAUDE_DISALLOWED = ['Task', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
const GROK_WEB = ['web_search', 'web_fetch'];
const GROK_SHELL_READ = ['run_terminal_command', 'get_command_or_subagent_output', 'kill_command_or_subagent', 'read_file', 'list_dir', 'grep'];
const GROK_SHELL_WRITE = ['write', 'search_replace'];
const GROK_DISALLOWED = [
  'spawn_subagent', 'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor',
  'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video',
];

function log(...parts) {
  try { process.stderr.write(`[chat-${PROVIDER}] ${parts.join(' ')}\n`); } catch {}
}

function fail(message, code = -32603) {
  return Object.assign(new Error(message), { code });
}

/* ---------- 状态持久化 ---------- */
function initialState() { return { version: 1, threads: {} }; }

function loadState() {
  let text;
  try { text = fs.readFileSync(STATE_FILE, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return initialState();
    log('state_read_failed', error.message);
    return initialState();
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('state must be an object');
    if (!value.threads || typeof value.threads !== 'object' || Array.isArray(value.threads)) value.threads = {};
    return { version: 1, threads: value.threads };
  } catch (error) {
    log('state_parse_failed', error.message);
    try { fs.renameSync(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`); } catch {}
    return initialState();
  }
}

const state = loadState();
const activeTurns = new Map();       // threadId -> turn
const capabilities = new Map();      // capability -> turn
let antigravityTurn = null;          // Antigravity shares one user-level MCP config, so only one turn at a time
const pendingClient = new Map();     // JSON-RPC id -> { turn, resolve, reject, timer }
let nextClientId = 1;
let stdoutClosed = false;
let shuttingDown = false;

function persist() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${STATE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, STATE_FILE);
    try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
  } catch (error) {
    log('state_write_failed', error.message);
  }
}

// Drop single-chat threads that have not been used for the history window, along with their scratch folder.
// Runs at start-up and whenever the app reconnects, so a long-running chat server still expires old threads.
function pruneExpiredThreads() {
  const expired = pruneThreads(state);
  if (!expired.length) return;
  persist();
  for (const id of expired) {
    try { fs.rmSync(path.join(THREADS_DIR, id), { recursive: true, force: true }); } catch {}
  }
}
pruneExpiredThreads();

/* ---------- 与 Electron 的 JSON-RPC ---------- */
function send(frame) {
  if (stdoutClosed) return false;
  try {
    process.stdout.write(JSON.stringify(frame) + '\n');
    return true;
  } catch (error) {
    stdoutClosed = true;
    log('stdout_failed', error.message);
    shutdown('stdout_failed');
    return false;
  }
}

function notify(method, params) {
  return send({ jsonrpc: '2.0', method, params });
}

function clientRequest(turn, method, params, timeout) {
  if (turn.finished) return Promise.reject(new Error('turn_finished'));
  const id = nextClientId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingClient.delete(id);
      turn.pending.delete(id);
      reject(new Error('client_request_timeout'));
    }, timeout);
    timer.unref?.();
    pendingClient.set(id, { turn, resolve, reject, timer });
    turn.pending.add(id);
    if (!send({ jsonrpc: '2.0', id, method, params })) {
      clearTimeout(timer);
      pendingClient.delete(id);
      turn.pending.delete(id);
      reject(new Error('transport_closed'));
    }
  });
}

function rejectPending(turn, error) {
  for (const id of [...turn.pending]) {
    const entry = pendingClient.get(id);
    if (!entry) continue;
    clearTimeout(entry.timer);
    pendingClient.delete(id);
    turn.pending.delete(id);
    entry.reject(error);
  }
}

function settleClientResponse(frame) {
  if (frame.id === undefined || frame.method !== undefined) return false;
  const entry = pendingClient.get(frame.id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingClient.delete(frame.id);
  entry.turn.pending.delete(frame.id);
  if (frame.error) entry.reject(new Error(frame.error.message || 'client_request_failed'));
  else entry.resolve(frame.result);
  return true;
}

/* ---------- 工具与线程元数据 ---------- */
function cleanTool(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  if (typeof tool.name !== 'string' || !CHAT_TOOL.test(tool.name)) return null;
  const inputSchema = tool.inputSchema;
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return null;
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description.slice(0, 2000) : tool.name,
    inputSchema,
    annotations: { readOnlyHint: !isWriteTool(tool.name) },
  };
}

function normalizeTools(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const tools = [];
  for (const value of list.slice(0, 64)) {
    const tool = cleanTool(value);
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  if (Buffer.byteLength(JSON.stringify(tools)) > 128 * 1024) throw fail('dynamic_tools_too_large');
  return tools;
}

function normalizeApproval(value) {
  return ['never', 'on-request', 'on-failure', 'untrusted'].includes(value) ? value : 'on-request';
}

function normalizeSandbox(value) {
  const type = value && typeof value === 'object' ? value.type : null;
  if (type === 'readOnly') return { type: 'readOnly', networkAccess: false };
  if (type === 'dangerFullAccess') return { type: 'dangerFullAccess' };
  return { type: 'workspaceWrite' };
}

function readOnlyOf(sandboxPolicy) {
  return sandboxPolicy?.type === 'readOnly';
}

function threadById(id) {
  if (typeof id !== 'string' || !/^(claude|grok|antigravity)-[0-9a-f-]{36}$/.test(id)) return null;
  return state.threads[id] || null;
}

function workspaceFor(threadId) {
  fs.mkdirSync(THREADS_DIR, { recursive: true, mode: 0o700 });
  const folder = path.join(THREADS_DIR, threadId);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

function freshSession() {
  return PROVIDER === 'antigravity' ? null : randomUUID();
}

function setSession(turn, id) {
  if (typeof id !== 'string' || !id || id.length > 256) return;
  turn.sessionSeen = true;
  if (turn.thread.sessionId !== id) {
    turn.thread.sessionId = id;
    turn.thread.updatedAt = Date.now();
    persist();
  }
}

function resetSession(thread) {
  thread.sessionId = freshSession();
  thread.started = false;
  delete thread.instructionsSent;
  thread.updatedAt = Date.now();
  persist();
}

/* ---------- 流式条目 ---------- */
function addAgentDelta(turn, text) {
  if (turn.finished || typeof text !== 'string' || !text) return;
  if (!turn.agentItemId) {
    turn.agentItemId = 'msg_' + randomUUID();
    notify('item/started', {
      threadId: turn.threadId,
      turnId: turn.id,
      item: { id: turn.agentItemId, type: 'agentMessage', text: '' },
    });
  }
  turn.agentText += text;
  for (let i = 0; i < text.length; i += 4000) {
    notify('item/agentMessage/delta', {
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: turn.agentItemId,
      delta: text.slice(i, i + 4000),
    });
  }
}

function addReasoningDelta(turn, text) {
  if (turn.finished || typeof text !== 'string' || !text) return;
  if (!turn.reasoningItemId) {
    turn.reasoningItemId = 'reason_' + randomUUID();
    notify('item/started', {
      threadId: turn.threadId,
      turnId: turn.id,
      item: { id: turn.reasoningItemId, type: 'reasoning', summary: [] },
    });
  }
  turn.reasoningText += text;
  for (let i = 0; i < text.length; i += 4000) {
    notify('item/reasoning/summaryTextDelta', {
      threadId: turn.threadId,
      turnId: turn.id,
      itemId: turn.reasoningItemId,
      delta: text.slice(i, i + 4000),
      summaryIndex: 0,
    });
  }
}

function finishReasoning(turn) {
  if (turn.finished) return;
  if (turn.reasoningItemId) {
    notify('item/completed', {
      threadId: turn.threadId,
      turnId: turn.id,
      item: { id: turn.reasoningItemId, type: 'reasoning', summary: [turn.reasoningText] },
    });
    turn.reasoningItemId = null;
  } else if (turn.reasoningFallback) {
    notify('item/completed', {
      threadId: turn.threadId,
      turnId: turn.id,
      item: { id: 'reason_' + randomUUID(), type: 'reasoning', summary: [turn.reasoningFallback] },
    });
    turn.reasoningFallback = '';
  }
}

function finishAgent(turn) {
  if (turn.finished) return;
  let text = turn.agentText || turn.assistantText || turn.resultText || '';
  if (!turn.agentItemId && text) {
    turn.assistantText = '';
    addAgentDelta(turn, text);
  }
  if (turn.agentItemId) {
    notify('item/completed', {
      threadId: turn.threadId,
      turnId: turn.id,
      item: { id: turn.agentItemId, type: 'agentMessage', text: turn.agentText || text },
    });
    turn.agentItemId = null;
  }
}

/* ---------- 工具调用 ---------- */
function isWriteTool(name) {
  return WRITE_TOOLS.has(name) || name.startsWith('desktop_');
}

function resultText(result) {
  const items = Array.isArray(result?.contentItems) ? result.contentItems : [];
  const text = items.filter((item) => item && item.type === 'inputText' && typeof item.text === 'string')
    .map((item) => item.text).join('\n');
  if (text) return text;
  try { return JSON.stringify(result ?? {}); } catch { return String(result ?? ''); }
}

async function invokeTool(turn, name, args) {
  if (turn.finished) throw new Error('turn_finished');
  if (typeof name !== 'string') throw new Error('invalid_tool');
  const tool = turn.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error('tool_not_available');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_arguments');

  const itemId = 'tool_' + randomUUID();
  const startedAt = Date.now();
  notify('item/started', {
    threadId: turn.threadId,
    turnId: turn.id,
    item: { id: itemId, type: 'mcpToolCall', server: 'agentdesk', tool: name, arguments: args, status: 'inProgress' },
  });

  let output = '';
  let failed = false;
  let content;
  try {
    if (name === ATTACHMENT_TOOL.name) {
      content = readAttachmentContent(turn, args);
      output = content.filter((item) => item.type === 'text').map((item) => item.text).join('\n').slice(0, 4000);
    } else {
    if (turn.readOnly && isWriteTool(name)) throw new Error('只读模式下不能使用写工具');
    if (isWriteTool(name) && turn.approvalPolicy !== 'never') {
      const decision = await clientRequest(turn, 'item/tool/requestApproval', {
        threadId: turn.threadId, turnId: turn.id, tool: name, arguments: args,
      }, APPROVAL_TIMEOUT);
      const accepted = decision && ['accept', 'acceptForSession', 'approved', 'approved_for_session'].includes(decision.decision);
      if (!accepted) throw new Error('用户拒绝了这次文件修改');
    }
    const result = await clientRequest(turn, 'item/tool/call', {
      threadId: turn.threadId, turnId: turn.id, tool: name, arguments: args,
    }, TOOL_TIMEOUT);
    const images = name.startsWith('desktop_') && Array.isArray(result?.contentItems)
      ? result.contentItems.filter((item) => item?.type === 'inputImage' &&
          /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+=*$/i.test(item.imageUrl || ''))
      : [];
    if (images.length) {
      if (images.reduce((size, item) => size + item.imageUrl.length, 0) > 6 * 1024 * 1024) {
        throw new Error('桌面截图超过单聊传输上限，请缩小截图范围');
      }
      content = images.map(({ imageUrl }) => {
        const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(imageUrl);
        return { type: 'image', mimeType, data };
      });
      output = '已返回本机截图。';
    } else output = resultText(result);
    failed = result?.success === false;
    }
  } catch (error) {
    output = turn.redact(error.message || String(error));
    failed = true;
  }

  if (!turn.finished) {
    notify('item/completed', {
      threadId: turn.threadId,
      turnId: turn.id,
      item: {
        id: itemId,
        type: 'mcpToolCall',
        server: 'agentdesk',
        tool: name,
        arguments: args,
        status: failed ? 'failed' : 'completed',
        result: { content: [{ type: 'text', text: output }] },
        durationMs: Date.now() - startedAt,
        ...(failed ? { error: { message: output } } : {}),
      },
    });
  }
  return { content: !failed && content ? content : [{ type: 'text', text: output }], ...(failed ? { isError: true } : {}) };
}

/* ---------- MCP socket ---------- */
const mcpServer = net.createServer((socket) => {
  socket.setTimeout(TOOL_TIMEOUT + 10_000, () => socket.destroy());
  const wire = new Lines(socket, socket, 8 * 1024 * 1024);
  let answered = false;
  wire.on('fault', () => socket.destroy());
  wire.once('frame', async (frame) => {
    if (answered) return;
    answered = true;
    try {
      if (!frame || typeof frame.capability !== 'string' || typeof frame.operation !== 'string') {
        throw new Error('invalid_request');
      }
      const turn = capabilities.get(frame.capability);
      if (!turn || turn.finished) throw new Error('invalid_capability');
      if (frame.operation === 'tools') {
        wire.send({ ok: true, value: { tools: turn.tools } });
      } else if (frame.operation === 'call') {
        const value = await invokeTool(turn, frame.name, frame.arguments || {});
        wire.send({ ok: true, value });
      } else {
        throw new Error('unsupported_operation');
      }
    } catch (error) {
      try { wire.send({ ok: false, error: error.message || 'mcp_failed' }); } catch {}
    }
    socket.end();
  });
});

/* ---------- CLI 参数 ---------- */
function mcpDefinition(turn) {
  return { command: process.execPath, args: [MCP_JS, SOCKET, turn.capability] };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function writeMcpConfig(turn, workspace) {
  if (PROVIDER === 'grok') {
    const folder = path.join(workspace, '.grok');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const server = mcpDefinition(turn);
    const body = `[mcp_servers.${turn.serverName}]\n`
      + `command = ${tomlString(server.command)}\n`
      + 'args = [\n'
      + server.args.map((arg) => `    ${tomlString(arg)},\n`).join('')
      + ']\nenabled = true\n';
    fs.writeFileSync(path.join(folder, 'config.toml'), body, { mode: 0o600 });
  } else if (PROVIDER === 'antigravity') {
    // Antigravity reads MCP servers from the user home, not the project folder.
    const folder = path.join(HOME, '.gemini', 'config');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, 'mcp_config.json');
    const backup = file + '.agentdesk-backup';
    let body = {};
    try {
      body = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') log('mcp_config_read_failed', error.message);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    if (!body.mcpServers || typeof body.mcpServers !== 'object' || Array.isArray(body.mcpServers)) body.mcpServers = {};
    // A crashed earlier turn can leave its entry behind; remove only our own entries.
    for (const [name, server] of Object.entries(body.mcpServers)) {
      if (server && server.command === process.execPath && Array.isArray(server.args)
        && server.args.includes(MCP_JS) && server.args.includes(SOCKET)) delete body.mcpServers[name];
    }
    if (!fs.existsSync(backup)) {
      try {
        fs.copyFileSync(file, backup);
        fs.chmodSync(backup, 0o600);
      } catch (error) {
        if (error.code !== 'ENOENT') log('mcp_config_backup_failed', error.message);
      }
    }
    body.mcpServers[turn.serverName] = { ...mcpDefinition(turn), disabled: false };
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

function cleanupConfigs(turn) {
  const workspace = workspaceFor(turn.threadId);
  for (const file of [
    path.join(workspace, '.grok', 'config.toml'),
    path.join(workspace, '.agents', 'mcp_config.json'),
  ]) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(turn.capability)) fs.unlinkSync(file);
    } catch {}
  }
  if (PROVIDER === 'antigravity') {
    const file = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
    try {
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      let changed = false;
      for (const [name, server] of Object.entries(body.mcpServers || {})) {
        if (name === turn.serverName || (server && server.command === process.execPath
          && Array.isArray(server.args) && server.args.includes(MCP_JS) && server.args.includes(SOCKET))) {
          delete body.mcpServers[name];
          changed = true;
        }
      }
      if (changed) {
        const temporary = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temporary, file);
      }
    } catch {}
    try { fs.unlinkSync(file + '.agentdesk-backup'); } catch {}
  }
}

function instructions(turn) {
  const root = turn.thread.localRoot || '(未提供)';
  const windows = /^[A-Za-z]:[\\/]/.test(root);
  const computer = windows ? 'Windows' : 'Mac';
  const workspace = workspaceFor(turn.threadId);
  const vps = SANDBOX
    ? `- 你可以在 VPS 上的会话工作目录 ${workspace} 里使用 shell 和自带的读写工具（运行命令、跑测试、下载依赖），它在沙盒里（只读轮次不能写）；这里不是用户电脑。`
    : '- VPS 上的 shell 和自带文件工具未开启。';
  return `${turn.thread.systemPrompt ? turn.thread.systemPrompt + '\n\n' : ''}[AgentDesk 单聊｜本机文件]
- 需要最新信息时可以联网搜索和读取网页。
${vps}
- 用户电脑上授权过的命令：先用 agentdesk_command_list 查看，再用 agentdesk_command_run 运行；按当前权限模式审批。
- 你运行在一台 VPS 上，但用户的真实文件在 ${computer} 上，项目路径是：${root}
- 读写用户文件只能调用 MCP 工具 agentdesk_file_list/read/write/mkdir/copy/move/trash（服务器名 ${turn.serverName}）。
- 本机路径必须是 ${computer} 的绝对路径，例如 ${root}/note.txt；不要使用 VPS 的 shell 或内置 Read/Write/Bash 工具操作本机文件。
- 可用的 desktop_* 工具在用户电脑上截图、点击或输入；只有在本机桌面开启且本轮可操作时才会提供。
- 写文件前先读目标；创建文件后把结果路径告诉用户。覆盖已有文件必须显式传 overwrite:true。
- 系统目录、凭据目录（如 ~/.ssh、~/.agentdesk）和 .git 内部会被拒绝，不要尝试绕过。
- 工具返回 JSON 文本；失败时如实告诉用户，不要假装成功。
- 大文件分页读取（用返回的 nextOffset 继续），只读需要的部分，不要整份反复读。`;
}

// Everything that varies from turn to turn goes into the user message, not the system prompt or the tool
// list, so the CLI's prompt cache stays valid across the conversation (the way pi keeps declarations stable).
function turnText(turn) {
  return (turn.readOnly ? '[本轮是只读规划模式：只能使用 list/read，写工具会被拒绝。]\n\n' : '') + turn.text;
}

function providerArgs(turn, workspace) {
  const first = !turn.thread.started;
  if (PROVIDER !== 'antigravity') {
    turn.thread.started = true;
    turn.thread.updatedAt = Date.now();
    persist();
  }
  const session = turn.thread.sessionId;
  if (PROVIDER === 'claude') {
    const args = [
      '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config',
      JSON.stringify({ mcpServers: { [turn.serverName]: mcpDefinition(turn) } }),
      // The bare server name and every tool name as well as the wildcard: the wildcard alone is ignored by some
      // Claude Code versions, which then deny every file tool and the chat cannot change the person's files.
      '--allowedTools', [`mcp__${turn.serverName}`, `mcp__${turn.serverName}__*`,
        ...turn.tools.map((tool) => `mcp__${turn.serverName}__${tool.name}`), ...CLAUDE_WEB,
        ...(SANDBOX ? [...CLAUDE_SHELL_READ, ...(turn.readOnly ? [] : CLAUDE_SHELL_WRITE)] : [])].join(','),
      '--disallowedTools', [...CLAUDE_DISALLOWED, ...(SANDBOX ? [] : CLAUDE_SHELL_READ),
        ...(SANDBOX && !turn.readOnly ? [] : CLAUDE_SHELL_WRITE)].join(','),
      '--append-system-prompt', instructions(turn),
    ];
    if (turn.model) args.push('--model', turn.model);
    if (turn.effort) args.push('--effort', turn.effort);
    if (session && first) args.push('--session-id', session);
    else if (session) { args.push('--resume', session); turn.resumeAttempt = true; }
    turn.promptViaStdin = true;
    return args;
  }
  if (PROVIDER === 'grok') {
    const args = [
      '--trust', '--no-auto-update', '--output-format', 'streaming-messages-json', '--include-partial-messages',
      '--permission-mode', 'dontAsk', '--no-subagents',
      '--tools', ['todo_write', ...GROK_WEB, ...(SANDBOX ? [...GROK_SHELL_READ, ...(turn.readOnly ? [] : GROK_SHELL_WRITE)] : [])].join(','),
      '--allow', `MCPTool(${turn.serverName}__*)`, '--allow', 'WebSearch', '--allow', 'WebFetch',
      ...(SANDBOX ? ['--allow', 'Bash', '--allow', 'Read', '--allow', 'Grep', ...(turn.readOnly ? [] : ['--allow', 'Edit'])] : []),
      '--disallowed-tools', [...GROK_DISALLOWED, ...(SANDBOX ? [] : GROK_SHELL_READ),
        ...(SANDBOX && !turn.readOnly ? [] : GROK_SHELL_WRITE)].join(','),
      '--rules', instructions(turn),
    ];
    if (turn.model) args.push('--model', turn.model);
if (turn.effort) args.push('--effort', turn.effort);
    if (session && first) args.push('--session-id', session);
    else if (session) { args.push('--resume', session); turn.resumeAttempt = true; }
    args.push('-p', turnText(turn));
    turn.promptViaStdin = false;
    return args;
  }
  const permissions = {
    allow: [
      `mcp(${turn.serverName}/*)`,
      ...turn.tools.map((tool) => `mcp(${turn.serverName}/${tool.name})`),
      'read_url(*)', 'search_web(*)',
      ...(SANDBOX ? ['read_file(*)', 'command(*)', ...(turn.readOnly ? [] : ['write_file(*)'])] : []),
    ],
    deny: ['execute_url(*)', ...(SANDBOX ? [] : ['read_file(*)', 'command(*)']),
      ...(SANDBOX && !turn.readOnly ? [] : ['write_file(*)'])],
    ask: [],
  };
  const args = [
    '--output-format', 'stream-json', '--mode', 'accept-edits',
    '--settings', JSON.stringify({ permissions }), '--disable-slash-commands',
  ];
  if (turn.model) args.push('--model', turn.model);
  // agy encodes the level in some model IDs and rejects an --effort that conflicts with it; only pass the
  // effort when it matches the model's suffix (or no model is selected).
  if (turn.effort && (!turn.model || turn.model.endsWith('-' + turn.effort))) args.push('--effort', turn.effort);
  if (session) { args.push('--conversation', session); turn.resumeAttempt = true; }
  // Antigravity keeps the conversation, so the instructions are sent once per conversation (again only when
  // they change), not repeated in every message.
  const text = instructions(turn);
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const repeat = session && turn.thread.instructionsSent === digest;
  turn.thread.instructionsSent = digest;
  args.push('-p', repeat ? turnText(turn) : `${text}\n\n${turnText(turn)}`);
  turn.promptViaStdin = false;
  return args;
}

function childEnvironment() {
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
  if (fs.existsSync(HOME)) env.HOME = HOME;
  env.AGENTDESK_CHAT_SOCKET = SOCKET;
  env.AGENTDESK_CHAT_PROVIDER = PROVIDER;
  return env;
}

function syncGrokAuth() {
  if (PROVIDER !== 'grok') return;
  const source = path.join(STATE_DIR, 'homes', 'grok', '.grok', 'auth.json');
  const target = path.join(HOME, '.grok', 'auth.json');
  try {
    const origin = fs.statSync(source);
    let current;
    try { current = fs.statSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!current || origin.mtimeMs > current.mtimeMs || origin.size !== current.size) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log('grok_auth_sync_failed', error.message);
  }
}

function killTurn(turn) {
  if (!turn.child?.pid) return;
  try { process.kill(-turn.child.pid, 'SIGTERM'); } catch {}
  if (!turn.killTimer) {
    turn.killTimer = setTimeout(() => {
      try { process.kill(-turn.child.pid, 'SIGKILL'); } catch {}
    }, 5000);
    turn.killTimer.unref?.();
  }
}

function startTurn(turn) {
  if (turn.finished) return;
  let child;
  try {
    syncGrokAuth();
    const workspace = workspaceFor(turn.threadId);
    writeMcpConfig(turn, workspace);
    const args = providerArgs(turn, workspace);
    log('turn_start', turn.id, 'args=' + args.length, 'resume=' + !!turn.resumeAttempt);
    // In the sandbox the CLI sees this conversation's workspace, its own home and the MCP socket; the rest of
    // the orchestrator's state (other conversations, other logins, tasks) is hidden.
    const launch = SANDBOX
      ? sandboxCommand(BIN, args, { bin: SANDBOX, cwd: workspace, home: HOME, writable: !turn.readOnly,
        hide: [STATE_DIR], sockets: [SOCKET], extraReadOnly: turn.attachmentDirectory ? [turn.attachmentDirectory] : [] })
      : { command: BIN, args };
    child = spawn(launch.command, launch.args, {
      cwd: workspace,
      env: { ...childEnvironment(), ...(PROVIDER === 'claude' && turn.effort && { CLAUDE_CODE_EFFORT_LEVEL: turn.effort }) },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    finishTurn(turn, null, error.message);
    return;
  }

  turn.child = child;
  const stdout = new StringDecoder('utf8');
  const stderr = new StringDecoder('utf8');
  let outputBuffer = '';
  let stderrBuffer = '';
  let outputBytes = 0;

  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    try { handleEvent(turn, event); }
    catch (error) { log('event_failed', turn.id, error.message); }
  };

  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > OUTPUT_LIMIT) {
      turn.failure = '本轮输出超过 4 MiB，已停止';
      killTurn(turn);
      return;
    }
    outputBuffer += stdout.write(chunk);
    let end;
    while ((end = outputBuffer.indexOf('\n')) >= 0) {
      const line = outputBuffer.slice(0, end);
      outputBuffer = outputBuffer.slice(end + 1);
      consume(line);
    }
    if (outputBuffer.length > 1024 * 1024) {
      turn.failure = 'CLI 输出了超长的一行，已停止';
      killTurn(turn);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuffer += stderr.write(chunk);
    if (stderrBuffer.length > 64_000) stderrBuffer = stderrBuffer.slice(-64_000);
  });
  child.stdin.on('error', () => {});
  child.on('error', (error) => {
    if (!turn.childError) turn.childError = error.message;
  });
  child.on('close', (code) => {
    if (outputBuffer.trim()) consume(outputBuffer);
    outputBuffer = '';
    turn.stderrTail = stderrBuffer;
    finishTurn(turn, code);
  });

  turn.timer = setTimeout(() => {
    turn.timedOut = true;
    killTurn(turn);
  }, TURN_TIMEOUT);
  turn.timer.unref?.();

  if (turn.promptViaStdin) child.stdin.end(turnText(turn));
  else child.stdin.end();
}

/* ---------- CLI 事件解析 ---------- */
function handleEvent(turn, event) {
  if (event.type === 'rate_limit_event') return captureRateLimits(event);
  if (typeof event.event === 'string') return handleAntigravity(turn, event);
  if (event.type === 'system') return handleSystem(turn, event);
  if (event.type === 'stream_event') return handleStreamEvent(turn, event.event || {});
  if (event.type === 'assistant') return handleAssistant(turn, event);
  if (event.type === 'result') return handleResult(turn, event);
}

function captureRateLimits(event) {
  if (PROVIDER !== 'claude' || !event.rate_limit_info) return;
  // Fire and forget: a quota write must never delay or fail the turn.
  captureClaudeRateLimitEvent(CLAUDE_QUOTA_FILE, event.rate_limit_info)
    .catch((error) => log('quota_capture_failed', error.message));
}

function handleSystem(turn, event) {
  if (event.subtype === 'init' && typeof event.session_id === 'string') setSession(turn, event.session_id);
}

function handleStreamEvent(turn, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'content_block_start') {
    const block = event.content_block || {};
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) addReasoningDelta(turn, block.thinking);
    if (block.type === 'text' && typeof block.text === 'string' && block.text) addAgentDelta(turn, block.text);
    return;
  }
  if (event.type === 'content_block_delta') {
    const delta = event.delta || {};
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') addReasoningDelta(turn, delta.thinking);
    else if (delta.type === 'text_delta' && typeof delta.text === 'string') addAgentDelta(turn, delta.text);
  }
}

function handleAssistant(turn, event) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  let text = '';
  let thinking = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block?.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking;
  }
  if (text) turn.assistantText = text;
  if (thinking) turn.reasoningFallback = thinking;
  if (typeof event.session_id === 'string') setSession(turn, event.session_id);
}

function handleResult(turn, event) {
  if (typeof event.session_id === 'string') setSession(turn, event.session_id);
  turn.usage = normalizeUsage(event.usage) || turn.usage;
  const reported = typeof event.result === 'string' ? event.result : '';
  if (event.is_error === true || event.subtype === 'error') {
    turn.resultError = reported || event.subtype || 'cli_reported_error';
    return;
  }
  if (!reported) return;
  if (!turn.agentText) turn.resultText = reported;
  else if (reported.startsWith(turn.agentText) && reported.length > turn.agentText.length) {
    addAgentDelta(turn, reported.slice(turn.agentText.length));
  }
}

function handleAntigravity(turn, event) {
  if (event.event === 'init') {
    const id = event.conversation_id || event.init?.conversation_id;
    if (typeof id === 'string') setSession(turn, id);
    return;
  }
  if (event.event === 'step_update' && event.step_update && typeof event.step_update === 'object') {
    const step = event.step_update;
    if (typeof step.conversation_id === 'string') setSession(turn, step.conversation_id);
    if (step.usage) turn.usage = normalizeUsage(step.usage) || turn.usage;
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
      const index = Number.isInteger(step.step_index) ? step.step_index : 0;
      const previous = turn.antigravityText[index] || '';
      if (step.text_delta.startsWith(previous)) {
        const suffix = step.text_delta.slice(previous.length);
        if (suffix) addAgentDelta(turn, suffix);
        turn.antigravityText[index] = step.text_delta;
      } else {
        addAgentDelta(turn, step.text_delta);
        turn.antigravityText[index] = previous + step.text_delta;
      }
    }
    return;
  }
  if (event.event === 'result' && event.result && typeof event.result === 'object') {
    const result = event.result;
    if (typeof result.conversation_id === 'string') setSession(turn, result.conversation_id);
    turn.usage = normalizeUsage(result.usage) || turn.usage;
    if (result.status && result.status !== 'SUCCESS') {
      turn.resultError = result.error || result.response || result.finished_reason || ('antigravity_' + result.status.toLowerCase());
      return;
    }
    if (typeof result.response === 'string' && result.response) {
      if (!turn.agentText) turn.resultText = result.response;
      else if (result.response.startsWith(turn.agentText) && result.response.length > turn.agentText.length) {
        addAgentDelta(turn, result.response.slice(turn.agentText.length));
      }
    }
  }
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...names) => names.map((name) => raw[name]).find((value) => Number.isFinite(value));
  const usage = {
    inputTokens: pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokenCount'),
    cachedInputTokens: pick('cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens', 'cachedContentTokenCount'),
    cacheWriteTokens: pick('cache_creation_input_tokens', 'cacheWriteTokens'),
    outputTokens: pick('output_tokens', 'outputTokens', 'completion_tokens', 'candidatesTokenCount'),
    reasoningTokens: pick('reasoning_tokens', 'reasoningTokens'),
    totalTokens: pick('total_tokens', 'totalTokens'),
  };
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return Object.values(usage).some((value) => value !== undefined)
    ? Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) : null;
}

/* ---------- 轮次收尾 ---------- */
const AUTH_FAILURE = /not logged in|log ?in required|please (?:log|sign) ?in|unauthori[sz]ed|\b401\b|authentication (?:failed|required)|invalid api key|oauth|eligibility check failed|permission_denied|not authenticated/i;
const QUOTA_FAILURE = /usage limit|rate[ -]?limit|quota|too many requests|\b429\b|credit balance|limit (?:reached|exceeded)|out of (?:credits|messages)/i;
const RESUME_FAILURE = /no conversation|conversation.*(?:not found|does not exist|invalid)|session.*(?:not found|does not exist|invalid|unknown)|could not resume|resume.*failed/i;

function failureMessage(turn, code) {
  const stderr = turn.redact(turn.stderrTail || '');
  const raw = turn.resultError || turn.childError || '';
  const text = turn.redact(raw || stderr);
  if (AUTH_FAILURE.test(text + '\n' + stderr)) return '未登录或登录已失效，请先在 VPS 上完成该 AI 的登录：' + (text || stderr).slice(0, 800);
  if (QUOTA_FAILURE.test(text + '\n' + stderr)) return '额度或频率限制：' + (text || stderr).slice(0, 800);
  if (text) return text.slice(0, 1200);
  if (code !== 0 && code != null) return `CLI 退出码 ${code}` + (stderr ? '：' + stderr.slice(-800) : '');
  return null;
}

function finishTurn(turn, code, startupError) {
  if (turn.done) return;
  turn.done = true;
  clearTimeout(turn.timer);
  clearTimeout(turn.killTimer);
  if (startupError) turn.childError = startupError;
  activeTurns.delete(turn.threadId);
  if (antigravityTurn === turn) antigravityTurn = null;
  capabilities.delete(turn.capability);
  rejectPending(turn, new Error('turn_finished'));
  if (turn.child?.pid) {
    try { process.kill(-turn.child.pid, 'SIGKILL'); } catch {}
  }

  let status = 'completed';
  let message = null;
  if (turn.interrupted) status = 'interrupted';
  else if (turn.timedOut) { status = 'failed'; message = '本轮超过 30 分钟，已停止'; }
  else if (turn.failure) { status = 'failed'; message = turn.failure; }
  else if (turn.resultError) { status = 'failed'; message = failureMessage(turn, code); }
  else if (turn.childError) { status = 'failed'; message = failureMessage(turn, code); }
  else if (code !== 0) { status = 'failed'; message = failureMessage(turn, code) || `CLI 退出码 ${code}`; }

  if (status === 'failed' && turn.resumeAttempt && RESUME_FAILURE.test(message || '')) {
    resetSession(turn.thread);
    message = '会话上下文已失效，已重置。请重试，或新建单聊。';
  }

  finishReasoning(turn);
  finishAgent(turn);

  if (message) message = turn.redact(message).slice(0, 1200);
  turn.thread.updatedAt = Date.now();
  persist();
  cleanupConfigs(turn);
  if (turn.attachmentDirectory) fs.rm(turn.attachmentDirectory, { recursive: true, force: true }, error => {
    if (error) log('attachment_cleanup_failed', error.code);
  });
  turn.finished = true;
  notify('turn/completed', {
    threadId: turn.threadId,
    turn: {
      id: turn.id,
      status,
      ...(message ? { error: { message } } : {}),
    },
    ...(turn.usage ? { usage: turn.usage } : {}),
  });
  log('turn_done', turn.id, status, message || '');
}

/* ---------- JSON-RPC 方法 ---------- */
async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      pruneExpiredThreads();
      return { serverInfo: { name: `agentdesk-chat-${PROVIDER}`, version: '1.0.0' }, capabilities: {} };

    case 'thread/start': {
      const id = `${PROVIDER}-${randomUUID()}`;
      const thread = {
        id,
        provider: PROVIDER,
        sessionId: freshSession(),
        started: false,
        dynamicTools: normalizeTools(params.dynamicTools),
        approvalPolicy: normalizeApproval(params.approvalPolicy),
        sandboxPolicy: normalizeSandbox(params.sandboxPolicy),
        systemPrompt: typeof params.systemPrompt === 'string' ? params.systemPrompt.slice(0, 32_768) : '',
        localRoot: typeof params.localRoot === 'string' ? params.localRoot.slice(0, 4096) : '',
        projectId: typeof params.projectId === 'string' ? params.projectId.slice(0, 256) : null,
        title: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.threads[id] = thread;
      workspaceFor(id);
      persist();
      return { thread: { id } };
    }

    case 'thread/resume': {
      const thread = threadById(params.threadId);
      if (!thread) throw fail('thread_not_found');
      workspaceFor(thread.id);
      return {
        thread: { id: thread.id },
        dynamicTools: thread.dynamicTools,
        approvalPolicy: thread.approvalPolicy,
        sandboxPolicy: thread.sandboxPolicy,
        localRoot: thread.localRoot,
        projectId: thread.projectId,
        systemPrompt: thread.systemPrompt,
      };
    }

    case 'thread/list':
      return { data: [] };

    case 'thread/name/set': {
      const thread = threadById(params.threadId);
      if (!thread) throw fail('thread_not_found');
      thread.title = typeof params.name === 'string' ? params.name.slice(0, 200) : '';
      thread.updatedAt = Date.now();
      persist();
      return {};
    }

    case 'thread/archive': {
      const thread = threadById(params.threadId);
      if (!thread) throw fail('thread_not_found');
      if (activeTurns.has(thread.id)) throw fail('turn_in_progress');
      delete state.threads[thread.id];
      persist();
      try { fs.rmSync(path.join(THREADS_DIR, thread.id), { recursive: true, force: true }); } catch {}
      return {};
    }

    case 'thread/unsubscribe':
      return {};

    case 'attachment/reset':
      if (!threadById(params.threadId)) throw fail('thread_not_found');
      incoming.clear();
      return {};

    case 'attachment/chunk': {
      if (!threadById(params.threadId)) throw fail('thread_not_found');
      const { id, offset, data } = params;
      if (typeof id !== 'string' || !idPattern.test(id) || !Number.isSafeInteger(offset) || offset < 0 ||
          typeof data !== 'string' || data.length > 350000) throw fail('invalid_attachment');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data) throw fail('invalid_attachment');
      let upload = incoming.get(id);
      if (!upload && offset === 0 && incoming.size < maxAttachments) {
        upload = { threadId: params.threadId, parts: [], size: 0 };
        incoming.set(id, upload);
      }
      if (!upload || upload.threadId !== params.threadId || upload.size !== offset ||
          upload.size + bytes.length > attachmentLimit) throw fail('invalid_attachment');
      if (bytes.length) upload.parts.push(bytes);
      upload.size += bytes.length;
      return { nextOffset: upload.size };
    }

    case 'turn/start': {
      const thread = threadById(params.threadId);
      if (!thread) throw fail('thread_not_found');
      if (activeTurns.has(thread.id)) throw fail('turn_in_progress');
      if (PROVIDER === 'antigravity' && antigravityTurn) throw fail('turn_in_progress');
      const input = Array.isArray(params.input) ? params.input : [];
      let text = input.filter((item) => item?.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text).join('\n').trim();
      if (!text) throw fail('empty_input');
      if (text.length > 200_000) throw fail('input_too_large');
      const effort = typeof params.effort === 'string' ? params.effort : '';
      if (effort && !EFFORTS.has(effort)) throw fail('invalid_effort', -32602);
      const approvalPolicy = normalizeApproval(params.approvalPolicy ?? thread.approvalPolicy);
      const sandboxPolicy = normalizeSandbox(params.sandboxPolicy ?? thread.sandboxPolicy);
      const readOnly = readOnlyOf(sandboxPolicy);
      const turnId = randomUUID();
      let attachmentDirectory;
      let attachments;
      if (params.attachments !== undefined) {
        if (!validAttachments(params.attachments)) throw fail('invalid_attachment');
        const files = params.attachments.map(item => {
          const upload = incoming.get(item.id);
          if (!upload || upload.threadId !== thread.id || upload.size !== item.size) throw fail('invalid_attachment');
          const bytes = Buffer.concat(upload.parts);
          if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw fail('invalid_attachment');
          return { ...item, bytes };
        });
        attachmentDirectory = path.join(STATE_DIR, 'chat-attachments', turnId);
        fs.mkdirSync(attachmentDirectory, { recursive: true, mode: 0o700 });
        const inputs = files.map(item => {
          const filename = path.join(attachmentDirectory, item.id + '-' + item.name.replace(/[^\p{L}\p{N}_.-]/gu, '_'));
          fs.writeFileSync(filename, item.bytes, { flag: 'wx', mode: 0o400 });
          incoming.delete(item.id);
          const copy = writeTextCopy(fs, filename, item.name, item.bytes);
          return { name: item.name, path: filename, ...(copy && { text: copy }) };
        });
        attachments = inputs;
        text += attachmentNote(inputs) + `\nRead each attachment with the MCP tool ${ATTACHMENT_TOOL.name} (file: its name)` +
          (SANDBOX ? ' or open its path directly.' : '; your own file tools cannot reach these paths.');
      }
      thread.approvalPolicy = approvalPolicy;
      thread.sandboxPolicy = sandboxPolicy;
      thread.updatedAt = Date.now();
      persist();

      const turn = {
        id: turnId,
        attachmentDirectory,
        threadId: thread.id,
        thread,
        text,
        approvalPolicy,
        readOnly,
        // The attachment tool is always declared, with or without attachments, so the tool list stays the same.
        tools: [...(params.dynamicTools === undefined ? thread.dynamicTools : normalizeTools(params.dynamicTools))
          .filter((tool) => !readOnly || READ_ONLY_TOOLS.has(tool.name)), ATTACHMENT_TOOL],
        attachments,
        capability: randomBytes(24).toString('hex'),
        // One name per conversation: a new name every turn changed the tool names and the system prompt, so
        // Claude and Grok re-read the whole history at full price on each turn.
        serverName: 'agentdesk_' + createHash('sha256').update(thread.id).digest('hex').slice(0, 8),
        model: typeof params.model === 'string' ? params.model.slice(0, 128) : '',
effort,
        agentText: '',
        agentItemId: null,
        assistantText: '',
        resultText: '',
        reasoningText: '',
        reasoningItemId: null,
        reasoningFallback: '',
        antigravityText: {},
        usage: null,
        pending: new Set(),
        finished: false,
        resumeAttempt: false,
        redact(value) { return String(value ?? '').replaceAll(this.capability, '<redacted>'); },
      };
      activeTurns.set(thread.id, turn);
      if (PROVIDER === 'antigravity') antigravityTurn = turn;
      capabilities.set(turn.capability, turn);
      notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress' } });
      setImmediate(() => startTurn(turn));
      return { turn: { id: turn.id } };
    }

    case 'turn/interrupt': {
      const turn = activeTurns.get(params.threadId);
      if (!turn || (params.turnId && params.turnId !== turn.id)) return {};
      turn.interrupted = true;
      killTurn(turn);
      return {};
    }

    case 'turn/steer':
      throw fail('steer_unsupported');

    case 'model/list':
      return { data: [] };
    case 'skills/list':
      return { data: [] };
    case 'account/rateLimits/read':
      return { rateLimits: null };

    default:
      throw fail('unsupported_method: ' + method, -32601);
  }
}

async function handleFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
  if (settleClientResponse(frame)) return;
  if (typeof frame.method !== 'string' || frame.id === undefined) return;
  try {
    const result = await dispatch(frame.method, frame.params || {});
    send({ jsonrpc: '2.0', id: frame.id, result });
  } catch (error) {
    send({ jsonrpc: '2.0', id: frame.id, error: { code: error.code || -32603, message: error.message || 'error' } });
  }
}

/* ---------- 启动与退出 ---------- */
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown', reason);
  for (const turn of activeTurns.values()) {
    turn.interrupted = true;
    killTurn(turn);
  }
  try { mcpServer.close(); } catch {}
  try { fs.unlinkSync(SOCKET); } catch {}
  setTimeout(() => process.exit(0), 100).unref?.();
  setTimeout(() => process.exit(0), 1000);
}

function main() {
  fs.mkdirSync(THREADS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch {}
  try { fs.unlinkSync(SOCKET); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  mcpServer.on('error', (error) => {
    log('mcp_socket_failed', error.message);
    process.exit(3);
  });
  mcpServer.listen(SOCKET, () => {
    try { fs.chmodSync(SOCKET, 0o600); } catch {}
    log('ready', 'provider=' + PROVIDER, 'socket=' + SOCKET);
  });

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      handleFrame(frame);
    }
    if (buffer.length > 16 * 1024 * 1024) {
      log('input_limit');
      shutdown('input_limit');
    }
  });
  process.stdin.on('end', () => shutdown('stdin_end'));
  process.stdin.on('close', () => shutdown('stdin_close'));
  process.on('SIGHUP', () => shutdown('sighup'));
  process.on('SIGTERM', () => shutdown('sigterm'));
  process.on('SIGINT', () => shutdown('sigint'));
  process.on('uncaughtException', (error) => {
    log('uncaught', error.stack || error.message);
    shutdown('uncaught');
  });
  process.on('unhandledRejection', (error) => log('unhandled', error?.message || String(error)));
}

main();

module.exports = { normalizeUsage };
