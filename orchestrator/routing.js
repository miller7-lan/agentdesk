// Capability routing: a plan says what kind of work a step needs; the router picks which CLI does it.
// Each capability has an ordered list of candidates. A candidate is skipped while it is not configured,
// or while it is blocked because its login expired or its quota ran out. Reordering a list is a config
// change, so the assignment can be tuned from measured results without touching the scheduler.

const ROLES = ['codex', 'claude', 'grok', 'gemini', 'antigravity'];

// write: whether a step of this capability may change files.
const CAPABILITIES = {
  plan: { write: false },
  scout: { write: false },      // read the code, logs or docs and report what matters
  implement: { write: true },   // change code
  review: { write: false },     // read a diff and report problems
  research: { write: false },   // look things up outside the repository
  accept: { write: false },     // judge the summarised results against the plan
};

const DEFAULT_ROUTES = {
  plan: ['claude', 'codex'],
  scout: ['antigravity', 'gemini', 'grok', 'claude'],
  implement: ['codex', 'claude'],
  review: ['grok', 'antigravity', 'gemini', 'claude'],
  research: ['grok', 'antigravity', 'gemini'],
  accept: ['claude', 'codex'],
};

// Gemini runs under a deny-all-but-read policy, so it can never take a writing step.
const READ_ONLY_ROLES = new Set(['gemini']);

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
  return routes;
}

class Router {
  constructor(config, now = () => Date.now()) {
    this.config = config;
    this.now = now;
    this.routes = validateRoutes(config.routing);
    this.blocked = new Map();   // role -> { until, reason }
  }

  configured(role) {
    return Boolean(this.config.adapters?.[role]);
  }

  roles() {
    return ROLES.filter((role) => this.configured(role));
  }

  available(role) {
    if (!this.configured(role)) return false;
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

  pick(capability, exclude = []) {
    return (this.routes[capability] || []).find((role) => !exclude.includes(role) && this.available(role)) || null;
  }

  canWrite(role) {
    return !READ_ONLY_ROLES.has(role);
  }

  status() {
    const now = this.now();
    return {
      routes: this.routes,
      blocked: Object.fromEntries([...this.blocked].filter(([, block]) => block.until > now)
        .map(([role, block]) => [role, { reason: block.reason, until: new Date(block.until).toISOString() }])),
    };
  }
}

module.exports = { ROLES, CAPABILITIES, DEFAULT_ROUTES, Router, validateRoutes };
