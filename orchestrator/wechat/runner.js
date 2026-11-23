'use strict';
// 一个微信任务的执行：组长规划（Opus，只读）→ 一个执行者做完。不验收、不中途干预。
//   高档：Claude Opus 直接做（指定 /高 时跳过规划；自动判成高档时沿用规划会话接着做）
//   中档：Codex（GPT）
//   低档：Antigravity；额度用尽或掉登录时换 Grok
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
const NAMES = { claude: 'Claude', codex: 'GPT', antigravity: 'Antigravity', grok: 'Grok' };
const SWITCH_ON = new Set(['cli_quota_exhausted', 'cli_auth_required', 'cli_model_unavailable']);

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

function fileLines(dir, names) {
  return names.length ? names.map((name) => `- in/${name}`).join('\n') : '（没有附件）';
}

function planningPrompt({ text, inputs, forcedTier }) {
  return `你是办公助手的组长，只负责规划，不动手做。先读 ${GUIDE}（办公规范）。
当前目录是本任务的目录：in/ 是用户发来的文件（可以用 python3 打开看结构和内容），out/ 是交付区。

用户在微信里的需求：
${text}

用户发来的文件：
${fileLines('in', inputs)}

请完成两件事：
1. 判断档位${forcedTier ? `（用户已指定 ${forcedTier}，照抄即可）` : ''}：
   - low：格式整理、单文件小改、简单生成（短文、简单表格、几页简单 PPT）、信息提取
   - mid：多步骤数据处理、复杂公式和图表、较长文档或 8 页以上 PPT、多文件合并
   - high：需要深度分析判断、高质量写作、复杂推理，或上述任务质量要求很高
2. 写给执行者的简报 brief：执行者只看这份简报干活，看不到这段对话。写清楚目标、要用的输入文件、具体步骤、成品文件名（放 out/）、交付前的自查要求（xlsx-recalc / office-preview）。信息不足时直接写出合理假设。

最后只输出一个 JSON 代码块：
\`\`\`json
{"tier": "low|mid|high", "brief": "……"}
\`\`\``;
}

function executorPrompt({ text, inputs, brief }) {
  return `你是办公助手，在 VPS 沙箱里替用户处理办公文件。先读 ${GUIDE}（办公规范），严格遵守。
当前目录是本任务的目录：in/ 原件（只读），work/ 草稿，out/ 交付区（这里的新文件会发给用户）。

用户在微信里的原话：
${text}

用户发来的文件：
${fileLines('in', inputs)}
${brief ? `\n组长的简报（按它做）：\n${brief}\n` : ''}
一次做完，不要提问。完成后用 1～3 句中文说明交付了什么、做了哪些假设。`;
}

