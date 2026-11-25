// Clears the files finished tasks leave on VPS2: each step's worktree and patch, the task's CLI logs, the Git
// worktree registrations and `agentdesk/<task>/…` branches in the project mirror, old `.agentdesk-uploads`
// copies and orphan folders. Task records stay until the history window (scheduler.js), so history, quota and
// metrics survive.
//
// Safety rules (see OPERATIONS.md「定期清理」):
// - Only tasks in a terminal state, not running, not referenced by an unfinished task (a queued review reads
//   its source's patch) and unchanged since the candidate list was taken are cleared.
// - Every path is checked to stay inside the state directory after resolving symlinks in its parents; the
//   target itself is never followed (lstat), and a symlinked `.agentdesk-uploads` folder is refused.
// - Nothing is deleted in place. A target is first renamed (atomic, same filesystem) into
//   `<stateDir>/.cleanup-trash/<pass>/` and only purged after `trashDays`, or at once when the disk is low.
//   A rename across filesystems is refused rather than falling back to a recursive delete.
// - Every action is appended to `<stateDir>/cleanup-audit.jsonl` before it happens; if the audit line cannot
//   be written the action is skipped. Deleted branches are logged with their commit so they can be restored.
// - Failures are collected per item in `result.errors`; one failure never stops the rest of the pass.
// - `dryRun` reports what would happen without changing anything.
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { git } = require('./git');

const DEFAULTS = {
  completedDays: 3, failedDays: 7, minFreePercent: 15, historyDays: 60, uploadDays: 7,
  trashDays: 1, archiveDays: 30, minAgeMinutes: 60,
};
const DAY = 86400_000;
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const TASK_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// Ids become path components and ref names: no dots, slashes or leading dash.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TRASH = '.cleanup-trash';
const ARCHIVE = 'cleanup-archive';
const AUDIT = 'cleanup-audit.jsonl';
const LOCK = '.cleanup.lock';
const AUDIT_MAX = 5 * 1024 * 1024;
const LOCK_STALE = 2 * 3600_000;
// Top-level folders of the state directory that never hold upload copies and must not be scanned:
// mounted user homes, Git mirrors, CLI logins/history, task folders and the cleanup's own archive.
const UPLOAD_SKIP = new Set(['mounts', 'repos', 'homes', 'cli-history', 'worktrees', 'logs', 'ssh', ARCHIVE]);
const REFERENCE_KEYS = ['replyTo', 'reviewOf'];

function retention(config = {}) {
  const value = { ...DEFAULTS, ...config };
  for (const key of Object.keys(DEFAULTS)) {
    if (!Number.isFinite(value[key]) || value[key] < 0 || (key === 'minFreePercent' && value[key] > 90)) throw new Error('invalid_retention:' + key);
  }
  return value;
}

async function freePercent(dir, statfs = fs.statfs) {
  try {
    const stats = await statfs(dir);
    return stats.blocks ? (stats.bavail / stats.blocks) * 100 : null;
  } catch {
    return null;
  }
}

async function sizeOf(target) {
  let total = 0;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) return stat.size;
    for (const entry of await fs.readdir(target)) total += await sizeOf(path.join(target, entry));
  } catch {}
  return total;
}

const changedAt = (task) => Date.parse(task.updatedAt || task.createdAt || '');

// Ids of tasks that other tasks point at (reply, review). With `activeOnly`, only references held by tasks that
// have not finished yet count: those still need the referenced task's files.
function referencedIds(tasks, { activeOnly = false } = {}) {
  const ids = new Set();
  for (const task of tasks) {
    if (activeOnly && TERMINAL.has(task.state)) continue;
    for (const key of REFERENCE_KEYS) if (typeof task[key] === 'string') ids.add(task[key]);
  }
  return ids;
}

// Which finished tasks may be cleared, oldest first. Age counts from the last change to the task.
function candidates(tasks, running, now, keep, { ignoreAge = false, referenced = new Set() } = {}) {
  return [...tasks].filter((task) => {
    if (running.has(task.id) || task.cleanedAt || !TERMINAL.has(task.state) || referenced.has(task.id)) return false;
    const changed = changedAt(task);
    if (!Number.isFinite(changed)) return false;
    // Even when the disk is low, a task that just finished keeps its files for a short while (the person may
    // be reading the result or about to retry it).
    if (ignoreAge) return now - changed >= keep.minAgeMinutes * 60_000;
    const days = task.state === 'failed' ? keep.failedDays : keep.completedDays;
    return now - changed >= days * DAY;
  }).sort((a, b) => changedAt(a) - changedAt(b));
}

