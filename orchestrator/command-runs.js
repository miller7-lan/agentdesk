const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COMMAND_TIMEOUT = 300_000;
const COMMAND_REPLY_TIMEOUT = COMMAND_TIMEOUT + 15_000;

function execute(root, binary, args, timeout, signal, env = process.env, outputLimit = 16000, onOutput = () => {}) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    let failure;
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.once('exit', (code) => { if (code) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    };
    const timer = setTimeout(() => stop(new Error('command_timeout')), timeout);
    const abort = () => stop(signal.reason || new Error('command_cancelled'));
    const output = { stdout: '', stderr: '' };
    let truncated = false;
    signal.addEventListener('abort', abort, { once: true });
    for (const channel of Object.keys(output)) {
      child[channel].setEncoding('utf-8').on('data', (chunk) => {
        const combined = output[channel] + chunk;
        if (combined.length > outputLimit) truncated = true;
        output[channel] = combined.slice(-outputLimit);
        onOutput({ ...output, truncated });
      });
    }
    child.once('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code === null) reject(new Error('command_terminated'));
      else resolve({ code, ...output, ...(truncated && { truncated }) });
    });
  });
}

class CommandRuns {
  constructor(notify = () => {}, journal) {
    this.runs = new Map();
    this.keys = new Map();
    this.notify = notify;
    this.journal = journal;
  }

  load() {
    if (!this.journal || this.loaded) return;
    try {
      const records = JSON.parse(fs.readFileSync(this.journal(), 'utf8'));
      for (const item of records) {
        const snapshot = item.snapshot;
        if (!snapshot.finishedAt) Object.assign(snapshot, {
          state: 'unknown', code: null, finishedAt: Date.now(), error: 'command_status_unknown', sequence: snapshot.sequence + 1,
        });
        this.runs.set(snapshot.id, { ...item, done: Promise.resolve({ ...snapshot }) });
        this.keys.set(item.key, this.runs.get(snapshot.id));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  save() {
    if (!this.journal) return;
    const file = this.journal();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID();
    const records = [...this.runs.values()].map(({ scope, key, name, cwd, turnId, snapshot }) =>
      ({ scope, key, name, cwd, turnId, snapshot }));
    try {
      fs.writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }

  start({ scope, key, turnId, itemId, name, argv, cwd, timeout = COMMAND_TIMEOUT, limit = 16_000 }) {
    this.load();
    this.prune();
    const existing = this.keys.get(key);
    if (existing) {
      if (existing.scope !== scope || existing.name !== name || existing.cwd !== cwd || existing.turnId !== turnId) {
        throw new Error('command_run_conflict');
      }
      return existing.done;
    }
    if (this.runs.size >= 128) throw new Error('command_run_capacity');
    const id = randomUUID();
    const controller = new AbortController();
    const snapshot = { id, name, cwd, state: 'running', startedAt: Date.now(), sequence: 0, stdout: '', stderr: '',
      ...(turnId && { turnId }), ...(itemId && { itemId }) };
    const entry = { scope, key, name, cwd, turnId, controller, snapshot };
    this.keys.set(key, entry);
    this.runs.set(id, entry);
    try { this.save(); } catch (error) {
      this.keys.delete(key);
      this.runs.delete(id);
      throw error;
    }
    let update;
    const emit = () => this.notify(scope, { ...snapshot });
    const onOutput = (output) => {
      Object.assign(snapshot, output, { sequence: snapshot.sequence + 1 });
      update ??= setTimeout(() => { update = null; emit(); }, 100);
    };
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(name)));
    entry.done = execute(cwd, argv[0], argv.slice(1), timeout, controller.signal, env, limit, onOutput).then(
      (result) => Object.assign(snapshot, result, { state: result.code === 0 ? 'completed' : 'failed' }),
      (error) => Object.assign(snapshot, { code: null, state: error.message === 'command_timeout' ? 'timed_out'
        : controller.signal.aborted ? 'cancelled' : 'failed', error: error.code || error.message }),
    ).then(() => {
      clearTimeout(update);
      snapshot.finishedAt = Date.now();
      snapshot.sequence++;
      try { this.save(); } catch { /* recover the run as unknown after a restart */ }
      emit();
      return { ...snapshot };
    });
    emit();
    return entry.done;
  }

  byKey(scope, key) {
    const item = this.keys.get(key);
    return item?.scope === scope ? { ...item.snapshot } : null;
  }

  list(scope) {
    this.load();
    this.prune();
    return [...this.runs.values()].filter((item) => item.scope === scope).slice(-16).map(({ snapshot }) => ({ ...snapshot }));
  }

  cancel(scope, id) {
    this.load();
    const item = this.runs.get(id);
    if (!item || item.scope !== scope) return null;
    this.abort(item);
    return { ...item.snapshot };
  }

  cancelKey(scope, key) {
    const item = this.keys.get(key);
    return item?.scope === scope ? this.cancel(scope, item.snapshot.id) : null;
  }

  cancelTurn(scope, turnId) {
    for (const item of this.runs.values()) {
      if (item.scope === scope && item.turnId === turnId) this.abort(item);
    }
  }

  close() {
    for (const item of this.runs.values()) this.abort(item);
  }

  abort(item) {
    if (item.snapshot.state !== 'running') return;
    item.snapshot.state = 'cancelling';
    item.snapshot.sequence++;
    item.controller.abort(new Error('command_cancelled'));
    this.notify(item.scope, { ...item.snapshot });
  }

  prune() {
    const oldest = Date.now() - 60 * 60 * 1000;
    const finished = [...this.runs.values()].filter(({ snapshot }) => snapshot.finishedAt)
      .sort((a, b) => a.snapshot.finishedAt - b.snapshot.finishedAt);
    for (const [index, { key, snapshot }] of finished.entries()) {
      if (snapshot.finishedAt >= oldest && index >= finished.length - 64) break;
      this.keys.delete(key);
      this.runs.delete(snapshot.id);
    }
  }
}

module.exports = { execute, CommandRuns, COMMAND_TIMEOUT, COMMAND_REPLY_TIMEOUT };
