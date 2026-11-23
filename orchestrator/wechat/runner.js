'use strict';
// 微信任务的两步：
//   planTask    组长（默认 Claude Opus，只读）出方案给用户看；用户提修改意见时在同一会话里改方案。
//   executeTask 用户发 /完成 后，按方案交给执行者一次做完，不验收、不中途干预。
//     高档：Claude Opus（组长也是 Opus 时沿用规划会话接着做）
//     中档：Codex（GPT）
//     低档：Antigravity、Grok 里剩余额度多的；途中额度用尽/掉登录换另一个
//   续做老任务（/进 编号）：直接交给原执行者，不再规划。
const fs = require('node:fs');
const path = require('node:path');

const GUIDE = '/opt/agentdesk-office/GUIDE.md';
const DEFAULTS = {
  planner: { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
  high: { provider: 'claude', model: 'claude-opus-5-5' },
  mid: { provider: 'codex' },
  low: { provider: 'antigravity', model: 'gemini-3.8-flash-high' },
  lowFallback: { provider: 'grok', model: 'grok-4.7' },
  planTimeoutMs: 5 * 60 * 1000,
  timeoutMs: 20 * 60 * 1000,
};
// 粗略的用时（分钟），组长没给估计时用；只用于提醒，不求准。
const TIER_ESTIMATE = { low: [5, 15], mid: [3, 10], high: [5, 20] };
const PLAN_ESTIMATE = [1, 3];
const NAMES = { claude: 'Claude', codex: 'GPT', antigravity: 'Antigravity', grok: 'Grok' };
const SWITCH_ON = new Set(['cli_quota_exhausted', 'cli_auth_required', 'cli_model_unavailable']);
const TIER_TEXT = { low: '低档（执行者能力一般，适合格式整理、简单文档）', mid: '中档（GPT 执行，适合多步骤数据处理、较长文档）', high: '高档（Claude Opus 执行，适合需要深度分析和高质量写作的任务）' };

function settingsFrom(wechat = {}) {
  return { ...DEFAULTS, ...wechat, planner: { ...DEFAULTS.planner, ...wechat.planner } };
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch { return []; }
}

function snapshot(dir) {
  const state = new Map();
  for (const name of listFiles(dir)) {
    const stat = fs.statSync(path.join(dir, name));
    state.set(name, `${stat.size}:${stat.mtimeMs}`);
  }
  return state;
}

function changedFiles(dir, before) {
  const after = snapshot(dir);
  return [...after].filter(([name, stamp]) => before.get(name) !== stamp).map(([name]) => path.join(dir, name));
}

function fileLines(names) {
  return names.length ? names.map((name) => `- in/${name}`).join('\n') : '（没有附件）';
}

const PLAN_FORMAT = `最后只输出一个 JSON 代码块：
\`\`\`json
{"plan": "给用户看的方案（中文，3～8 行，每行一点：要交付什么文件、主要内容和结构、关键做法、你做的假设）",
 "brief": "给执行者的完整简报：执行者只看这份简报干活，看不到这段对话。写清目标、要用的输入文件、具体步骤、成品文件名（放 out/）、交付前自查（xlsx-recalc / office-preview）。",
 "estimate_minutes": 执行大约需要的分钟数（整数，粗估即可）}
\`\`\``;

function planningPrompt({ text, inputs, tier }) {
  return `你是办公助手的组长，只负责出方案，不动手做。先读 ${GUIDE}（办公规范）。
当前目录是本任务的目录：in/ 是用户发来的文件（可以用 python3 打开看结构和内容），out/ 是交付区。

用户在微信里的需求：
${text}

用户发来的文件：
${fileLines(inputs)}

用户选的档位：${TIER_TEXT[tier] || tier}。方案的复杂度要和执行者能力相称。
方案会先发给用户确认，用户可能提修改意见。信息不足时写出合理假设，不要反问。

${PLAN_FORMAT}`;
}

function revisionPrompt({ feedback, newInputs }) {
  return `用户看了方案，提出修改意见：
${feedback}
${newInputs.length ? `\n用户新发来的文件：\n${fileLines(newInputs)}\n` : ''}
按意见修改方案（没提到的部分保持不变），同样只输出 JSON：

${PLAN_FORMAT}`;
}

function executorPrompt({ text, inputs, brief }) {
  return `你是办公助手，在 VPS 沙箱里替用户处理办公文件。先读 ${GUIDE}（办公规范），严格遵守。
当前目录是本任务的目录：in/ 原件（只读），work/ 草稿，out/ 交付区（这里的新文件会发给用户）。

用户在微信里的原话：
${text}

用户发来的文件：
${fileLines(inputs)}
${brief ? `\n用户已确认的方案和组长的简报（按它做）：\n${brief}\n` : ''}
一次做完，不要提问。完成后用 1～3 句中文说明交付了什么、做了哪些假设。`;
}

function continuePrompt({ text, newInputs, outputs }) {
  return `用户在微信里追加了要求（同一个任务，继续按 ${GUIDE} 的规范做）：
${text}
${newInputs.length ? `\n新发来的文件：\n${fileLines(newInputs)}\n` : ''}
上一版成品在 out/：${outputs.length ? outputs.join('、') : '（无）'}。在它的基础上改，另存为新文件名（如加 -v2），不要覆盖旧版。
完成后用 1～3 句中文说明改了什么。`;
}

function parsePlan(output) {
  const text = String(output || '');
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
  const candidates = [...blocks.reverse(), ...(text.match(/\{[\s\S]*\}/) || [])];
  for (const candidate of candidates) {
    try {
      const plan = JSON.parse(candidate);
      if (plan && typeof plan.brief === 'string') {
        const minutes = Math.round(Number(plan.estimate_minutes));
        return {
          plan: String(plan.plan || '').trim(),
          brief: plan.brief.trim(),
          estimateMinutes: Number.isFinite(minutes) && minutes > 0 && minutes < 600 ? minutes : null,
        };
      }
    } catch {}
  }
  return null;
}

function statusFor(error, signal) {
  if (signal?.aborted) return 'cancelled';
  const code = error?.code || error?.message || '';
  if (code === 'quota_low') return 'quota_low';
  if (code === 'cli_timeout' || code.startsWith('cli_timeout')) return 'timeout';
  if (code.startsWith('cli_quota_exhausted')) return 'quota_limited';
  if (code.startsWith('cli_auth_required')) return 'auth_expired';
  return 'failed';
}

function context({ task, dir, signal, deps }) {
  const settings = settingsFrom(deps.settings);
  const quota = deps.quota || { require: async () => {}, rank: async (choices) => choices, invalidate() {} };
  const logs = path.join(dir, '.logs');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const sessions = { ...(task.sessions || {}) };
  let calls = 0;
  const call = async (role, choice, { prompt, readonly, session, timeoutMs }) => {
    const config = deps.adapters[choice.provider];
    if (!config) throw Object.assign(new Error(`${choice.provider}_not_configured`), { code: `${choice.provider}_not_configured` });
    const timeout = timeoutMs || settings.timeoutMs;
    calls += 1;
    const result = await deps.runAdapter({
      name: choice.provider, config, cwd: dir, prompt, readonly, timeout,
      printTimeoutMs: Math.max(60_000, timeout - 60_000), signal,
      log: path.join(logs, `${role}-${task.turns || 1}-${calls}.log`),
      onSession: (id) => { sessions[role] = id; },
      session, model: choice.model, effort: choice.effort,
    });
    return result.output || '';
  };
  return { settings, quota, sessions, call };
}

function failure(error, signal, quota, extra) {
  if (String(error?.code || '').startsWith('cli_quota')) quota.invalidate();
  return { status: statusFor(error, signal), ...(error?.blocked && { blocked: error.blocked }), error: String(error?.message || error).slice(0, 300), ...extra };
}

// 出方案或改方案。revision: { feedback, newInputs } 时在组长原会话里改。
async function planTask({ task, dir, signal, deps, revision }) {
  const { settings, quota, sessions, call } = context({ task, dir, signal, deps });
  try {
    await quota.require([settings.planner.provider]);
    const inputs = listFiles(path.join(dir, 'in'));
    let output;
    if (revision && sessions.planner) {
      try {
        output = await call('planner', settings.planner, { prompt: revisionPrompt(revision), readonly: true, session: sessions.planner, timeoutMs: settings.planTimeoutMs });
      } catch (error) {
        if (signal.aborted) throw error;
        // 会话恢复不了：带上原需求、上一版方案和修改意见重新出。
        delete sessions.planner;
        const text = `${task.text}\n\n上一版方案：\n${task.plan || '（无）'}\n\n用户的修改意见：\n${revision.feedback}`;
        output = await call('planner', settings.planner, { prompt: planningPrompt({ text, inputs, tier: task.tier }), readonly: true, timeoutMs: settings.planTimeoutMs });
      }
    } else {
      output = await call('planner', settings.planner, { prompt: planningPrompt({ text: task.text, inputs, tier: task.tier }), readonly: true, timeoutMs: settings.planTimeoutMs });
    }
    const plan = parsePlan(output);
    if (!plan) return { status: 'failed', error: 'plan_unparsed', sessions, raw: String(output).slice(0, 2000) };
    return { status: 'planned', sessions, ...plan };
  } catch (error) {
    return failure(error, signal, quota, { sessions });
  }
}

// 按确认的方案执行；continuation: { text, newInputs } 时续做老任务。
async function executeTask({ task, dir, signal, deps, continuation }) {
  const { settings, quota, sessions, call } = context({ task, dir, signal, deps });
  const onStage = deps.onStage || (() => {});
  const outDir = path.join(dir, 'out');
  const inputs = listFiles(path.join(dir, 'in'));
  const before = snapshot(outDir);
  const tier = task.tier;
  let executor;
  let summary;
  let note = '';
  try {
    if (continuation) {
      executor = task.executor;
      await quota.require([executor.provider]);
      const prompt = continuePrompt({ text: continuation.text, newInputs: continuation.newInputs, outputs: listFiles(outDir) });
      onStage('running', { executor });
      try {
        summary = await call('executor', executor, { prompt, readonly: false, session: sessions.executor });
      } catch (error) {
        if (signal.aborted || !sessions.executor) throw error;
        delete sessions.executor;
        summary = await call('executor', executor, { prompt: executorPrompt({ text: task.text, inputs, brief: task.brief }) + '\n\n' + prompt, readonly: false });
      }
    } else if (tier === 'high') {
      executor = settings.high;
      await quota.require([executor.provider]);
      onStage('running', { tier, executor });
      const samePlanner = settings.planner.provider === executor.provider && sessions.planner;
      summary = samePlanner
        ? await call('executor', executor, { prompt: '用户已确认方案。按最新方案和简报直接完成这个任务（现在可以写文件了，成品放 out/）。完成后用 1～3 句中文说明交付了什么。', readonly: false, session: sessions.planner })
        : await call('executor', executor, { prompt: executorPrompt({ text: task.text, inputs, brief: task.brief }), readonly: false });
    } else {
      const ranked = await quota.rank(tier === 'low' ? [settings.low, settings.lowFallback] : [settings[tier] || settings.mid]);
      executor = ranked[0];
      onStage('running', { tier, executor });
      const prompt = executorPrompt({ text: task.text, inputs, brief: task.brief });
      try {
        summary = await call('executor', executor, { prompt, readonly: false });
      } catch (error) {
        const code = String(error.code || '');
        if (!ranked[1] || signal.aborted || ![...SWITCH_ON].some((kind) => code.startsWith(kind))) throw error;
        quota.invalidate();
        note = `${NAMES[executor.provider]} 不可用（${code.startsWith('cli_quota') ? '额度用尽' : code.startsWith('cli_auth') ? '需要重新登录' : '模型不可用'}），已换 ${NAMES[ranked[1].provider]}。`;
        executor = ranked[1];
        delete sessions.executor;
        onStage('running', { tier, executor, switched: true });
        summary = await call('executor', executor, { prompt, readonly: false });
      }
    }
    return { status: 'succeeded', tier, executor, sessions, summary: summary.trim(), note, outputs: changedFiles(outDir, before) };
  } catch (error) {
    return failure(error, signal, quota, { tier, executor, sessions, note, outputs: changedFiles(outDir, before) });
  }
}

function estimateText(task) {
  if (task.estimateMinutes) {
    const m = task.estimateMinutes;
    return `约 ${m} 分钟`;
  }
  const [a, b] = TIER_ESTIMATE[task.tier] || [5, 15];
  return `约 ${a}～${b} 分钟`;
}

// 超过这个时长就提醒一次“比预估慢”（毫秒）。
function overdueAfterMs(task) {
  const minutes = task.estimateMinutes || (TIER_ESTIMATE[task.tier] || [5, 15])[1];
  return Math.max(3, Math.round(minutes * 1.5)) * 60_000;
}

module.exports = {
  DEFAULTS, NAMES, TIER_ESTIMATE, PLAN_ESTIMATE, settingsFrom, planningPrompt, revisionPrompt, executorPrompt, continuePrompt,
  parsePlan, statusFor, planTask, executeTask, listFiles, estimateText, overdueAfterMs,
};
