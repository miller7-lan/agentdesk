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
  constructor(t, provider, stateDir, toolTimeout = 4000) {
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
        AGENTDESK_CHAT_TOOL_TIMEOUT: String(toolTimeout),
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

test('Antigravity single chat lists the local CLI catalog without starting a model turn', async (t) => {
  const client = await new ChatClient(t, 'antigravity', temporary(t)).start();
  const result = await client.request('model/list', {});
  assert.deepEqual(result.data, [{ id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' }]);
  assert.equal(result.defaultModel, result.data[0].id);
});

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

test('Grok Build reports an exhausted subscription as a quota failure', async (t) => {
  const client = await new ChatClient(t, 'grok', temporary(t)).start();
  const { completed } = await runTurn(client, await thread(client), 'QUOTA');
  assert.equal(completed.turn.status, 'failed');
  assert.match(completed.turn.error.message, /额度或频率限制.*Grok Build usage balance exhausted/);
});

test('Claude rate limits from a direct turn refresh the quota snapshot', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const threadId = await thread(client);
  const { completed } = await runTurn(client, threadId, 'QUOTA');
  assert.equal(completed.turn.status, 'completed');
  // The write is fire-and-forget; give it a moment past turn/completed.
  const file = path.join(dir, 'claude-quotas.json');
  const started = Date.now();
  while (!fs.existsSync(file) && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(snapshot.buckets[0].id, 'claude-account');
  assert.equal(snapshot.buckets[0].fiveHour.usedPercent, 54);
  assert.equal(snapshot.buckets[0].weekly.usedPercent, 84);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the selected model and reasoning effort are passed to every provider CLI', async (t) => {
  for (const [provider, model, effort, flag] of [
    ['claude', 'claude-opus-5-5', 'high', '--effort'],
    ['grok', 'grok-4.7', 'xhigh', '--effort'],
    ['antigravity', 'gemini-3.8-flash-medium', 'medium', '--effort'],
  ]) {
    const dir = temporary(t);
    const client = await new ChatClient(t, provider, dir).start();
    const threadId = await thread(client);
    const { id, completed } = await runTurn(client, threadId, 'TEXT', { model, effort });
    assert.equal(completed.turn.status, 'completed');
    const report = reportOf(agentText(client, id));
    assert.equal(report.args[report.args.indexOf('--model') + 1], model, provider);
    assert.equal(report.args[report.args.indexOf(flag) + 1], effort, provider);
    // Claude also gets the environment variable, which every Claude Code version honours.
    if (provider === 'claude') assert.equal(report.claudeEffort, effort);
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

test('an effort level the provider does not accept is refused', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'grok', dir).start();
  const threadId = await thread(client);
  // Grok tops out at xhigh; `max` is only valid for Claude and Antigravity.
  await assert.rejects(
    client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'SCENARIO:TEXT' }],
      effort: 'max',
    }),
    (error) => error.code === -32602 && /invalid_effort/.test(error.message),
  );
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
  assert.deepEqual(report.tools.sort(), ['agentdesk_attachment_read', 'agentdesk_file_read', 'agentdesk_file_write']);
  assert.match(report.call.value.content[0].text, /hello from mac/);
  assert.equal(report.unknown, 'invalid_capability');
  assert.equal(state.calls.length, 1);
  const toolStart = client.notifications('item/started').find((params) => params.item?.type === 'mcpToolCall');
  assert.equal(toolStart.item.server, 'agentdesk');
});

test('a local command can finish after the ordinary tool deadline', async (t) => {
  const delayMs = Number(process.env.AGENTDESK_QA_COMMAND_DELAY_MS) || 700;
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir, delayMs > 65000 ? 65000 : 200).start();
  const threadId = await thread(client, {
    approvalPolicy: 'on-request',
    dynamicTools: [{ name: 'agentdesk_command_run', description: 'Run a local command',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }],
  });
  let approvalItem;
  let callItem;
  client.serverHandler = async ({ method, params }) => {
    if (method === 'item/tool/requestApproval') {
      approvalItem = params.itemId;
      return { result: { decision: 'accept' } };
    }
    callItem = params.itemId;
    assert.equal(params.requiresApproval, true);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { result: { success: true, contentItems: [{ type: 'inputText', text: 'local command finished' }] } };
  };
  const started = await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'SCENARIO:TOOL_COMMAND' }] });
  const completed = await client.waitFor('turn/completed', (params) => params.turn?.id === started.turn.id, delayMs + 12000);
  assert.equal(completed.turn.status, 'completed');
  assert.ok(approvalItem);
  assert.equal(approvalItem, callItem);
  assert.equal(reportOf(agentText(client, started.turn.id)).call.value.content[0].text, 'local command finished');
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
  assert.deepEqual(report.tools, ['agentdesk_file_read', 'agentdesk_attachment_read']);
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
  assert.ok(grokReport1.args.some((arg, i) => arg === '--allow' && grokReport1.args[i + 1] === 'Fetch'));
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
  assert.deepEqual(antigravityToolReport.tools.sort(), ['agentdesk_attachment_read', 'agentdesk_file_read', 'agentdesk_file_write']);
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
test('every chat reads attachments of any type through its own tool, without the sandbox', async (t) => {
  const { createHash, randomUUID } = require('node:crypto');
  for (const provider of ['claude', 'grok', 'antigravity']) {
    const dir = temporary(t);
    const client = await new ChatClient(t, provider, dir).start();
    const threadId = await thread(client);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const files = [['note.txt', Buffer.from('附件里的文字')], ['pic.png', png], ['data.bin', Buffer.from([0, 1, 2, 3])]].map(([name, bytes]) =>
      ({ item: { id: randomUUID(), name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, bytes }));
    await client.request('attachment/reset', { threadId });
    for (const { item, bytes } of files) {
      await client.request('attachment/chunk', { threadId, id: item.id, offset: 0, data: bytes.toString('base64') });
    }
    const { id, completed } = await runTurn(client, threadId, 'ATTACH', { attachments: files.map(({ item }) => item) });
    assert.equal(completed.turn.status, 'completed', provider);
    const report = reportOf(agentText(client, id));
    assert.ok(report.tools.includes('agentdesk_attachment_read'), provider);
    assert.match(report.reads['note.txt'].value.content[0].text, /附件里的文字/);
    const image = report.reads['pic.png'].value.content.find((item) => item.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(Buffer.from(image.data, 'base64').toString('hex'), png.toString('hex'));
    assert.match(report.reads['data.bin'].value.content[0].text, /二进制文件，4 字节/);
    assert.equal(report.reads['missing.txt'].value.isError, true);
  }
});

test('the prompt cache stays valid: one tool server name per conversation, instructions sent once to Antigravity', async (t) => {
  const claude = await new ChatClient(t, 'claude', temporary(t)).start();
  const claudeThread = await thread(claude);
  const names = [];
  for (let i = 0; i < 2; i += 1) {
    const { id } = await runTurn(claude, claudeThread, 'TEXT');
    const args = reportOf(agentText(claude, id)).args;
    names.push(args[args.indexOf('--allowedTools') + 1].split(',')[0]);
    assert.doesNotMatch(args[args.indexOf('--append-system-prompt') + 1], /本轮是只读规划模式/);   // per-turn notes stay out of the system prompt
  }
  assert.equal(names[0], names[1]);

  const antigravity = await new ChatClient(t, 'antigravity', temporary(t)).start();
  const agThread = await thread(antigravity);
  const prompts = [];
  for (let i = 0; i < 2; i += 1) {
    const { id } = await runTurn(antigravity, agThread, 'TEXT');
    const args = reportOf(agentText(antigravity, id)).args;
    prompts.push(args[args.indexOf('-p') + 1]);
  }
  assert.match(prompts[0], /AgentDesk 单聊/);
  assert.doesNotMatch(prompts[1], /AgentDesk 单聊/);
  assert.match(prompts[1], /SCENARIO:TEXT/);
});

test('question cards: agentdesk_ask_user reaches the app as requestUserInput and the answer reaches the CLI', async (t) => {
  for (const provider of ['claude', 'grok', 'antigravity']) {
    const dir = temporary(t);
    const client = await new ChatClient(t, provider, dir).start();
    const info = await client.request('initialize', { clientInfo: { name: 'test', version: '1' }, capabilities: { questionCards: true } });
    assert.equal(info.features.questionCards, true);
    const asked = [];
    client.serverHandler = (frame) => {
      if (frame.method !== 'item/tool/requestUserInput') return { error: { code: -32601, message: 'unexpected' } };
      asked.push(frame.params);
      return { result: { answers: { q1: { answers: ['蓝'] }, q2: { answers: ['导出', '打印'] } } } };
    };
    const threadId = await thread(client, { approvalPolicy: 'on-request' });
    const { id, completed } = await runTurn(client, threadId, 'ASK_USER', { sandboxPolicy: { type: 'readOnly' } });
    assert.equal(completed.turn.status, 'completed', provider);
    const report = reportOf(agentText(client, id));
    assert.ok(report.tools.includes('agentdesk_ask_user'), provider + ' read-only turns still offer the question tool');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].agent, provider);
    assert.equal(asked[0].source, 'agentdesk_ask_user');
    assert.deepEqual(asked[0].questions.map((q) => q.id), ['q1', 'q2']);
    assert.deepEqual(asked[0].questions[0].options, [{ label: '红', description: '暖色' }, { label: '蓝' }]);
    assert.equal(asked[0].questions[1].multiSelect, true);
    assert.match(report.call.value.content[0].text, /你喜欢哪个颜色？\n   → 蓝/);
    assert.match(report.call.value.content[0].text, /导出；打印/);
    assert.equal(report.mcpToolTimeout, provider === 'antigravity' ? null : String(15 * 60_000 + 60_000));
  }
});

