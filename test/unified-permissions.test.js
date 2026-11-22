const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativePermissionPrompt, GROUP_PERMISSION_NOTE } = require('../orchestrator/permission-prompt');
const { groupProfile } = require('../orchestrator/platform-mac');

const source = (name) => fs.readFileSync(path.join(__dirname, '..', 'orchestrator', name), 'utf8');

test('one permission statement per platform, the same for every model', () => {
  const mac = nativePermissionPrompt({ platform: 'darwin' });
  const win = nativePermissionPrompt({ platform: 'win32' });
  assert.match(mac, /Claude、Codex、Grok、Antigravity 权限相同/);
  assert.match(mac, /zsh/);
  assert.match(mac, /钥匙串/);
  assert.match(win, /PowerShell/);
  assert.doesNotMatch(win, /钥匙串/);
  for (const text of [mac, win]) {
    assert.match(text, /local_shell/);
    assert.match(text, /子代理/);
    assert.match(text, /~\/\.agentdesk/);
    assert.doesNotMatch(text, /~\/\.ssh/);
  }
  assert.match(nativePermissionPrompt({ platform: 'darwin', writable: false }), /只读/);
  assert.match(GROUP_PERMISSION_NOTE, /same for Claude, Codex, Grok and Antigravity/);
});

test('chat server and seat use the shared statement and open shell and sub-agents', () => {
  const chat = source('chat-server.js');
  assert.match(chat, /nativePermissionPrompt\(/);
  assert.doesNotMatch(chat, /--no-subagents/);
  assert.match(chat, /const GROK_AGENTS = \['spawn_subagent', 'workflow'\]/);
  assert.match(chat, /const CLAUDE_AGENTS = \['Task', 'Agent'\]/);
  assert.doesNotMatch(chat, /'ExitPlanMode', 'Bash'/);
  const seat = source('windows-native-seat.js');
  assert.match(seat, /developerInstructions = \[nativePermissionPrompt/);
  assert.match(seat, /value\.nativePlatform = process\.platform/);
});

test('group commands on a Mac close only AgentDesk folders', () => {
  const profile = groupProfile({ home: '/Users/me', credentials: false });
  assert.match(profile, /\/Users\/me\/\.agentdesk/);
  assert.doesNotMatch(profile, /\/Users\/me\/\.ssh/);
  assert.match(groupProfile({ home: '/Users/me', credentials: true }), /\/Users\/me\/\.ssh/);
  assert.match(source('group-local.js'), /wrap\(launch\.argv, \{ credentials: false/);
  assert.match(source('windows.js'), /wrap\(spec, \{ credentials: false/);
});
