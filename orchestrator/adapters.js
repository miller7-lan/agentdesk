const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { sandboxCommand } = require('./sandbox');
const { captureClaudeRateLimitEvent } = require('./quotas');

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
      ...(readonly ? ['--deny', 'Edit'] : ['--allow', 'Edit']), '--deny', 'Bash', '--session-id', session, '-p', prompt,
    ],
    plain: true,
    promptArg: true,
  },
  gemini: {
    args: (_prompt, readonly, session) => [
      '--output-format', 'stream-json', '--approval-mode', readonly ? 'default' : 'auto_edit',
      ...(session ? ['--resume', session] : []),
    ],
    session: (event) => event.type === 'init' && event.session_id,
    output: (event) => event.type === 'message' && event.role === 'assistant' && event.content,
    append: (event) => event.delta === true,
    usage: (event) => event.type === 'result' && (event.stats || event.usage),
  },
};

// Reasoning effort per CLI, as each accepts it. Codex: -c model_reasoning_effort; Claude Code: the
// CLAUDE_CODE_EFFORT_LEVEL environment variable (its --effort flag is ignored by some versions); Grok Build:
// --effort. Antigravity has no flag for it (only the interactive /effort); a template may give effortArgs.
const EFFORTS = {
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high', 'xhigh'],
};
const effortsFor = (name, config) => config?.template?.efforts || EFFORTS[name] || [];

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
    failure: (event) => field(event, t.errorField),
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
// "Resets in 4h54m26s" (Antigravity) or "try again in 2h 3m" (Codex): how long until the quota returns, in ms.
// A minute is added so the CLI is not asked again just before its quota actually comes back.
function resetDelay(text) {
  const match = /(?:resets? in|try again in)\s*((?:\d+\s*[dhms]\s*)+)/i.exec(String(text || ''));
  if (!match) return null;
  const unit = { d: 86400_000, h: 3600_000, m: 60_000, s: 1000 };
  let ms = 0;
  for (const [, n, u] of match[1].matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(n) * unit[u.toLowerCase()];
  return ms > 0 && ms <= 8 * 86400_000 ? ms + 60_000 : null;
}

function classifyFailure(text) {
  if (/not logged in|log ?in required|please (?:log|sign) ?in|unauthori[sz]ed|\b401\b|authentication (?:failed|required)|invalid api key|(?:token|session|credentials?) (?:has )?expired|IneligibleTierError|UNSUPPORTED_CLIENT|client is no longer supported/i.test(text)) return 'cli_auth_required';
  if (/usage limit|rate[ _-]?limit|quota|too many requests|\b429\b|credit balance|limit (?:reached|exceeded)|hit your \d+[ -]hour limit|out of (?:credits|messages)/i.test(text)) return 'cli_quota_exhausted';
  return null;
}

async function runAdapter({ name, config, cwd, prompt, readonly, timeout, signal, log, onSession, session, model, effort, mcp, attachmentDirectory }) {
  if (effort !== undefined && !effortsFor(name, config).includes(effort)) effort = undefined;   // never pass an unknown level
  if (signal.aborted) throw signal.reason;
  const provider = config.template ? templateProvider(config.template) : providers[name];
  if (!provider) throw new Error(name + '_not_supported');
  if ((provider.plain && !provider.template && !session) || (provider.generateSession && !session)) {
    session = randomUUID();
    onSession(session);
  }
  const args = provider.args(prompt, readonly, session, model);
  // In the sandbox these CLIs may run shell commands, as Codex does in its own sandbox.
  const sandboxed = Boolean(config.sandbox) && name !== 'codex';
  if (sandboxed && name === 'grok' && !provider.template) {
    const deny = args.findIndex((arg, index) => arg === 'Bash' && args[index - 1] === '--deny');
    if (deny > 0) args.splice(deny - 1, 2, '--allow', 'Bash');
  }
  if (sandboxed && name === 'claude' && !provider.template && !readonly) args.push('--allowedTools', 'Bash');
  if (name === 'gemini' && !provider.template) {
    if (!readonly && !config.writePolicy) throw new Error('provider_write_not_enabled');
    args.push('--admin-policy', readonly ? config.reviewPolicy : config.writePolicy);
  }
  if (model && !provider.template) {
    if (name === 'codex') {
      args.splice(args[1] === 'resume' ? 2 : 1, 0, '-c', 'model=' + JSON.stringify(model));
    } else {
      args.unshift('--model', model);
    }
  }
  const env = { ...config.env };
  if (effort) {
    if (provider.template) args.unshift(...fill(config.template.effortArgs, {}).map((arg) => arg.replace('{effort}', effort)));
    else if (name === 'codex') args.splice(args[1] === 'resume' ? 2 : 1, 0, '-c', 'model_reasoning_effort=' + JSON.stringify(effort));
    else if (name === 'claude') env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    else if (name === 'grok') args.unshift('--effort', effort);
  }
  if (name === 'antigravity' && provider.template && (mcp || sandboxed)) {
    if (mcp) {
      env.AGENTDESK_MCP_SOCKET = mcp.socket;
      env.AGENTDESK_MCP_CAPABILITY = mcp.capability;
    }
    const allow = [...(mcp ? ['mcp(agentdesk_windows/*)'] : []), ...(sandboxed ? ['command(*)'] : [])];
    args.unshift('--settings', JSON.stringify({ permissions: { allow } }));
  }
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
      args.unshift('--allow', 'MCPTool(agentdesk_windows__*)');
    }
  }
  const launch = sandboxed
    ? sandboxCommand(config.bin, args, { bin: config.sandbox.bin, cwd, home: env.HOME, writable: !readonly,
      hide: [config.sandbox.stateDir], hideDefaults: config.sandbox.hideDefaults, sockets: mcp ? [mcp.socket] : [],
      extraReadOnly: attachmentDirectory ? [attachmentDirectory] : [] })
    : { command: config.bin, args };
  const child = spawn(launch.command, launch.args, {
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
      if (channel === 'stderr' && /permission required:.*was not run.*headless run cannot ask for approval/i.test(safe)) {
        failure = 'cli_tool_permission_required';
      }
      if (channel === 'stderr') return;
      if (provider.plain) {
        output = (output + safe + '\n').slice(-12000);
        return;
      }
      try {
        const event = JSON.parse(line);
        // Claude tasks report the account's limits too, so the quota snapshot also stays live between direct chats.
        if (name === 'claude' && config.quotaFile && event.type === 'rate_limit_event') {
          captureClaudeRateLimitEvent(config.quotaFile, event.rate_limit_info).catch(() => {});
        }
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
      const kind = failure === 'cli_tool_permission_required' ? failure : classifyFailure((failure || '') + '\n' + tail);
      const retryAfterMs = kind === 'cli_quota_exhausted' ? resetDelay((failure || '') + '\n' + tail) : null;
      throw Object.assign(new Error(kind || (code !== 0 ? 'cli_exit_' + code : 'cli_reported_error')),
        { provider: name, usage, ...(retryAfterMs && { retryAfterMs }) });
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

module.exports = { EFFORTS, effortsFor, providers, runAdapter, templateProvider, normalizeUsage, addUsage, classifyFailure, resetDelay };
