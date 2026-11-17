// Review and acceptance outputs are data, not prose. The reviewer must end with a JSON object so the
// scheduler can gate apply and escalate a disagreement without asking a person to read the transcript.

const REVIEW_VERDICTS = new Set(['pass', 'rework', 'blocked']);
const ACCEPTANCE_VERDICTS = new Set(['accept', 'rework', 'reject']);
const VERDICTS = new Set([...REVIEW_VERDICTS, ...ACCEPTANCE_VERDICTS]);
const POSITIVE = new Set(['pass', 'accept']);
const NEGATIVE = new Set(['rework', 'blocked', 'reject']);
const SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit']);
const MAX_FINDINGS = 50;

const REVIEW_INSTRUCTION = 'End your reply with one fenced JSON object and nothing after it: ' +
  '{"verdict":"pass|rework|blocked","summary":"one short paragraph","findings":[{"severity":"blocker|major|minor|nit",' +
  '"file":"path","line":1,"issue":"what is wrong","suggestion":"how to fix it"}],"tests":"what you ran or observed"}. ' +
  'Use rework when the change needs another edit and blocked when it cannot be judged. At most 50 findings.';

const ACCEPTANCE_INSTRUCTION = 'Judge the brief against the request, not against unstated preferences. ' +
  'End your reply with one fenced JSON object and nothing after it: ' +
  '{"verdict":"accept|rework|reject","summary":"one short paragraph","findings":[{"severity":"blocker|major|minor|nit",' +
  '"file":"path","line":1,"issue":"what is wrong","suggestion":"how to fix it"}],"tests":"what you ran or observed"}. ' +
  'Use rework when more work would fix it and reject when the approach is wrong. At most 50 findings.';

function normalizeFinding(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !SEVERITIES.has(value.severity) || typeof value.issue !== 'string' || !value.issue.trim()) {
    throw new Error('invalid_verdict:finding_' + index);
  }
  return {
    severity: value.severity,
    ...(typeof value.file === 'string' && value.file.trim() && { file: value.file.trim().slice(0, 300) }),
    ...(Number.isSafeInteger(value.line) && value.line > 0 && { line: value.line }),
    issue: value.issue.trim().slice(0, 1000),
    ...(typeof value.suggestion === 'string' && value.suggestion.trim() && { suggestion: value.suggestion.trim().slice(0, 1000) }),
  };
}

// Throws on a malformed verdict. Untrusted model text goes through parseReviewVerdict, which turns a
// malformed object into `unknown` instead of trusting it.
function validateVerdict(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_verdict');
  if (!VERDICTS.has(value.verdict)) throw new Error('invalid_verdict:verdict');
  if (kind === 'review' && !REVIEW_VERDICTS.has(value.verdict)) throw new Error('invalid_verdict:verdict');
  if (kind === 'accept' && !ACCEPTANCE_VERDICTS.has(value.verdict)) throw new Error('invalid_verdict:verdict');
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  const findings = value.findings ?? [];
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) throw new Error('invalid_verdict:findings');
  return {
    verdict: value.verdict,
    summary: summary.slice(0, 2000),
    findings: findings.map(normalizeFinding),
    ...(value.tests !== undefined && {
      tests: typeof value.tests === 'string' ? value.tests.trim().slice(0, 1000) : null,
    }),
  };
}

// Preference: the last fenced JSON object, then a VERDICT: line, then a bare JSON object. A reply with
// no usable verdict is `unknown`; callers must not treat that as a pass.
function parseReviewVerdict(output) {
  const text = String(output ?? '');
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse();
  for (const match of fenced) {
    try {
      const value = JSON.parse(match[1].trim());
      if (value && typeof value === 'object' && Object.hasOwn(value, 'verdict')) return validateVerdict(value);
    } catch {}
  }
  const lines = [...text.matchAll(/\bVERDICT:\s*(pass|rework|blocked|accept|reject)\b/gi)];
  if (lines.length) return { verdict: lines.at(-1)[1].toLowerCase(), summary: '', findings: [] };
  try {
    const value = JSON.parse(text.trim());
    if (value && typeof value === 'object' && Object.hasOwn(value, 'verdict')) return validateVerdict(value);
  } catch {}
  return { verdict: 'unknown', summary: '', findings: [] };
}

// One reviewer passing while another asks for rework (or says it is blocked) is a disagreement; two
// negative reviews agree that more work is needed and their findings are simply merged.
function reviewConflicts(verdicts) {
  const values = (verdicts || []).map((item) => typeof item === 'string' ? item : item?.verdict);
  return values.some((value) => POSITIVE.has(value)) && values.some((value) => NEGATIVE.has(value));
}

function mergeFindings(verdicts) {
  const rank = { blocker: 0, major: 1, minor: 2, nit: 3 };
  const merged = new Map();
  for (const verdict of verdicts || []) {
    for (const finding of verdict?.findings || []) {
      const key = [finding.file || '', finding.line || '', finding.issue.toLowerCase()].join('|');
      if (!merged.has(key)) merged.set(key, { ...finding });
    }
  }
  return [...merged.values()].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

function verdictDigest(verdict) {
  return {
    verdict: verdict?.verdict || 'unknown',
    summary: String(verdict?.summary || '').slice(0, 600),
    findings: (verdict?.findings || []).length,
    ...(verdict?.tests && { tests: String(verdict.tests).slice(0, 300) }),
  };
}

module.exports = {
  REVIEW_VERDICTS, ACCEPTANCE_VERDICTS, VERDICTS, SEVERITIES, MAX_FINDINGS,
  REVIEW_INSTRUCTION, ACCEPTANCE_INSTRUCTION,
  validateVerdict, parseReviewVerdict, reviewConflicts, mergeFindings, verdictDigest,
};