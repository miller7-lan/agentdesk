const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { readFile, rename, rm, writeFile } = require('node:fs/promises');
const { createInterface } = require('node:readline');
const { modelId } = require('./model-profiles');

const providers = ['codex', 'claude', 'grok', 'gemini', 'antigravity'];

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

// Grok Build: the share of the period's credits used, from the billing endpoint the CLI itself calls, with
// the sign-in the CLI keeps in <HOME>/.grok/auth.json (or GROK_HOME). The token is only read: never refreshed,
// written or logged. An expired token is the CLI's ordinary state between runs; the CLI renews it when it runs.
// Mechanism as documented by Agent HUD (jazzenchen/agent-hud-open, Apache-2.0); written here from scratch.
const GROK_BILLING = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

function grokSignIn(env) {
  const home = env.GROK_HOME || (env.HOME && env.HOME + '/.grok');
  if (!home) return null;
  let auth;
  try { auth = JSON.parse(readFileSync(home + '/auth.json', 'utf8')); } catch { return null; }
  const now = Date.now();
  const expiry = (key, entry) => {
    try {
      const exp = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).exp;
      if (Number.isFinite(exp)) return exp * 1000;
    } catch {}
    const at = entry.expires_at;
    return typeof at === 'string' ? Date.parse(at) : Number.isFinite(at) ? (at > 1e10 ? at : at * 1000) : null;
  };
  return Object.values(auth || {}).filter((entry) => typeof entry?.key === 'string' && entry.key && !/[\0\r\n]/.test(entry.key))
    .map((entry) => ({ key: entry.key, expires: expiry(entry.key, entry) }))
    .find((entry) => !Number.isFinite(entry.expires) || entry.expires > now + 60_000) || null;
}

async function readGrokQuotas({ env }, fetchImpl = fetch) {
  const signIn = grokSignIn(env || {});
  if (!signIn) throw new Error('grok_signed_out');
  const response = await fetchImpl(GROK_BILLING, {
    headers: { Authorization: 'Bearer ' + signIn.key, 'X-XAI-Token-Auth': 'xai-grok-cli' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('grok_billing_' + response.status);
  const config = (await response.json())?.config;
  const start = Date.parse(config?.currentPeriod?.start);
  const end = Date.parse(config?.currentPeriod?.end);
  const used = config?.creditUsagePercent == null ? 0 : Number(config.creditUsagePercent);
  if (!Number.isFinite(start) || !(end > start) || !Number.isFinite(used)) throw new Error('grok_billing_format');
  const window = quotaWindow({ usedPercent: Math.min(100, Math.max(0, used)), resetsAt: Math.ceil(end / 1000) });
  // The period is usually a week; a period of a few hours counts as the short window.
  return window ? [{ id: 'grok-credits', ...(end - start <= 6 * 3600_000 ? { fiveHour: window } : { weekly: window }) }] : [];
}

// Antigravity: `agy -p /usage --output-format json` prints the quota groups without starting a model turn.
// Each group (Gemini models; Claude and GPT models) has a 5-hour and a weekly bucket with the fraction left.
// Only the Gemini group decides routing when there is one, because the team runs Gemini models on Antigravity.
function antigravityBuckets(body) {
  if (body?.status !== 'SUCCESS' || body.command?.name !== 'usage' || !Array.isArray(body.command.data?.groups)) {
    throw new Error(body?.status === 'ERROR' ? 'antigravity_usage_refused' : 'antigravity_usage_format');
  }
  const groups = body.command.data.groups.map((group) => {
    const windows = {};
    for (const bucket of group.buckets || []) {
      const left = bucket.remaining_fraction;
      if (!Number.isFinite(left) || left < 0 || left > 1) continue;
      const key = { '5h': 'fiveHour', weekly: 'weekly' }[bucket.window];
      const resetsAt = Date.parse(bucket.reset_time);
      if (key) windows[key] = quotaWindow({ usedPercent: Math.round((1 - left) * 1000) / 10, resetsAt: Number.isFinite(resetsAt) ? Math.ceil(resetsAt / 1000) : undefined });
    }
    const name = String(group.name || '');
    return { id: 'antigravity-' + (/gemini/i.test(name) ? 'gemini' : /claude|gpt/i.test(name) ? 'third-party' : name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'models'),
      label: name, ...windows };
  }).filter((group) => group.fiveHour || group.weekly);
  const gemini = groups.filter((group) => group.id === 'antigravity-gemini');
  return gemini.length ? gemini : groups;
}

function readAntigravityQuotas({ bin, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '/usage', '--output-format', 'json'],
      { env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('quota_timeout')); }, 30_000);
    child.stdout.on('data', (chunk) => { out = (out + chunk).slice(-200_000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').reverse().find((text) => text.trim().startsWith('{'));
      try { resolve(antigravityBuckets(JSON.parse(out.trim().startsWith('{') ? out : line))); } catch (error) { reject(error); }
    });
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
      const live = { codex: 'codex_app_server', grok: 'grok_billing', antigravity: 'antigravity_usage' }[provider];
      const source = useSnapshot ? 'snapshot' : live || null;
      if (!source) return { provider, state: 'unavailable', reason: 'no_quota_source', buckets: [] };
      if (adapter.authRequired) return { provider, state: 'unavailable', reason: 'auth_required', buckets: [] };
      const reader = { codex_app_server: readCodexQuotas, grok_billing: readGrokQuotas, antigravity_usage: readAntigravityQuotas }[source];
      const { observedAt, buckets } = useSnapshot
        ? await readSnapshot(adapter.quotaFile)
        : { buckets: await reader(adapter), observedAt: new Date().toISOString() };
      return { provider, state: buckets.length ? 'available' : 'unavailable', source, observedAt, buckets };
    } catch (error) {
      const reason = error?.message === 'grok_signed_out' ? 'signed_out' : 'quota_read_failed';
      return { provider, state: 'unavailable', reason, buckets: [] };
    }
  }));
}

