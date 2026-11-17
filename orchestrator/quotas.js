const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { readFile, rename, rm, writeFile } = require('node:fs/promises');
const { createInterface } = require('node:readline');
const { modelId } = require('./model-profiles');

const providers = ['codex', 'claude', 'grok', 'gemini'];

function quotaWindow(window) {
  if (!Number.isFinite(window?.usedPercent) || window.usedPercent < 0) return null;
  const resetsAt = Number.isSafeInteger(window.resetsAt) ? window.resetsAt : null;
  if (resetsAt !== null && resetsAt * 1000 <= Date.now()) return null;
  return { usedPercent: window.usedPercent, resetsAt };
}

function codexBuckets(result) {
  const byId = Object.entries(result?.rateLimitsByLimitId || {});
  const main = result?.rateLimits;
  const snapshots = byId.length ? byId : main ? [[main.limitId || 'codex', main]] : [];
  return snapshots.map(([id, snapshot]) => {
    const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
    return {
      id,
      ...(typeof snapshot.limitName === 'string' && { label: snapshot.limitName }),
      fiveHour: quotaWindow(windows.find((window) => window.windowDurationMins === 300)),
      weekly: quotaWindow(windows.find((window) => window.windowDurationMins === 10080)),
    };
  }).filter(({ fiveHour, weekly }) => fiveHour || weekly);
}

function readCodexQuotas({ bin, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const input = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error('quota_timeout')), 7000);
    let finished = false;
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.close();
      child.stdin.destroy();
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }
    function send(frame) {
      child.stdin.write(JSON.stringify(frame) + '\n');
    }
    child.once('error', finish);
    child.stdin.once('error', finish);
    child.once('exit', () => finish(new Error('quota_connection_closed')));
    input.on('line', (line) => {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.id !== 1 && frame.id !== 2) return;
      if (frame.error) { finish(new Error('quota_not_available')); return; }
      if (frame.id === 2) { finish(null, codexBuckets(frame.result)); return; }
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'account/rateLimits/read', params: {} });
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentdesk-quotas', version: '1' } } });
  });
}

async function readSnapshot(filename) {
  const snapshot = JSON.parse(await readFile(filename, 'utf8'));
  const observedAt = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() || !Array.isArray(snapshot.buckets)) {
    throw new Error('invalid_quota_snapshot');
  }
  const buckets = snapshot.buckets.map(({ id, modelIds, fiveHour, weekly }) => ({
    id,
    ...(Array.isArray(modelIds) && { modelIds: modelIds.filter((name) => typeof name === 'string' && modelId.test(name)) }),
    fiveHour: quotaWindow(fiveHour),
    weekly: quotaWindow(weekly),
  })).filter(({ id, fiveHour, weekly }) => typeof id === 'string' && id && (fiveHour || weekly));
  return { observedAt: new Date(observedAt).toISOString(), buckets };
}

async function quotaStatus(adapters, { liveOnly = false } = {}) {
  return Promise.all(providers.map(async (provider) => {
    const adapter = adapters?.[provider];
    if (!adapter) return { provider, state: 'not_configured', buckets: [] };
    try {
      const useSnapshot = !liveOnly && adapter.quotaFile;
      const source = useSnapshot ? 'snapshot' : provider === 'codex' ? 'codex_app_server' : null;
      if (!source) return { provider, state: 'unavailable', reason: 'no_quota_source', buckets: [] };
      const { observedAt, buckets } = useSnapshot
        ? await readSnapshot(adapter.quotaFile)
        : { buckets: await readCodexQuotas(adapter), observedAt: new Date().toISOString() };
      return { provider, state: buckets.length ? 'available' : 'unavailable', source, observedAt, buckets };
    } catch {
      return { provider, state: 'unavailable', reason: 'quota_read_failed', buckets: [] };
    }
  }));
}

async function captureClaudeQuotas(filename, statusLine) {
  const limits = statusLine.rate_limits;
  const toWindow = (window) => quotaWindow({ usedPercent: window?.used_percentage, resetsAt: window?.resets_at });
  const fiveHour = toWindow(limits?.five_hour);
  const weekly = toWindow(limits?.seven_day);
  if (!fiveHour && !weekly) return;
  const temporary = filename + '.' + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify({
      observedAt: new Date().toISOString(),
      buckets: [{ id: 'claude-account', fiveHour, weekly }],
    }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (require.main === module) {
  const [, , command, filename] = process.argv;
  if (command === 'claude-statusline' && filename) {
    Promise.resolve().then(() => captureClaudeQuotas(filename, JSON.parse(readFileSync(0, 'utf8')))).catch(() => {
      console.error('claude_quota_capture_failed');
      process.exitCode = 1;
    });
  } else {
    quotaStatus({ codex: { bin: command || 'codex', env: process.env } }).then((result) => {
      console.log(JSON.stringify(result[0], null, 2));
    });
  }
}

module.exports = { codexBuckets, quotaStatus };
