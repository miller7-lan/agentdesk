// Clears the files finished tasks leave on VPS2: each step's worktree and patch, the task's CLI logs, and the
// Git worktree registrations and branches in the project mirror. Task records stay, so history, quota and
// metrics survive. A task waiting for its patch to be reviewed is never cleared, because "apply" needs the patch.
const fs = require('node:fs/promises');
const path = require('node:path');
const { git } = require('./git');

const DEFAULTS = { completedDays: 3, failedDays: 7, minFreePercent: 15 };
const DAY = 86400_000;

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
  return { cleared, freedBytes, freePercent: free === null ? null : Math.round(free * 10) / 10,
    lowDisk: free !== null && free < keep.minFreePercent, pendingReview, at: new Date(now).toISOString() };
}

module.exports = { cleanup, retention, candidates, DEFAULTS };
