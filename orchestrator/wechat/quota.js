'use strict';
// 开工前查额度：剩余低于 8% 的 CLI 不用；同一档有多个候选时选剩余多的。
// 额度来自主控的 quotas.js（与桌面端显示同源）。看 5 小时窗口；没有 5 小时窗口的（如 Grok）看周额度。
// 读不到额度时不拦（交给 CLI 自己报错，runner 会识别额度用尽）。

const MIN_REMAINING = 8;
const NAMES = { claude: 'Claude', codex: 'GPT', antigravity: 'Antigravity', grok: 'Grok' };

class QuotaLow extends Error {
  constructor(blocked) {
    super('quota_low');
    this.code = 'quota_low';
    this.blocked = blocked;          // [{ provider, remaining, resetsAt }]
  }
}

// quotaStatus 的一项 → { remaining, resetsAt, window } 或 null（读不到）。
function remainingOf(entry) {
  if (!entry || entry.state !== 'available' || !entry.buckets?.length) return null;
  // Antigravity 按模型族分多个桶；Flash 系列在通用的「Gemini Models」桶里。
  const bucket = entry.buckets.find((item) => /gemini models/i.test(item.label || '')) || entry.buckets[0];
  const window = bucket.fiveHour ? 'fiveHour' : bucket.weekly ? 'weekly' : null;
  if (!window) return null;
  const used = Number(bucket[window].usedPercent);
  if (!Number.isFinite(used)) return null;
  return { remaining: Math.max(0, Math.round((100 - used) * 10) / 10), resetsAt: bucket[window].resetsAt || null, window };
}

class QuotaGate {
  constructor({ adapters, quotaStatus, now = Date.now, ttlMs = 60_000, minRemaining = MIN_REMAINING }) {
    Object.assign(this, { adapters, quotaStatus, now, ttlMs, minRemaining });
    this.cache = null;
  }

  async read() {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const list = await this.quotaStatus(this.adapters);
    const value = Object.fromEntries(list.map((entry) => [entry.provider, remainingOf(entry)]));
    this.cache = { at: this.now(), value };
    return value;
  }

  // 额度刚被用掉（CLI 报额度用尽）时清缓存，下次重新读。
  invalidate() { this.cache = null; }

  // 每个 provider 是否可用：{ provider, remaining|null, resetsAt, ok }
  async inspect(providers) {
    let quotas = {};
    try { quotas = await this.read(); } catch { quotas = {}; }
    return providers.map((provider) => {
      const info = quotas[provider];
      return { provider, remaining: info ? info.remaining : null, resetsAt: info?.resetsAt || null, window: info?.window || null,
        ok: !info || info.remaining >= this.minRemaining };
    });
  }

  // 必须全部可用，否则抛 QuotaLow。
  async require(providers) {
    const blocked = (await this.inspect(providers)).filter((item) => !item.ok);
    if (blocked.length) throw new QuotaLow(blocked);
  }

  // 候选执行者按剩余额度从多到少排，去掉不够的；全不够时抛 QuotaLow。读不到额度的排在读得到的后面。
  async rank(choices) {
    const info = await this.inspect(choices.map((choice) => choice.provider));
    const usable = choices.map((choice, index) => ({ choice, ...info[index] })).filter((item) => item.ok);
    if (!usable.length) throw new QuotaLow(info);
    usable.sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1));
    return usable.map((item) => item.choice);
  }
}

function describeBlocked(blocked, timeZone = 'Asia/Shanghai') {
  return blocked.map(({ provider, remaining, resetsAt, window }) => {
    const when = resetsAt ? new Date(resetsAt * 1000).toLocaleString('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const scope = window === 'weekly' ? '周额度' : '5 小时额度';
    return `${NAMES[provider] || provider} ${scope}只剩 ${remaining}%${when ? `，约 ${when} 恢复` : ''}`;
  }).join('；');
}

module.exports = { MIN_REMAINING, QuotaGate, QuotaLow, remainingOf, describeBlocked };
