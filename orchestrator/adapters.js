const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

const providers = {
  codex: {
    args: (prompt, readonly, session) => session
      ? ['exec', 'resume', '--json', '-c', 'sandbox_mode=' + JSON.stringify(readonly ? 'read-only' : 'workspace-write'), session, '-']
      : ['exec', '--json', '--sandbox', readonly ? 'read-only' : 'workspace-write', '-'],
    session: (event) => event.thread_id,
    output: (event) => event.item?.type === 'agent_message' && event.item.text,
    usage: (event) => event.type === 'turn.completed' && event.usage,
    failure: (event) => event.type === 'turn.failed' && (event.error?.message || 'turn_failed'),
    diagnostic: (event) => event.type === 'error' && event.message,
  },
  claude: {
    args: (_prompt, readonly, session) => [
      '-p', '--verbose', '--output-format', 'stream-json',
      '--permission-mode', readonly ? 'plan' : 'acceptEdits',
      ...(readonly ? ['--disallowedTools', 'Bash,Write,Edit,NotebookEdit'] : []),
      ...(session ? ['--resume', session] : []),
    ],
    session: (event) => event.session_id,
    output: (event) => event.type === 'result' && event.result,
    usage: (event) => event.type === 'result' && { ...event.usage, cost_usd: event.total_cost_usd },
    failure: (event) => event.type === 'result' && event.is_error && String(event.result || event.subtype || 'error'),
  },
  grok: {
    args: (prompt, readonly, session) => [
      '--no-auto-update', '--output-format', 'plain', '--permission-mode', readonly ? 'dontAsk' : 'acceptEdits',
      '--allow', 'Read', '--allow', 'Grep', '--allow', 'WebSearch',
      ...(readonly ? ['--deny', 'Edit'] : []), '--deny', 'Bash', '--session-id', session, '-p', prompt,
    ],
    plain: true,
    promptArg: true,
  },
  gemini: {
    args: (_prompt, _readonly, session) => [
      '--output-format', 'stream-json', '--approval-mode', 'default',
      ...(session ? ['--resume', session] : []),
    ],
    session: (event) => event.type === 'init' && event.session_id,
    output: (event) => event.type === 'message' && event.role === 'assistant' && event.content,
    append: (event) => event.delta === true,
    usage: (event) => event.type === 'result' && (event.stats || event.usage),
  },
};

const field = (value, dotted) => dotted && String(dotted).split('.').reduce((node, key) => node?.[key], value);
const fill = (list, values) => (list || []).map((arg) => arg.replace(/\{(prompt|model|session)\}/g, (_, key) => values[key] ?? ''));

// A CLI described entirely by configuration, so a new subscription CLI (Antigravity first) can be added
// after checking its flags on the server, without code changes. See orchestrator/OPERATIONS.md.
function templateProvider(t) {
  return {
    template: true,
    plain: t.output !== 'jsonl',
    promptArg: t.prompt === 'arg',
    generateSession: t.session === 'generate',
    args: (prompt, readonly, session, model) => [
      ...fill(session ? t.resumeArgs : [], { session }),
      ...fill(readonly ? t.readonlyArgs : t.writeArgs, {}),
      ...fill(model ? t.modelArgs : [], { model }),
      ...fill(t.args, { prompt, session }),
    ],
    session: (event) => field(event, t.sessionField),
    output: (event) => field(event, t.outputField),
    usage: (event) => field(event, t.usageField),
  };
}

// Token counts in whatever shape a CLI reports them, reduced to one shape.
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...names) => names.map((name) => raw[name]).find((value) => Number.isFinite(value));
  const usage = {
    input: pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokenCount'),
    cachedInput: pick('cached_input_tokens', 'cache_read_input_tokens', 'cachedInputTokens', 'cachedContentTokenCount'),
    cacheWrite: pick('cache_creation_input_tokens'),
    output: pick('output_tokens', 'outputTokens', 'completion_tokens', 'candidatesTokenCount'),
    costUsd: pick('cost_usd', 'total_cost_usd'),
  };
  return Object.values(usage).some((value) => value !== undefined)
    ? Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) : null;
}

function addUsage(total, usage) {
  if (!usage) return total;
  const sum = { ...(total || {}) };
  for (const [key, value] of Object.entries(usage)) sum[key] = (sum[key] || 0) + value;
  return sum;
}

// Exit text that means "this CLI cannot work right now" rather than "the task failed".
// Login problems are checked first: an expired session often also mentions limits.
function classifyFailure(text) {
  if (/not logged in|log ?in required|please (?:log|sign) ?in|unauthori[sz]ed|\b401\b|authentication (?:failed|required)|invalid api key|(?:token|session|credentials?) (?:has )?expired/i.test(text)) return 'cli_auth_required';
  if (/usage limit|rate[ _-]?limit|quota|too many requests|\b429\b|credit balance|limit (?:reached|exceeded)|hit your \d+[ -]hour limit|out of (?:credits|messages)/i.test(text)) return 'cli_quota_exhausted';
  return null;
}

