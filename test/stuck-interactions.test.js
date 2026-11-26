// "不要再有一开始就有交互卡住的情况 … 每个阶段都检查一下": the places in group and single chats where a click did
// nothing, or a chat stayed "running"/"执行中" for good, each now answers or recovers. These checks keep the fixes in
// place; the packaged-app window check (scripts/packaged-ui-smoke.js, CI on macOS and Windows) shows the last
// safety net working in the real window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

test('the last safety net: any failure nothing handled is shown in the window', () => {
  const app = read('app.js');
  assert.match(app, /addEventListener\('unhandledrejection'/);
  assert.match(app, /addEventListener\('error'/);
  assert.match(app, /'操作没有完成：'/);
});

test('single chat: sending never stays silent or stuck in "thinking"; stop and approvals always resolve', () => {
  const live = read('live.js');
  assert.match(live, /catch \(error\) \{\s*\/\/ Any failure while starting the turn/);
  assert.match(live, /if \(s\.busy && s\.items\.some\(\(item\) => item\.t === 'thinking'\)\) return fail\(s, message\)/);
  assert.match(live, /这一轮正在开始，稍后再停止/);
  assert.match(live, /已停止：没有找到正在运行的这一轮，已恢复为可输入/);
  assert.match(live, /it\.state = 'expired'/, 'an approval that no longer reaches anyone does not leave the chat "执行中"');
  assert.match(read('app.js'), /'已失效，未送达'/);
  assert.match(live, /这个项目还没在「工作区」里建好/);
});

test('new single chats and automatic project setup always answer', () => {
  const app = read('app.js');
  assert.match(app, /catch \(error\) \{ toast\('没能新建单聊：'/);
  assert.match(app, /if \(!p\) \{ toast\('找不到这个项目/);
  assert.match(read('projects.js'), /\.catch\(\(error\) => \(\{ ok: false, error: error\?\.message \|\| String\(error\) \}\)\)/);
});

test('provider-direct chats restored as running with nothing to follow, or whose task is gone, stop being "running"', () => {
  const direct = read('provider-direct.js');
  assert.match(direct, /\.\.\.\(s\.busy && !following && \{ busy: false, status: 'idle' \}\)/);
  assert.match(direct, /if \(!item\) \{ settle\(s, null\); return; \}/);
  assert.match(direct, /unknown_task\|task_access_denied\|invalid_task_id/);
});

test('group chat: a click while another operation runs, or while offline, gets an answer; projects are not created unbound by accident', () => {
  const group = read('orchestrator.js');
  assert.match(group, /function stillBusy\(\) \{\s*if \(busy\) A\.toast\('上一个操作还在进行，完成后再试'\)/);
  assert.equal((group.match(/stillBusy\(\)/g) || []).length >= 7, true, 'run, send, stop task, stop step, approve addition, retry, plan buttons');
  assert.doesNotMatch(group, /\|\| busy\) return;/, 'no handler ignores a click silently while busy');
  assert.match(group, /主控线路还没连上，连上后再发送回复/);
  assert.match(group, /方案已更新，请按最新一轮操作/);
  assert.match(group, /这个主控工作区现在不可用/);
  assert.match(group, /正在读取主控的工作区，读到后再选择并创建/);
});

test('single chat: the input box empties on send and gets the text back if the turn does not start', () => {
  const live = read('live.js');
  const turn = live.slice(live.indexOf('async function sendTurn('));
  // Cleared before waiting on the connection / resume, not only after turn/start succeeded.
  assert.ok(turn.indexOf('if (!fromQueue) takeInput(s, text);') < turn.indexOf('await ensureReady(s)'));
  assert.match(live, /const ok = await sendTurn\(s, fromButton, options\);\s*if \(!ok\) restoreInput\(s\);/);
  assert.match(live, /restoreInput\(s\);\s*const message = '发送失败：'/);
  assert.match(live, /finally \{ takenInput\.delete\(s\); startingTurns\.delete\(s\); \}/);
  // Another chat opened meanwhile: the text goes into this chat's draft instead of someone else's box.
  assert.match(live, /else if \(!s\.draft\?\.trim\(\)\) s\.draft = text;/);
});
