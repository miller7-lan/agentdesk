'use strict';
// 引导式对话：把一条消息按当前阶段解析成动作。纯函数，不读写文件、不发消息。
//
// 阶段（每个用户一份，存在草稿里）：
//   idle      没有进行中的引导。发需求或文件 → 进入 tier；直接回 1/2/3 → 选档后进入 collect
//   tier      等用户回数字选档（1 低 / 2 中 / 3 高）；回错了重新提示
//   collect   收集需求文字和文件，发「开始」交给组长出方案
//   planning  组长正在出方案 / 改方案，其它内容先不收
//   review    方案已给用户看：说修改意见 → 组长改；发「完成」→ 交给执行 AI
//
// 命令一律是「/」紧跟数字或词，中间不加空格（加了也认）：
//   /0 帮助　/1 历史任务　/2 取消当前　/3问题 快问快答
//   /进12 接着改 #12　/看12 看 #12 详情　/停12 停止 #12　/重试12　/重发12

const TIERS = { '1': 'low', '2': 'mid', '3': 'high', '低': 'low', '中': 'mid', '高': 'high', '低档': 'low', '中档': 'mid', '高档': 'high' };
const TIER_LABEL = { low: '低档', mid: '中档', high: '高档' };
const START_WORDS = new Set(['开始', '开始吧', '开始规划', '出方案', 'start', 'go']);
const DONE_WORDS = new Set(['完成', '确认', '提交', '可以', '可以了', '没问题', '就这样', 'ok', 'done']);
const GREETINGS = /^(你好|您好|嗨|hi|hello|hey|在吗|在不在|哈喽|早上好|晚上好|下午好)[!！。.~～？?]*$/i;

const TIER_MENU = [
  '请选择档位，直接回复数字：',
  '1 → 低档：Antigravity / Grok 执行，适合格式整理、简单文档（约 5～15 分钟）',
  '2 → 中档：GPT 执行，适合多步骤数据处理、较长文档（约 3～10 分钟）',
  '3 → 高档：Claude Opus 执行，适合深度分析、高质量写作（约 5～20 分钟）',
].join('\n');

const HELP = [
  '【办公助手 · 用法】',
  '步骤：',
  '① 发需求或文件 → 回数字选档（1 低 / 2 中 / 3 高）',
  '② 继续发需求和 Word/Excel/PPT 文件 → 发「开始」',
  '③ 组长出方案（约 1～3 分钟）→ 有要改的直接说，改到满意',
  '④ 发「完成」→ 执行 AI 交付文件，做完主动通知你',
  '',
  '命令（「/」后面直接跟，不要空格）：',
  '/0 → 显示本帮助',
  '/1 → 查看历史任务（最近 10 个）',
  '/2 → 取消当前这一步，重新开始',
  '/3问题 → 快问快答，例：/3今天星期几',
  '/进12 → 接着修改 #12 的成品',
  '/看12 → 查看 #12 详情',
  '/停12 → 停止 #12',
  '/重试12 → 重新执行失败的 #12',
  '/重发12 → 重新发送 #12 的文件',
  '',
  '任务记录和文件保留 30 天。',
].join('\n');

function normalize(text) { return String(text || '').trim(); }
function word(text) { return normalize(text).replace(/^[/／]/, '').replace(/[。.！!～~]+$/, '').toLowerCase(); }
function tierChoice(text) { return TIERS[word(text)] || null; }

// 不分阶段的命令；不是命令返回 null。
function parseCommand(raw) {
  const text = normalize(raw);
  if (GREETINGS.test(text)) return { kind: 'greet' };
  if (!/^[/／]/.test(text)) return null;
  const body = text.slice(1).trim();
  // 数字菜单：/0 /1 /2 /3问题
  const numbered = /^([0-3])\s*([\s\S]*)$/.exec(body);
  if (numbered) {
    const rest = numbered[2].trim();
    if (numbered[1] === '0') return { kind: 'help' };
    if (numbered[1] === '1') return { kind: 'list' };
    if (numbered[1] === '2') return { kind: 'cancel' };
    return rest ? { kind: 'ask', text: rest } : { kind: 'reply', text: '快问快答要把问题接在后面，例：/3今天星期几' };
  }
  // 带任务编号：/进12 /看12 /停12 /重试12 /重发12（编号前的 # 和空格可有可无）
  const withId = /^(进|看|停|重试|重发)\s*#?(\d+)$/.exec(body);
  if (withId) return { kind: { '进': 'enter', '看': 'show', '停': 'stop', '重试': 'retry', '重发': 'resend' }[withId[1]], id: Number(withId[2]) };
  if (/^(进|看|停|重试|重发)$/.test(body)) return { kind: 'reply', text: `要接任务编号，不加空格，例：/${body}12。发 /1 查看历史任务的编号。` };
  const name = word(text);
  if (['帮助', 'help', '?'].includes(name)) return { kind: 'help' };
  if (['取消', '新', 'new', 'cancel', '清空'].includes(name)) return { kind: 'cancel' };
  if (DONE_WORDS.has(name)) return { kind: 'confirm' };
  if (START_WORDS.has(name)) return { kind: 'start' };
  return { kind: 'unknown' };
}

