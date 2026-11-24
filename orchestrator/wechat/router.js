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
  '选档位，回数字：',
  '1 低档 · Antigravity/Grok · 简单整理（5～15 分钟）',
  '2 中档 · GPT · 多步骤、较长文档（3～10 分钟）',
  '3 高档 · Claude Opus · 深度分析、高质量写作（5～20 分钟）',
].join('\n');

const HELP = [
  '【办公助手】',
  '发需求或文件 → 选档 1/2/3 → 发「开始」出方案 → 改到满意发「完成」→ 收文件。',
  '做完后接着发消息 = 继续改上一个任务；开新任务发 /新',
  '',
  '/0 帮助　/1 历史　/2 取消当前　/新 新任务',
  '/3问题 快问快答（例 /3今天星期几）',
  '/进12 接着改 #12　/看12 详情　/停12 停止',
  '/重试12 重做　/重发12 重发文件',
  '记录和文件保留 30 天。',
].join('\n');

const ADMIN_HELP = [
  '【管理员助理】直接发消息就交给所选 AI，默认接着当前对话；发 /新 开新对话。',
  'AI 能处理办公文件，也能操作关联电脑：截屏发来、看/建/改/删文件、执行命令。',
  '',
  '/模型 查看和切换 AI（/模型1～4）',
  '/设备 马上查一次各电脑是否在线；上线/离线也会主动提醒',
  '/电脑 查看和切换要操作的电脑（/电脑1、/电脑2…）',
  '/新 开新对话　/2 停止当前回复　/1 历史',
  '/3问题 快问快答',
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
  // /新 开新任务（默认是接着上一个）；管理员：/模型 /模型2 选 AI，/电脑 /电脑2 看设备、选电脑（service 里校验身份）
  if (/^(新|新开|新任务|新对话|new)$/i.test(body)) return { kind: 'new' };
  if (body === '设备') return { kind: 'devices' };            // 现查一次在线情况
  const pick = /^(模型|电脑)\s*(\d*)$/.exec(body);
  if (pick) return { kind: pick[1] === '模型' ? 'model' : 'computer', choice: pick[2] ? Number(pick[2]) : null };
  const name = word(text);
  if (['帮助', 'help', '?'].includes(name)) return { kind: 'help' };
  if (['取消', 'cancel', '清空'].includes(name)) return { kind: 'cancel' };
  if (DONE_WORDS.has(name)) return { kind: 'confirm' };
  if (START_WORDS.has(name)) return { kind: 'start' };
  return { kind: 'unknown' };
}

// 消息 → 动作。state = { allowUsers: Set, stage, admin }
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
  const media = ['file', 'image'].includes(message.type) || (message.type === 'mixed' && Boolean(message.media));
  // 管理员：除命令外都交给管理员助理（所选 AI 的连续对话）。
  if (state.admin) {
    const command = media ? null : parseCommand(normalize(message.text));
    if (command) return ['confirm', 'start', 'unknown'].includes(command.kind) ? { kind: 'chat', text: normalize(message.text) } : command;
    if (media) return { kind: 'chat-file', text: normalize(message.text) };
    if (!normalize(message.text) || !['text', 'voice', 'mixed'].includes(message.type)) return { kind: 'ignore' };
    return { kind: 'chat', text: normalize(message.text) };
  }
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

module.exports = { TIERS, TIER_LABEL, TIER_MENU, HELP, ADMIN_HELP, START_WORDS, DONE_WORDS, parseCommand, route, composeDraft, tierChoice };
