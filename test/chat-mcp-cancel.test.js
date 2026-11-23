'use strict';
// When the CLI cancels a pending agentdesk_ask_user call (notifications/cancelled), chat-mcp closes that call's
// connection, so chat-server withdraws the question at once (chat-server.js: caller 'close').
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('a cancelled question call closes its connection; other calls are not cut', { skip: process.platform === 'win32' && 'unix socket path' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 's.sock');
  const closed = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('close', () => closed.push(JSON.parse(buffer.split('\n')[0]).name));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'orchestrator', 'chat-mcp.js'), socketPath, 'cap'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const replies = [];
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; let i; while ((i = out.indexOf('\n')) >= 0) { replies.push(JSON.parse(out.slice(0, i))); out = out.slice(i + 1); } });
  const send = (frame) => child.stdin.write(JSON.stringify(frame) + '\n');
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agentdesk_ask_user', arguments: { questions: [{ question: '?' }] } } });
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agentdesk_file_read', arguments: { path: '/x' } } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 6 } });
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
  for (let i = 0; i < 40 && !replies.some((reply) => reply.id === 5); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(closed, ['agentdesk_ask_user'], 'only the question call was closed');
  const reply = replies.find((item) => item.id === 5);
  assert.equal(reply.result.isError, true);
  assert.equal(replies.some((item) => item.id === 6), false, 'the file read is still waiting for chat-server');
});