// 消息 → 动作。state = { allowUsers: Set, stage }
function route(message, state) {
  if (message.type === 'event') {
    if (message.event === 'enter_chat' && message.chatType !== 'group') return { kind: 'welcome' };
    return { kind: 'ignore' };
  }
  if (!message.from) return { kind: 'ignore' };
  if (!state.allowUsers.size || !state.allowUsers.has(message.from)) return { kind: 'deny' };
  if (message.chatType === 'group') return { kind: 'reply', text: '请在和我的单聊里使用办公助手（群里不处理任务和文件）。' };
  if (message.type === 'video') return { kind: 'reply', text: '暂不处理视频，请发文件或文字。' };
  if (message.type === 'voice' && !message.text) return { kind: 'reply', text: '语音没有转成文字，请打字。' };
  const stage = state.stage || 'idle';
  const hasMedia = ['file', 'image'].includes(message.type) || (message.type === 'mixed' && Boolean(message.media));
  const text = normalize(message.text);
  if (!hasMedia && !['text', 'voice', 'mixed'].includes(message.type)) return { kind: 'ignore' };
  if (!hasMedia && !text) return { kind: 'ignore' };

  if (!hasMedia) {
    const command = parseCommand(text);
    if (command) {
      // 「完成」只在看方案时有意义，「开始」只在收集需求时有意义；不认识的命令也给出当前阶段的提示。
      if (command.kind === 'confirm' && stage !== 'review') return { kind: 'remind', why: 'confirm' };
      if (command.kind === 'start' && stage !== 'collect') return { kind: 'remind', why: 'start' };
      if (command.kind === 'unknown') return { kind: 'remind', why: 'unknown' };
      return command;
    }
  }

  switch (stage) {
    case 'tier': {
      if (hasMedia) return { kind: 'file', text };
      const tier = tierChoice(text);
      return tier ? { kind: 'tier', tier } : { kind: 'remind', why: 'tier' };
    }
    case 'collect':
      if (hasMedia) return { kind: 'file', text };
      if (START_WORDS.has(word(text))) return { kind: 'start' };
      if (tierChoice(text)) return { kind: 'tier', tier: tierChoice(text) };   // 收集时回 1/2/3 = 改档位
      return { kind: 'append', text };
    case 'planning':
      return { kind: 'wait' };
    case 'review':
      if (hasMedia) return { kind: 'file', text };
      if (DONE_WORDS.has(word(text))) return { kind: 'confirm' };
      if (tierChoice(text)) return { kind: 'tier', tier: tierChoice(text) };   // 看方案时回 1/2/3 = 改档位
      if (START_WORDS.has(word(text))) return { kind: 'remind', why: 'start' };
      return { kind: 'revise', text };
    default: {   // idle
      if (hasMedia) return { kind: 'file', text };
      const tier = tierChoice(text);
      if (tier) return { kind: 'tier', tier };
      return { kind: 'append', text };
    }
  }
}

// 草稿里的多条内容合成一段给 AI 的需求。
function composeDraft(texts) {
  const items = texts.map((text) => String(text).trim()).filter(Boolean);
  if (items.length <= 1) return items[0] || '';
  return items.map((text, index) => `${index + 1}. ${text}`).join('\n');
}

module.exports = { TIERS, TIER_LABEL, TIER_MENU, HELP, START_WORDS, DONE_WORDS, parseCommand, route, composeDraft, tierChoice };
