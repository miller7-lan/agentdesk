// Capability routing: a plan says what kind of work a step needs; the router picks which CLI does it.
// Each capability has an ordered list of candidates. A candidate is skipped while it is not configured,
// or while it is blocked because its login expired or its quota ran out. Reordering a list is a config
// change, so the assignment can be tuned from measured results without touching the scheduler.

const ROLES = ['codex', 'claude', 'grok', 'gemini', 'antigravity'];

// Claude is the lead: it plans, triages escalated work and accepts results. It never implements,
// reviews, scouts or researches, so that its scarce quota is kept for judgement calls.
const LEAD_ROLE = 'claude';
const LEAD_CAPABILITIES = new Set(['plan', 'triage', 'accept']);

// write: whether a step of this capability may change files.
const CAPABILITIES = {
  plan: { write: false },
  triage: { write: false },     // diagnose an escalation and choose retry/rework/accept/fail
  scout: { write: false },      // read the code, logs or docs and report what matters
  implement: { write: true },   // change code
  review: { write: false },     // read a diff and report problems
  research: { write: false },   // look things up outside the repository
  accept: { write: false },     // judge the summarised results against the plan
};

// Antigravity (Google AI Ultra 20x, Gemini 4) has by far the most quota, so it takes implementation first;
// the lead names Codex for hard, cross-cutting or risky changes, and Codex and then Grok Build take over when
// Antigravity is out. It never falls back to Claude, whose quota is kept for leading; Gemini runs read-only in
// group work. When none of them can take it, the step waits. Review and scouting exclude Claude too, and a
// review goes to a different member than the one who wrote the change (see validateSteps in scheduler.js).
const DEFAULT_ROUTES = {
  plan: ['claude', 'codex'],
  triage: ['claude'],
  scout: ['antigravity', 'gemini', 'grok'],
  implement: ['antigravity', 'codex', 'grok'],
  review: ['antigravity', 'grok', 'gemini'],
  research: ['antigravity', 'grok', 'gemini'],   // Antigravity searches with Google and has the largest quota
  accept: ['claude'],
};

// Gemini runs under a deny-all-but-read policy, so it can never take a writing step.
const READ_ONLY_ROLES = new Set(['gemini']);

// Subscriptions are limited by quota (the share of the 5-hour and weekly windows already used), not by tokens.
// Above `soft` a CLI only takes the capabilities in `keepFor`; above `hard` it takes nothing.
// Claude and Codex are the scarce ones, so they step back early and keep their quota for their main jobs.
const DEFAULT_QUOTA_POLICY = {
  claude: { soft: 60, hard: 95, keepFor: ['plan', 'triage', 'accept'] },
  codex: { soft: 70, hard: 95, keepFor: ['implement'] },
  grok: { soft: 95, hard: 95, keepFor: [] },
  gemini: { soft: 95, hard: 95, keepFor: [] },
  antigravity: { soft: 95, hard: 95, keepFor: [] },
};

function validateQuotaPolicy(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('invalid_quota_policy');
  const policy = structuredClone(DEFAULT_QUOTA_POLICY);
  for (const [role, value] of Object.entries(overrides)) {
    const merged = { ...policy[role], ...value };
    if (!ROLES.includes(role) || !value || typeof value !== 'object' ||
        Object.keys(value).some((key) => !['soft', 'hard', 'keepFor'].includes(key)) ||
        ![merged.soft, merged.hard].every((n) => Number.isFinite(n) && n >= 0 && n <= 100) || merged.soft > merged.hard ||
        !Array.isArray(merged.keepFor) || merged.keepFor.some((name) => !Object.hasOwn(CAPABILITIES, name))) {
      throw new Error('invalid_quota_policy:' + role);
    }
    policy[role] = merged;
  }
  return policy;
}

