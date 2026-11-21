// File locks for direct chats (spec §6, D2, Q1, Q2). One manager per device, inside the local Worker, because
// the files live on that computer. Every write path that goes through AgentDesk takes the lock first: the
// project mount's SFTP server (the CLI's own file tools and its Bash on VPS2) and the agentdesk_file_* tools.
//
//   - Waiting: a later session waits for the holder, at most 120 seconds (Q1), then gets a retryable error.
//   - Holding: from the first write until 30 seconds after the last write or the end of the turn, whichever
//     comes first, at most 10 minutes (Q2). At the limit the lock is taken away; the holder queues again.
//   - Stale writes: after the wait, a write based on a read older than the current file is refused and the
//     session must read again (Q1). The SFTP server compares the revision it saw with the file on disk.
//
// What cannot be enforced (spec §6.4): programs started by local_shell or in a terminal, the user's editor,
// sync clients and network drives write to disk directly. watchProject() only detects such changes to a
// locked file and reports them as `bypassed`; it does not prevent them.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const WAIT_MS = 120_000;
const IDLE_MS = 30_000;
const MAX_HOLD_MS = 10 * 60_000;
const fold = process.platform === 'win32' || process.platform === 'darwin' ? (text) => text.toLowerCase() : (text) => text;
const lockError = (code, message, detail) => Object.assign(new Error(message), { code, ...detail });

class FileLockManager extends EventEmitter {
  constructor({ waitMs = WAIT_MS, idleMs = IDLE_MS, maxHoldMs = MAX_HOLD_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    Object.assign(this, { waitMs, idleMs, maxHoldMs, now, setTimer, clearTimer });
    this.locks = new Map();     // key -> { owner, label, since, last, file }
    this.owners = new Map();    // owner -> { keys:Set, idleTimer, maxTimer, label }
    this.waiters = [];          // FIFO of { owner, keys, resolve, reject, since, timer }
    this.recent = new Map();    // key -> time of the last write through the manager (for bypass detection)
    this.sequence = 0;
  }

  key(file) { return fold(path.resolve(file)); }

  event(type, value) {
    const payload = { type, sequence: ++this.sequence, timestamp: new Date(this.now()).toISOString(), ...value };
    this.emit('event', payload);
    this.emit(type, payload);
    return payload;
  }

  holder(file) {
    const lock = this.locks.get(this.key(file));
    return lock ? { owner: lock.owner, label: lock.label, since: lock.since } : null;
  }

  free(keys, owner) { return keys.every((key) => !this.locks.has(key) || this.locks.get(key).owner === owner); }

  grant(owner, label, keys, files) {
    let entry = this.owners.get(owner);
    if (!entry) {
      entry = { keys: new Set(), label, idleTimer: null, maxTimer: null, since: this.now() };
      this.owners.set(owner, entry);
      // Q2: never longer than ten minutes in one go.
      entry.maxTimer = this.setTimer(() => this.release(owner, 'max_hold'), this.maxHoldMs);
      entry.maxTimer.unref?.();
    }
    keys.forEach((key, index) => {
      if (this.locks.get(key)?.owner === owner) return;
      this.locks.set(key, { owner, label, since: this.now(), file: files[index] });
      entry.keys.add(key);
      this.event('acquired', { owner, label, path: files[index] });
    });
    this.touch(owner);
  }

  // Resolves once every file is held by owner (re-entrant). Rejects with code ELOCKTIMEOUT after waitMs.
  acquire(owner, label, files, { signal } = {}) {
    const list = [...new Set(files.map((file) => path.resolve(file)))];
    const keys = list.map((file) => this.key(file));
    // Re-entrant: the holder keeps writing what it already holds, even while others queue for it.
    if (keys.every((key) => this.locks.get(key)?.owner === owner)) {
      this.touch(owner);
      return Promise.resolve();
    }
    // Arrival order is kept: a file that is free now still goes to an earlier waiter for it first.
    const blockedByQueue = this.waiters.some((waiter) => waiter.owner !== owner &&
      waiter.keys.some((key) => keys.includes(key) && this.locks.get(key)?.owner !== owner));
    if (this.free(keys, owner) && !blockedByQueue) {
      this.grant(owner, label, keys, list);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { owner, label, keys, files: list, resolve, reject, since: this.now() };
      const blocking = keys.map((key) => this.locks.get(key)).find((lock) => lock && lock.owner !== owner);
      this.event('waiting', { owner, label, path: list[0], holder: blocking?.owner, holderLabel: blocking?.label });
      waiter.timer = this.setTimer(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        const holder = keys.map((key) => this.locks.get(key)).find((lock) => lock && lock.owner !== owner);
        this.event('timeout', { owner, label, path: list[0], holder: holder?.owner, holderLabel: holder?.label, waitedMs: this.now() - waiter.since });
        reject(lockError('ELOCKTIMEOUT', `project_file_locked: ${holder?.label || '另一个会话'} 仍在修改 ${path.basename(list[0])}，已等待 ${Math.round(this.waitMs / 1000)} 秒，请稍后重试`,
          { holder: holder?.owner, retryable: true }));
        this.drain();
      }, this.waitMs);
      waiter.timer.unref?.();
      signal?.addEventListener('abort', () => {
        this.clearTimer(waiter.timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(signal.reason || lockError('ABORT_ERR', 'lock_wait_aborted'));
        this.drain();
      }, { once: true });
      this.waiters.push(waiter);
    });
  }

