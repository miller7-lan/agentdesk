#!/usr/bin/env node
// Native CLI single chats, step 2 of 2 (see native-tui.js). Started by native-tui-host.js inside the session's
// pseudo-terminal, already as the CLI's service account (Codex: root, as for the native Codex seat). Prepares the
// CLI's private history and its connection to the agentdesk MCP server, then runs the official CLI in bubblewrap
// with the terminal passed straight through. Its exit code is the CLI's.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sandboxCommand } = require('./sandbox');
const cliHistory = require('./cli-history');
const { BINS, MCP_SERVER, UPLOADS, tuiPrompt, previousConversation, cliArgs, grokMcpToml } = require('./native-tui');

const HOST_STATE = '/var/lib/agentdesk-orchestrator';
const BILLING = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
  'GROK_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function fail(code) {
  process.stderr.write(`\r\n\x1b[31mAgentDesk：原生 CLI 启动失败（${code}）\x1b[0m\r\n`);
  process.exit(70);
}

function plan(config, { env = process.env, fresh = false } = {}) {
  const { provider, writable, platform, cwd, mountDir, runtimeDir, historyRoot, socket, capability, tools = [], home } = config;
  const mcp = { command: process.execPath, args: [path.join(__dirname, 'chat-mcp.js'), socket, capability] };
  const prompt = tuiPrompt({ platform, writable, tools });
  const extraWritable = [];
  const roBinds = [];
  let leaderSocket;
  if (provider === 'grok') {
    // The Grok login lives in the grok profile; the chat profile gets a copy (as chat-server.js does).
    const source = path.join(HOST_STATE, 'homes', 'grok', '.grok', 'auth.json');
    const target = path.join(home, '.grok', 'auth.json');
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = path.join(home, '.grok', 'config.toml');
    try { fs.writeFileSync(config, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const file = path.join(runtimeDir, 'grok-mcp.toml');
    fs.writeFileSync(file, grokMcpToml(mcp), { mode: 0o600 });
    roBinds.push([file, config]);
    const leader = fs.mkdtempSync(path.join(runtimeDir, 'grok-leader-'));
    extraWritable.push(leader);
    leaderSocket = path.join(leader, 'grok.sock');
  }
  if (provider === 'antigravity') {
    const folder = path.join(home, '.gemini', 'config');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const target = path.join(folder, 'mcp_config.json');
    try { fs.writeFileSync(target, '{}\n', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const file = path.join(runtimeDir, 'agy-mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [MCP_SERVER]: { ...mcp, disabled: false } } }), { mode: 0o600 });
    roBinds.push([file, target]);
  }
  const history = provider === 'codex' ? [] : cliHistory.binds(provider, home, historyRoot);
  const resume = fresh ? null : previousConversation(provider, { historyRoot, codexHome: home, cwd });
  const args = cliArgs(provider, { prompt, mcp, writable, resume, leaderSocket });
  const launch = sandboxCommand(BINS[provider], args, {
    cwd: mountDir, home, writable, hide: [HOST_STATE, runtimeDir], sockets: [socket], extraWritable,
  });
  // The project appears as /work/<name> (sandboxCommand binds it at its own path; move that bind).
  const chdir = launch.args.indexOf('--chdir');
  launch.args.splice(chdir - 3, 5, writable ? '--bind' : '--ro-bind', fs.realpathSync(mountDir), cwd, '--chdir', cwd);
  const extra = [...cliHistory.bwrapArgs(history), ...roBinds.flatMap(([source, target]) => ['--ro-bind', source, target]),
    '--ro-bind', path.join(runtimeDir, 'uploads'), UPLOADS];
  launch.args.splice(launch.args.indexOf('--chdir'), 0, ...extra);
  const childEnv = { ...env, HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    // Commands on the person's computer may run long; the CLI must not give up on the agentdesk tool first.
    MCP_TOOL_TIMEOUT: String(15 * 60_000), AGENTDESK_NATIVE_TUI: '1' };
  if (provider === 'codex') childEnv.CODEX_HOME = home;
  for (const key of [...BILLING, 'AGENTDESK_TUI', 'GROK_HOME', 'GROK_CONFIG', 'GROK_CONFIG_PATH', 'NO_COLOR']) delete childEnv[key];
  return { command: launch.command, args: launch.args, env: childEnv, resume: Boolean(resume) };
}

function main() {
  let config;
  try { config = JSON.parse(process.env.AGENTDESK_TUI || ''); } catch { fail('config'); }
  let child;
  let stopping = false;
  const run = (fresh) => {
    let launch;
    try { launch = plan(config, { fresh }); } catch (error) { fail(String(error.code || error.message).slice(0, 80)); }
    const started = Date.now();
    child = spawn(launch.command, launch.args, { stdio: 'inherit', env: launch.env, cwd: '/' });
    child.on('error', (error) => fail(error.code || 'spawn'));
    child.on('exit', (code, signal) => {
      // Continuing the last conversation failed at once (nothing the CLI can continue): start a new one instead.
      if (!stopping && launch.resume && code && Date.now() - started < 10_000) {
        process.stdout.write('\x1b[?1049l\x1b[2J\x1b[H\x1b[2mAgentDesk：没有可继续的对话，正在开始新对话…\x1b[0m\r\n');
        run(true);
        return;
      }
      process.exit(signal ? 128 + (require('node:os').constants.signals[signal] || 1) : code ?? 1);
    });
  };
  run(false);
  // A closed terminal (SIGHUP) or a stopped session ends the CLI with it; bwrap --die-with-parent covers a crash.
  for (const name of ['SIGHUP', 'SIGTERM']) process.on(name, () => { stopping = true; try { child.kill(name); } catch {} });
  // Ctrl+C / Ctrl+\ outside raw mode reach the whole foreground group: they are the CLI's to handle, not ours.
  for (const name of ['SIGINT', 'SIGQUIT', 'SIGTSTP']) process.on(name, () => {});
}

if (require.main === module) main();

module.exports = { plan };