async function runAdapter({ name, config, cwd, prompt, readonly, timeout, signal, log, onSession, session, model, mcp }) {
  if (signal.aborted) throw signal.reason;
  const provider = config.template ? templateProvider(config.template) : providers[name];
  if (!provider) throw new Error(name + '_not_supported');
  if ((provider.plain && !provider.template && !session) || (provider.generateSession && !session)) {
    session = randomUUID();
    onSession(session);
  }
  const args = provider.args(prompt, readonly, session, model);
  if (name === 'gemini' && !provider.template) args.push('--admin-policy', config.reviewPolicy);
  if (model && !provider.template) {
    if (name === 'codex') {
      args.splice(args[1] === 'resume' ? 2 : 1, 0, '-c', 'model=' + JSON.stringify(model));
    } else {
      args.unshift('--model', model);
    }
  }
  const env = { ...config.env };
  if (mcp && !provider.template && name !== 'gemini') {
    const server = { command: process.execPath, args: [require.resolve('./mcp'), mcp.socket, mcp.capability] };
    if (name === 'codex') {
      args.splice(args[1] === 'resume' ? 2 : 1, 0,
        '-c', 'mcp_servers.agentdesk_windows.command=' + JSON.stringify(server.command),
        '-c', 'mcp_servers.agentdesk_windows.args=' + JSON.stringify(server.args),
        '-c', 'mcp_servers.agentdesk_windows.default_tools_approval_mode="writes"');
    } else if (name === 'claude') {
      args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { agentdesk_windows: server } }),
        '--allowedTools', 'mcp__agentdesk_windows__*');
    } else {
      env.AGENTDESK_MCP_SOCKET = mcp.socket;
      env.AGENTDESK_MCP_CAPABILITY = mcp.capability;
      args.unshift('--allow', 'MCPTool(agentdesk_windows:*)');
    }
  }
  const child = spawn(config.bin, args, {
    cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stream = createWriteStream(log, { flags: 'a', mode: 0o600 });
  stream.on('error', () => {});
  const secrets = Object.entries(config.env).filter(([key, value]) => /KEY|TOKEN|SECRET/i.test(key) && value)
    .map(([, value]) => value);
  if (mcp) secrets.push(mcp.capability);
  const redact = (line) => secrets.reduce((safe, secret) => safe.replaceAll(secret, '<redacted>'), String(line));
  let killTimer;
  let stopped;
  let output = '';
  let bytes = 0;
  let usage = null;
  let failure = null;
  let tail = '';                // last lines of both streams, used to tell quota and login errors apart
  function terminate(reason) {
    if (stopped) return;
    stopped = reason;
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 3000);
  }
  const timer = setTimeout(() => terminate(new Error('cli_timeout')), timeout);
  const abort = () => terminate(signal.reason ?? new Error('cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  for (const [channel, input] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    createInterface({ input }).on('line', (line) => {
      const safe = redact(line);
      bytes += Buffer.byteLength(safe);
      if (bytes > 4 * 1024 * 1024) {
        terminate(new Error('cli_output_limit'));
        return;
      }
      stream.write(channel + ' ' + safe + '\n');
      if (channel === 'stderr' || provider.plain) tail = (tail + safe + '\n').slice(-4000);   // JSON output holds the model's own text
      if (channel === 'stderr') return;
      if (provider.plain) {
        output = (output + safe + '\n').slice(-12000);
        return;
      }
      try {
        const event = JSON.parse(line);
        const id = provider.session(event);
        if (typeof id === 'string') onSession(id);
        const message = provider.output(event);
        if (typeof message === 'string') output = (provider.append?.(event) ? output + redact(message) : redact(message)).slice(0, 12000);
        usage = addUsage(usage, normalizeUsage(provider.usage?.(event)));
        const diagnostic = provider.diagnostic?.(event);
        if (typeof diagnostic === 'string') tail = (tail + redact(diagnostic) + '\n').slice(-4000);
        const failed = provider.failure?.(event);
        if (failed) failure = redact(failed);
      } catch {}
    });
  }
  child.stdin.on('error', () => {});
  child.stdin.end(provider.promptArg ? undefined : prompt);
  try {
    const [code] = await once(child, 'close');
    if (stopped) throw stopped;
    if (code !== 0 || failure) {
      const kind = classifyFailure((failure || '') + '\n' + tail);
      throw Object.assign(new Error(kind || (code !== 0 ? 'cli_exit_' + code : 'cli_reported_error')), { provider: name, usage });
    }
    return { output, usage };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    signal.removeEventListener('abort', abort);
    stream.end();
  }
}

module.exports = { providers, runAdapter, templateProvider, normalizeUsage, addUsage, classifyFailure };
