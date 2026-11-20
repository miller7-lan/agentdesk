// Each CLI knows which models its account can use right now; the server asks it instead of trusting a
// hand-written list. A login change can add a whole model family (Gemini 4, a new Codex generation) and a
// retired model disappears, without editing the server configuration. Claude Code has no catalog command, so
// its hand-written profiles stay as they are.
const { execFile } = require('node:child_process');
const { EFFORT_LEVELS, modelId } = require('./model-profiles');

const CATALOG_TIMEOUT = 25_000;

function catalogError(role, error) {
  const reason = error?.code === 'ENOENT' ? 'not_installed'
    : error?.killed ? 'timeout'
    : String(error?.stderr || error?.message || 'failed').trim().split('\n')[0].slice(0, 160);
  return new Error('model_catalog:' + role + ':' + reason);
}

function run(file, args, env, exec = execFile) {
  return new Promise((resolve, reject) => {
    exec(file, args, { env, timeout: CATALOG_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

const rows = (text) => String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

// `agy models` prints one `id<TAB>display name` per line after a progress line. Only Gemini models are
// adopted automatically: the team routes this CLI by its Gemini quota group, so offering its Claude/GPT
// models to the planner would make quota decisions use the wrong bucket. They can still be added by hand.
function parseAntigravity(text) {
  const models = [];
  for (const line of rows(text)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!modelId.test(id) || !/^gemini-/i.test(id) || models.some((model) => model.id === id)) continue;
    models.push({ id, ...(label && label !== id && { label }) });
  }
  return { models, ...(models.find((model) => /flash-medium$/.test(model.id))?.id
    ? { defaultModel: models.find((model) => /flash-medium$/.test(model.id)).id } : {}) };
}

// `grok models` prints the account's default and a bullet list; it needs the CLI's sign-in, so the same
// command without the adapter's HOME reports a different (older) list.
function parseGrok(text) {
  const body = String(text || '');
  const models = [];
  for (const line of rows(body)) {
    const match = /^[*-]\s+([a-zA-Z0-9][\w.:/-]*)(?:\s+\(default\))?\s*$/.exec(line);
    if (match && modelId.test(match[1]) && !models.some((model) => model.id === match[1])) {
      models.push({ id: match[1] });
    }
  }
  const declared = /Default model:\s*([a-zA-Z0-9][\w.:/-]*)/.exec(body)?.[1];
  return { models, ...(declared && models.some((model) => model.id === declared) && { defaultModel: declared }) };
}

// `codex debug models` prints the app-server's raw catalog as JSON. `visibility: "hide"` marks models the
// CLI itself will not offer, so they are left out. The catalog carries enough detail to fill a profile.
function parseCodex(text) {
  const body = JSON.parse(text);
  if (!Array.isArray(body?.models)) throw new Error('model_catalog:codex:format');
  const models = [];
  for (const entry of body.models) {
    if (entry?.visibility === 'hide' || !modelId.test(entry?.slug || '')) continue;
    const efforts = (entry.supported_reasoning_levels || []).map((level) => level?.effort)
      .filter((effort) => EFFORT_LEVELS.includes(effort));
    const unique = [...new Set(efforts)];
    const strengths = String(entry.description || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    models.push({
      id: entry.slug,
      ...(entry.display_name && { label: String(entry.display_name).slice(0, 80) }),
      ...(strengths && { strengths }),
      ...(unique.length && { efforts: unique }),
      ...(entry.default_reasoning_level && unique.includes(entry.default_reasoning_level) && { defaultEffort: entry.default_reasoning_level }),
    });
  }
  return { models };
}

const parsers = { antigravity: parseAntigravity, grok: parseGrok, codex: parseCodex };

// Claude Code has no command that lists models, so Claude's list comes from Anthropic's model list
// (GET /v1/models), with an API key when the adapter has one, otherwise the CLI's own sign-in token on VPS2 —
// the same token the live quota reading uses. Listing models with a sign-in token is not documented by
// Anthropic; when it is refused, Claude keeps the models in the configuration.
function parseClaude(body) {
  const models = [];
  for (const entry of body?.data || []) {
    const id = entry?.id;
    if (typeof id !== 'string' || !/^claude-/i.test(id) || !modelId.test(id) || models.some((model) => model.id === id)) continue;
    models.push({ id, ...(typeof entry.display_name === 'string' && entry.display_name.trim() && { label: entry.display_name.trim().slice(0, 80) }) });
  }
  return { models };
}
async function discoverClaude(adapter, request = globalThis.fetch) {
  const key = adapter.env?.ANTHROPIC_API_KEY;
  const headers = key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: 'Bearer ' + await require('./quotas').claudeToken(adapter.env), 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' };
  const response = await request('https://api.anthropic.com/v1/models?limit=1000', { headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT) });
  if (!response.ok) throw new Error('model_catalog:claude:http_' + response.status);
  return parseClaude(await response.json());
}

function discoverModels(role, adapter, exec) {
  if (role === 'claude') return discoverClaude(adapter);
  const parser = parsers[role];
  if (!parser) return Promise.reject(new Error('model_catalog:' + role + ':unsupported'));
  const args = { codex: ['debug', 'models'], grok: ['models'], antigravity: ['models'] }[role];
  return run(adapter.bin, args, adapter.env, exec).then(parser, (error) => {
    throw catalogError(role, error);
  });
}

// The catalog is authoritative for the models the CLI offers. Hand-written metadata (strengths, billing,
// prices) is kept for every model that is still offered; new models get a neutral description. The default
// model only changes when the configured one no longer exists. For Antigravity, manually configured
// non-Gemini models are left in place because discovery deliberately ignores them.
function mergeModels(profiles, role, catalog) {
  const models = catalog.models || [];
  if (!models.length) throw new Error('model_catalog:' + role + ':empty');
  const previous = profiles.models || {};
  const keepManual = role === 'antigravity'
    ? Object.fromEntries(Object.entries(previous).filter(([id]) => !/^gemini-/i.test(id)))
    : {};
  const next = { ...keepManual };
  for (const entry of models) {
    const profile = { ...(previous[entry.id] || {}) };
    profile.strengths ||= entry.strengths
      || (role === 'antigravity'
        ? '由 agy 自动发现；强度写在模型名里（low/medium/high），按模型名选择。'
        : '由 ' + role + ' CLI 自动发现；尚无人工说明。');
    profile.billing ||= entry.billing || 'unknown';
    if (!profile.label && entry.label) profile.label = entry.label;
    if (!profile.efforts && entry.efforts?.length) profile.efforts = entry.efforts;
    if (!profile.defaultEffort && entry.defaultEffort && profile.efforts?.includes(entry.defaultEffort)) {
      profile.defaultEffort = entry.defaultEffort;
    }
    next[entry.id] = profile;
  }
  const before = Object.keys(previous);
  const after = Object.keys(next);
  const configured = profiles.defaultModel;
  const fallback = catalog.defaultModel && next[catalog.defaultModel] ? catalog.defaultModel
    : after.find((id) => /flash-medium$/.test(id))
      || after.find((id) => /medium/.test(id))
      || after[0];
  const defaultModel = configured && next[configured] ? configured : fallback;
  profiles.models = next;
  if (defaultModel) profiles.defaultModel = defaultModel;
  return {
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
    defaultModel,
  };
}

// Best-effort: one CLI being signed out or slow must not hide the catalog of the others.
async function refreshModelCatalog(config, exec) {
  const roles = ['codex', 'grok', 'antigravity', 'claude'].filter((role) => config.adapters?.[role]);
  const entries = await Promise.all(roles.map(async (role) => {
    try {
      const catalog = await discoverModels(role, config.adapters[role], exec);
      const change = mergeModels(config.adapters[role].profiles, role, catalog);
      return [role, { ...change, models: catalog.models.length }];
    } catch (error) {
      return [role, { error: error.message }];
    }
  }));
  return Object.fromEntries(entries);
}

module.exports = {
  parseAntigravity, parseGrok, parseCodex, parseClaude, discoverClaude, discoverModels, mergeModels, refreshModelCatalog,
};