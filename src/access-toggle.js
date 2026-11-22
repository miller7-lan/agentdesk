(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskAccess = factory();
})(globalThis, function () {
  'use strict';
  // Permission modes of a single chat and the composer's 「完全访问」 switch (one state, two controls).
  //   ask  每步询问  every file change and command asks
  //   edit 自动编辑  file changes go through, commands still ask
  //   plan 只读规划  read-only
  //   auto 完全访问  nothing asks
  // Stored (client store, mode names only):
  //   lastPermissionMode    last choice of any mode (kept for the status line; not the new-chat default)
  //   lastWritableMode      ask/edit/auto, never plan: what a new chat starts in and what a plan hands over to
  //   lastSafeWritableMode  ask/edit only: where the switch goes back to when it is turned off
  const MODES = ['ask', 'edit', 'plan', 'auto'];
  const WRITABLE = new Set(['ask', 'edit', 'auto']);
  const SAFE = new Set(['ask', 'edit']);
  const NATIVE = new Set(['plan', 'auto']);
  const FIRST = 'edit';

  const valid = (mode) => MODES.includes(mode);

  // An older client only kept lastPermissionMode; fill the new keys from it once (a stored plan counts as nothing).
  function migrate(store) {
    const last = store.get('lastPermissionMode', null);
    if (!WRITABLE.has(store.get('lastWritableMode', null)) && WRITABLE.has(last)) store.set('lastWritableMode', last);
    if (!SAFE.has(store.get('lastSafeWritableMode', null)) && SAFE.has(last)) store.set('lastSafeWritableMode', last);
  }

  function lastWritable(store) {
    const mode = store.get('lastWritableMode', null);
    return WRITABLE.has(mode) ? mode : FIRST;
  }

  function lastSafe(store) {
    const mode = store.get('lastSafeWritableMode', null);
    return SAFE.has(mode) ? mode : FIRST;
  }

  // A native chat (the project is mounted, Codex/CLI run with the person's rights) only knows plan and auto.
  function coerce(mode, native) {
    if (!valid(mode)) mode = FIRST;
    return native && !NATIVE.has(mode) ? 'auto' : mode;
  }

  // What a new chat starts in: the last writable mode, never plan.
  function newSessionMode(store, { native = false } = {}) {
    return coerce(lastWritable(store), native);
  }

  function record(store, mode) {
    if (!valid(mode)) return;
    store.set('lastPermissionMode', mode);
    if (WRITABLE.has(mode)) store.set('lastWritableMode', mode);
    if (SAFE.has(mode)) store.set('lastSafeWritableMode', mode);
  }

  // The switch: on → auto; off → the last ask/edit. Never back to plan. Not available in a native chat.
  function toggled(on, store, { native = false } = {}) {
    if (native) return null;
    return on ? 'auto' : lastSafe(store);
  }

  // Which mode a plan hands over to.
  function handoverMode(store, { native = false } = {}) {
    return coerce(lastWritable(store), native);
  }

  function allowed(native) { return native ? [...NATIVE] : [...MODES]; }

  return { MODES, migrate, newSessionMode, record, toggled, handoverMode, coerce, allowed, lastSafe, lastWritable };
});