// Task records and their events older than the history window. Running work, patches waiting for review and
// tasks another task still references are kept: deleting them would break an apply or a reply. With
// `requireCleaned`, a task whose files were never cleared (a failed pass) is kept until they are.
function historyCandidates(tasks, running, now, keep, { referenced = new Set(), requireCleaned = false } = {}) {
  return [...tasks].filter((task) => {
    if (running.has(task.id) || referenced.has(task.id) || !TERMINAL.has(task.state)) return false;
    if (requireCleaned && !task.cleanedAt) return false;
    const changed = changedAt(task);
    return Number.isFinite(changed) && now - changed >= keep.historyDays * DAY;
  }).sort((a, b) => changedAt(a) - changedAt(b));
}

// True when `target` is strictly below `root` (both already resolved).
function inside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// The state directory must be an absolute, normalised path at least two levels deep ("/var/x", not "/" or "/var").
async function checkedStateDir(stateDir) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir ||
      stateDir.split(path.sep).filter(Boolean).length < 2) throw new Error('unsafe_state_dir');
  return fs.realpath(stateDir);
}

// One pass's context: where things go, what was done, and the audit trail.
function context({ stateDir, realState, now, keep, dryRun }) {
  const pass = new Date(now).toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  const ctx = {
    stateDir, realState, now, keep, dryRun, pass, purgeNow: false,
    trash: path.join(stateDir, TRASH, pass), trashReady: false,
    errors: [], planned: [], missingRepositories: [], quarantined: 0, purged: 0,
    async audit(entry) {
      if (dryRun) return;
      const file = path.join(stateDir, AUDIT);
      try {
        if ((await fs.stat(file)).size > AUDIT_MAX) await fs.rename(file, file + '.1');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), pass, ...entry }) + '\n', { mode: 0o600 });
    },
    async fail(entry, error) {
      const item = { ...entry, error: error?.code || error?.message || String(error) };
      if (ctx.errors.length < 50) ctx.errors.push(item);
      console.error('cleanup:', JSON.stringify(item));
      const { action, ...rest } = item;
      await ctx.audit({ ...rest, action: 'error', failed: action }).catch(() => {});
    },
  };
  return ctx;
}

// Resolves `target` for removal: its parent's real path must stay inside the state directory (and outside the
// trash), and the target itself is examined without following it. Returns null when it does not exist.
async function resolveTarget(ctx, target) {
  const parent = await fs.realpath(path.dirname(target)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (parent === null) return null;
  const real = path.join(parent, path.basename(target));
  const trashRoot = path.join(ctx.realState, TRASH);
  if (!inside(ctx.realState, real) || real === trashRoot || inside(trashRoot, real)) throw new Error('path_outside_state_dir');
  const stat = await fs.lstat(real).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return stat && { real, stat };
}

async function purgeEntry(ctx, target, reason) {
  const real = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  if (!inside(path.join(ctx.realState, TRASH), real)) throw new Error('purge_outside_trash');
  await ctx.audit({ action: 'purge', reason, path: real });
  await fs.rm(real, { recursive: true, force: true });
  ctx.purged += 1;
}

// Moves `target` into this pass's trash folder (or records it in a dry run). Returns the bytes it holds.
async function quarantine(ctx, target, meta) {
  const found = await resolveTarget(ctx, target);
  if (!found) return 0;
  const bytes = await sizeOf(found.real);
  if (ctx.dryRun) {
    ctx.planned.push({ action: 'quarantine', ...meta, path: found.real, bytes });
    return bytes;
  }
  if (!ctx.trashReady) {
    await fs.mkdir(ctx.trash, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(ctx.trash, '.pass.json'), JSON.stringify({ at: new Date(ctx.now).toISOString() }), { mode: 0o600 });
    ctx.trashReady = true;
  }
  const name = [meta.kind, meta.taskId, path.basename(found.real), randomBytes(3).toString('hex')].filter(Boolean).join('--');
  const destination = path.join(ctx.trash, name);
  await ctx.audit({ action: 'quarantine', ...meta, path: found.real, to: destination, bytes });
  try {
    await fs.rename(found.real, destination);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error.code === 'EXDEV' ? new Error('cross_device_refused') : error;
  }
  ctx.quarantined += 1;
  if (ctx.purgeNow) await purgeEntry(ctx, destination, 'low_disk');
  return bytes;
}

// Purges trash passes older than `trashDays`, or all of them with `all` (low disk).
async function purgeTrash(ctx, { all = false } = {}) {
  const root = path.join(ctx.stateDir, TRASH);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const folder = path.join(root, entry.name);
    try {
      let at = NaN;
      try { at = Date.parse(JSON.parse(await fs.readFile(path.join(folder, '.pass.json'), 'utf8')).at); } catch {}
      if (!Number.isFinite(at)) at = (await fs.lstat(folder)).mtimeMs;
      if (!all && ctx.now - at < ctx.keep.trashDays * DAY) continue;
      if (ctx.dryRun) { ctx.planned.push({ action: 'purge', path: folder }); continue; }
      await purgeEntry(ctx, folder, all ? 'low_disk' : 'expired');
      if (folder === ctx.trash) ctx.trashReady = false;
    } catch (error) {
      await ctx.fail({ action: 'purge', path: folder }, error);
    }
  }
}

