const modelId = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/;

const abilities = {
  codex: 'Repository navigation, implementation, debugging, and verification. Can generate patches in automatic collaboration.',
  claude: 'Independent design and code review, reasoning about edge cases, and synthesizing findings.',
  grok: 'Research, quick second opinions, and alternative approaches. The integration exposes web search.',
  gemini: 'Read-only repository investigation, comparison, and synthesis in group collaboration.',
  antigravity: 'Reading large codebases, logs and documents, and writing short briefs; a second opinion in review.',
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
      const { strengths, billing, inputUsdPerMillion, outputUsdPerMillion } = profile;
      const rates = [inputUsdPerMillion, outputUsdPerMillion];
      if (billing === 'api' && rates.some((rate) => !Number.isFinite(rate) || rate < 0)) throw new Error('invalid_model_price');
      return [id, { strengths, billing, ...(billing === 'api' && { inputUsdPerMillion, outputUsdPerMillion }) }];
    })),
  };
}

function plannerProfiles(roles, adapters, preferredRole, preferredModel) {
  return Object.fromEntries(roles.map((role) => {
    const { defaultModel, models } = adapters[role]?.profiles || { models: {} };
    const configuredModels = { ...models };
    if (role === preferredRole && preferredModel && !Object.hasOwn(configuredModels, preferredModel)) {
      configuredModels[preferredModel] = { billing: 'unknown' };
    }
    return [role, { strengths: abilities[role], defaultModel, models: configuredModels }];
  }));
}

module.exports = { modelId, modelProfiles, plannerProfiles };
