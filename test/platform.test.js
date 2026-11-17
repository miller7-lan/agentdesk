const assert = require('node:assert/strict');
const { test } = require('node:test');
const platform = require('../src/platform');

function fakeDocument(shortcuts = [], titles = []) {
  const root = { dataset: {}, style: { values: {}, setProperty(key, value) { this.values[key] = value; } } };
  const nodes = [
    ...shortcuts.map(({ key, shift = false }) => ({
      dataset: { shortcut: key, ...(shift ? { shortcutShift: '' } : {}) },
      textContent: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; },
    })),
    ...titles.map(({ text, key, shift = false }) => ({
      dataset: { shortcutTitle: text + '|' + key, ...(shift ? { shortcutShift: '' } : {}) },
      title: '',
    })),
  ];
  return {
    documentElement: root,
    querySelectorAll(selector) {
      if (selector === '[data-shortcut]') return nodes.filter((node) => node.attrs);
      if (selector === '[data-shortcut-title]') return nodes.filter((node) => !node.attrs);
      return [];
    },
    nodes,
  };
}

test('detectOs normalises Electron and human names', () => {
  assert.equal(platform.detectOs('darwin'), 'mac');
  assert.equal(platform.detectOs({ platform: 'win32' }), 'win');
  assert.equal(platform.detectOs({ os: 'windows' }), 'win');
  assert.equal(platform.detectOs('linux'), 'linux');
  assert.equal(platform.detectOs(undefined), 'linux');
});

test('Windows build parsing ignores pre-10 releases', () => {
  assert.equal(platform.parseBuild('10.0.22631'), 22631);
  assert.equal(platform.parseBuild('10.0.19045'), 19045);
  assert.equal(platform.parseBuild('6.3.9600'), 0);
  assert.equal(platform.parseBuild(22631), 22631);
  assert.equal(platform.parseBuild(''), 0);
  assert.equal(platform.isWindows11(22000), true);
  assert.equal(platform.isWindows11(21999), false);
});

test('window material follows the OS and Windows build', () => {
  assert.equal(platform.materialFor({ os: 'mac' }), 'vibrancy');
  assert.equal(platform.materialFor({ os: 'win', build: 22631 }), 'acrylic');
  assert.equal(platform.materialFor({ os: 'win', build: 19045 }), 'drawn');
  assert.equal(platform.materialFor({ os: 'linux' }), 'drawn');
});

test('fonts and shortcut labels match the platform', () => {
  assert.match(platform.fontStack('mac'), /PingFang SC/);
  assert.match(platform.fontStack('win'), /Microsoft YaHei UI/);
  assert.match(platform.fontStack('win', 'mono'), /Cascadia Code/);
  assert.equal(platform.shortcutLabel('mac', 'k'), '⌘K');
  assert.equal(platform.shortcutLabel('mac', 'l', { shift: true }), '⇧⌘L');
  assert.equal(platform.shortcutLabel('win', 'k'), 'Ctrl+K');
  assert.equal(platform.shortcutLabel('win', 'l', { shift: true }), 'Ctrl+Shift+L');
  assert.equal(platform.shortcutKeys('mac', 'k'), 'Meta+K');
  assert.equal(platform.shortcutKeys('win', 'k'), 'Control+K');
});

test('applyPlatform writes attributes and rewrites labels', () => {
  const doc = fakeDocument(
    [{ key: 'K' }, { key: 'L', shift: true }],
    [{ text: '切换侧栏', key: 'B' }],
  );
  const info = platform.applyPlatform(doc, { os: 'mac', build: 0 });
  assert.equal(info.os, 'mac');
  assert.equal(info.material, 'vibrancy');
  assert.equal(doc.documentElement.dataset.os, 'mac');
  assert.equal(doc.documentElement.dataset.material, 'vibrancy');
  assert.equal(doc.documentElement.dataset.mod, 'cmd');
  assert.match(doc.documentElement.style.values['--font'], /PingFang SC/);
  assert.equal(doc.nodes[0].textContent, '⌘K');
  assert.equal(doc.nodes[0].attrs['aria-keyshortcuts'], 'Meta+K');
  assert.equal(doc.nodes[1].textContent, '⇧⌘L');
  assert.equal(doc.nodes[2].title, '切换侧栏 (⌘B)');
});

test('applyPlatform leaves Windows 10 on the drawn background', () => {
  const doc = fakeDocument();
  const info = platform.applyPlatform(doc, { os: 'win32', build: 19045 });
  assert.equal(info.material, 'drawn');
  assert.equal(info.isWindows11, false);
  assert.equal(doc.documentElement.dataset.mod, 'ctrl');
  assert.match(doc.documentElement.style.values['--mono'], /Cascadia Code/);
});