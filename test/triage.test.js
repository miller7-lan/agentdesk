const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTriageDecision, validateDecision } = require('../orchestrator/triage');

const fenced = (value) => 'Reasoning first.\n```json\n' + JSON.stringify(value) + '\n```';

test('a triage decision is normalised and its steps are bounded', () => {
  const decision = validateDecision({
    decision: 'rework',
    reason: '  tests fail  ',
    instructions: '  fix the parser  ',
    steps: [{ prompt: '  patch the parser  ' }, { capability: 'review', prompt: 'check it' }],
  });
  assert.equal(decision.reason, 'tests fail');
  assert.equal(decision.instructions, 'fix the parser');
  assert.deepEqual(decision.steps, [
    { capability: 'implement', prompt: 'patch the parser' },
    { capability: 'review', prompt: 'check it' },
  ]);
  assert.throws(() => validateDecision({ decision: 'sure' }), /invalid_decision:decision/);
  assert.throws(() => validateDecision({ decision: 'rework', steps: Array.from({ length: 5 }, () => ({ prompt: 'x' })) }),
    /invalid_decision:steps/);
  assert.throws(() => validateDecision({ decision: 'rework', steps: [{ capability: 'accept', prompt: 'x' }] }),
    /invalid_decision:step_0/);
  assert.throws(() => validateDecision({ decision: 'rework', steps: [{ prompt: 'x'.repeat(4001) }] }),
    /invalid_decision:step_0/);
});

test('the last fenced decision wins and a malformed or missing one is unknown', () => {
  assert.equal(parseTriageDecision(fenced({ decision: 'retry' })).decision, 'retry');
  const two = fenced({ decision: 'retry' }) + '\n' + fenced({ decision: 'fail', reason: 'wrong approach' });
  assert.equal(parseTriageDecision(two).decision, 'fail');
  assert.equal(parseTriageDecision('{"decision":"accept_with_risk"}').decision, 'accept_with_risk');
  assert.equal(parseTriageDecision('try again').decision, 'unknown');
  assert.equal(parseTriageDecision(fenced({ decision: 'rework', steps: [{ capability: 'claude', prompt: 'x' }] })).decision, 'unknown');
  assert.deepEqual(parseTriageDecision('try again').steps, []);
});