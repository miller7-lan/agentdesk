(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskApprovals = factory();
})(globalThis, function () {
  'use strict';

  const key = 'agentdesk.group.approvals';
  const commands = new Set(['item/commandExecution/requestApproval', 'execCommandApproval']);
  const patches = new Set(['item/fileChange/requestApproval', 'applyPatchApproval']);
  const question = 'item/tool/requestUserInput';
  const elicitation = 'mcpServer/elicitation/request';
  const permitted = (method) => commands.has(method) || patches.has(method) || method === question || method === elicitation;

  function valid(scope) {
    return scope && ['threadId', 'tool', 'cwd'].every((field) =>
      typeof scope[field] === 'string' && scope[field].trim().length > 0 && scope[field].length <= 4096);
  }

  function identity({ method, params = {} }) {
    if (!permitted(method) || method === question) return null;
    const tool = method === elicitation
      ? params.serverName && params._meta?.tool_name && method + '/' + JSON.stringify([params.serverName, params._meta.tool_name])
      : params.tool ? method + '/' + params.tool : method;
    const scope = { threadId: params.threadId, tool, cwd: params.cwd };
    return valid(scope) ? scope : null;
  }

  function matches(rule, scope) {
    return Boolean(valid(rule) && valid(scope) &&
      rule.threadId === scope.threadId && rule.tool === scope.tool && rule.cwd === scope.cwd);
  }

  function load(storage, group) {
    try {
      const values = JSON.parse(storage.getItem(key + '.' + group));
      return Array.isArray(values) ? values.filter(valid).slice(-100) : [];
    } catch { return []; }
  }

  function remember(storage, group, scope) {
    if (!valid(scope)) return false;
    const rules = load(storage, group);
    if (!rules.some((rule) => matches(rule, scope))) rules.push({
      threadId: scope.threadId, tool: scope.tool, cwd: scope.cwd,
    });
    try {
      storage.setItem(key + '.' + group, JSON.stringify(rules.slice(-100)));
      return true;
    } catch { return false; }
  }

  function clear(storage, group) {
    try { storage.removeItem(key + '.' + group); } catch {}
  }

  function decision(method, accept, answers = {}) {
    if (method === question) return { answers: accept ? answers : {} };
    if (method === elicitation) return { action: accept ? 'accept' : 'decline', content: accept ? {} : null };
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: accept ? 'approved' : 'denied' };
    }
    return { decision: accept ? 'accept' : 'decline' };
  }

  return { permitted, question, identity, matches, load, remember, clear, decision };
});
