// Runs a CLI inside bubblewrap, the same isolation Codex uses for its own commands on the VPS, so that Grok
// Build, Antigravity and Claude Code can run shell commands as Codex does without reaching anything else.
//
// What the CLI sees:
// - the whole system read-only (tools, compilers, Node, Python…);
// - its working folder, writable unless the step or turn is read-only;
// - its own CLI home (login, sessions), writable;
// - the sockets it is given (the AgentDesk MCP socket);
// - fresh /tmp, /dev and /proc, its own PID namespace; it dies with AgentDesk's process.
// What it does not see: the orchestrator's state folder (other tasks' worktrees, every other CLI's login,
// the task database, sockets), the orchestrator and enrollment configuration and credentials, and other users'
// homes. Each of those is covered by an empty tmpfs before the allowed paths are mounted back in.
// The network is shared: the CLI needs its model API, web search and package registries.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_HIDDEN = ['/etc/agentdesk-orchestrator', '/etc/agentdesk-enrollment', '/etc/agentdesk-relay', '/root', '/home'];

// options: { bin, cwd, home, writable, hide: [paths], hideDefaults: [paths] (default DEFAULT_HIDDEN), sockets, extraWritable }
function sandboxCommand(command, args, options) {
  const exists = (target) => { try { fs.statSync(target); return true; } catch { return false; } };
  const real = (target) => { try { return fs.realpathSync(target); } catch { return path.resolve(target); } };
  const cwd = real(options.cwd);
  const home = options.home && real(options.home);
  // Hide parents first, then mount the allowed paths back inside them.
  const hidden = [...new Set([...(options.hideDefaults || DEFAULT_HIDDEN), ...(options.hide || [])].map(real))]
    .filter((target) => target !== '/' && exists(target))
    .sort((a, b) => a.length - b.length);
  const argv = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent'];
  for (const target of hidden) argv.push('--tmpfs', target);
  if (home) { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); argv.push('--bind', home, home); }
  for (const target of options.extraWritable || []) if (exists(target)) argv.push('--bind', real(target), real(target));
  for (const socket of options.sockets || []) if (exists(socket)) argv.push('--bind', real(socket), real(socket));
  argv.push(options.writable === false ? '--ro-bind' : '--bind', cwd, cwd, '--chdir', cwd, '--', command, ...args);
  if (options.gitView) argv.splice(argv.indexOf('--'), 0, '--ro-bind', options.gitView.directory, options.gitView.target);
  for (const target of options.extraReadOnly || []) {
    if (exists(target)) argv.splice(argv.indexOf('--'), 0, '--ro-bind', real(target), real(target));
  }
  // Covered after the read-only folders are in place (a folder inside one of them, e.g. the live project on the
  // mount while the step works on a snapshot).
  for (const target of options.mask || []) {
    if (exists(target)) argv.splice(argv.indexOf('--'), 0, '--tmpfs', real(target));
  }
  return { command: options.bin || '/usr/bin/bwrap', args: argv };
}

module.exports = { sandboxCommand, DEFAULT_HIDDEN };