// Clears one task's folders. Returns the bytes cleared, or null when the task changed meanwhile or failed.
async function clearTask(ctx, task, eligible) {
  if (typeof task.id !== 'string' || !SAFE_ID.test(task.id)) {
    await ctx.fail({ action: 'clear_task', taskId: String(task.id).slice(0, 80) }, new Error('unsafe_task_id'));
    return null;
  }
  if (!eligible(task)) return null;   // started again, referenced or changed since the list was taken
  let bytes = 0;
  for (const kind of ['worktrees', 'logs']) {
    try {
      bytes += await quarantine(ctx, path.join(ctx.stateDir, kind, task.id), { kind, taskId: task.id });
    } catch (error) {
      await ctx.fail({ action: 'clear_task', kind, taskId: task.id }, error);
      return null;
    }
  }
  return bytes;
}

// Deletes `agentdesk/<task>/…` branches whose task was cleared, or whose task record is gone and has no folder
// left. Prunes worktree registrations first so a branch is not held by a worktree that no longer exists.
async function sweepBranches(ctx, tasks, repositories, { unknownAllowed }) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let removed = 0;
  for (const repository of repositories) {
    // A mirror that was never created or has moved is reported, not treated as a failure.
    if (!(await fs.lstat(repository).then((stat) => stat.isDirectory(), () => false))) {
      ctx.missingRepositories.push(repository);
      continue;
    }
    try {
      if (!ctx.dryRun) await git(repository, ['worktree', 'prune']);
      const refs = (await git(repository, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/agentdesk/']))
        .split('\n').filter(Boolean).map((line) => line.split(' '));
      const doomed = [];
      for (const [branch, commit] of refs) {
        const id = branch.split('/')[1];
        if (!id || !SAFE_ID.test(id)) continue;
        const task = byId.get(id);
        if (task ? !task.cleanedAt : !unknownAllowed) continue;
        if (!task && await fs.lstat(path.join(ctx.stateDir, 'worktrees', id)).then(() => true, () => false)) continue;
        doomed.push({ branch, commit, taskId: id });
      }
      if (!doomed.length) continue;
      if (ctx.dryRun) {
        for (const item of doomed) ctx.planned.push({ action: 'delete_branch', repository, ...item });
        continue;
      }
      // The commit is logged so `git branch <branch> <commit>` restores it until Git's own gc drops the objects.
      for (const item of doomed) await ctx.audit({ action: 'delete_branch', repository, ...item });
      await git(repository, ['branch', '-D', '--', ...doomed.map((item) => item.branch)]);
      removed += doomed.length;
    } catch (error) {
      await ctx.fail({ action: 'sweep_branches', repository }, error);
    }
  }
  return removed;
}

// Uploaded files are only needed while the task that used them is active. They live under a workspace in the
// state directory, so only the AgentDesk-managed .agentdesk-uploads folder is touched. Mounted user homes,
// mirrors and logins are never scanned, and a symlinked uploads folder is refused.
async function sweepUploads(ctx) {
  let removed = 0;
  const roots = [ctx.stateDir];
  try {
    for (const entry of await fs.readdir(ctx.stateDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !UPLOAD_SKIP.has(entry.name)) roots.push(path.join(ctx.stateDir, entry.name));
    }
  } catch (error) {
    await ctx.fail({ action: 'sweep_uploads', path: ctx.stateDir }, error);
  }
  const cutoff = ctx.now - ctx.keep.uploadDays * DAY;
  for (const root of roots) {
    const directory = path.join(root, '.agentdesk-uploads');
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat) continue;
    if (!stat.isDirectory()) {
      await ctx.fail({ action: 'sweep_uploads', path: directory }, new Error('uploads_not_a_directory'));
      continue;
    }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      try {
        if ((await fs.lstat(target)).mtimeMs >= cutoff) continue;
        await quarantine(ctx, target, { kind: 'upload' });
        removed += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') await ctx.fail({ action: 'sweep_uploads', path: target }, error);
      }
    }
  }
  return removed;
}

