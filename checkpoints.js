// Per-turn checkpoints for the files an AI changes on this computer, so a turn can be undone.
//
// Before a file tool (write, mkdir, copy, move, trash) touches a path for the first time in a turn, the path's
// original state is saved under the app's own folder: its bytes and mode, a folder's contents, or the fact
// that it did not exist. When the turn ends the state after the turn is recorded too. Undoing restores the
// original state of every path in reverse order, but skips a path that was changed again after the turn
// (unless forced), so later work by the person or another conversation is never overwritten. Removing a path
// that the turn created goes to the system trash, not a permanent delete.
//
// Only changes made through AgentDesk's file tools are covered; a local command run by the AI can change
// files that no checkpoint knows about.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_FILE = 25 * 1024 * 1024;
const MAX_TURN = 200 * 1024 * 1024;
const MAX_TREE_FILES = 2000;
const KEEP_TURNS = 100;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ACTIONS = { write: 'write', mkdir: 'mkdir', copy: 'copy', move: 'move', trash: 'trash' };

// The paths a tool call may change, and what happens to each.
function affected(tool, args = {}) {
  const action = String(tool).replace(/^(agentdesk|windows)_file_/, '');
  if (!ACTIONS[action] || typeof args.path !== 'string') return [];
  const resolve = (value) => typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null;
  const source = resolve(args.path);
  const target = resolve(args.destination);
  if (action === 'write' || action === 'mkdir' || action === 'trash') return source ? [{ path: source, action }] : [];
  if (action === 'copy') return target ? [{ path: target, action }] : [];
  return [source && { path: source, action: 'move' }, target && { path: target, action: 'move' }].filter(Boolean);
}

class Checkpoints {
  // trash(path) moves a path to the system trash; allowed(path) throws for a path the file tools refuse.
  constructor(root, { trash, allowed = () => {} } = {}) {
    this.root = root;
    this.trash = trash;
    this.allowed = allowed;
    this.turns = new Map();   // turnId -> live record while the turn runs
  }

  folder(turnId) {
    if (!ID.test(turnId)) throw new Error('invalid_turn');
    return path.join(this.root, turnId.replace(/:/g, '_'));
  }

  record(turnId, threadId) {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { turnId, threadId, entries: [], bytes: 0, seen: new Set() };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  async saveBlob(turn, bytes) {
    const name = randomUUID();
    const folder = this.folder(turn.turnId);
    await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(folder, name), bytes, { mode: 0o600 });
    turn.bytes += bytes.length;
    return name;
  }

