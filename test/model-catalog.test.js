const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAntigravity, parseGrok, parseCodex, discoverModels, mergeModels, refreshModelCatalog,
} = require('../orchestrator/model-catalog');

test('agy models contributes Gemini models and ignores its Claude and GPT models', () => {
  const catalog = parseAntigravity([
    'Fetching available models...',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ].join('\n'));
  assert.deepEqual(catalog.models.map((model) => model.id), [
    'gemini-4-neon-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  ]);
  assert.equal(catalog.models[0].label, 'Gemini 4 Neon (High)');
  assert.equal(catalog.defaultModel, 'gemini-3.8-flash-medium');
});

test('grok models is read from the account-specific list', () => {
  const catalog = parseGrok([
    'You are logged in with grok.com.',
    '',
    'Default model: grok-4.7',
    '',
    'Available models:',
    '  * grok-4.7 (default)',
    '  - grok-4.7-build-fast',
    '  - grok-4.6',
  ].join('\n'));
  assert.deepEqual(catalog.models.map((model) => model.id), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
  assert.equal(catalog.defaultModel, 'grok-4.7');
});

test('codex debug models keeps visible models and the efforts each accepts', () => {
  const catalog = parseCodex(JSON.stringify({ models: [
    { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', description: 'Fast, go-to model.',
      default_reasoning_level: 'medium', visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }] },
    { slug: 'gpt-reserve', display_name: 'Reserve', description: 'Hidden.', visibility: 'hide',
      supported_reasoning_levels: [{ effort: 'high' }] },
  ] }));
  assert.equal(catalog.models.length, 1);
  assert.deepEqual(catalog.models[0], {
    id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', strengths: 'Fast, go-to model.',
    efforts: ['low', 'medium'], defaultEffort: 'medium',
  });
});

test('merging a catalog keeps hand-written metadata, adds new models and drops retired Gemini models', () => {
  const profiles = {
    defaultModel: 'gemini-3.8-flash-medium',
    models: {
      'gemini-3.8-flash-medium': { strengths: 'Hand-written guidance', billing: 'subscription' },
      'gemini-3.8-flash-low': { strengths: 'Retired soon', billing: 'subscription' },
      'claude-opus-4-6-thinking': { strengths: 'Manual third-party entry', billing: 'subscription' },
    },
  };
  const change = mergeModels(profiles, 'antigravity', { models: [
    { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  ] });
  assert.deepEqual(change.added, ['gemini-4-neon-medium']);
  assert.deepEqual(change.removed, ['gemini-3.8-flash-low']);
  assert.equal(profiles.defaultModel, 'gemini-3.8-flash-medium');
  assert.equal(profiles.models['gemini-3.8-flash-medium'].strengths, 'Hand-written guidance');
  assert.equal(profiles.models['gemini-4-neon-medium'].billing, 'unknown');
  assert.match(profiles.models['gemini-4-neon-medium'].strengths, /agy 自动发现/);
  assert.equal(profiles.models['claude-opus-4-6-thinking'].strengths, 'Manual third-party entry');
});

test('a default model that disappeared is replaced by the CLI default', () => {
  const profiles = {
    defaultModel: 'gemini-3.8-flash-medium',
    models: { 'gemini-3.8-flash-medium': { strengths: 'Old', billing: 'subscription' } },
  };
  const change = mergeModels(profiles, 'antigravity', {
    defaultModel: 'gemini-4-neon-medium',
    models: [{ id: 'gemini-4-neon-medium' }, { id: 'gemini-4-neon-high' }],
  });
  assert.equal(change.defaultModel, 'gemini-4-neon-medium');
  assert.equal(profiles.defaultModel, 'gemini-4-neon-medium');
  assert.equal(profiles.models['gemini-3.8-flash-medium'], undefined);
});

test('a signed-out CLI does not hide another CLI catalog', async () => {
  const outputs = {
    '/bin/codex': JSON.stringify({ models: [
      { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', description: 'Fast.', visibility: 'list' },
    ] }),
    '/bin/grok': '',   // this one fails
    '/bin/agy': 'gemini-4-neon-medium\tGemini 4 Neon (Medium)\n',
  };
  const exec = (file, args, options, callback) => {
    if (file === '/bin/grok') callback(Object.assign(new Error('exit 1'), { code: 1, stderr: 'not authenticated' }));
    else callback(null, outputs[file]);
  };
  const config = { adapters: {
    codex: { bin: '/bin/codex', env: {}, profiles: { models: {} } },
    grok: { bin: '/bin/grok', env: {}, profiles: { models: {} } },
    antigravity: { bin: '/bin/agy', env: {}, profiles: { models: {} } },
  } };
  const result = await refreshModelCatalog(config, exec);
  assert.deepEqual(result.codex.added, ['gpt-6.2-sol']);
  assert.match(result.grok.error, /not authenticated/);
  assert.deepEqual(result.antigravity.added, ['gemini-4-neon-medium']);
  assert.equal(config.adapters.grok.profiles.models['grok-4.7'], undefined);
});

test('a CLI without a catalog command is left alone', async () => {
  await assert.rejects(discoverModels('claude', { bin: '/bin/claude', env: {} }),
    /model_catalog:claude:unsupported/);
});

test('an empty catalog is not treated as "no models available"', () => {
  assert.throws(() => mergeModels({ models: { 'gpt-6.2-sol': { strengths: 'x', billing: 'unknown' } } }, 'codex',
    { models: [] }), /model_catalog:codex:empty/);
});