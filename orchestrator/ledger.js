// Daily owner caps: a person may spend only so much of each CLI's subscription per local day. The
// ledger is derived from task.quota (charged after each task), so it survives restarts and needs no
// separate counter. A cap is a percentage of the plan, not a token count.

const { ROLES } = require('./routing');

function validateOwnerCaps(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_owner_caps');
  const caps = {};
  for (const [owner, limits] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(owner) || !limits || typeof limits !== 'object' || Array.isArray(limits)) {
      throw new Error('invalid_owner_caps:' + owner);
    }
    caps[owner] = {};
    for (const [role, limit] of Object.entries(limits)) {
      if (!ROLES.includes(role) || !Number.isFinite(limit) || limit < 0 || limit > 100) {
        throw new Error('invalid_owner_caps:' + owner + ':' + role);
      }
      caps[owner][role] = limit;
    }
  }
  return caps;
}

function capFor(ownerCaps, owner, role) {
  return ownerCaps?.[owner]?.[role] ?? ownerCaps?.default?.[role];
}

function dayBounds(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { start, end };
}

function nextReset(at = new Date()) {
  return dayBounds(at).end;
}

function taskPercent(task, role) {
  const windows = task.quota?.[role];
  const value = windows?.fiveHour ?? windows?.weekly;
  return Number.isFinite(value) ? value : 0;
}

// Percent used today, by role. Only tasks that started inside the local day count; a task without a
// recorded start time cannot be placed on a day and is ignored rather than guessed.
function usageForOwner(tasks, owner, { at = new Date() } = {}) {
  const { start, end } = dayBounds(at);
  const usage = {};
  for (const task of tasks) {
    if ((task.owner || 'local') !== owner) continue;
    const started = Date.parse(task.metrics?.startedAt || task.startedAt || '');
    if (!Number.isFinite(started) || started < start.getTime() || started >= end.getTime()) continue;
    for (const role of Object.keys(task.quota || {})) {
      const percent = taskPercent(task, role);
      if (percent) usage[role] = Math.round(((usage[role] || 0) + percent) * 10) / 10;
    }
  }
  return usage;
}

function allow(tasks, owner, role, ownerCaps, at = new Date()) {
  const cap = capFor(ownerCaps, owner, role);
  if (cap === undefined) return { allowed: true, used: usageForOwner(tasks, owner, { at })[role] || 0, cap: null, resetAt: nextReset(at) };
  const used = usageForOwner(tasks, owner, { at })[role] || 0;
  return { allowed: used < cap, used, cap, resetAt: nextReset(at) };
}

// One object per person that appears in tasks or in the cap configuration. Only today's use is shown,
// because that is what the cap governs.
function ownerUsageReport(tasks, ownerCaps = {}, at = new Date()) {
  const owners = new Set([...tasks.map((task) => task.owner || 'local'), ...Object.keys(ownerCaps).filter((owner) => owner !== 'default')]);
  return Object.fromEntries([...owners].map((owner) => {
    const usage = usageForOwner(tasks, owner, { at });
    const caps = Object.fromEntries(ROLES.map((role) => [role, capFor(ownerCaps, owner, role)]).filter(([, cap]) => cap !== undefined));
    return [owner, { usage, caps, resetAt: nextReset(at) }];
  }));
}

module.exports = { validateOwnerCaps, capFor, usageForOwner, allow, nextReset, dayBounds, ownerUsageReport };