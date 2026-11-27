// 单聊 CLI 的 stdio MCP 入口：工具表由 chat-server 按线程/轮次下发，实际文件操作由 Electron 主进程执行。
const { createInterface } = require('node:readline');
const { connect } = require('node:net');
const { Lines } = require('./transport');
const { COMMAND_REPLY_TIMEOUT } = require('./command-runs');
const { ASK_TOOL, QUESTION_TIMEOUT } = require('./ask-user');

function request(socketPath, frame, timeout = 65000, onSocket = null) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    onSocket?.(socket);
    const wire = new Lines(socket, socket, 8 * 1024 * 1024);
    const timer = setTimeout(() => {
      reject(new Error('chat_mcp_timeout'));
      socket.destroy();
    }, timeout);
    socket.once('close', () => {
      clearTimeout(timer);
      reject(new Error('chat_mcp_socket_closed'));
    });
    wire.on('fault', reject);
    wire.once('frame', (message) => {
      if (message.ok) resolve(message.value);
      else reject(Object.assign(new Error(message.error || 'chat_mcp_failed'), { requestId: message.request_id }));
      socket.destroy();
    });
    socket.once('connect', () => wire.send(frame));
  });
}

if (require.main === module) {
  const [socketPath, capability] = process.argv.slice(2);
  if (!socketPath || !capability) {
    process.stderr.write('chat-mcp: missing socket or capability\n');
    process.exit(1);
  }
  const input = createInterface({ input: process.stdin });
  const inFlight = new Map();
  input.on('line', async (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    // The CLI gave up on a call (its own tool timeout): close that call, so chat-server withdraws a pending question.
    if (frame.method === 'notifications/cancelled') {
      inFlight.get(frame.params?.requestId)?.destroy();
      return;
    }
    if (frame.id === undefined) return;
    let result;
    try {
      if (frame.method === 'initialize') {
        result = {
          protocolVersion: frame.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'agentdesk-chat', version: '1.0.0' },
        };
      } else if (frame.method === 'ping') {
        result = {};
      } else if (frame.method === 'tools/list') {
        const value = await request(socketPath, { capability, operation: 'tools' });
        result = { tools: value.tools || [] };
      } else if (frame.method === 'tools/call') {
        const value = await request(socketPath, {
          capability,
          operation: 'call',
          name: frame.params?.name,
          arguments: frame.params?.arguments || {},
        }, frame.params?.name === 'agentdesk_command_run' ? COMMAND_REPLY_TIMEOUT + 75_000
          : frame.params?.name === ASK_TOOL.name ? QUESTION_TIMEOUT + 75_000
            : frame.params?.name === 'agentdesk_admin_shell' ? 14 * 60_000 + 75_000
              // Native CLI chats: commands and terminals on the person's computer (native-tui-host.js).
              : ['local_shell', 'terminal'].includes(frame.params?.name) ? 15 * 60_000 : undefined,
        // Only a question is withdrawn on cancel; other tools finish as before.
        frame.params?.name === ASK_TOOL.name ? (socket) => inFlight.set(frame.id, socket) : null)
          .finally(() => inFlight.delete(frame.id));
        result = { content: value.content || [], ...(value.isError ? { isError: true } : {}) };
      } else {
        throw new Error('unsupported_mcp_method');
      }
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
  });
}

module.exports = { request };