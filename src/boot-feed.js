(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskBootFeed = factory();
})(globalThis, function () {
  'use strict';

  const members = [
    ['lead', 'Claude · 组长', '', 'claude'],
    ['codex', 'Codex', '改代码', 'codex'],
    ['antigravity', 'Antigravity', '侦察', 'antigravity'],
    ['grok', 'Grok Build', '审查', 'grok'],
    ['gemini', 'Gemini', '分析', 'gemini'],
    ['local', '本机 Bridge', '桌面与文件', null],
  ];

  function buildBootData(checks = {}) {
    const remote = checks.remote?.value;
    const routes = checks.routes?.value;
    const quotas = Array.isArray(checks.quota?.value) ? checks.quota.value : [];
    const docker = checks.resources?.value?.docker;
    const online = remote?.codex === 'ready' || Boolean(routes?.ssh || routes?.relay);
    const offline = Boolean(checks.remote && checks.routes && !online);
    const nodes = members.map(([id, name, role, provider], order) => {
      const quota = quotas.find((item) => item.provider === provider);
      const check = id === 'local' ? checks.desktop
        : id === 'codex' && remote?.codex === 'ready' ? checks.remote : checks.quota;
      let status = 'WAITING';
      if (check) {
        if (id === 'local') status = check.value === true ? 'AUTHORIZED' : 'DESKTOP OFF';
        else if (quota?.disabled?.reason === 'auth_expired' || quota?.exclusion === 'auth_expired') status = 'LOGIN REQUIRED';
        else if (quota?.state === 'not_configured') status = 'NOT CONFIGURED';
        else if (quota?.used >= 100) status = 'QUOTA 0%';
        else if ((id === 'codex' && remote?.codex === 'ready') || quota || routes?.providers?.includes(provider)) status = 'READY';
        else status = online ? 'NOT CONFIGURED' : 'OFFLINE';
      }
      return { id, name, role, status, kind: ['READY', 'AUTHORIZED'].includes(status) ? 'ok' : 'warn', at: check?.at ?? Infinity, order };
    }).sort((a, b) => a.at - b.at || a.order - b.order);
    let previous = 0.9;
    for (const node of nodes) {
      if (!Number.isFinite(node.at)) continue;
      node.at = Math.max(previous + 0.45, node.at);
      previous = node.at;
    }
    // 日志只由固定标签和状态组成，不输出 IPC 错误或原始响应。
    const logs = [];
    if (checks.remote) logs.push({ name: 'link vps2 · ssh', status: remote?.codex === 'ready' ? 'OK' : 'OFFLINE', at: checks.remote.at });
    if (checks.routes) logs.push({ name: 'orchestrator', status: routes?.ssh ? 'ONLINE' : routes?.relay ? 'RELAY' : 'OFFLINE', at: checks.routes.at });
    if (docker?.ok && Number.isSafeInteger(docker.count)) logs.push({ name: 'docker · containers', status: String(docker.count), at: checks.resources.at });
    for (const node of nodes) if (Number.isFinite(node.at)) logs.push(node);
    logs.sort((a, b) => a.at - b.at);
    return { nodes, logs, online, offline };
  }

  function collect(desk, publish, { timeout = 5000, now = () => performance.now() } = {}) {
    const start = now();
    const checks = {};
    const control = async (operation) => {
      const result = await desk.orchestrator.control({ operation });
      if (!result?.ok) throw new Error('unavailable');
      return result.value;
    };
    const requests = {
      remote: () => desk.remote.status(),
      routes: () => control('routes'),
      quota: () => control('quota_status'),
      resources: () => control('resource_status'),
      desktop: () => desk.desktop.enabled(),
    };
    let active = true;
    const cancel = () => {
      active = false;
      clearTimeout(timer);
    };
    const timer = setTimeout(cancel, timeout);
    const update = (key, value) => {
      if (!active) return;
      checks[key] = { value, at: (now() - start) / 1000 };
      publish(buildBootData(checks));
      if (Object.keys(checks).length === Object.keys(requests).length) cancel();
    };
    for (const [key, request] of Object.entries(requests)) {
      Promise.resolve().then(request).then((value) => update(key, value), () => update(key, null));
    }
    return cancel;
  }

  return { buildBootData, collect };
});
