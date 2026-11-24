const test = require('node:test');
const assert = require('node:assert/strict');
const background = require('../background');

test('only a Windows launch with --background starts hidden', () => {
  assert.equal(background.startedInBackground(['AgentDesk.exe', '--background'], 'win32'), true);
  assert.equal(background.startedInBackground(['AgentDesk.exe'], 'win32'), false);
  assert.equal(background.startedInBackground(['AgentDesk', '--background'], 'darwin'), false);
});

test('login item only for a packaged Windows app with a Bridge, unless turned off', () => {
  const base = { platform: 'win32', packaged: true, bridgeConfigured: true };
  assert.equal(background.wantsLoginItem(base), true);
  assert.equal(background.wantsLoginItem({ ...base, setting: false }), false);
  assert.equal(background.wantsLoginItem({ ...base, bridgeConfigured: false }), false);
  assert.equal(background.wantsLoginItem({ ...base, packaged: false }), false);
  assert.equal(background.wantsLoginItem({ ...base, platform: 'darwin' }), false);
});

test('login item is written only when it differs, always with --background', () => {
  const writes = [];
  let on = false;
  const app = {
    getLoginItemSettings: (options) => { assert.deepEqual(options.args, ['--background']); return { openAtLogin: on }; },
    setLoginItemSettings: (options) => { writes.push(options); on = options.openAtLogin; },
  };
  assert.equal(background.syncLoginItem(app, true), true);
  assert.equal(background.syncLoginItem(app, true), false);
  assert.equal(background.syncLoginItem(app, false), true);
  assert.deepEqual(writes.map((item) => [item.openAtLogin, item.args]), [[true, ['--background']], [false, ['--background']]]);
});

test('tray offers open and quit', () => {
  const events = {};
  let template;
  class Tray { constructor(icon) { this.icon = icon; } setToolTip(text) { this.tip = text; } setContextMenu() {} on(name, fn) { events[name] = fn; } }
  const Menu = { buildFromTemplate: (items) => { template = items; return items; } };
  const calls = [];
  const tray = background.createTray({ Tray, Menu, icon: 'i.png', open: () => calls.push('open'), quit: () => calls.push('quit') });
  assert.match(tray.tip, /后台/);
  template[0].click(); template[2].click(); events['double-click']();
  assert.deepEqual(calls, ['open', 'quit', 'open']);
});