function continuePrompt({ text, newInputs, outputs }) {
  return `用户在微信里追加了要求（同一个任务，继续按 ${GUIDE} 的规范做）：
${text}
${newInputs.length ? `\n新发来的文件：\n${fileLines('in', newInputs)}\n` : ''}
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
      if (plan && typeof plan.brief === 'string') return { tier: ['low', 'mid', 'high'].includes(plan.tier) ? plan.tier : null, brief: plan.brief.trim() };
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

// deps: { adapters, runAdapter, settings, onStage(stage, info) }
// task: { id, text, tier (指定的档位或 null), executor?, sessions? }
// continuation: { text, newInputs } 时续做同一任务
async function runTask({ task, dir, signal, deps, continuation }) {
  const settings = settingsFrom(deps.settings);
  const { adapters, runAdapter } = deps;
  // 额度闸门：没给就不查（测试或读不到额度时）。
  const quota = deps.quota || { require: async () => {}, rank: async (choices) => choices, invalidate() {} };
  const onStage = deps.onStage || (() => {});
  const logs = path.join(dir, '.logs');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const outDir = path.join(dir, 'out');
  const inputs = listFiles(path.join(dir, 'in'));
  const before = snapshot(outDir);
  const sessions = { ...(task.sessions || {}) };

  const call = async (role, choice, { prompt, readonly, session, timeoutMs, effort }) => {
    const config = adapters[choice.provider];
    if (!config) throw Object.assign(new Error(`${choice.provider}_not_configured`), { code: `${choice.provider}_not_configured` });
    const timeout = timeoutMs || settings.timeoutMs;
    const result = await runAdapter({
      name: choice.provider, config, cwd: dir, prompt, readonly, timeout,
      printTimeoutMs: Math.max(60_000, timeout - 60_000), signal,
      log: path.join(logs, `${role}-${task.turns || 1}.log`),
      onSession: (id) => { sessions[role] = id; },
      session, model: choice.model, effort: effort || choice.effort,
    });
    return result.output || '';
  };

  let executor;
  let tier = task.tier;
  let summary;
  let note = '';
  try {
    if (continuation) {
      // 续做：直接交给上次的执行者，沿用它的会话；不再规划。
      executor = task.executor;
      await quota.require([executor.provider]);
      const prompt = continuePrompt({ text: continuation.text, newInputs: continuation.newInputs, outputs: listFiles(outDir) });
      onStage('running', { executor });
      try {
        summary = await call('executor', executor, { prompt, readonly: false, session: sessions.executor });
      } catch (error) {
        if (signal.aborted || !sessions.executor) throw error;
        // 会话恢复不了（过期、被清理）：开新会话，把原始需求一起带上。
        delete sessions.executor;
        summary = await call('executor', executor, { prompt: executorPrompt({ text: `${task.text}\n\n（追加）${continuation.text}`, inputs, brief: task.brief }) + '\n\n' + continuePrompt({ text: continuation.text, newInputs: continuation.newInputs, outputs: listFiles(outDir) }), readonly: false });
      }
    } else if (tier === 'high') {
      executor = settings.high;
      await quota.require([executor.provider]);
      onStage('running', { tier, executor });
      summary = await call('executor', executor, { prompt: executorPrompt({ text: task.text, inputs }), readonly: false });
    } else {
      await quota.require([settings.planner.provider]);
      onStage('planning', {});
      const planOutput = await call('planner', settings.planner, { prompt: planningPrompt({ text: task.text, inputs, forcedTier: tier }), readonly: true, timeoutMs: settings.planTimeoutMs });
      const plan = parsePlan(planOutput) || { tier: null, brief: '' };
      tier = tier || plan.tier || 'mid';
      task.brief = plan.brief;
      if (tier === 'high') {
        // 自动判成高档：组长沿用规划会话，直接动手。
        executor = settings.high;
        await quota.require([executor.provider]);
        sessions.executor = sessions.planner;
        onStage('running', { tier, executor, auto: true });
        summary = await call('executor', executor, { prompt: `按你刚才的判断和简报直接完成这个任务（现在可以写文件了，成品放 out/）。完成后用 1～3 句中文说明交付了什么。`, readonly: false, session: sessions.planner });
      } else {
        // 同一档有多个候选（低档：Antigravity、Grok）时，选剩余额度多的；剩下的作为备选。
        const ranked = await quota.rank(tier === 'low' ? [settings.low, settings.lowFallback] : [settings[tier]]);
        executor = ranked[0];
        onStage('running', { tier, executor, auto: !task.tier });
        const prompt = executorPrompt({ text: task.text, inputs, brief: plan.brief });
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
    }
    return { status: 'succeeded', tier, executor, sessions, brief: task.brief, summary: summary.trim(), note, outputs: changedFiles(outDir, before) };
  } catch (error) {
    if (String(error?.code || '').startsWith('cli_quota')) quota.invalidate();
    return { status: statusFor(error, signal), ...(error?.blocked && { blocked: error.blocked }), tier, executor, sessions, brief: task.brief, error: String(error.message || error).slice(0, 300), note, outputs: changedFiles(outDir, before) };
  }
}

module.exports = { DEFAULTS, NAMES, settingsFrom, planningPrompt, executorPrompt, continuePrompt, parsePlan, statusFor, runTask, listFiles };
