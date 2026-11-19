// Escalation decisions are structured data. A malformed or missing decision is `unknown` and must not
// be treated as permission to retry, rework or apply anything.

const DECISIONS = new Set(['retry', 'rework', 'accept_with_risk', 'fail']);
const REWORK_CAPABILITIES = new Set(['implement', 'review', 'scout', 'research']);
const MAX_STEPS = 4;

const TRIAGE_INSTRUCTION = 'You are the lead diagnosing a task that got stuck. Choose exactly one next action. ' +
  'End your reply with one fenced JSON object and nothing after it: ' +
  '{"decision":"retry|rework|accept_with_risk|fail","reason":"what went wrong",' +
  '"instructions":"what the next step must do","executor":"optional member for a retry","model":"optional model ID","effort":"optional",' +
  '"steps":[{"capability":"implement","prompt":"concrete work","executor":"optional member","model":"optional","effort":"optional"}]}. ' +
  'When the failure is cli_stalled (the CLI wrote nothing for a long time), prefer retry with another model of the same member (set model) over another member. ' +
  'When the reason is step_failed, a member\u2019s step failed (failures.steps lists who and which model already tried, and how many ' +
  'of the 3 reassignments that step has used): retry hands the same step to another member or another model ' +
  '(set executor and/or model from reassignOptions; a model alone keeps the member), rework replaces the step with new steps, ' +
  'and fail ends the task when no member or model can do it. Pick executors only from reassignOptions; never claude. ' +
  'Use retry only when the failure looks transient, rework when another edit can fix it (at most 4 steps), ' +
  'accept_with_risk when the result is usable despite the failure, and fail when the approach is wrong. ' +
  'Never ask Claude to implement: implementation steps must be implement/review/scout/research capability steps.';

// An optional model ID and effort level; the scheduler checks them against the member's configuration.
function choice(value) {
  const ok = (text) => typeof text === 'string' && /^[A-Za-z0-9._:\/-]{1,96}$/.test(text);
  return { ...(ok(value.model) && { model: value.model }), ...(ok(value.effort) && { effort: value.effort }) };
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Throws on a malformed decision. Untrusted model text goes through parseTriageDecision, which returns
// `unknown` rather than acting on a partially valid object.
function validateDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_decision');
  if (!DECISIONS.has(value.decision)) throw new Error('invalid_decision:decision');
  const steps = value.steps ?? [];
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) throw new Error('invalid_decision:steps');
  const normalized = steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step) ||
        typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 4000) {
      throw new Error('invalid_decision:step_' + index);
    }
    const capability = step.capability ?? 'implement';
    if (!REWORK_CAPABILITIES.has(capability)) throw new Error('invalid_decision:step_' + index);
    const executor = typeof step.executor === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(step.executor) ? step.executor : undefined;
    return { capability, prompt: step.prompt.trim(), ...(executor && { executor }), ...choice(step) };
  });
  return {
    decision: value.decision,
    reason: clip(value.reason, 2000),
    instructions: clip(value.instructions, 4000),
    ...(typeof value.executor === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value.executor) && { executor: value.executor }),
    ...choice(value),
    steps: normalized,
  };
}

// Preference matches review verdicts: the last fenced JSON object, then a bare JSON object. No decision
// is `unknown`; callers must not auto-retry on it.
function parseTriageDecision(output) {
  const text = String(output ?? '');
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse();
  for (const match of fenced) {
    try {
      const value = JSON.parse(match[1].trim());
      if (value && typeof value === 'object' && Object.hasOwn(value, 'decision')) return validateDecision(value);
    } catch {}
  }
  try {
    const value = JSON.parse(text.trim());
    if (value && typeof value === 'object' && Object.hasOwn(value, 'decision')) return validateDecision(value);
  } catch {}
  return { decision: 'unknown', reason: '', instructions: '', steps: [] };
}

module.exports = { DECISIONS, MAX_STEPS, REWORK_CAPABILITIES, TRIAGE_INSTRUCTION, validateDecision, parseTriageDecision };