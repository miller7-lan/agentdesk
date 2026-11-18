#!/usr/bin/env node
// 测试用假 CLI：按提示词里的 SCENARIO 输出 Claude/Grok/Antigravity 的流式事件，
// 并从实际参数/工作区 MCP 配置里找到 chat-server 的 socket，验证工具往返。
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);
const provider = args.includes('--mcp-config') ? 'claude'
  : args.includes('streaming-messages-json') ? 'grok' : 'antigravity';

function argAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function promptText() {
  if (provider !== 'claude') return argAfter('-p') || '';
  return fs.readFileSync(0, 'utf8');
}

function parseTomlStrings(text) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse('"' + match[1] + '"'));
}

function mcpDefinition() {
  if (provider === 'claude') {
    const config = JSON.parse(argAfter('--mcp-config'));
    const server = Object.values(config.mcpServers)[0];
    return { command: server.command, args: server.args };
  }
  if (provider === 'grok') {
    const text = fs.readFileSync(path.join(process.cwd(), '.grok', 'config.toml'), 'utf8');
    const block = text.match(/args = \[([\s\S]*?)\]/);
    return { command: text.match(/command = ("(?:[^"\\]|\\.)*")/)?.[1], args: parseTomlStrings(block?.[1] || '') };
  }
  // Antigravity discovers MCP servers from the user home, not the project folder.
  const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  return Object.values(config.mcpServers)[0];
}

function socketRequest(socketPath, frame, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('fake_cli_socket_timeout')); }, timeout);
    socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
      socket.end();
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function sessionId() {
  return argAfter('--session-id') || argAfter('--resume') || argAfter('-s') || argAfter('-r')
    || argAfter('--conversation') || randomUUID();
}

function writeLine(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function main() {
  const prompt = promptText();
  const scenario = (prompt.match(/SCENARIO:([A-Z_]+)/) || [])[1] || 'TEXT';
  const definition = mcpDefinition();
  const socketPath = definition.args[1];
  const capability = definition.args[2];
  const report = { provider, scenario, socket: socketPath, capabilityLength: capability.length, args };

  if (scenario === 'HANG') {
    writeLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } });
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'RESUME_FAIL') {
    if (args.includes('--resume') || args.includes('-r') || args.includes('--conversation')) {
      process.stderr.write('No conversation found with session ID\n');
      process.exit(1);
    }
  }

  if (scenario.startsWith('TOOL_') || scenario === 'PLAN_READ' || scenario === 'APPROVE_WRITE' || scenario === 'PLAN_WRITE') {
    const listed = await socketRequest(socketPath, { capability, operation: 'tools' });
    report.tools = (listed.value?.tools || []).map((tool) => tool.name);
    if (scenario === 'PLAN_WRITE' || scenario === 'APPROVE_WRITE') {
      report.call = await socketRequest(socketPath, {
        capability, operation: 'call', name: 'agentdesk_file_write',
        arguments: { path: '/Users/example/blocked.txt', content: 'x', overwrite: true },
      });
    } else {
      report.call = await socketRequest(socketPath, {
        capability, operation: 'call', name: 'agentdesk_file_read',
        arguments: { path: '/Users/example/note.txt' },
      });
    }
    if (scenario === 'TOOL_READ') {
      const unknown = await socketRequest(socketPath, { capability: 'not-the-capability', operation: 'tools' });
      report.unknown = unknown.error;
    }
  }

  const session = sessionId();
  const text = 'REPORT:' + JSON.stringify(report);
  if (provider === 'antigravity') {
    writeLine({ event: 'init', conversation_id: session, init: { cwd: process.cwd(), tools: [], permission_mode: 'accept-edits' } });
    writeLine({ event: 'step_update', step_update: { conversation_id: session, step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'REPORT:' } });
    writeLine({ event: 'step_update', step_update: { conversation_id: session, step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: text } });
    writeLine({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: text, duration_seconds: 0.1, num_turns: 1, usage: { input_tokens: 7, output_tokens: 3 } } });
    return;
  }
  writeLine({ type: 'system', subtype: 'init', session_id: session, model: 'fake' });
  writeLine({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  writeLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'checking' } } });
  writeLine({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  writeLine({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
  writeLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  writeLine({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  writeLine({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'checking' }, { type: 'text', text }] }, session_id: session });
  writeLine({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, usage: { input_tokens: 7, output_tokens: 3 } });
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exit(1);
});