// Worktree and log folders whose task record is gone and that are older than the history window.
async function clearOrphans(ctx, tasks) {
  const known = new Set(tasks.map((task) => task.id));
  const cutoff = ctx.now - ctx.keep.historyDays * DAY;
  let removed = 0;
  for (const kind of ['worktrees', 'logs']) {
    const root = path.join(ctx.stateDir, kind);
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_ID.test(entry.name) || known.has(entry.name)) continue;
      const folder = path.join(root, entry.name);
      try {
        if ((await fs.lstat(folder)).mtimeMs >= cutoff) continue;
        await quarantine(ctx, folder, { kind: 'orphan_' + kind, taskId: entry.name });
        removed += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') await ctx.fail({ action: 'clear_orphan', kind, taskId: entry.name }, error);
      }
    }
  }
  return removed;
}

// Removes archived history older than `archiveDays`.
async function purgeArchives(ctx) {
  const root = path.join(ctx.stateDir, ARCHIVE);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^history-.*\.json\.gz$/.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    try {
      if (ctx.now - (await fs.lstat(file)).mtimeMs < ctx.keep.archiveDays * DAY) continue;
      if (ctx.dryRun) { ctx.planned.push({ action: 'purge_archive', path: file }); continue; }
      await ctx.audit({ action: 'purge_archive', path: file });
      await fs.rm(file, { force: true });
    } catch (error) {
      await ctx.fail({ action: 'purge_archive', path: file }, error);
    }
  }
}

// Writes the task records and events about to be deleted into a gzip JSON archive (temp file, fsync, rename),
// so a history prune can be undone. Throws if it cannot, and the caller then keeps the records.
async function archiveHistory(stateDir, records, eventsOf, now = Date.now()) {
  const root = path.join(stateDir, ARCHIVE);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'history-' + new Date(now).toISOString().replace(/[:.]/g, '-') + '-' +
    randomBytes(3).toString('hex') + '.json.gz');
  const temporary = file + '.tmp';
  const body = zlib.gzipSync(JSON.stringify({
    version: 1, at: new Date(now).toISOString(),
    tasks: records.map((task) => ({ task, events: eventsOf(task.id) })),
  }));
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  return file;
}

// Appends one line to the audit log (used by the scheduler for the history prune).
async function auditLine(stateDir, entry) {
  await fs.appendFile(path.join(stateDir, AUDIT), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
}

// A lock file so two passes (two processes, or a hung pass and a new one) never clear at the same time.
// A lock whose process is gone, or that is older than two hours, is taken over.
async function acquireLock(stateDir, now) {
  const file = path.join(stateDir, LOCK);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); }
      finally { await handle.close(); }
      return () => fs.rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = {};
      try { holder = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
      let alive = false;
      try { process.kill(holder.pid, 0); alive = true; } catch {}
      if (alive && Date.now() - (Date.parse(holder.at) || 0) < LOCK_STALE) throw new Error('cleanup_locked');
      await fs.rm(file, { force: true });
    }
  }
  throw new Error('cleanup_locked');
}

