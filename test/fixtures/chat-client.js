// A small JSON-RPC client for orchestrator/chat-server.js, shared by the direct chat v2 tests.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'orchestrator', 'chat-server.js');
const FAKE = path.join(__dirname, 'fake-chat-cli.js');

class ChatClient extends EventEmitter {
  constructor(t, provider, stateDir, env = {}) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.frames = [];
    this.stderr = '';
    this.alive = false;
    const homes = path.join(stateDir, 'homes');
    for (const name of ['claude', 'grok-chat', 'antigravity']) fs.mkdirSync(path.join(homes, name), { recursive: true });
    this.child = spawn(process.execPath, [SERVER, provider], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENTDESK_CHAT_STATE: stateDir,
        AGENTDESK_CHAT_CLAUDE_BIN: FAKE,
        AGENTDESK_CHAT_GROK_BIN: FAKE,
        AGENTDESK_CHAT_ANTIGRAVITY_BIN: FAKE,
        AGENTDESK_CHAT_HOME_CLAUDE: path.join(homes, 'claude'),
        AGENTDESK_CHAT_HOME_GROK: path.join(homes, 'grok-chat'),
        AGENTDESK_CHAT_HOME_ANTIGRAVITY: path.join(homes, 'antigravity'),
        AGENTDESK_CHAT_TOOL_TIMEOUT: '4000',
        AGENTDESK_CHAT_APPROVAL_TIMEOUT: '4000',
        AGENTDESK_SEAT_POLL_MS: '50',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        this.onFrame(frame);
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    this.child.on('exit', () => {
      this.alive = false;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('server_closed')); }
      this.pending.clear();
    });
    t.after(() => this.close());
  }

  start() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server_start_timeout: ' + this.stderr)), 5000);
      const check = () => {
        if (this.stderr.includes('ready')) { clearTimeout(timer); this.alive = true; resolve(this); }
      };
      this.child.stderr.on('data', check);
      this.child.once('exit', (code) => { clearTimeout(timer); if (!this.alive) reject(new Error(`server_exited_${code}: ${this.stderr}`)); });
      check();
    });
  }

  onFrame(frame) {
    this.frames.push(frame);
    this.emit('frame', frame);
    if (frame.method && frame.id !== undefined) {
      // Tool calls and approvals: answer with a harmless default.
      const result = frame.method === 'item/tool/requestApproval' ? { decision: 'accept' }
        : { success: true, contentItems: [{ type: 'inputText', text: '{}' }] };
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
      return;
    }
    if (frame.id !== undefined && frame.method === undefined) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(frame.id);
      if (frame.error) entry.reject(Object.assign(new Error(frame.error.message || 'rpc_error'), { code: frame.error.code }));
      else entry.resolve(frame.result);
    }
  }

  request(method, params = {}, timeout = 8000) {
    if (!this.alive) return Promise.reject(new Error('server_not_running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('rpc_timeout: ' + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  waitFor(method, predicate = () => true, timeout = 8000) {
    const existing = this.frames.find((frame) => frame.method === method && frame.params && predicate(frame.params));
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('frame', listener); reject(new Error('event_timeout: ' + method)); }, timeout);
      const listener = (frame) => {
        if (frame.method === method && frame.params && predicate(frame.params)) {
          clearTimeout(timer);
          this.off('frame', listener);
          resolve(frame.params);
        }
      };
      this.on('frame', listener);
    });
  }

  notifications(method) { return this.frames.filter((frame) => frame.method === method).map((frame) => frame.params); }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill('SIGKILL'); } catch {}
  }
}

module.exports = { ChatClient, ROOT };
