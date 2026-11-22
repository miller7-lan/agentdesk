// Group chat on Windows (v7, Q6: one module per platform in the same repository).
// No operating-system enforcement was chosen for Windows (M1 picked none of the options; M2 "Windows取决于M1";
// O3 "Windows 不变"), so:
// - commands run with the person's own access; the credential folders are not closed for them (AgentDesk's own
//   file tools, mounts and patches still refuse them — N2);
// - the local copy of a code-changing step is a plain copy, not isolated: the Bridge only detects a change of
//   the original project outside a patch and reports it.
// The labels below are shown in the group and in the tool results, so nobody takes either for isolation.
const fs = require('node:fs/promises');
const path = require('node:path');

async function copyProject(source, target) {
  // A real copy: no hard links (they would change the original) and links are copied as links, not followed.
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
}

function shell(script, kind = 'powershell') {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  if (kind === 'cmd') return { argv: [path.join(system, 'cmd.exe'), '/d', '/s', '/c', '"chcp 65001 > nul & ' + script + '"'], windowsVerbatimArguments: true };
  const command = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' + script;
  return { argv: [path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')] };
}

module.exports = {
  platform: 'windows', enforcement: { credentials: 'none', original: 'detect' },
  labels: { credentials: 'Windows 未强制保护凭据目录（仅 AgentDesk 工具和挂载会拒绝）', copy: '副本未强制隔离（Windows）' },
  wrap: (argv) => argv, copyProject, shell,
};
