(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskPlatform = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Platform differences live here: window chrome, fonts, shortcut labels and window material.
  // The module is loaded before the rest of the renderer so `data-os` is on <html> for the first paint.
  const FONTS = {
    mac: {
      sans: '-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", system-ui, sans-serif',
      mono: '"SF Mono", Menlo, ui-monospace, "PingFang SC", monospace',
    },
    win: {
      sans: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
      mono: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
    },
    linux: {
      sans: 'system-ui, "Noto Sans CJK SC", "Ubuntu", Cantarell, sans-serif',
      mono: 'ui-monospace, "DejaVu Sans Mono", "Noto Sans Mono", monospace',
    },
  };

  function normalizeOs(value) {
    const os = String(value || '').toLowerCase();
    if (os === 'mac' || os === 'macos' || os === 'darwin' || os === 'osx') return 'mac';
    if (os === 'win' || os === 'windows' || os === 'win32') return 'win';
    return 'linux';
  }

  function detectOs(input) {
    if (typeof input === 'string') return normalizeOs(input);
    if (!input || typeof input !== 'object') return 'linux';
    return normalizeOs(input.os || input.platform);
  }

  // process.getSystemVersion() is "10.0.22631" on Windows; a bare build number is accepted too.
  function parseBuild(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    const parts = String(value || '').trim().split('.');
    if (parts.length === 1) {
      const build = Number(parts[0]);
      return Number.isFinite(build) && build > 0 ? Math.trunc(build) : 0;
    }
    if (parts.length < 3) return 0;
    const major = Number(parts[0]);
    const build = Number(parts[2]);
    if (!Number.isFinite(major) || !Number.isFinite(build) || major < 10) return 0;
    return Math.trunc(build);
  }

  function isWindows11(build) {
    return Number(build) >= 22000;
  }

  function materialFor(input) {
    const os = detectOs(input);
    if (os === 'mac') return 'vibrancy';
    if (os === 'win' && isWindows11(parseBuild(input && input.build))) return 'acrylic';
    return 'drawn';
  }

  function fontStack(os, kind = 'sans') {
    const fonts = FONTS[detectOs(os)] || FONTS.linux;
    return kind === 'mono' ? fonts.mono : fonts.sans;
  }

  function shortcutLabel(os, key, options = {}) {
    const mac = detectOs(os) === 'mac';
    const name = String(key || '').toUpperCase();
    if (mac) return (options.shift ? '⇧' : '') + '⌘' + name;
    return 'Ctrl+' + (options.shift ? 'Shift+' : '') + name;
  }

  function shortcutKeys(os, key, options = {}) {
    const mac = detectOs(os) === 'mac';
    const parts = [];
    if (options.shift) parts.push(mac ? 'Meta+Shift' : 'Control+Shift');
    else parts.push(mac ? 'Meta' : 'Control');
    parts.push(String(key || '').toUpperCase());
    return parts.join('+');
  }

  function applyPlatform(doc, info) {
    if (!doc || !doc.documentElement) return null;
    const source = info && typeof info === 'object' ? info : { os: info };
    const os = detectOs(source);
    const build = Number(source.build) || parseBuild(source.release || source.systemVersion);
    const material = materialFor({ os, build });
    const rootEl = doc.documentElement;
    rootEl.dataset.os = os;
    rootEl.dataset.material = material;
    rootEl.dataset.mod = os === 'mac' ? 'cmd' : 'ctrl';
    // Let CSS pick the platform font even before styles.css applies its own body rule.
    rootEl.style.setProperty('--font', fontStack(os));
    rootEl.style.setProperty('--mono', fontStack(os, 'mono'));

    if (typeof doc.querySelectorAll === 'function') {
      for (const el of doc.querySelectorAll('[data-shortcut]')) {
        const key = el.dataset.shortcut;
        if (!key) continue;
        const shift = el.dataset.shortcutShift != null;
        el.textContent = shortcutLabel(os, key, { shift });
        el.setAttribute('aria-keyshortcuts', shortcutKeys(os, key, { shift }));
      }
      for (const el of doc.querySelectorAll('[data-shortcut-title]')) {
        const [text, key] = String(el.dataset.shortcutTitle || '').split('|');
        if (!text || !key) continue;
        const shift = el.dataset.shortcutShift != null;
        el.title = text + ' (' + shortcutLabel(os, key, { shift }) + ')';
      }
    }

    return { os, build, material, isWindows11: os === 'win' && isWindows11(build) };
  }

  const api = {
    detectOs, parseBuild, isWindows11, materialFor, fontStack, shortcutLabel, shortcutKeys, applyPlatform,
    FONTS,
  };

  // In the renderer the preload bridge is already available while <head> is parsed, so the very
  // first paint already has the platform attributes. In tests `document` is absent.
  if (typeof document !== 'undefined' && typeof window !== 'undefined'
      && window.document === document && window.desk && window.desk.system) {
    window.__agentdeskSystem = applyPlatform(document, window.desk.system);
  }

  return api;
});