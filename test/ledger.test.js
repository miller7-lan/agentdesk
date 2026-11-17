const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateOwnerCaps, capFor, usageForOwner, allow, nextReset, dayBounds, ownerUsageReport,
} = require('../orchestrator/ledger');

function task({ id = 't', owner = 'alice', at = new Date(2026, 10, 17, 10, 0), quota } = {}) {
  const value = { id, owner, state: 'completed', quota };
  if (at) value.metrics = { startedAt: at.toISOString() };
  return value;
}

test('owner caps are validated and fall back to default per role', () => {
  const caps = validateOwnerCaps({ default: { claude: 20, codex: 30 }, alice: { claude: 5 } });
  assert.equal(capFor(caps, 'alice', 'claude'), 5);
  assert.equal(capFor(caps, 'alice', 'codex'), 30);
  assert.equal(capFor(caps, 'bob', 'claude'), 20);
  assert.equal(capFor(caps, 'bob', 'grok'), undefined);
  assert.throws(() => validateOwnerCaps(null), /invalid_owner_caps/);
  assert.throws(() => validateOwnerCaps({ 'bad owner': {} }), /invalid_owner_caps/);
  assert.throws(() => validateOwnerCaps({ alice: { claude: 101 } }), /invalid_owner_caps/);
  assert.throws(() => validateOwnerCaps({ alice: { claude: -1 } }), /invalid_owner_caps/);
  assert.throws(() => validateOwnerCaps({ alice: { unknown: 1 } }), /invalid_owner_caps/);
  assert.throws(() => validateOwnerCaps({ alice: [] }), /invalid_owner_caps/);
});

test('usage counts only the owner and the local day, preferring the five-hour window', () => {
  const at = new Date(2026, 10, 17, 23, 30);
  const tasks = [
    task({ id: 'one', quota: { claude: { fiveHour: 11, weekly: 2 }, codex: { weekly: 4 } } }),
    task({ id: 'two', quota: { claude: { fiveHour: 6.5 } } }),
    task({ id: 'other-owner', owner: 'bob', quota: { claude: { fiveHour: 50 } } }),
    task({ id: 'yesterday', at: new Date(2026, 10, 16, 23, 59), quota: { claude: { fiveHour: 50 } } }),
    task({ id: 'no-start', at: null, quota: { claude: { fiveHour: 50 } } }),
  ];
  delete tasks[4].metrics;
  assert.deepEqual(usageForOwner(tasks, 'alice', { at }), { claude: 17.5, codex: 4 });
  assert.deepEqual(usageForOwner(tasks, 'bob', { at }), { claude: 50 });
  assert.deepEqual(usageForOwner(tasks, 'carol', { at }), {});
});

test('a cap allows use below it and blocks use at it, with no cap meaning unlimited', () => {
  const at = new Date(2026, 10, 17, 12, 0);
  const tasks = [task({ quota: { claude: { fiveHour: 10 } } })];
  const caps = { default: { claude: 20 }, alice: { claude: 10 } };
  const blocked = allow(tasks, 'alice', 'claude', caps, at);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.used, 10);
  assert.equal(blocked.cap, 10);
  assert.equal(blocked.resetAt.getTime(), nextReset(at).getTime());
  assert.equal(allow(tasks, 'bob', 'claude', caps, at).allowed, true);       // 10 < default 20
  assert.equal(allow([], 'alice', 'claude', caps, at).allowed, true);
  const unlimited = allow(tasks, 'alice', 'grok', caps, at);
  assert.equal(unlimited.allowed, true);
  assert.equal(unlimited.cap, null);
});

test('the reset is the next local midnight, also when the day changes month or year', () => {
  const { start, end } = dayBounds(new Date(2026, 11, 31, 18, 0));
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getDate(), 31);
  assert.equal(end.getFullYear(), 2027);
  assert.equal(end.getMonth(), 0);
  assert.equal(end.getDate(), 1);
  assert.equal(end.getHours(), 0);
  assert.equal(nextReset(new Date(2026, 10, 17, 0, 0)).getDate(), 18);
});

test('the owner usage report shows today\'s use and configured caps for everyone', () => {
  const at = new Date(2026, 10, 17, 9, 0);
  const report = ownerUsageReport([
    task({ owner: 'alice', quota: { claude: { fiveHour: 7 } } }),
  ], { default: { claude: 20, codex: 30 }, bob: { claude: 5 } }, at);
  assert.deepEqual(report.alice.usage, { claude: 7 });
  assert.deepEqual(report.alice.caps, { claude: 20, codex: 30 });
  assert.deepEqual(report.bob.usage, {});
  assert.deepEqual(report.bob.caps, { claude: 5, codex: 30 });
  assert.equal(report.alice.resetAt.getTime(), nextReset(at).getTime());
});