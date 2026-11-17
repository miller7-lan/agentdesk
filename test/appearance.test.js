const assert = require('node:assert/strict');
const { test } = require('node:test');
const appearance = require('../src/appearance');

function fakeStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => { values[key] = String(value); },
    values,
  };
}

function fakeDocument() {
  const root = { dataset: {}, style: { values: {}, setProperty(key, value) { this.values[key] = value; } } };
  return { documentElement: root };
}

test('defaults are the light aqua floating skin', () => {
  assert.deepEqual(appearance.normalizeSettings({}), {
    skin: 'aqua', layout: 'float', blur: 22, frost: 72, hue: 212, bright: 1,
    wallpaper: 'none', wallpaperBlur: 0, boot: 'always',
  });
});

test('settings are clamped to safe ranges', () => {
  const settings = appearance.normalizeSettings({
    skin: 'unknown', layout: 'round', blur: -5, frost: 10, hue: 720, bright: 9,
    wallpaper: 'http://example', wallpaperBlur: 90, boot: 'maybe',
  });
  assert.equal(settings.skin, 'aqua');
  assert.equal(settings.layout, 'float');
  assert.equal(settings.blur, 0);
  assert.equal(settings.frost, 50);
  assert.equal(settings.hue, 359);
  assert.equal(settings.bright, 1.3);
  assert.equal(settings.wallpaper, 'none');
  assert.equal(settings.wallpaperBlur, 30);
  assert.equal(settings.boot, 'always');

  const high = appearance.normalizeSettings({ blur: 99, frost: 99, hue: -20, bright: 0 });
  assert.equal(high.blur, 40);
  assert.equal(high.frost, 95);
  assert.equal(high.hue, 0);
  assert.equal(high.bright, 0.6);
});

test('load and save round-trip through storage', () => {
  const storage = fakeStorage();
  assert.deepEqual(appearance.load(storage), appearance.normalizeSettings(appearance.DEFAULTS));
  appearance.save(storage, { skin: 'classic', layout: 'flat', frost: 60, boot: 'off' });
  const loaded = appearance.load(storage);
  assert.equal(loaded.skin, 'classic');
  assert.equal(loaded.layout, 'flat');
  assert.equal(loaded.frost, 60);
  assert.equal(loaded.boot, 'off');
  storage.values[appearance.STORAGE_KEY] = '{not json';
  assert.equal(appearance.load(storage).skin, 'aqua');
});

test('cssVars turn percentages into CSS-ready values', () => {
  const vars = appearance.cssVars({ blur: 18, frost: 66, hue: 190, bright: 0.9, wallpaperBlur: 12 });
  assert.equal(vars['--blur'], '18px');
  assert.equal(vars['--frost'], '0.66');
  assert.equal(vars['--hue'], '190');
  assert.equal(vars['--bright'], '0.9');
  assert.equal(vars['--wall-blur'], '12px');
});

test('applySettings writes skin, layout, variables and wallpaper flag', () => {
  const doc = fakeDocument();
  const settings = appearance.applySettings(doc, {
    skin: 'classic', layout: 'flat', blur: 30, frost: 55, hue: 10, bright: 1.2, wallpaper: 'custom',
  });
  assert.equal(settings.skin, 'classic');
  assert.equal(doc.documentElement.dataset.skin, 'classic');
  assert.equal(doc.documentElement.dataset.layout, 'flat');
  assert.equal(doc.documentElement.dataset.wall, 'on');
  assert.equal(doc.documentElement.style.values['--blur'], '30px');
  assert.equal(doc.documentElement.style.values['--frost'], '0.55');

  appearance.applySettings(doc, { ...settings, wallpaper: 'none' });
  assert.equal(doc.documentElement.dataset.wall, undefined);
  assert.equal(doc.documentElement.dataset.skin, 'classic');
});