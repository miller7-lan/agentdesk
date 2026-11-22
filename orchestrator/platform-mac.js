// Group chat on a Mac (v7, Q6: one module per platform in the same repository).
// - M2: group commands run under sandbox-exec with the credential folders (the read-only mount's HIDDEN list) and
//   AgentDesk's own key folders closed. `.git` is not closed. The keychain service itself stays reachable, so
//   HTTPS git pushes through the osxkeychain helper keep working; SSH-key pushes do not (~/.ssh is closed).
// - O3: commands of a code-changing step run in a local copy, with the original project (its Git top level, so
//   its .git too) closed for writing. The copy, temporary folders and places outside the project stay writable.
// - M3 (Claude's recommendation, not a decision of the owner): the copy is an APFS clone (cp -c, copy-on-write).
// sandbox-exec is marked deprecated by Apple. Should it disappear the command fails; it never runs unprotected.
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { HIDDEN } = require('./sftp-readonly');

const run = promisify(execFile);
const SANDBOX = '/usr/bin/sandbox-exec';
const quote = (value) => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function ownFolders(home, extra = []) {
  return [path.posix.join(home, '.agentdesk'), path.posix.join(home, 'Library', 'Application Support', 'AgentDesk'), ...extra];
}

// credentials: M2 (HIDDEN + AgentDesk's folders); denyWrite: O3 (the original project's root, for the copy).
function groupProfile({ home = os.homedir(), extra = [], credentials = true, denyWrite = [] } = {}) {
  const closed = [...(credentials ? HIDDEN.map((entry) => path.posix.join(home, entry)) : []), ...ownFolders(home, extra)];
  return ['(version 1)', '(allow default)',
    '(deny file-read* file-write* ' + closed.map((folder) => '(subpath ' + quote(folder) + ')').join(' ') + ')',
    ...(denyWrite.length ? ['(deny file-write* ' + denyWrite.map((folder) => '(subpath ' + quote(folder) + ')').join(' ') + ')'] : []),
  ].join('\n');
}

function wrap(argv, options) {
  return [SANDBOX, '-p', groupProfile(options), ...argv];
}

async function copyProject(source, target) {
  // APFS clone: instant and copy-on-write; never hard or symbolic links back into the original.
  // Another volume (no clone possible) falls back to a plain copy, still a real copy without links back.
  try { await run('/bin/cp', ['-c', '-R', source, target], { timeout: 600000 }); }
  catch {
    await require('node:fs/promises').rm(target, { recursive: true, force: true });
    await run('/bin/cp', ['-R', source, target], { timeout: 600000 });
  }
}

const shell = (script, kind = 'zsh') => [kind === 'bash' ? '/bin/bash' : '/bin/zsh', '-l', '-c', script];

module.exports = {
  platform: 'mac', enforcement: { credentials: 'sandbox', original: 'sandbox' },
  labels: {},
  groupProfile, wrap, copyProject, shell,
};
