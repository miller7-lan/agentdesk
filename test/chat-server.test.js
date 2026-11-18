const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeTest = require('node:test');
const assert = require('node:assert/strict');

// chat-server runs on VPS2 (Linux) and uses a Unix domain socket; Windows has no
// filesystem sockets, so its local run of these tests is not meaningful.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'orchestrator', 'chat-server.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-chat-cli.js');

const TOOLS = [
  {
    name: 'agentdesk_file_read',
    description: 'Read a local file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'agentdesk_file_write',
    description: 'Write a local file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];

function temporary(t, prefix = 'agentdesk-chat-') {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

class ChatClient extends EventEmitter {
  constructor(t, provider, stateDir) {
    super();
    this.provider = provider;
    this.stateDir = stateDir;
    this.nextId = 1;
    this.pending = new Map();
    this.frames = [];
    this.serverRequests = [];
    this.stderr = '';
    this.alive = false;
    const homes = path.join(stateDir, 'homes');
    for (const name of ['claude', 'grok-chat', 'antigravity']) fs.mkdirSync(path.join(homes, name), { recursive: true });
    this.home = path.join(homes, provider === 'grok' ? 'grok-chat' : provider);
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
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.serverHandler = null;
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
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('server_closed'));
      }
      this.pending.clear();
      this.emit('exit');
    });
    t.after(() => this.close());
  }

  async start() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server_start_timeout: ' + this.stderr)), 5000);
      const check = () => {
        if (this.stderr.includes('ready')) {
          clearTimeout(timer);
          this.alive = true;
          resolve();
        }
      };
      this.child.stderr.on('data', check);
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        if (!this.alive) reject(new Error(`server_exited_${code}: ${this.stderr}`));
      });
      check();
    });
    return this;
  }

  onFrame(frame) {
    this.frames.push(frame);
    this.emit('frame', frame);
    if (frame.method && frame.id !== undefined) {
      this.serverRequests.push(frame);
      this.emit('server-request', frame);
      const handler = this.serverHandler;
      if (handler) {
        Promise.resolve(handler(frame)).then((answer) => {
          if (!answer) return;
          this.respond(frame.id, answer.result, answer.error);
        }).catch((error) => this.respond(frame.id, null, { code: -32603, message: error.message }));
      }
      return;
    }
    if (frame.id !== undefined && frame.method === undefined) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(frame.id);
      if (frame.error) {
        const error = new Error(frame.error.message || 'rpc_error');
        error.code = frame.error.code;
        entry.reject(error);
      } else entry.resolve(frame.result);
    }
  }

  request(method, params = {}, timeout = 8000) {
    if (!this.alive) return Promise.reject(new Error('server_not_running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('rpc_timeout: ' + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  respond(id, result, error) {
    const frame = { jsonrpc: '2.0', id, ...(error ? { error } : { result }) };
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  waitFor(method, predicate = () => true, timeout = 8000) {
    const check = (params) => params && predicate(params);
    const existing = this.frames.find((frame) => frame.method === method && check(frame.params));
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('frame', listener);
        reject(new Error('event_timeout: ' + method));
      }, timeout);
      const listener = (frame) => {
        if (frame.method === method && check(frame.params)) {
          clearTimeout(timer);
          this.removeListener('frame', listener);
          resolve(frame.params);
        }
      };
      this.on('frame', listener);
    });
  }

  notifications(method) {
    return this.frames.filter((frame) => frame.method === method).map((frame) => frame.params);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill('SIGKILL'); } catch {}
  }
}

async function thread(client, overrides = {}) {
  const result = await client.request('thread/start', {
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
    dynamicTools: TOOLS,
    systemPrompt: 'system',
    localRoot: '/Users/example/project',
    projectId: 'project-a',
    ...overrides,
  });
  return result.thread.id;
}

async function runTurn(client, threadId, scenario, overrides = {}) {
  const started = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: `SCENARIO:${scenario}` }],
    ...overrides,
  });
  const completed = await client.waitFor('turn/completed', (params) => params.turn?.id === started.turn.id, 12000);
  return { id: started.turn.id, completed };
}