async function writeClaudeSnapshot(filename, fiveHour, weekly) {
  if (!fiveHour && !weekly) return false;
  const temporary = filename + '.' + randomUUID();
  try {
    await writeFile(temporary, JSON.stringify({
      observedAt: new Date().toISOString(),
      buckets: [{ id: 'claude-account', fiveHour, weekly }],
    }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function captureClaudeQuotas(filename, statusLine) {
  const limits = statusLine.rate_limits;
  const toWindow = (window) => quotaWindow({ usedPercent: window?.used_percentage, resetsAt: window?.resets_at });
  return writeClaudeSnapshot(filename, toWindow(limits?.five_hour), toWindow(limits?.seven_day));
}

// Claude Code reports the account's limits on every headless turn (`rate_limit_event`). `unifiedWindows` holds
// both windows as the fraction used (0.54 = 54%), so direct chats and scheduled tasks can refresh the same
// snapshot a status line would write, without waiting for the CLI's interactive mode.
function claudeRateLimitBuckets(info) {
  const unified = info?.unifiedWindows || {};
  const source = (name) => unified[name] || (info?.rateLimitType === name ? info : null);
  const toWindow = (window) => {
    const utilization = Number(window?.utilization);
    return Number.isFinite(utilization) && utilization >= 0
      ? quotaWindow({ usedPercent: Math.round(Math.min(1, utilization) * 1000) / 10, resetsAt: window?.resetsAt })
      : null;
  };
  return [{ id: 'claude-account', fiveHour: toWindow(source('five_hour')), weekly: toWindow(source('seven_day')) }];
}

async function captureClaudeRateLimitEvent(filename, info) {
  const [bucket] = claudeRateLimitBuckets(info);
  return writeClaudeSnapshot(filename, bucket.fiveHour, bucket.weekly);
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

module.exports = {
  codexBuckets, quotaStatus, readGrokQuotas, antigravityBuckets,
  captureClaudeQuotas, claudeRateLimitBuckets, captureClaudeRateLimitEvent,
};
