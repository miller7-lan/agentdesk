const modelId = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/;

const abilities = {
  codex: 'Strongest implementer for hard, cross-cutting or risky changes; repository navigation, debugging and verification in a sandbox that can run tests. Scarce quota.',
  claude: 'Independent design and code review, reasoning about edge cases, and synthesizing findings.',
  grok: 'Code review from a different vendor, research with web search, quick second opinions. Cannot run shell commands.',
  gemini: 'Read-only repository investigation, comparison, and synthesis in group collaboration.',
  antigravity: 'Google Gemini 4 on an Ultra 20x subscription: the most quota by far. Routine and multi-file implementation, reading large codebases, logs and documents, research with Google search, and review. Choose the model per step from its profiles.',
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