// The fullest window decides: a CLI at 20% of its 5-hour window but 90% of its week is nearly out.
function usedPercent(entry) {
  const values = (entry?.buckets || []).flatMap(({ fiveHour, weekly }) => [fiveHour?.usedPercent, weekly?.usedPercent])
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function validateRoutes(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('invalid_routing');
  const routes = { ...DEFAULT_ROUTES };
  for (const [capability, list] of Object.entries(overrides)) {
    if (!Object.hasOwn(CAPABILITIES, capability) || !Array.isArray(list) || !list.length ||
        list.some((role) => !ROLES.includes(role)) || new Set(list).size !== list.length ||
        (CAPABILITIES[capability].write && list.some((role) => READ_ONLY_ROLES.has(role)))) {
      throw new Error('invalid_routing:' + capability);
    }
    routes[capability] = [...list];
  }
  // The lead rule is checked after merging overrides so no configuration can widen Claude's role.
  for (const [capability, list] of Object.entries(routes)) {
    if (list.includes(LEAD_ROLE) && !LEAD_CAPABILITIES.has(capability)) throw new Error('invalid_routing:' + capability + ':lead_reserved');
    if (['triage', 'accept'].includes(capability) && (list.length !== 1 || list[0] !== LEAD_ROLE)) {
      throw new Error('invalid_routing:' + capability + ':lead_required');
    }
    if (capability === 'plan' && list[0] !== LEAD_ROLE) throw new Error('invalid_routing:plan:lead_required');
  }
  return routes;
}

class Router {
  constructor(config, now = () => Date.now()) {
    this.config = config;
    this.now = now;
    if (config.writeProviders !== undefined && (!Array.isArray(config.writeProviders) ||
        config.writeProviders.some((role) => !ROLES.includes(role)))) throw new Error('invalid_write_providers');
    this.routes = validateRoutes(config.routing);
    this.quotaPolicy = validateQuotaPolicy(config.quotaPolicy);
    this.blocked = new Map();   // role -> { until, reason }
    this.quota = {};            // role -> percent used (fullest window); absent when the CLI reports no quota
  }

  // Takes the result of quotaStatus(): [{ provider, buckets: [{ fiveHour, weekly }] }].
  setQuota(status) {
    this.quota = Object.fromEntries((status || []).map((entry) => [entry.provider, usedPercent(entry)])
      .filter(([, used]) => used !== null));
  }

  // Unknown quota counts as available; an exhausted quota is still caught from the CLI's own error.
  quotaAllows(role, capability) {
    const used = this.quota[role];
    const { soft, hard, keepFor } = this.quotaPolicy[role];
    if (used === undefined || used < soft) return true;
    return used < hard && capability !== undefined && keepFor.includes(capability);
  }

  quotaAllowsDirect(role) {
    // Explicit user assignments may use quota reserved by automatic routing, but never exhausted quota.
    const used = this.quota[role];
    return used === undefined || used < this.quotaPolicy[role].hard;
  }

  // Why a configured role cannot take this capability right now, for the person-facing status line.
  unavailableReason(role, capability) {
    if (!this.configured(role)) return 'unconfigured';
    if (this.config.adapters[role].authRequired) return 'auth';
    const block = this.blocked.get(role);
    if (block && block.until > this.now()) return block.reason;
    if (!this.quotaAllows(role, capability)) return 'quota';
    return 'busy';
  }

  configured(role) {
    return Boolean(this.config.adapters?.[role]);
  }

  roles() {
    return ROLES.filter((role) => this.configured(role));
  }

  available(role) {
    if (!this.configured(role)) return false;
    if (this.config.adapters[role].authRequired) return false;
    const block = this.blocked.get(role);
    if (block && block.until > this.now()) return false;
    if (block) this.blocked.delete(role);
    return true;
  }

  availableRoles() {
    return this.roles().filter((role) => this.available(role));
  }

  // reason: 'quota' | 'auth'. Quota blocks lift on their own; login problems need a person, so they last longer.
  block(role, reason, ms = reason === 'auth' ? 6 * 3600_000 : 30 * 60_000) {
    this.blocked.set(role, { until: this.now() + ms, reason });
  }

  candidates(capability, exclude = []) {
    return (this.routes[capability] || []).filter((role) =>
      !exclude.includes(role) && this.available(role) && this.quotaAllows(role, capability));
  }

  pick(capability, exclude = []) {
    return this.candidates(capability, exclude)[0] || null;
  }

  canWrite(role) {
    return this.config.writeProviders?.includes(role) || !READ_ONLY_ROLES.has(role);
  }

  status() {
    const now = this.now();
    return {
      routes: this.routes,
      lead: LEAD_ROLE,
      leadCapabilities: [...LEAD_CAPABILITIES],
      quotaUsed: this.quota,
      quotaPolicy: this.quotaPolicy,
      blocked: Object.fromEntries([...this.blocked].filter(([, block]) => block.until > now)
        .map(([role, block]) => [role, { reason: block.reason, until: new Date(block.until).toISOString() }])),
    };
  }
}

module.exports = {
  ROLES, CAPABILITIES, DEFAULT_ROUTES, DEFAULT_QUOTA_POLICY, LEAD_ROLE, LEAD_CAPABILITIES,
  Router, validateRoutes, validateQuotaPolicy, usedPercent,
};
