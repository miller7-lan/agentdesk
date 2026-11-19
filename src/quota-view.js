// "额度与分工": opened from the quota items in the status bar.
// It shows every member's subscription quota as a double ring (outer: 5-hour window, inner: weekly), the rule
// that quota triggers (above the soft line a member only takes its main jobs, above the hard line nothing), and
// the live hand-out order for each kind of work: who takes it now, and why each member before them is skipped.
(() => {
  const A = window.__desk;
  if (!A) return;
  const { $, esc } = A;
  const avatars = window.AgentDeskAvatars;
  const api = window.desk?.orchestrator;
  const ROLES = ['claude', 'codex', 'grok', 'antigravity', 'gemini'];
  const names = { claude: 'Claude', codex: 'Codex', grok: 'Grok Build', antigravity: 'Antigravity', gemini: 'Gemini' };
  const capabilities = [['plan', '规划'], ['triage', '诊断'], ['scout', '侦察'], ['implement', '改代码'], ['review', '审查'], ['research', '查资料'], ['accept', '验收']];
  const capName = Object.fromEntries(capabilities);
  // The person's own order for each kind of work (kept on this computer and sent with every group task). An entry
  // is a member ("codex") or a member on one of its models ("codex@gpt-5.5"); with「+ 补充」the person adds more
  // members and models to fill the fallback chain. Member work never goes to Claude; the lead's work (规划、诊断、
  // 验收) takes only Claude models, so the lead stays Claude.
  const ORDERABLE = ['scout', 'implement', 'review', 'research'];
  const LEAD = ['plan', 'triage', 'accept'];
  const WRITES = new Set(['implement']);
  const store = A.store;
  const savedOrder = () => store.get('routeOrder', {});
  const parse = (entry) => { const [role, model] = String(entry).split('@'); return { entry, role, model }; };
  const modelLabel = (role, model) => model ? (data?.models?.[role]?.models?.[model]?.label || window.AgentDeskLanes?.modelShort?.(model) || model) : '';
  // The chain shown for a kind of work: the person's entries first, then the configured members not named yet.
  function chainFor(capability) {
    const base = data.team.routes[capability] || [];
    const saved = (savedOrder()[capability] || []).map(parse);
    if (LEAD.includes(capability)) {
      const lead = saved.filter((item) => item.role === 'claude');
      return [...(lead.length ? lead : [parse('claude')]), ...base.filter((role) => role !== 'claude').map(parse)]
        .map((item) => ({ ...item, added: Boolean(item.model), movable: item.role === 'claude' && lead.length > 1 }));
    }
    const named = new Set(saved.map((item) => item.role));
    return [...saved, ...base.filter((role) => !named.has(role)).map(parse)]
      .map((item) => ({ ...item, added: Boolean(item.model) || !base.includes(item.role), movable: true }));
  }
  function save(capability, chain) {
    const entries = LEAD.includes(capability) ? chain.filter((item) => item.role === 'claude' && item.model).map((item) => item.entry)
      : chain.map((item) => item.entry);
    const order = { ...savedOrder() };
    if (entries.length) order[capability] = entries; else delete order[capability];
    store.set('routeOrder', order);
    render();
  }
  function move(capability, entry, step) {
    const chain = chainFor(capability);
    const from = chain.findIndex((item) => item.entry === entry);
    const to = from + step;
    if (from < 0 || to < 0 || to >= chain.length || !chain[to].movable) return;
    [chain[from], chain[to]] = [chain[to], chain[from]];
    save(capability, chain);
  }
  function remove(capability, entry) {
    save(capability, chainFor(capability).filter((item) => item.entry !== entry));
  }
  function add(capability, entry) {
    const chain = chainFor(capability);
    if (!entry || chain.some((item) => item.entry === entry)) return;
    save(capability, [...chain, parse(entry)]);
  }
  // What can still be added to a kind of work: every configured member that may do it, on its latest model or
  // on one of its models (newest first).
  function addable(capability) {
    const present = new Set(chainFor(capability).map((item) => item.entry));
    const roles = LEAD.includes(capability) ? ['claude']
      : data.team.configured.filter((role) => role !== 'claude' && (!WRITES.has(capability) || (data.writeProviders || []).includes(role)));
    const version = (id) => (/(\d+(?:[.-]\d+)*)/.exec(id)?.[1] || '').split(/[.-]/).map(Number).filter((n) => n <= 999);
    const newest = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i += 1) { const d = (y[i] ?? -1) - (x[i] ?? -1); if (d) return d; } return 0; };
    return roles.flatMap((role) => {
      const models = Object.keys(data.models?.[role]?.models || {}).sort(newest);
      return [...(LEAD.includes(capability) ? [] : [[role, `${names[role]} · 最新模型`]]),
        ...models.map((model) => [role + '@' + model, `${names[role]} · ${modelLabel(role, model)}`])];
    }).filter(([entry]) => !present.has(entry));
  }
  function reset(capability) {
    const order = savedOrder();
    delete order[capability];
    store.set('routeOrder', order);
    render();
  }
  const levels = {
    ok: ['正常', 'ok'], reserved: ['只接主业', 'reserved'], stopped: ['已停', 'stopped'],
    auth: ['需登录', 'auth'], cooling: ['冷却中', 'stopped'], absent: ['未配置', 'auth'], unknown: ['未读到', 'auth'],
  };

  // Shown when no orchestrator answers, so the layout can be checked offline (example projects, screenshots).
  const sample = {
    quotas: [
      { provider: 'claude', used: 64, level: 'reserved', policy: { soft: 60, hard: 95, keepFor: ['plan', 'triage', 'accept'] },
        buckets: [{ fiveHour: { usedPercent: 38, resetsAt: now(1.7) }, weekly: { usedPercent: 64, resetsAt: now(70) } }] },
      { provider: 'codex', used: 41, level: 'ok', policy: { soft: 70, hard: 95, keepFor: ['implement'] },
        buckets: [{ fiveHour: { usedPercent: 41, resetsAt: now(2.2) }, weekly: { usedPercent: 22, resetsAt: now(110) } }] },
      { provider: 'grok', used: 97, level: 'stopped', policy: { soft: 95, hard: 95, keepFor: [] },
        buckets: [{ fiveHour: { usedPercent: 97, resetsAt: now(0.6) }, weekly: { usedPercent: 51, resetsAt: now(80) } }] },
      { provider: 'antigravity', used: 12, level: 'ok', policy: { soft: 95, hard: 95, keepFor: [] },
        buckets: [{ fiveHour: { usedPercent: 12, resetsAt: now(4) }, weekly: { usedPercent: 9, resetsAt: now(130) } }] },
    ],
    team: {
      routes: { plan: ['claude', 'codex'], triage: ['claude'], scout: ['antigravity', 'grok'], implement: ['antigravity', 'codex', 'grok'],
        review: ['antigravity', 'grok'], research: ['antigravity', 'grok'], accept: ['claude'] },
      configured: ['claude', 'codex', 'grok', 'antigravity'], authRequired: [], blocked: {},
      quotaPolicy: { claude: { soft: 60, hard: 95, keepFor: ['plan', 'triage', 'accept'] }, codex: { soft: 70, hard: 95, keepFor: ['implement'] },
        grok: { soft: 95, hard: 95, keepFor: [] }, antigravity: { soft: 95, hard: 95, keepFor: [] } },
    },
    resources: { memory: { used: 2.9 * 1024 ** 3, total: 4 * 1024 ** 3 }, swap: { used: 0.3 * 1024 ** 3, total: 2 * 1024 ** 3 } },
    models: {
      claude: { models: { 'claude-opus-5-5': { label: 'Opus 5.5' }, 'claude-sonnet-5-5': { label: 'Sonnet 5.5' }, 'claude-haiku-5-5': { label: 'Haiku 5.5' } } },
      codex: { models: { 'gpt-5.5': { label: 'GPT-5.5' }, 'gpt-5.4': { label: 'GPT-5.4' }, 'gpt-5.5-mini': { label: 'GPT-5.5 mini' } } },
      grok: { models: { 'grok-4.7': {}, 'grok-4.7-build-fast': {} } },
      antigravity: { models: { 'gemini-4-hydrogen': {}, 'gemini-3-pro': {} } },
    },
    writeProviders: ['codex', 'claude', 'grok', 'antigravity'],
  };
  function now(hours) { return Math.round(Date.now() / 1000 + hours * 3600); }

  let data = null;
  let error = '';
  let loading = false;
  let loadedAt = 0;
  let focus = null;

  async function control(operation) {
    const result = await api.control({ operation });
    if (!result?.ok) throw Error(result?.error || 'unavailable');
    return result.value;
  }

  async function load() {
    if (loading) return;
    loading = true;
    render();
    try {
      if (!api) throw Error('offline');
      const [quotas, routes, resources] = await Promise.all([
        control('quota_status').catch((e) => ({ failed: e.message })),
        control('routes'),
        control('resource_status').catch(() => null),
      ]);
      if (!routes?.team) throw Error(routes?.ssh || routes?.relay ? 'old_orchestrator' : 'offline');
      data = { quotas: Array.isArray(quotas) ? quotas : [], quotaError: quotas?.failed, team: routes.team, resources, live: true,
        models: routes.modelProfiles || {}, writeProviders: routes.writeProviders || [] };
      error = '';
    } catch (e) {
      data = { ...sample, live: false };
      error = e.message === 'old_orchestrator' ? '主控版本较旧，请更新 VPS2 后查看实时数据。下面是示例。'
        : '主控未连接，下面是示例数据。';
    } finally {
      loading = false;
      loadedAt = Date.now();
      render();
    }
  }

  // Codex's own account usage from the direct connection, when the orchestrator does not report Codex.
  function codexFromLive() {
    const usage = window.__live?.usage?.();
    const snap = usage?.rateLimits || usage;
    if (!snap?.primary && !snap?.secondary) return null;
    const win = (w) => w ? { usedPercent: w.usedPercent, resetsAt: w.resetsAt > 1e12 ? Math.round(w.resetsAt / 1000) : w.resetsAt } : null;
    return { provider: 'codex', buckets: [{ fiveHour: win(snap.primary), weekly: win(snap.secondary) }], source: 'direct' };
  }

  const windowOf = (entry, key) => (entry?.buckets || []).map((bucket) => bucket[key]).filter(Boolean)
    .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0] || null;
  function resetText(window) {
    if (!window?.resetsAt) return '';
    const ms = window.resetsAt * 1000 - Date.now();
    if (ms <= 0) return '即将重置';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    return h >= 24 ? new Date(window.resetsAt * 1000).toLocaleDateString(undefined, { weekday: 'short' }) + '重置' : `${h}:${String(m).padStart(2, '0')} 后重置`;
  }

  // The same decision routing.js makes, for display: can this member take this kind of work now, and if not, why.
  function standing(role, capability) {
    const team = data.team;
    if (!team.configured.includes(role)) return 'absent';
    if (team.authRequired?.includes(role)) return 'auth';
    const block = team.blocked?.[role];
    if (block) return block.reason === 'auth' ? 'auth' : 'cooling';
    const quota = data.quotas.find((entry) => entry.provider === role);
    const used = quota?.used ?? team.quotaUsed?.[role];
    const policy = team.quotaPolicy?.[role];
    if (!Number.isFinite(used) || !policy || used < policy.soft) return 'ok';
    if (used < policy.hard && capability && policy.keepFor.includes(capability)) return 'reserved';
    return used >= policy.hard ? 'stopped' : 'reserved-other';
  }
  const takes = (state) => state === 'ok' || state === 'reserved';

  function ring(five, week, color) {
    const arc = (r, pct, w, alpha) => {
      const len = 2 * Math.PI * r;
      return `<circle cx="41" cy="41" r="${r}" fill="none" stroke="var(--qv-track)" stroke-width="${w}"/>` + (Number.isFinite(pct)
        ? `<circle cx="41" cy="41" r="${r}" fill="none" stroke="${color}" stroke-opacity="${alpha}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${len * Math.min(100, pct) / 100} ${len}"/>` : '');
    };
    const top = Math.max(five ?? -1, week ?? -1);
    return `<div class="qv-ring"><svg viewBox="0 0 82 82">${arc(35, five, 7, 1)}${arc(24, week, 6, .55)}</svg>
      <div class="qv-big">${top >= 0 ? `<b>${Math.round(top)}%</b><small>${(five ?? -1) >= (week ?? -1) ? '5 小时' : '每周'}</small>` : '<small>未读到</small>'}</div></div>`;
  }

  function card(role) {
    const team = data.team;
    const entry = data.quotas.find((item) => item.provider === role) || (role === 'codex' ? codexFromLive() : null);
    const five = windowOf(entry, 'fiveHour');
    const week = windowOf(entry, 'weekly');
    const policy = team.quotaPolicy?.[role] || entry?.policy;
    const used = entry?.used ?? Math.max(five?.usedPercent ?? -1, week?.usedPercent ?? -1);
    const state = !team.configured.includes(role) ? 'absent' : team.authRequired?.includes(role) || team.blocked?.[role]?.reason === 'auth' ? 'auth'
      : team.blocked?.[role] ? 'cooling' : entry?.level && entry.level !== 'unknown' ? entry.level : used >= 0 ? 'ok' : 'unknown';
    const [label, tone] = levels[state];
    const color = `var(--qv-${tone})`;
    const main = role === 'claude' ? '规划、诊断、验收' : policy?.keepFor?.map((name) => capName[name]).join('、');
    const rule = !policy ? '' : role === 'claude'
      ? `超过 ${policy.soft}% 只接组长的活；${policy.hard}% 停止派活`
      : policy.soft >= policy.hard ? `${policy.hard}% 前什么都接，到了就停`
      : `超过 ${policy.soft}% 只接${main}；${policy.hard}% 停止派活`;
    const block = team.blocked?.[role];
    const note = block ? (block.reason === 'auth' ? '登录失效，' : '额度报尽，') + new Date(block.until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' 后再试'
      : team.authRequired?.includes(role) ? '在 VPS2 完成登录后才会派活' : entry?.source === 'direct' ? '来自 Codex 直连账户'
      : entry?.source === 'estimate' ? '估算：按主控调用次数，' + [five && `5 小时 ${five.calls}/${five.limit} 次`, week && `每周 ${week.calls}/${week.limit} 次`].filter(Boolean).join('，')
      : entry?.reason === 'no_quota_source' ? '这个 CLI 不报告额度；在配置里填 callLimits 即可按调用次数估算' : '';
    return `<article class="qv-card ${focus === role ? 'focused' : ''}" data-tone="${tone}">
      <header>${avatars?.html(role === 'claude' ? 'lead' : role, { size: 22, still: true }) || ''}<b>${names[role]}</b>${entry?.source === 'estimate' ? '<span class="qv-est">估算</span>' : ''}<span class="qv-level">${label}</span></header>
      <div class="qv-body">${ring(five?.usedPercent, week?.usedPercent, color)}<div class="qv-stats">
        <div class="qv-row"><i style="background:${color}"></i>5 小时<b>${Number.isFinite(five?.usedPercent) ? Math.round(five.usedPercent) + '%' : '—'}</b></div>
        <div class="qv-reset">${esc(resetText(five))}</div>
        <div class="qv-row"><i style="background:${color};opacity:.55"></i>每周<b>${Number.isFinite(week?.usedPercent) ? Math.round(week.usedPercent) + '%' : '—'}</b></div>
        <div class="qv-reset">${esc(resetText(week))}</div>
      </div></div>
      ${policy ? `<div class="qv-line" title="软线 ${policy.soft}% · 硬线 ${policy.hard}%"><span class="fill" style="width:${Math.max(0, Math.min(100, used))}%;background:${color}"></span>
        <span class="mark" style="left:${policy.soft}%"></span><span class="mark" style="left:${policy.hard}%"></span></div>` : ''}
      <p class="qv-rule">${esc(rule)}</p>${note ? `<p class="qv-note">${esc(note)}</p>` : ''}
    </article>`;
  }

  function routesTable() {
    const routes = data.team.routes || {};
    return capabilities.filter(([key]) => routes[key]).map(([key, label]) => {
      let picked = false;
      const editable = ORDERABLE.includes(key) || LEAD.includes(key);
      const list = chainFor(key);
      const custom = Boolean(savedOrder()[key]?.length);
      const chain = list.map((item, index) => {
        const { role, model, entry } = item;
        const state = standing(role, key);
        const takesIt = !picked && takes(state);
        if (takesIt) picked = true;
        const why = takesIt ? (state === 'reserved' ? '接手（主业）' : '接手')
          : picked ? '后备' : { absent: '未配置', auth: '需登录', cooling: '冷却中', stopped: '已停', 'reserved-other': '只接主业' }[state] || '跳过';
        const canMove = editable && item.movable;
        const before = index > 0 && list[index - 1].movable, after = index < list.length - 1 && list[index + 1].movable;
        const arrows = canMove ? `<span class="qv-move"><button type="button" data-qv-move="${key}" data-entry="${esc(entry)}" data-step="-1" ${before ? '' : 'disabled'} title="往前排" aria-label="${names[role]} 往前排">‹</button><button type="button" data-qv-move="${key}" data-entry="${esc(entry)}" data-step="1" ${after ? '' : 'disabled'} title="往后排" aria-label="${names[role]} 往后排">›</button></span>` : '';
        const drop = item.added ? `<button type="button" class="qv-drop" data-qv-remove="${key}" data-entry="${esc(entry)}" title="去掉" aria-label="去掉 ${names[role]} ${esc(modelLabel(role, model))}">×</button>` : '';
        return `${index ? '<span class="qv-arrow">›</span>' : ''}<span class="qv-member ${takesIt ? 'pick' : picked ? 'backup' : 'skip'}${item.added ? ' added' : ''}">
          ${avatars?.html(role === 'claude' ? 'lead' : role, { size: 18, still: true }) || ''}${names[role]}${model ? `<span class="qv-model">${esc(modelLabel(role, model))}</span>` : ''}<small>${why}</small>${arrows}${drop}</span>`;
      }).join('');
      // Filled in automatically: the other members that can do this work step in when nobody above can take it;
      // for the lead's work, Claude's other models are the fallbacks when the lead's model gets stuck.
      const inChain = new Set(list.map((item) => item.role));
      const fillRoles = LEAD.includes(key) ? [] : data.team.configured.filter((role) => role !== 'claude' && !inChain.has(role) &&
        (!WRITES.has(key) || (data.writeProviders || []).includes(role)));
      const listedClaude = new Set(list.filter((item) => item.role === 'claude' && item.model).map((item) => item.model));
      const fillModels = LEAD.includes(key) ? Object.keys(data.models?.claude?.models || {}).filter((model) => !listedClaude.has(model)) : [];
      let fill = '';
      if (fillRoles.length) {
        const taker = !picked && fillRoles.find((role) => takes(standing(role, key)));
        if (taker) picked = true;
        fill = `<span class="qv-arrow">›</span><span class="qv-member qv-fill ${taker ? 'pick' : 'backup'}" title="上面的成员都接不了时，这些成员自动补上，用各自最新的模型">补齐：${fillRoles.map((role) => names[role]).join('、')}<small>${taker ? names[taker] + ' 接手' : '后备'}</small></span>`;
      } else if (fillModels.length) {
        fill = `<span class="qv-arrow">›</span><span class="qv-member qv-fill backup" title="组长的模型卡住时，按从新到旧换成这些模型">补齐：${fillModels.map((model) => esc(modelLabel('claude', model))).join('、')}<small>卡住时换</small></span>`;
      }
      const options = editable ? addable(key) : [];
      const picker = options.length ? `<select class="qv-add" data-qv-add="${key}" aria-label="给${label}补充成员或模型"><option value="">+ 补充</option>${options.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join('')}</select>` : '';
      return `<div class="qv-route"><span class="qv-cap">${label}${custom ? '<em class="qv-custom">自定义</em>' : ''}</span><div class="qv-chain">${chain}${fill}${picked ? '' : '<span class="qv-wait">没人能接，这一步会排队等待</span>'}${picker}${custom ? `<button type="button" class="qv-reset" data-qv-reset="${key}">恢复默认</button>` : ''}</div></div>`;
    }).join('');
  }

  function resourceCard() {
    const host = data.resources?.host;
    const r = host ? { memory: { used: host.memoryUsedBytes, total: host.memoryTotalBytes },
      swap: { used: host.swapUsedBytes, total: host.swapTotalBytes } } : data.resources;
    if (!r) return '';
    const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
    const rows = [
      r.memory && ['内存', r.memory.used / r.memory.total, `${gb(r.memory.used)} / ${gb(r.memory.total)} GB`],
      r.swap?.total && ['交换', r.swap.used / r.swap.total, `${gb(r.swap.used)} / ${gb(r.swap.total)} GB`],
      r.disk?.total && ['磁盘', r.disk.used / r.disk.total, `剩 ${Math.round(100 - r.disk.used / r.disk.total * 100)}%`],
    ].filter(Boolean);
    if (!rows.length) return '';
    return `<article class="qv-card qv-res"><header><b>VPS2 资源</b></header>${rows.map(([k, v, t]) =>
      `<div class="qv-resrow">${k}<span class="qv-bar"><i style="width:${Math.round(v * 100)}%"></i></span><b>${t}</b></div>`).join('')}</article>`;
  }

  function render() {
    const dialog = $('#quotaDialog');
    if (!dialog?.open) return;
    const body = dialog.querySelector('.qv-content');
    if (!data) { body.innerHTML = '<p class="qv-empty">正在读取…</p>'; return; }
    const roles = ROLES.filter((role) => data.team.configured.includes(role) || data.quotas.some((q) => q.provider === role) || (role === 'codex' && codexFromLive()));
    body.innerHTML = `${error ? `<p class="qv-banner">${esc(error)}</p>` : ''}
      ${data.quotaError ? '<p class="qv-banner">主控没有开放额度读取（quotaBridges），只能显示分工规则。</p>' : ''}
      <section class="qv-cards">${roles.map(card).join('')}${resourceCard()}</section>
      <section class="qv-section"><h3>分工与降级顺序 <small>实时 · 每种活从左往右找第一个能接的成员 · 用「+ 补充」给每种活加成员和具体模型，用 ‹ › 调整顺序</small></h3>${routesTable()}</section>
      <section class="qv-section qv-rules"><h3>规则</h3><ul>
        <li>额度按 5 小时窗口和每周窗口里<b>用得多的那个</b>算。</li>
        <li>过了软线只接自己的主业，过了硬线不再派活；Claude 只当组长（规划、诊断、验收），配置也改不了。</li>
        <li>CLI 报额度用尽会冷却 30 分钟，报登录失效会停 6 小时，到时自动恢复。</li>
        <li>改代码默认按 Antigravity → Codex → Grok Build 降级，永不派给 Claude；困难的改动由组长点名 Codex。</li>
        <li>你调整和补充的顺序保存在这台电脑上，随你发出的群聊任务一起发给主控：自动派活、降级、重新分配和卡住换模型都按你的顺序，排在前面的具体模型先用；组长也会参考，确有更合适的成员时会说明原因。可以补充主控已配置的任何成员和它的任何模型；规划、诊断、验收只能补充 Claude 的模型（组长始终是 Claude）。不影响别人发的任务。</li>
        <li>审查交给与改代码不同的成员（交叉审查），没有别人可用时才由作者自审。</li>
        <li>每种活最后都会自动「补齐」：上面列的成员都接不了（额度、登录、没配置）时，其他能做这种活的成员自动补上；每个成员卡住时，按从新到旧换它的其他模型。只是暂时忙的成员会等它空下来，不会补。</li>
      </ul></section>`;
    dialog.querySelector('.qv-time').textContent = loading ? '刷新中…' : loadedAt ? '更新于 ' + new Date(loadedAt).toLocaleTimeString() : '';
  }

  function ensureDialog() {
    let dialog = $('#quotaDialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'quotaDialog';
    dialog.className = 'quota-dialog';
    dialog.setAttribute('aria-labelledby', 'quotaDialogTitle');
    dialog.innerHTML = `<header class="qv-head"><h2 id="quotaDialogTitle">额度与分工</h2><span class="qv-time"></span>
      <button type="button" class="btn" data-qv-refresh>刷新</button><button type="button" class="qv-close" data-qv-close aria-label="关闭">×</button></header>
      <div class="qv-content"></div>`;
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('[data-qv-close]')) dialog.close();
      else if (event.target.closest('[data-qv-refresh]')) load();
      else if (event.target.closest('[data-qv-move]')) {
        const button = event.target.closest('[data-qv-move]');
        move(button.dataset.qvMove, button.dataset.entry, Number(button.dataset.step));
      } else if (event.target.closest('[data-qv-remove]')) {
        const button = event.target.closest('[data-qv-remove]');
        remove(button.dataset.qvRemove, button.dataset.entry);
      } else if (event.target.closest('[data-qv-reset]')) reset(event.target.closest('[data-qv-reset]').dataset.qvReset);
    });
    dialog.addEventListener('change', (event) => {
      const select = event.target.closest('[data-qv-add]');
      if (select?.value) add(select.dataset.qvAdd, select.value);
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function open(member) {
    focus = member || null;
    const dialog = ensureDialog();
    if (!dialog.open) dialog.showModal();
    render();
    if (!data || Date.now() - loadedAt > 20000) load();
  }

  // Every quota item in the status bar opens this page.
  document.querySelector('.statusbar')?.addEventListener('click', (event) => {
    const item = event.target.closest('#sbUsage, .sb-quota, #sbQuotaOpen');
    if (!item) return;
    event.stopPropagation();
    open(item.dataset.statusMember || (item.id === 'sbUsage' ? 'codex' : null));
  }, true);

  window.__quotaView = { open };
})();
