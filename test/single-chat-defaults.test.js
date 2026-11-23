'use strict';
// Regression: new live single chats used to be created with mode 'auto' in three places, so the owner's rule
// (start in the last writable mode, never in 只读规划, first use 自动编辑) never applied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

test('no live single chat is created with a fixed permission mode', () => {
  for (const file of ['app.js', 'live.js']) {
    assert.doesNotMatch(source(file), /mode:\s*(?:p\.live\s*\?\s*)?'auto'/, file);
    assert.doesNotMatch(source(file), /session\.mode\s*=\s*'auto'/, file);
  }
  assert.match(source('live.js'), /session\.mode = window\.AgentDeskAccess\.newSessionMode\(store\)/);
  assert.match(source('live.js'), /Access\.newSessionMode\(store, \{ native: !!s\.native \}\)/);
});

test('the access and question scripts load before the app', () => {
  const html = source('index.html');
  const at = (name) => html.indexOf(`<script src="${name}"></script>`);
  assert.ok(at('access-toggle.js') > 0 && at('access-toggle.js') < at('app.js'));
  assert.ok(at('question-card.js') > 0 && at('question-card.js') < at('app.js'));
  assert.match(html, /id="fullAccessToggle" role="switch"/);
  assert.doesNotMatch(source('app.js'), /Shift\+Tab|shiftKey\s*&&\s*e\.key\s*===\s*'Tab'/);
});
