const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateVerdict, parseReviewVerdict, reviewConflicts, mergeFindings, verdictDigest,
} = require('../orchestrator/review');

const finding = (issue, severity = 'major', file = 'src/a.js', line = 4) => ({ severity, file, line, issue });

test('a valid verdict is normalised and findings are bounded', () => {
  const verdict = validateVerdict({
    verdict: 'rework', summary: '  Missing the empty state  ',
    findings: [{ severity: 'blocker', file: 'src/a.js', line: 4, issue: 'Crashes when empty', suggestion: 'Guard the list' }],
    tests: 'node --test',
  });
  assert.deepEqual(verdict, {
    verdict: 'rework', summary: 'Missing the empty state',
    findings: [{ severity: 'blocker', file: 'src/a.js', line: 4, issue: 'Crashes when empty', suggestion: 'Guard the list' }],
    tests: 'node --test',
  });
  assert.throws(() => validateVerdict({ verdict: 'maybe', findings: [] }), /invalid_verdict/);
  assert.throws(() => validateVerdict({ verdict: 'pass', findings: [{ severity: 'urgent', issue: 'x' }] }), /invalid_verdict:finding_0/);
  assert.throws(() => validateVerdict({ verdict: 'pass', findings: [{ severity: 'major' }] }), /invalid_verdict:finding_0/);
  assert.throws(() => validateVerdict({ verdict: 'pass', findings: Array.from({ length: 51 }, () => finding('x')) }), /invalid_verdict:findings/);
});

test('the last fenced verdict wins; VERDICT: is the fallback; a reply without one is unknown', () => {
  const text = [
    'First pass:',
    '```json',
    JSON.stringify({ verdict: 'rework', summary: 'first', findings: [finding('fix it')] }),
    '```',
    'After looking again:',
    '```json',
    JSON.stringify({ verdict: 'pass', summary: 'second', findings: [] }),
    '```',
  ].join('\n');
  assert.equal(parseReviewVerdict(text).verdict, 'pass');
  assert.equal(parseReviewVerdict(text).summary, 'second');
  assert.equal(parseReviewVerdict('Looks fine.\nVERDICT: blocked').verdict, 'blocked');
  assert.equal(parseReviewVerdict(JSON.stringify({ verdict: 'accept', findings: [] })).verdict, 'accept');
  assert.equal(parseReviewVerdict('Looks fine to me.').verdict, 'unknown');
  assert.equal(parseReviewVerdict('```json\n{"verdict":"pass","findings":[{"severity":"urgent"}]}\n```').verdict, 'unknown');
});

test('one pass and one request for rework conflict; two negative reviews do not', () => {
  assert.equal(reviewConflicts([{ verdict: 'pass' }, { verdict: 'rework' }]), true);
  assert.equal(reviewConflicts([{ verdict: 'accept' }, { verdict: 'blocked' }]), true);
  assert.equal(reviewConflicts([{ verdict: 'rework' }, { verdict: 'blocked' }]), false);
  assert.equal(reviewConflicts([{ verdict: 'pass' }, { verdict: 'pass' }]), false);
  assert.equal(reviewConflicts([]), false);
});

test('findings merge without duplicates and blockers come first', () => {
  const merged = mergeFindings([
    { findings: [finding('Same bug', 'minor'), finding('Style', 'nit')] },
    { findings: [finding('Same bug', 'minor'), finding('Crash', 'blocker')] },
  ]);
  assert.deepEqual(merged.map((item) => item.issue), ['Crash', 'Same bug', 'Style']);
  assert.equal(merged.length, 3);
});

test('verdictDigest is short enough for an event or task card', () => {
  const digest = verdictDigest({ verdict: 'blocked', summary: 's'.repeat(2000), findings: [finding('x')], tests: 't'.repeat(2000) });
  assert.equal(digest.verdict, 'blocked');
  assert.ok(digest.summary.length <= 600);
  assert.equal(digest.findings, 1);
  assert.ok(digest.tests.length <= 300);
  assert.equal(verdictDigest(null).verdict, 'unknown');
});