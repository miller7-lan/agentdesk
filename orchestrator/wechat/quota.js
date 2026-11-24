'use strict';
// 开工前查额度：5 小时剩余低于 8%、或本周剩余低于 3% 的 CLI 不派活，按顺序换下一个。
// 额度来自主控的 quotas.js（与桌面端显示同源，读各 CLI 自己的额度接口，不消耗模型额度）。
// 读不到额度时不拦（交给 CLI 自己报错，runner 会识别额度用尽）。

const MIN_REMAINING = 8;          // 5 小时窗口
const MIN_WEEKLY = 3;             // 本周窗口
const NAMES = { claude: 'Claude', codex: 'GPT', antigravity: 'Antigravity', grok: 'Grok' };

class QuotaLow extends Error {
  constructor(blocked) {
    super('quota_low');
    this.code = 'quota_low';
    this.blocked = blocked;          // [{ provider, remaining, resetsAt }]
  }
}

// quotaStatus 的一项 → { remaining, resetsAt, window, windows: [...] } 或 null（读不到）。remaining 等取剩得少的窗口。
function remainingOf(entry) {
  if (!entry || entry.state !== 'available' || !entry.buckets?.length) return null;
  // Antigravity 按模型族分多个桶；Flash 系列在通用的「Gemini Models」桶里。
  const bucket = entry.buckets.find((item) => /gemini models/i.test(item.label || '')) || entry.buckets[0];
  const windows = ['fiveHour', 'weekly']
    .filter((key) => Number.isFinite(Number(bucket[key]?.usedPercent)))
    .map((key) => ({ window: key, remaining: Math.max(0, Math.round((100 - Number(bucket[key].usedPercent)) * 10) / 10), resetsAt: bucket[key].resetsAt || null }));
  if (!windows.length) return null;
  return { ...windows.reduce((low, item) => (item.remaining < low.remaining ? item : low)), windows };
}

// 各窗口的门槛：低于就不派活。
function thresholdOf(window, limits) { return window === 'weekly' ? limits.minWeekly : limits.minRemaining; }

class QuotaGate {
  constructor({ adapters, quotaStatus, now = Date.now, ttlMs = 60_000, minRemaining = MIN_REMAINING, minWeekly = MIN_WEEKLY }) {
    Object.assign(this, { adapters, quotaStatus, now, ttlMs, minRemaining, minWeekly });
    this.cache = null;
  }

  async read() {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const list = await this.quotaStatus(this.adapters);
    const value = Object.fromEntries(list.map((entry) => [entry.provider, remainingOf(entry)]));
    this.cache = { at: this.now(), value };
    return value;
  }

  // /额度：不走缓存，现读一次完整数据（各窗口、各桶）。
  async fresh() {
    const list = await this.quotaStatus(this.adapters);
    this.cache = { at: this.now(), value: Object.fromEntries(list.map((entry) => [entry.provider, remainingOf(entry)])) };
    return list;
  }

  // 额度刚被用掉（CLI 报额度用尽）时清缓存，下次重新读。
  invalidate() { this.cache = null; }

  // 每个 provider 是否可用：{ provider, remaining|null, resetsAt, ok }
  async inspect(providers) {
    let quotas = {};
    try { quotas = await this.read(); } catch { quotas = {}; }
    return providers.map((provider) => {
      const info = quotas[provider];
      // 卡住的窗口（低于各自门槛）；没卡住就报剩得少的那个。
      const low = info?.windows?.find((item) => item.remaining < thresholdOf(item.window, this));
      const shown = low || info;
      return { provider, remaining: shown ? shown.remaining : null, resetsAt: shown?.resetsAt || null, window: shown?.window || null, ok: !low };
    });
  }

  // 必须全部可用，否则抛 QuotaLow。
  async require(providers) {
    const blocked = (await this.inspect(providers)).filter((item) => !item.ok);
    if (blocked.length) throw new QuotaLow(blocked);
  }

  // 按给定顺序挑第一个额度够的（读不到额度的算够）。返回 { choice, skipped: [{ provider, remaining, resetsAt, window }] }；
  // 全不够时抛 QuotaLow。
  async pick(choices) {
    const info = await this.inspect(choices.map((choice) => choice.provider));
    const index = info.findIndex((item) => item.ok);
    if (index < 0) throw new QuotaLow(info);
    return { choice: choices[index], skipped: info.slice(0, index) };
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

// 恢复时间：今天只写时分，其它天写月日。
function whenText(resetsAt, now, timeZone) {
  if (!resetsAt) return '';
  const opts = { timeZone, hour: '2-digit', minute: '2-digit', hour12: false };
  const day = (ms) => new Date(ms).toLocaleDateString('zh-CN', { timeZone });
  const at = resetsAt * 1000;
  const time = new Date(at).toLocaleTimeString('zh-CN', opts);
  return day(at) === day(now) ? time : `${new Date(at).toLocaleDateString('zh-CN', { timeZone, month: 'numeric', day: 'numeric' })} ${time}`;
}

// /额度 的文字：models = [{ provider, label }]（按 /1～/4 的顺序），list = quotaStatus 的原始结果。
function quotaReport(list, { models, current = null, minRemaining = MIN_REMAINING, minWeekly = MIN_WEEKLY, now = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
  const byProvider = new Map((list || []).map((entry) => [entry.provider, entry]));
  const lines = ['【额度 · 剩余】'];
  models.forEach((model, index) => {
    const entry = byProvider.get(model.provider);
    const head = `/${index + 1} ${model.label}${model.provider === current ? '（当前）' : ''}`;
    if (!entry || entry.state !== 'available' || !entry.buckets?.length) {
      lines.push(`${head}：读不到${entry?.state === 'not_configured' ? '（未配置）' : ''}`);
      return;
    }
    const parts = [];
    for (const bucket of entry.buckets) {
      const windows = [['fiveHour', '5 小时'], ['weekly', '本周']].filter(([key]) => Number.isFinite(Number(bucket[key]?.usedPercent)));
      const text = windows.map(([key, name]) => {
        const left = Math.max(0, Math.round((100 - Number(bucket[key].usedPercent)) * 10) / 10);
        const when = whenText(bucket[key].resetsAt, now, timeZone);
        return `${name} ${left}%${left < thresholdOf(key, { minRemaining, minWeekly }) ? ' ⚠️' : ''}${when ? `（${when} 恢复）` : ''}`;
      }).join('，');
      if (text) parts.push(entry.buckets.length > 1 && bucket.label ? `${bucket.label}：${text}` : text);
    }
    lines.push(`${head}：${parts.join('；') || '读不到'}`);
    const age = entry.observedAt ? now - Date.parse(entry.observedAt) : 0;
    if (age > 10 * 60_000) lines.push(`　（${Math.round(age / 60_000)} 分钟前的数据）`);
  });
  lines.push(`⚠️ = 5 小时低于 ${minRemaining}% 或本周低于 ${minWeekly}%，不派活，自动换别的 AI。`);
  return lines.join('\n');
}

module.exports = { MIN_REMAINING, MIN_WEEKLY, QuotaGate, QuotaLow, remainingOf, describeBlocked, quotaReport };