// Runs one pass. Returns what was cleared (or, with dryRun, what would be) and the state of the disk.
async function cleanup({ tasks, running, config, now = Date.now(), statfs, onCleared, dryRun = false }) {
  const keep = retention(config.retention);
  const stateDir = config.stateDir;
  const realState = await checkedStateDir(stateDir);
  const ctx = context({ stateDir, realState, now, keep, dryRun });
  const release = dryRun ? null : await acquireLock(stateDir, now);
  try {
    const cleared = [];
    let freedBytes = 0;
    // Tasks an unfinished task points at keep their files (a queued review reads the source's patch).
    const referenced = referencedIds(tasks, { activeOnly: true });
    const clear = async (task) => {
      const seen = task.updatedAt;
      // Checked again right before the move: the task may have been retried, replied to or reviewed meanwhile.
      const eligible = (live) => !running.has(live.id) && TERMINAL.has(live.state) && !live.cleanedAt &&
        live.updatedAt === seen && !referencedIds(tasks, { activeOnly: true }).has(live.id);
      const bytes = await clearTask(ctx, task, eligible);
      if (bytes === null) return;
      freedBytes += bytes;
      cleared.push(task.id);
      if (dryRun) return;
      task.cleanedAt = new Date(now).toISOString();
      await ctx.audit({ action: 'task_cleared', taskId: task.id, state: task.state, bytes })
        .catch((error) => ctx.fail({ action: 'task_cleared', taskId: task.id }, error));
      try { onCleared?.(task); } catch (error) { await ctx.fail({ action: 'record_cleared', taskId: task.id }, error); }
    };
    for (const task of candidates(tasks, running, now, keep, { referenced })) await clear(task);
    await purgeTrash(ctx);
    // Low on disk: empty the trash, then clear the oldest finished tasks early (deleting at once) until a little
    // above the threshold. Tasks that finished within `minAgeMinutes` are still kept.
    let free = await freePercent(stateDir, statfs);
    if (free !== null && free < keep.minFreePercent) {
      ctx.purgeNow = true;
      await purgeTrash(ctx, { all: true });
      free = await freePercent(stateDir, statfs);
      for (const task of candidates(tasks, running, now, keep, { ignoreAge: true, referenced })) {
        if (free === null || free >= keep.minFreePercent + 5) break;
        await clear(task);
        free = await freePercent(stateDir, statfs);
      }
    }
    // With no task records at all (a fresh or unreadable database) nothing is treated as an orphan.
    const unknownAllowed = tasks.length > 0;
    const repositories = [...new Set(Object.values(config.workspaces || {}).map((workspace) => workspace?.repository)
      .filter((repository) => typeof repository === 'string' && path.isAbsolute(repository)))];
    const branchesRemoved = await sweepBranches(ctx, tasks, repositories, { unknownAllowed });
    const pendingReview = tasks.filter((task) => task.state === 'needs_review' && !task.cleanedAt).length;
    const uploadsRemoved = await sweepUploads(ctx);
    const orphansRemoved = unknownAllowed ? await clearOrphans(ctx, tasks) : 0;
    await purgeArchives(ctx);
    const result = {
      ok: ctx.errors.length === 0, dryRun, cleared, freedBytes,
      freePercent: free === null ? null : Math.round(free * 10) / 10,
      lowDisk: free !== null && free < keep.minFreePercent, pendingReview, uploadsRemoved, orphansRemoved,
      branchesRemoved, quarantined: ctx.quarantined, purged: ctx.purged, errors: ctx.errors,
      ...(ctx.missingRepositories.length && { missingRepositories: ctx.missingRepositories }),
      ...(!unknownAllowed && { orphanGuard: 'no_task_records' }),
      ...(dryRun && { planned: ctx.planned }),
      at: new Date(now).toISOString(), pass: ctx.pass,
    };
    await ctx.audit({ action: 'pass_done', ok: result.ok, cleared: cleared.length, freedBytes, uploadsRemoved, orphansRemoved,
      branchesRemoved, errors: ctx.errors.length }).catch(() => {});
    return result;
  } finally {
    await release?.();
  }
}

module.exports = {
  cleanup, retention, candidates, historyCandidates, referencedIds, archiveHistory, auditLine, inside, DEFAULTS,
  TRASH, ARCHIVE, AUDIT,
};