  // The original state of one path: absent, a file (with its bytes when within the limits) or a folder tree.
  async capture(turn, target) {
    const info = await fs.promises.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return { kind: 'absent' };
    if (info.isFile()) {
      if (info.size > MAX_FILE || turn.bytes + info.size > MAX_TURN) return { kind: 'file', tooLarge: true, size: info.size };
      const bytes = await fs.promises.readFile(target);
      return { kind: 'file', blob: await this.saveBlob(turn, bytes), sha256: hash(bytes), mode: info.mode & 0o777 };
    }
    if (info.isDirectory()) {
      const tree = [];
      let tooLarge = false;
      const walk = async (folder, prefix) => {
        for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
          if (tooLarge) return;
          const full = path.join(folder, entry.name);
          const rel = prefix ? prefix + '/' + entry.name : entry.name;
          if (tree.length >= MAX_TREE_FILES) { tooLarge = true; return; }
          if (entry.isDirectory()) { tree.push({ rel, dir: true }); await walk(full, rel); }
          else if (entry.isFile()) {
            const size = (await fs.promises.stat(full)).size;
            if (size > MAX_FILE || turn.bytes + size > MAX_TURN) { tooLarge = true; return; }
            tree.push({ rel, blob: await this.saveBlob(turn, await fs.promises.readFile(full)) });
          }
        }
      };
      await walk(target, '');
      return tooLarge ? { kind: 'dir', tooLarge: true } : { kind: 'dir', tree };
    }
    return { kind: 'other' };
  }

  // A cheap description of a path now, to tell whether it changed after the turn.
  async fingerprint(target) {
    const info = await fs.promises.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return 'absent';
    if (info.isFile()) return 'file:' + (info.size <= MAX_FILE ? hash(await fs.promises.readFile(target)) : info.size + ':' + info.mtimeMs);
    if (info.isDirectory()) return 'dir';
    return 'other';
  }

  // Runs one file tool call, saving the original state of what it may change first.
  async around(turnId, threadId, tool, args, run) {
    const paths = affected(tool, args);
    if (!paths.length || !turnId) return run();
    const turn = this.record(turnId, threadId);
    for (const item of paths) {
      if (turn.seen.has(item.path)) continue;
      turn.seen.add(item.path);
      try {
        turn.entries.push({ path: item.path, action: item.action, before: await this.capture(turn, item.path) });
      } catch (error) {
        turn.entries.push({ path: item.path, action: item.action, before: { kind: 'unknown', error: error.code || error.message } });
      }
    }
    return run();
  }

  // Ends a turn: drops paths that ended as they began, saves the manifest and returns the summary for the UI.
  async finish(turnId) {
    const turn = this.turns.get(turnId);
    this.turns.delete(turnId);
    if (!turn) return null;
    const entries = [];
    for (const entry of turn.entries) {
      const after = await this.fingerprint(entry.path).catch(() => 'unknown');
      const before = entry.before.kind === 'absent' ? 'absent' : entry.before.kind === 'file' && entry.before.sha256 ? 'file:' + entry.before.sha256 : null;
      if (before && before === after) continue;
      entries.push({ ...entry, after });
    }
    const folder = this.folder(turnId);
    if (!entries.length) {
      await fs.promises.rm(folder, { recursive: true, force: true });
      return null;
    }
    const manifest = { turnId, threadId: turn.threadId, at: Date.now(), entries, undone: false };
    await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await this.prune().catch(() => {});
    return summary(manifest);
  }

  async manifest(turnId) {
    return JSON.parse(await fs.promises.readFile(path.join(this.folder(turnId), 'manifest.json'), 'utf8'));
  }

  // Restores every path of the turn to its state before the turn, newest change first.
  async undo(turnId, { force = false } = {}) {
    const folder = this.folder(turnId);
    const manifest = await this.manifest(turnId);
    if (manifest.undone) throw new Error('这一轮已经撤销过了');
    const restored = [];
    const skipped = [];
    for (const entry of [...manifest.entries].reverse()) {
      const { before } = entry;
      try {
        this.allowed(entry.path);
        if (!force && await this.fingerprint(entry.path) !== entry.after) { skipped.push({ path: entry.path, reason: '之后又被修改过' }); continue; }
        if (before.tooLarge || ['other', 'unknown'].includes(before.kind)) { skipped.push({ path: entry.path, reason: before.tooLarge ? '文件太大，没有存档' : '无法存档的类型' }); continue; }
        const now = await fs.promises.lstat(entry.path).catch(() => null);
        if (before.kind === 'absent') {
          if (now) await this.trash(entry.path);
        } else if (before.kind === 'file') {
          if (now?.isDirectory()) { skipped.push({ path: entry.path, reason: '现在是文件夹' }); continue; }
          await fs.promises.mkdir(path.dirname(entry.path), { recursive: true });
          await fs.promises.writeFile(entry.path, await fs.promises.readFile(path.join(folder, before.blob)));
          await fs.promises.chmod(entry.path, before.mode).catch(() => {});
        } else if (before.kind === 'dir') {
          if (now) { skipped.push({ path: entry.path, reason: '位置已被占用' }); continue; }
          await fs.promises.mkdir(entry.path, { recursive: true });
          for (const item of before.tree) {
            const target = path.join(entry.path, ...item.rel.split('/'));
            if (item.dir) await fs.promises.mkdir(target, { recursive: true });
            else await fs.promises.writeFile(target, await fs.promises.readFile(path.join(folder, item.blob)));
          }
        }
        restored.push(entry.path);
      } catch (error) {
        skipped.push({ path: entry.path, reason: error.message });
      }
    }
    manifest.undone = true;
    manifest.undoneAt = Date.now();
    manifest.result = { restored, skipped };
    await fs.promises.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    return { restored, skipped };
  }

  // The checkpoints of one conversation, newest first.
  async list(threadId) {
    const names = await fs.promises.readdir(this.root).catch(() => []);
    const out = [];
    for (const name of names) {
      const manifest = await fs.promises.readFile(path.join(this.root, name, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
      if (manifest && manifest.threadId === threadId) out.push(summary(manifest));
    }
    return out.sort((a, b) => b.at - a.at);
  }

  async prune() {
    const names = await fs.promises.readdir(this.root).catch(() => []);
    const dated = [];
    for (const name of names) {
      const info = await fs.promises.stat(path.join(this.root, name)).catch(() => null);
      if (info?.isDirectory()) dated.push({ name, at: info.mtimeMs });
    }
    for (const { name } of dated.sort((a, b) => b.at - a.at).slice(KEEP_TURNS)) {
      await fs.promises.rm(path.join(this.root, name), { recursive: true, force: true });
    }
  }
}

function summary(manifest) {
  return {
    turnId: manifest.turnId, threadId: manifest.threadId, at: manifest.at, undone: manifest.undone,
    files: manifest.entries.map((entry) => ({ path: entry.path, action: entry.action, created: entry.before.kind === 'absent',
      restorable: !entry.before.tooLarge && !['other', 'unknown'].includes(entry.before.kind) })),
  };
}

module.exports = { Checkpoints, affected };
