// Single-chat thread metadata (session IDs, local roots, dynamic tools) is kept for the same history window as
// task records. The transcript itself lives in the CLI and is not stored here.

const DAY = 86400_000;
const DEFAULT_DAYS = 60;

function retentionDays(env = process.env) {
  const days = Number(env.AGENTDESK_CHAT_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : DEFAULT_DAYS;
}

function pruneThreads(state, { now = Date.now(), days = retentionDays() } = {}) {
  const cutoff = now - days * DAY;
  const removed = [];
  for (const [id, thread] of Object.entries(state?.threads || {})) {
    const changed = Number(thread?.updatedAt ?? thread?.createdAt);
    if (Number.isFinite(changed) && changed > 0 && changed < cutoff) {
      delete state.threads[id];
      removed.push(id);
    }
  }
  return removed;
}

module.exports = { pruneThreads, retentionDays, DEFAULT_DAYS, DAY };