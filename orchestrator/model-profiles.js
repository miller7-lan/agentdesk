const modelId = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/;

// 推理强度档位与各 CLI 的 `--effort` / `--reasoning-effort` 取值一致；
// 配置只能声明 CLI 实际接受的子集，UI 也只展示这些档位。
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const abilities = {
  codex: 'The default implementer: every file change in a task goes to Codex on one model, routine or hard; repository navigation, debugging and verification in a sandbox that can run tests.',
  claude: 'Independent design and code review, reasoning about edge cases, and synthesizing findings.',
  grok: 'Code review from a different vendor, research with web search, quick second opinions. Runs shell commands and tests when the server sandboxes it.',
  gemini: 'Read-only repository investigation, comparison, and synthesis in group collaboration.',
  antigravity: 'Google Gemini on an Ultra subscription. Routine and multi-file implementation, reading large codebases, logs and documents, research with Google search, and review. The model list follows the signed-in account, so choose from the profiles offered here; the effort level is part of the model ID (low/medium/high), and step.effort must be left out for this executor.',
};

function modelProfiles(settings) {
  const models = settings.models || {};
  if (typeof models !== 'object' || Array.isArray(models) || Object.keys(models).length > 32 ||
      (settings.defaultModel !== undefined &&
        (typeof settings.defaultModel !== 'string' || !Object.hasOwn(models, settings.defaultModel)))) {
    throw new Error('invalid_model_profile');
  }
  return {
    defaultModel: settings.defaultModel,
    models: Object.fromEntries(Object.entries(models).map(([id, profile]) => {
      if (!modelId.test(id) || typeof profile?.strengths !== 'string' || !profile.strengths.trim() || profile.strengths.length > 500 ||
          !['api', 'subscription', 'unknown'].includes(profile.billing)) throw new Error('invalid_model_profile');
      const { strengths, billing, label, efforts, defaultEffort, inputUsdPerMillion, outputUsdPerMillion } = profile;
      if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 80)) throw new Error('invalid_model_profile');
      if (efforts !== undefined && (!Array.isArray(efforts) || !efforts.length || efforts.length > EFFORT_LEVELS.length ||
          new Set(efforts).size !== efforts.length || efforts.some((effort) => !EFFORT_LEVELS.includes(effort)))) {
        throw new Error('invalid_model_efforts');
      }
      if (defaultEffort !== undefined && (efforts === undefined || !efforts.includes(defaultEffort))) {
        throw new Error('invalid_model_efforts');
      }
      const rates = [inputUsdPerMillion, outputUsdPerMillion];
      if (billing === 'api' && rates.some((rate) => !Number.isFinite(rate) || rate < 0)) throw new Error('invalid_model_price');
      return [id, {
        strengths, billing,
        ...(label !== undefined && { label }),
        ...(efforts !== undefined && { efforts }),
        ...(defaultEffort !== undefined && { defaultEffort }),
        ...(billing === 'api' && { inputUsdPerMillion, outputUsdPerMillion }),
      }];
    })),
  };
}

// Newer generations first, read from the version numbers in the model ID (gpt-5.5 > gpt-5.4 > gpt-5,
// grok-4.7 > grok-4, gemini-4-… > gemini-3-…, claude-opus-5-5 > claude-opus-4-8); within one generation a full
// model comes before a small or fast one. A number above 999 (a date) is not a version. Equal models keep
// their listed order.
const SMALL = /(^|[-_.])(mini|nano|lite|flash|fast|haiku|small)([-_.]|$)/i;
function versionOf(id) {
  const match = /(\d+(?:[.-]\d+)*)/.exec(String(id));
  return match ? match[1].split(/[.-]/).map(Number).filter((part) => part <= 999) : [];
}
function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (b[i] ?? -1) - (a[i] ?? -1);
    if (difference) return difference;
  }
  return 0;
}
function newestFirst(ids) {
  return ids.map((id, index) => ({ id, index, version: versionOf(id), small: SMALL.test(id) }))
    .sort((a, b) => compareVersions(a.version, b.version) || Number(a.small) - Number(b.small) || a.index - b.index)
    .map(({ id }) => id);
}
// The model a member uses when the lead names none: its newest full model. The configured default wins only
// when it is of that same newest generation and size (it may pick a variant, e.g. an effort level).
function preferredModel(profiles) {
  const ids = Object.keys(profiles?.models || {});
  if (!ids.length) return profiles?.defaultModel;
  const [top] = newestFirst(ids);
  const fallback = profiles.defaultModel;
  if (fallback && ids.includes(fallback) && compareVersions(versionOf(fallback), versionOf(top)) === 0 &&
      SMALL.test(fallback) === SMALL.test(top)) return fallback;
  return top;
}

function plannerProfiles(roles, adapters, preferredRole, preferredModel) {
  return Object.fromEntries(roles.map((role) => {
    const { defaultModel, models } = adapters[role]?.profiles || { models: {} };
    const configuredModels = { ...models };
    if (role === preferredRole && preferredModel && !Object.hasOwn(configuredModels, preferredModel)) {
      configuredModels[preferredModel] = { billing: 'unknown' };
    }
    const { effortsFor } = require('./adapters');
    return [role, { strengths: abilities[role], defaultModel, newestFirst: newestFirst(Object.keys(configuredModels)),
      models: configuredModels, efforts: effortsFor(role, adapters[role]) }];
  }));
}

module.exports = { EFFORT_LEVELS, modelId, modelProfiles, plannerProfiles, newestFirst, preferredModel };