function agentText(client, turnId) {
  const completed = client.notifications('item/completed')
    .filter((params) => params.item?.type === 'agentMessage' && (!turnId || params.turnId === turnId))
    .at(-1);
  return completed?.item?.text || '';
}

function reportOf(text) {
  const index = text.indexOf('REPORT:');
  assert.notEqual(index, -1, 'expected REPORT in agent text: ' + text);
  return JSON.parse(text.slice(index + 'REPORT:'.length));
}

function defaultHandler(state) {
  return (frame) => {
    if (frame.method === 'item/tool/requestApproval') {
      state.approvals.push(frame.params);
      return { result: { decision: 'accept' } };
    }
    if (frame.method === 'item/tool/call') {
      state.calls.push(frame.params);
      return {
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify({ content: 'hello from mac', path: frame.params.arguments?.path }) }],
        },
      };
    }
    return { error: { code: -32601, message: 'unexpected request' } };
  };
}

test('initialize, thread/start and a streaming turn', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const initialized = await client.request('initialize', { clientInfo: { name: 'test', version: '1' } });
  assert.match(initialized.serverInfo.name, /agentdesk-chat-claude/);

  const threadId = await thread(client);
  assert.match(threadId, /^claude-[0-9a-f-]{36}$/);
  const { id, completed } = await runTurn(client, threadId, 'TEXT');
  assert.equal(completed.turn.status, 'completed');
  assert.equal(completed.usage.inputTokens, 7);

  const reasoning = client.notifications('item/reasoning/summaryTextDelta').map((params) => params.delta).join('');
  assert.equal(reasoning, 'checking');
  assert.match(agentText(client, id), /REPORT:/);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'chat-claude.json'), 'utf8'));
  assert.equal(stored.threads[threadId].localRoot, '/Users/example/project');
  assert.equal(stored.threads[threadId].provider, 'claude');
});

test('the selected model is passed to every provider CLI', async (t) => {
  for (const [provider, model] of [['claude', 'opus'], ['grok', 'grok-4.7'], ['antigravity', 'gemini-3-pro']]) {
    const dir = temporary(t);
    const client = await new ChatClient(t, provider, dir).start();
    const threadId = await thread(client);
    const { id, completed } = await runTurn(client, threadId, 'TEXT', { model });
    assert.equal(completed.turn.status, 'completed');
    const report = reportOf(agentText(client, id));
    assert.equal(report.args[report.args.indexOf('--model') + 1], model, provider);
    if (provider === 'claude') {
      // The wildcard alone is ignored by some Claude Code versions; the bare server name and tool names are given too.
      const allowed = report.args[report.args.indexOf('--allowedTools') + 1].split(',');
      const server = allowed.find((rule) => /^mcp__agentdesk_[0-9a-f]+$/.test(rule));
      assert.ok(server, allowed.join(','));
      assert.ok(allowed.includes(server + '__*'));
      assert.ok(allowed.includes(server + '__agentdesk_file_write'), allowed.join(','));
    }
  }
});

test('Claude tool roundtrip through the capability socket', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const state = { approvals: [], calls: [] };
  client.serverHandler = defaultHandler(state);
  const threadId = await thread(client);
  const { id, completed } = await runTurn(client, threadId, 'TOOL_READ');
  assert.equal(completed.turn.status, 'completed');
  const report = reportOf(agentText(client, id));
  assert.deepEqual(report.tools.sort(), ['agentdesk_file_read', 'agentdesk_file_write']);
  assert.match(report.call.value.content[0].text, /hello from mac/);
  assert.equal(report.unknown, 'invalid_capability');
  assert.equal(state.calls.length, 1);
  const toolStart = client.notifications('item/started').find((params) => params.item?.type === 'mcpToolCall');
  assert.equal(toolStart.item.server, 'agentdesk');
});

test('read-only turn only exposes read tools and rejects writes without approval', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const state = { approvals: [], calls: [] };
  client.serverHandler = defaultHandler(state);
  const threadId = await thread(client, { approvalPolicy: 'on-request' });
  const { id, completed } = await runTurn(client, threadId, 'PLAN_WRITE', {
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'on-request',
  });
  assert.equal(completed.turn.status, 'completed');
  const report = reportOf(agentText(client, id));
  assert.deepEqual(report.tools, ['agentdesk_file_read']);
  assert.match(report.call.error, /tool_not_available/);
  assert.equal(state.approvals.length, 0);
  assert.equal(state.calls.length, 0);
});

