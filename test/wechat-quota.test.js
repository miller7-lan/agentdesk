const test = require('node:test');
const assert = require('node:assert/strict');
const { QuotaGate, remainingOf, describeBlocked } = require('../orchestrator/wechat/quota');

const entry = (provider, buckets, state = 'available') => ({ provider, state, buckets });

test('remainingOf prefers the five-hour window, falls back to weekly, picks the Gemini Models bucket', () => {
  assert.deepEqual(remainingOf(entry('codex', [{ fiveHour: { usedPercent: 93.5, resetsAt: 1 }, weekly: { usedPercent: 10 } }])), { remaining: 6.5, resetsAt: 1, window: 'fiveHour' });
  assert.equal(remainingOf(entry('grok', [{ weekly: { usedPercent: 92 } }])).window, 'weekly');
  assert.equal(remainingOf(entry('antigravity', [{ label: 'Gemini 4 Argon', fiveHour: { usedPercent: 0 } }, { label: 'Gemini Models', fiveHour: { usedPercent: 50 } }])).remaining, 50);
  assert.equal(remainingOf(entry('claude', [], 'unavailable')), null);
});

test('rank orders candidates by remaining quota and drops those under 8%; unknown counts as usable', async () => {
  const quotaStatus = async () => [
    entry('antigravity', [{ label: 'Gemini Models', fiveHour: { usedPercent: 70 } }]),
    entry('grok', [{ weekly: { usedPercent: 20 } }]),
    entry('codex', [{ fiveHour: { usedPercent: 95 } }]),
  ];
  const gate = new QuotaGate({ adapters: {}, quotaStatus });
  const low = await gate.rank([{ provider: 'antigravity' }, { provider: 'grok' }]);
  assert.deepEqual(low.map((c) => c.provider), ['grok', 'antigravity']);
  await assert.rejects(gate.rank([{ provider: 'codex' }]), (error) => error.code === 'quota_low' && error.blocked[0].remaining === 5);
  await gate.require(['claude']);                       // 读不到 → 不拦
  await assert.rejects(gate.require(['codex']), /quota_low/);
});

test('a failing quota read never blocks work', async () => {
  const gate = new QuotaGate({ adapters: {}, quotaStatus: async () => { throw new Error('boom'); } });
  await gate.require(['claude']);
  assert.equal((await gate.rank([{ provider: 'grok' }])).length, 1);
});

test('describeBlocked is readable', () => {
  assert.match(describeBlocked([{ provider: 'claude', remaining: 3, resetsAt: 1795460549, window: 'fiveHour' }]), /Claude 5 小时额度只剩 3%，约 .+ 恢复/);
});
