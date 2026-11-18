const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readGrokQuotas, antigravityBuckets } = require('../orchestrator/quotas');
const { resetDelay } = require('../orchestrator/adapters');

test('Grok credits come from the billing endpoint with the CLI sign-in, which is only read', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-grok-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await assert.rejects(readGrokQuotas({ env: { HOME: home } }, async () => assert.fail('no request without a sign-in')), /grok_signed_out/);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const key = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.sig';
  await fs.mkdir(path.join(home, '.grok'));
  const auth = JSON.stringify({ 'https://auth.x.ai::u1': { key, refresh_token: 'never-sent', email: 'dev@example.invalid' } });
  await fs.writeFile(path.join(home, '.grok', 'auth.json'), auth);
  const requests = [];
  const end = new Date(Date.now() + 3 * 86400_000).toISOString();
  const fetchFake = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ config: { creditUsagePercent: 37.5,
      currentPeriod: { type: 'WEEKLY', start: new Date(Date.now() - 4 * 86400_000).toISOString(), end } } }) };
  };
  const buckets = await readGrokQuotas({ env: { HOME: home } }, fetchFake);
  assert.deepEqual(buckets, [{ id: 'grok-credits', weekly: { usedPercent: 37.5, resetsAt: Math.ceil(Date.parse(end) / 1000) } }]);
  assert.equal(requests[0].url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + key);
  assert.ok(!JSON.stringify(requests).includes('never-sent'));                 // the refresh token never leaves the file
  assert.equal(await fs.readFile(path.join(home, '.grok', 'auth.json'), 'utf8'), auth);   // nothing is written
});

test('Antigravity usage: the Gemini group decides, windows come from the fraction left', () => {
  const reset = new Date(Date.now() + 86400_000).toISOString();
  const usage = { status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: reset },
      { id: 'gemini-5h', window: '5h', remaining_fraction: 1.0 }] },
    { name: 'Claude and GPT models', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0 }] }] } } };
  assert.deepEqual(antigravityBuckets(usage), [{ id: 'antigravity-gemini', label: 'Gemini Models',
    fiveHour: { usedPercent: 0, resetsAt: null }, weekly: { usedPercent: 25, resetsAt: Math.ceil(Date.parse(reset) / 1000) } }]);
  assert.throws(() => antigravityBuckets({ status: 'ERROR', error: 'Not eligible in this region.' }), /antigravity_usage_refused/);
  assert.throws(() => antigravityBuckets({ status: 'SUCCESS', command: { name: 'credits' } }), /antigravity_usage_format/);
});

test('an exhausted quota keeps the CLI out until the reset it states, plus a minute', () => {
  assert.equal(resetDelay('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h54m26s.'), (4 * 3600 + 54 * 60 + 26) * 1000 + 60_000);
  assert.equal(resetDelay('Rate limit reached, try again in 2h 3m'), (2 * 3600 + 3 * 60) * 1000 + 60_000);
  assert.equal(resetDelay('You have exhausted your quota on this model.'), null);
});