test('on-request write asks the app and runs after approval', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const state = { approvals: [], calls: [] };
  client.serverHandler = defaultHandler(state);
  const threadId = await thread(client, { approvalPolicy: 'on-request' });
  const { id, completed } = await runTurn(client, threadId, 'APPROVE_WRITE', { approvalPolicy: 'on-request' });
  assert.equal(completed.turn.status, 'completed');
  assert.equal(state.approvals.length, 1);
  assert.equal(state.approvals[0].tool, 'agentdesk_file_write');
  assert.equal(state.calls.length, 1);
  const report = reportOf(agentText(client, id));
  assert.match(report.call.value.content[0].text, /hello from mac/);
});

test('declining approval returns an MCP error and never calls the app', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const state = { approvals: [], calls: [] };
  client.serverHandler = (frame) => {
    if (frame.method === 'item/tool/requestApproval') {
      state.approvals.push(frame.params);
      return { result: { decision: 'decline' } };
    }
    state.calls.push(frame.params);
    return { result: { success: true, contentItems: [] } };
  };
  const threadId = await thread(client, { approvalPolicy: 'on-request' });
  const { id, completed } = await runTurn(client, threadId, 'APPROVE_WRITE', { approvalPolicy: 'on-request' });
  assert.equal(completed.turn.status, 'completed');
  assert.equal(state.approvals.length, 1);
  assert.equal(state.calls.length, 0);
  const report = reportOf(agentText(client, id));
  assert.equal(report.call.value.isError, true);
  assert.match(report.call.value.content[0].text, /用户拒绝/);
});

test('a thread runs one turn at a time and interrupt completes as interrupted', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'grok', dir).start();
  const threadId = await thread(client);
  const started = await client.request('turn/start', {
    threadId, input: [{ type: 'text', text: 'SCENARIO:HANG' }],
  });
  await assert.rejects(client.request('turn/start', {
    threadId, input: [{ type: 'text', text: 'SCENARIO:TEXT' }],
  }), /turn_in_progress/);
  await client.waitFor('item/agentMessage/delta', (params) => params.turnId === started.turn.id);
  await client.request('turn/interrupt', { threadId, turnId: started.turn.id });
  const completed = await client.waitFor('turn/completed', (params) => params.turn?.id === started.turn.id);
  assert.equal(completed.turn.status, 'interrupted');
  const text = client.notifications('item/agentMessage/delta').map((params) => params.delta).join('');
  assert.match(text, /partial/);
});

test('thread metadata survives a server restart and resume is passed to the CLI', async (t) => {
  const dir = temporary(t);
  const first = await new ChatClient(t, 'claude', dir).start();
  const threadId = await thread(first);
  await runTurn(first, threadId, 'TEXT');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'chat-claude.json'), 'utf8'));
  const session = stored.threads[threadId].sessionId;
  assert.ok(session);
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 150));

  const second = await new ChatClient(t, 'claude', dir).start();
  const resumed = await second.request('thread/resume', { threadId });
  assert.equal(resumed.thread.id, threadId);
  assert.equal(resumed.localRoot, '/Users/example/project');
  const { completed } = await runTurn(second, threadId, 'TEXT');
  assert.equal(completed.turn.status, 'completed');
  const report = reportOf(agentText(second));
  assert.ok(report.args.includes('--resume'), report.args.join(' '));
  assert.equal(report.args[report.args.indexOf('--resume') + 1], session);
});

