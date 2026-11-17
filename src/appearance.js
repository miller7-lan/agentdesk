(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskAppearance = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'agentdesk.appearance';
  const DEFAULTS = Object.freeze({
    skin: 'aqua',
    layout: 'float',
    blur: 22,
    frost: 72,
    hue: 212,
    bright: 1,
    wallpaper: 'none',
    wallpaperBlur: 0,
    boot: 'always',
  });

  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  // Renderer settings are untrusted input: clamp every value so CSS custom properties stay valid.
  function normalizeSettings(input) {
    const src = input && typeof input === 'object' ? input : {};
    return {
      skin: src.skin === 'classic' ? 'classic' : 'aqua',
      layout: src.layout === 'flat' ? 'flat' : 'float',
      blur: Math.round(number(src.blur, DEFAULTS.blur, 0, 40)),
      // Never below 50%: the frosted panes must keep their text readable.
      frost: Math.round(number(src.frost, DEFAULTS.frost, 50, 95)),
      hue: Math.round(number(src.hue, DEFAULTS.hue, 0, 359)),
      bright: Math.round(number(src.bright, DEFAULTS.bright, 0.6, 1.3) * 100) / 100,
      wallpaper: src.wallpaper === 'custom' ? 'custom' : 'none',
      wallpaperBlur: Math.round(number(src.wallpaperBlur, DEFAULTS.wallpaperBlur, 0, 30)),
      boot: src.boot === 'off' ? 'off' : 'always',
    };
  }

  function load(storage) {
    if (!storage || typeof storage.getItem !== 'function') return { ...DEFAULTS };
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return normalizeSettings(raw ? JSON.parse(raw) : DEFAULTS);
    } catch {
      return { ...DEFAULTS };
    }
  }

  function save(storage, settings) {
    const normalized = normalizeSettings(settings);
    if (storage && typeof storage.setItem === 'function') {
      try { storage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* quota or private mode */ }
    }
    return normalized;
  }

  function cssVars(settings) {
    const normalized = normalizeSettings(settings);
    return {
      '--blur': normalized.blur + 'px',
      '--frost': String(normalized.frost / 100),
      '--hue': String(normalized.hue),
      '--bright': String(normalized.bright),
      '--wall-blur': normalized.wallpaperBlur + 'px',
    };
  }

  function applySettings(doc, settings) {
    const normalized = normalizeSettings(settings);
    if (doc && doc.documentElement) {
      const rootEl = doc.documentElement;
      rootEl.dataset.skin = normalized.skin;
      rootEl.dataset.layout = normalized.layout;
      if (normalized.wallpaper === 'custom') rootEl.dataset.wall = 'on';
      else delete rootEl.dataset.wall;
      const vars = cssVars(normalized);
      for (const [name, value] of Object.entries(vars)) rootEl.style.setProperty(name, value);
    }
    return normalized;
  }

  return { STORAGE_KEY, DEFAULTS, normalizeSettings, load, save, cssVars, applySettings };
});