  drain() {
    const taken = new Set();
    for (const waiter of [...this.waiters]) {
      const conflict = waiter.keys.some((key) => taken.has(key));
      if (!conflict && this.free(waiter.keys, waiter.owner)) {
        this.clearTimer(waiter.timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        this.grant(waiter.owner, waiter.label, waiter.keys, waiter.files);
        waiter.resolve();
      }
      waiter.keys.forEach((key) => taken.add(key));
    }
  }

  // After each write: restart the idle window (Q2) and remember the write for bypass detection.
  touch(owner, files = []) {
    const entry = this.owners.get(owner);
    if (!entry) return;
    for (const file of files) this.recent.set(this.key(file), this.now());
    if (entry.idleTimer) this.clearTimer(entry.idleTimer);
    entry.idleTimer = this.setTimer(() => this.release(owner, 'idle'), this.idleMs);
    entry.idleTimer.unref?.();
  }

  // reason: turn_end | idle | max_hold | suspended | disconnected | closed
  release(owner, reason = 'turn_end') {
    const entry = this.owners.get(owner);
    if (!entry) return 0;
    this.clearTimer(entry.idleTimer);
    this.clearTimer(entry.maxTimer);
    this.owners.delete(owner);
    let count = 0;
    for (const key of entry.keys) {
      const lock = this.locks.get(key);
      if (lock?.owner !== owner) continue;
      this.locks.delete(key);
      count += 1;
      this.event('released', { owner, label: entry.label, path: lock.file, reason });
    }
    this.drain();
    return count;
  }

  // A write that found the file changed since this session read it (Q1).
  staleWrite(owner, label, file) { return this.event('staleWriteRejected', { owner, label, path: file }); }

  // Called for a change seen on disk. If the file is locked and no write went through the manager just now,
  // something outside AgentDesk changed it: report it, it cannot be stopped.
  noteChange(file, { graceMs = 2_000 } = {}) {
    const key = this.key(file);
    const lock = this.locks.get(key);
    if (!lock) return null;
    if (this.now() - (this.recent.get(key) || 0) <= graceMs) return null;
    return this.event('bypassed', { owner: lock.owner, label: lock.label, path: lock.file });
  }

  status() {
    return {
      locks: [...this.locks.values()].map(({ owner, label, since, file }) => ({ owner, label, since: new Date(since).toISOString(), path: file })),
      waiting: this.waiters.map(({ owner, label, files, since }) => ({ owner, label, path: files[0], waitedMs: this.now() - since })),
    };
  }

  // Watches a project folder for changes that did not come through AgentDesk (FSEvents on macOS,
  // ReadDirectoryChangesW on Windows, inotify on Linux). Returns a close function.
  watchProject(root, { watch = fs.watch } = {}) {
    let watcher;
    try {
      watcher = watch(root, { recursive: true, persistent: false }, (_type, name) => {
        if (name) this.noteChange(path.join(root, String(name)));
      });
    } catch { return () => {}; }
    watcher.on?.('error', () => {});
    return () => { try { watcher.close(); } catch {} };
  }
}

module.exports = { FileLockManager, WAIT_MS, IDLE_MS, MAX_HOLD_MS };