test('Grok and Antigravity use their own event formats and session flags', async (t) => {
  const grokDir = temporary(t);
  const grok = await new ChatClient(t, 'grok', grokDir).start();
  const grokThread = await thread(grok);
  const grokFirst = await runTurn(grok, grokThread, 'TEXT');
  const grokReport1 = reportOf(agentText(grok, grokFirst.id));
  assert.equal(grokReport1.provider, 'grok');
  assert.ok(grokReport1.args.includes('--session-id'));
  assert.ok(grokReport1.args.includes('streaming-messages-json'));
  assert.ok(grokReport1.args.includes('--trust'), 'project MCP config only loads in a trusted folder');
  assert.match(grokReport1.args[grokReport1.args.indexOf('--allow') + 1], /^MCPTool\(agentdesk_[0-9a-f]+__\*\)$/);
  // Web search is on, as for Codex; without the sandbox the shell stays off.
  assert.ok(!grokReport1.args.includes('--disable-web-search'));
  assert.match(grokReport1.args[grokReport1.args.indexOf('--tools') + 1], /web_search/);
  assert.match(grokReport1.args[grokReport1.args.indexOf('--disallowed-tools') + 1], /run_terminal_command/);
  const grokStored = JSON.parse(fs.readFileSync(path.join(grokDir, 'chat-grok.json'), 'utf8'));
  const grokSession = grokStored.threads[grokThread].sessionId;
  const grokSecond = await runTurn(grok, grokThread, 'TEXT');
  const grokReport2 = reportOf(agentText(grok, grokSecond.id));
  assert.equal(grokReport2.args[grokReport2.args.indexOf('--resume') + 1], grokSession);
  assert.equal(grok.notifications('item/agentMessage/delta').length > 0, true);

  const antigravityDir = temporary(t);
  const antigravity = await new ChatClient(t, 'antigravity', antigravityDir).start();
  const antigravityState = { approvals: [], calls: [] };
  antigravity.serverHandler = defaultHandler(antigravityState);
  const antigravityThread = await thread(antigravity);
  const antigravityFirst = await runTurn(antigravity, antigravityThread, 'TEXT');
  const antigravityReport1 = reportOf(agentText(antigravity, antigravityFirst.id));
  assert.equal(antigravityReport1.provider, 'antigravity');
  assert.ok(antigravityReport1.args.includes('--settings'));
  const agyPermissions = JSON.parse(antigravityReport1.args[antigravityReport1.args.indexOf('--settings') + 1]).permissions;
  assert.ok(agyPermissions.allow.includes('read_url(*)') && agyPermissions.deny.includes('command(*)'));
  const antigravityStored = JSON.parse(fs.readFileSync(path.join(antigravityDir, 'chat-antigravity.json'), 'utf8'));
  const conversation = antigravityStored.threads[antigravityThread].sessionId;
  assert.ok(conversation);
  const antigravitySecond = await runTurn(antigravity, antigravityThread, 'TEXT');
  const antigravityReport2 = reportOf(agentText(antigravity, antigravitySecond.id));
  assert.equal(antigravityReport2.args[antigravityReport2.args.indexOf('--conversation') + 1], conversation);

  // Antigravity discovers MCP servers from $HOME/.gemini/config, so a tool turn
  // also proves the user-level config written by chat-server is the one it reads.
  const antigravityTool = await runTurn(antigravity, antigravityThread, 'TOOL_READ');
  const antigravityToolReport = reportOf(agentText(antigravity, antigravityTool.id));
  assert.deepEqual(antigravityToolReport.tools.sort(), ['agentdesk_file_read', 'agentdesk_file_write']);
  assert.match(antigravityToolReport.call.value.content[0].text, /hello from mac/);
  assert.equal(antigravityToolReport.unknown, 'invalid_capability');
  assert.equal(antigravityState.calls.length, 1);
});

test('a failed resume resets the session so the next turn starts fresh', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const threadId = await thread(client);
  await runTurn(client, threadId, 'TEXT');
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'chat-claude.json'), 'utf8')).threads[threadId];
  const oldSession = before.sessionId;

  const failed = await runTurn(client, threadId, 'RESUME_FAIL');
  assert.equal(failed.completed.turn.status, 'failed');
  assert.match(failed.completed.turn.error.message, /已重置/);
  const reset = JSON.parse(fs.readFileSync(path.join(dir, 'chat-claude.json'), 'utf8')).threads[threadId];
  assert.notEqual(reset.sessionId, oldSession);
  assert.equal(reset.started, false);

  const next = await runTurn(client, threadId, 'TEXT');
  assert.equal(next.completed.turn.status, 'completed');
  const report = reportOf(agentText(client, next.id));
  assert.ok(report.args.includes('--session-id'));
  assert.equal(report.args[report.args.indexOf('--session-id') + 1], reset.sessionId);
});