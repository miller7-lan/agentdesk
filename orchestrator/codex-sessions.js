const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const SOURCE_KINDS = Object.freeze(['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']);

// Use the CLI's deletion API so its SQLite index and rollout files agree after cleanup.
async function deleteCodexSessions(adapter, { sessions = [], directories = [], roots = [], spawnProcess = spawn }) {
  if (!adapter?.bin) {
    if (sessions.length) throw Error('codex_cleanup_not_configured');
    return;
  }
  if (!sessions.length && !directories.length && !roots.length) return;
  const child = spawnProcess(adapter.bin, ['app-server'], { env: adapter.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  const fail = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer);entry.reject(error); }
    pending.clear();
  };
  child.once('error', fail);
  child.once('exit', () => fail(Error('codex_cleanup_disconnected')));
  lines.on('line', text => {
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);clearTimeout(entry.timer);
    if (frame.error) entry.reject(Error(frame.error.message || 'codex_cleanup_failed'));
    else entry.resolve(frame.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id);reject(Error('codex_cleanup_timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) fail(error); });
  });
  child.stdin.on('error', fail);
  try {
    await request('initialize', { clientInfo: { name: 'agentdesk-cleanup', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const ids = new Set(sessions);
    for (const cwd of roots.length ? [null] : directories) {
      for (const archived of [false, true]) {
        let cursor;
        do {
          const page = await request('thread/list', { ...(cwd && { cwd }), archived, sourceKinds: SOURCE_KINDS, limit: 100, ...(cursor && { cursor }) });
          for (const thread of page.data || []) if (cwd ? thread.cwd === cwd : roots.some(root => thread.cwd === root || thread.cwd?.startsWith(root + '/'))) ids.add(thread.id);
          cursor = page.nextCursor;
        } while (cursor);
      }
    }
    for (const threadId of ids) {
      try { await request('thread/delete', { threadId }); }
      catch (error) { if (!/thread.*not found|no rollout found|does not exist/i.test(error.message)) throw error; }
    }
  } finally {
    fail(Error('codex_cleanup_closed'));
    lines.close();child.stdin.end();child.kill();
  }
}

module.exports = { deleteCodexSessions, SOURCE_KINDS };