test('question cards: a skipped question tells the CLI to carry on', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  await client.request('initialize', { clientInfo: { name: 'test', version: '1' }, capabilities: { questionCards: true } });
  client.serverHandler = () => ({ result: { answers: {}, cancelled: true } });
  const threadId = await thread(client);
  const { id } = await runTurn(client, threadId, 'ASK_USER');
  assert.match(reportOf(agentText(client, id)).call.value.content[0].text, /用户跳过了这些问题/);
});

test('question cards: a client without question cards never gets the question tool', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  await client.request('initialize', { clientInfo: { name: 'old', version: '0.2.0' } });
  client.serverHandler = () => ({ error: { code: -32601, message: 'unexpected' } });
  const threadId = await thread(client);
  const { id } = await runTurn(client, threadId, 'ASK_USER');
  const report = reportOf(agentText(client, id));
  assert.equal(report.tools.includes('agentdesk_ask_user'), false);
  assert.match(JSON.stringify(report.call), /tool_not_available/);
  assert.equal(report.mcpToolTimeout, null);
  assert.equal(client.serverRequests.length, 0);
});

test('自动编辑: file writes skip approval, commands still ask', async (t) => {
  const dir = temporary(t);
  const client = await new ChatClient(t, 'claude', dir).start();
  const state = { approvals: [], calls: [] };
  client.serverHandler = defaultHandler(state);
  const threadId = await thread(client, { approvalPolicy: 'on-request' });
  await runTurn(client, threadId, 'APPROVE_WRITE', { approvalPolicy: 'on-request', autoApprove: 'edits' });
  assert.equal(state.approvals.length, 0);
  assert.equal(state.calls.length, 1);
  const commandThread = await thread(client, { approvalPolicy: 'on-request', dynamicTools: [{ name: 'agentdesk_command_run',
    description: 'Run a local command', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }] });
  await runTurn(client, commandThread, 'TOOL_COMMAND', { approvalPolicy: 'on-request', autoApprove: 'edits' });
  assert.equal(state.approvals.length, 1);
  assert.equal(state.approvals[0].tool, 'agentdesk_command_run');
});
