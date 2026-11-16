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
  },
  grok: {
    args: (prompt, readonly, session) => [
      '--no-auto-update', '--output-format', 'plain', '--permission-mode', readonly ? 'dontAsk' : 'acceptEdits',
      '--allow', 'Read', '--allow', 'Grep', '--allow', 'WebSearch',
      ...(readonly ? ['--deny', 'Edit'] : []), '--deny', 'Bash', '--session-id', session, '-p', prompt,
    ],
    plain: true,
  },
};

async function runAdapter({ name, config, cwd, prompt, readonly, timeout, signal, log, onSession, session, model, mcp }) {
  if (signal.aborted) throw signal.reason;
  const provider = providers[name];
  if (provider.plain && !session) {
    session = randomUUID();
    onSession(session);
  }
  const args = provider.args(prompt, readonly, session);
  if (model) {
    if (name === 'codex') {
      args.splice(args[1] === 'resume' ? 2 : 1, 0, '-c', 'model=' + JSON.stringify(model));
    } else {
      args.unshift('--model', model);
    }
  }
  const env = { ...config.env };
  if (mcp) {
    const server = { command: process.execPath, args: [require.resolve('./mcp'), mcp.socket, mcp.capability] };
    if (name === 'codex') {
      args.splice(args[1] === 'resume' ? 2 : 1, 0,
        '-c', 'mcp_servers.agentdesk_windows.command=' + JSON.stringify(server.command),
        '-c', 'mcp_servers.agentdesk_windows.args=' + JSON.stringify(server.args));
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
        if (typeof message === 'string') output = redact(message).slice(0, 12000);
      } catch {}
    });
  }
  child.stdin.on('error', () => {});
  child.stdin.end(name === 'grok' ? undefined : prompt);
  try {
    const [code] = await once(child, 'close');
    if (stopped) throw stopped;
    if (code !== 0) throw new Error('cli_exit_' + code);
    return { output };
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

module.exports = { providers, runAdapter };
