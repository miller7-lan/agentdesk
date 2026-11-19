// Clears the files finished tasks leave on VPS2: each step's worktree and patch, the task's CLI logs, and the
// Git worktree registrations and branches in the project mirror. Task records stay, so history, quota and
// metrics survive. A task waiting for its patch to be reviewed is never cleared, because "apply" needs the patch.
const fs = require('node:fs/promises');
const path = require('node:path');
const { git } = require('./git');

const DEFAULTS = { completedDays: 3, failedDays: 7, minFreePercent: 15, historyDays: 60, uploadDays: 7 };
const DAY = 86400_000;
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const TASK_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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

// Which finished tasks may be cleared, oldest first. Age counts from the last change to the task.
function candidates(tasks, running, now, keep, { ignoreAge = false } = {}) {
  return [...tasks].filter((task) => {
    if (running.has(task.id) || task.cleanedAt || !['completed', 'cancelled', 'failed'].includes(task.state)) return false;
    const changed = Date.parse(task.updatedAt || task.createdAt || '');
    if (!Number.isFinite(changed)) return false;
    const days = task.state === 'failed' ? keep.failedDays : keep.completedDays;
    return ignoreAge || now - changed >= days * DAY;
  }).sort((a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt));
}

// Task records and their events older than the history window. Running work, patches waiting for review and
// tasks another task still references are kept: deleting them would break an apply or a reply.
function historyCandidates(tasks, running, now, keep, { referenced = new Set() } = {}) {
  return [...tasks].filter((task) => {
    if (running.has(task.id) || referenced.has(task.id) || !TERMINAL.has(task.state)) return false;
    const changed = Date.parse(task.updatedAt || task.createdAt || '');
    return Number.isFinite(changed) && now - changed >= keep.historyDays * DAY;
  }).sort((a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt));
}

async function clearTask(task, { stateDir, repository }) {
  const folders = [path.join(stateDir, 'worktrees', task.id), path.join(stateDir, 'logs', task.id)];
  let bytes = 0;
  for (const folder of folders) {
    bytes += await sizeOf(folder);
    await fs.rm(folder, { recursive: true, force: true });
  }
  if (repository) {
    try {
      await git(repository, ['worktree', 'prune']);
      const refs = (await git(repository, ['for-each-ref', '--format=%(refname:short)', `refs/heads/agentdesk/${task.id}/`]))
        .split('\n').filter(Boolean);
      if (refs.length) await git(repository, ['branch', '-D', ...refs]);
    } catch {}   // a mirror that moved or disappeared must not stop the files from being cleared
  }
  return bytes;
}

// Uploaded files are only needed while the task that used them is active. They live under the user's
// workspace, so only the AgentDesk-managed .agentdesk-uploads folder is touched; lstat avoids following
// a symlink out of that folder.
async function sweepUploads(stateDir, now, days) {
  let removed = 0;
  const roots = [stateDir];
  try {
    for (const entry of await fs.readdir(stateDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) roots.push(path.join(stateDir, entry.name));
    }
  } catch {}
  for (const root of roots) {
    const directory = path.join(root, '.agentdesk-uploads');
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      let stat;
      try { stat = await fs.lstat(target); } catch { continue; }
      if (stat.mtimeMs >= now - days * DAY) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// Worktree and log folders whose task record is gone and that are older than the history window.
async function clearOrphans(stateDir, tasks, now, keep) {
  const known = new Set(tasks.map((task) => task.id));
  const cutoff = now - keep.historyDays * DAY;
  let removed = 0;
  for (const kind of ['worktrees', 'logs']) {
    const root = path.join(stateDir, kind);
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_ID.test(entry.name) || known.has(entry.name)) continue;
      const folder = path.join(root, entry.name);
      let stat;
      try { stat = await fs.stat(folder); } catch { continue; }
      if (stat.mtimeMs >= cutoff) continue;
      await fs.rm(folder, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// Runs one pass. Returns what was cleared and the state of the disk.
async function cleanup({ tasks, running, config, now = Date.now(), statfs, onCleared }) {
  const keep = retention(config.retention);
  const cleared = [];
  let freedBytes = 0;
  const repositoryOf = (task) => config.workspaces?.[task.workspace]?.repository;
  const clear = async (task) => {
    freedBytes += await clearTask(task, { stateDir: config.stateDir, repository: repositoryOf(task) });
    task.cleanedAt = new Date(now).toISOString();
    onCleared?.(task);
    cleared.push(task.id);
  };
  for (const task of candidates(tasks, running, now, keep)) await clear(task);
  // Low on disk: clear the oldest finished tasks early, until a little above the threshold.
  let free = await freePercent(config.stateDir, statfs);
  let lowDisk = free !== null && free < keep.minFreePercent;
  if (lowDisk) {
    for (const task of candidates(tasks, running, now, keep, { ignoreAge: true })) {
      if (free >= keep.minFreePercent + 5) break;
      await clear(task);
      free = await freePercent(config.stateDir, statfs);
    }
  }
  const pendingReview = [...tasks].filter((task) => task.state === 'needs_review' && !task.cleanedAt).length;
  const uploadsRemoved = await sweepUploads(config.stateDir, now, keep.uploadDays);
  const orphansRemoved = await clearOrphans(config.stateDir, tasks, now, keep);
  return { cleared, freedBytes, freePercent: free === null ? null : Math.round(free * 10) / 10,
    lowDisk: free !== null && free < keep.minFreePercent, pendingReview, uploadsRemoved, orphansRemoved,
    at: new Date(now).toISOString() };
}

module.exports = { cleanup, retention, candidates, historyCandidates, sweepUploads, clearOrphans, DEFAULTS };
