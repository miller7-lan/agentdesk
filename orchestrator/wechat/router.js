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
//   /help（/帮助 /0）详细指令　/1～/4 随时切换 AI（管理员）
//   /新 新对话或新任务　/停 停止当前　/历史 历史记录　/问问题 快问快答
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
  '【办公助手 · 指令】',
  '用法：发需求或文件 → 回数字 1/2/3 选档 → 发「开始」出方案 → 改到满意发「完成」→ 收文件。',
  '做完后接着发消息 = 继续改上一个任务。',
  '',
  '/help　查看本说明（/帮助 也行）',
  '/新　开新任务',
  '/停　取消当前步骤',
  '/历史　历史任务和编号',
  '/问问题　快问快答，例：/问今天星期几',
  '/进12　接着改 #12　　/看12　看 #12 详情',
  '/停12　停止 #12　　/重试12　重做　　/重发12　重发文件',
  '',
  '命令是「/」紧跟文字，不加空格。记录和文件保留 30 天。',
].join('\n');

// 管理员 /help 里的 AI 编号和 runner.ADMIN_MODELS 的顺序一致。
const ADMIN_HELP = [
  '【管理员助理 · 指令】',
  '直接发消息就交给当前 AI，默认接着当前对话。AI 能处理办公文件，也能操作关联电脑：截屏、看/建/改/删文件、执行命令。',
  '',
  '随时切换 AI（切换后开新对话）：',
  '/1　Claude Opus',
  '/2　Codex（GPT）',
  '/3　Antigravity',
  '/4　Grok',
  '/模型　看当前用的是哪个',
  '',
  '/help　查看本说明（/帮助 也行）',
  '/新　开新对话',
  '/停　停止当前回复',
  '/历史　历史记录',
  '/问问题　快问快答，例：/问今天星期几',
  '/电脑　查看和切换要操作的电脑（/电脑1、/电脑2…）',
  '/设备　马上查一次各电脑是否在线（上线/离线也会主动提醒）',
  '/工作　切到工作模式（和普通成员一样：选档→出方案→完成→收文件）',
  '/管理　切回管理员模式（现在就是）　/模式　看当前模式',
  '',
  '命令是「/」紧跟文字，不加空格。',
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
  // /0 帮助；/1～/4 切换 AI（service 里校验管理员）
  if (/^0$/.test(body)) return { kind: 'help' };
  const numbered = /^([1-4])\s*([\s\S]*)$/.exec(body);
  if (numbered) {
    if (!numbered[2].trim()) return { kind: 'model', choice: Number(numbered[1]) };
    return { kind: 'reply', text: `/${numbered[1]} 只用来切换 AI，后面不接内容。快问快答改成 /问，例：/问今天星期几` };
  }
  if (/^(历史|历史记录|记录|list)$/i.test(body)) return { kind: 'list' };
  if (/^(停|停止|退出|stop)$/i.test(body)) return { kind: 'cancel' };
  const asked = /^问\s*([\s\S]*)$/.exec(body);
  if (asked) return asked[1].trim() ? { kind: 'ask', text: asked[1].trim() } : { kind: 'reply', text: '快问快答要把问题接在后面，例：/问今天星期几' };
  // 带任务编号：/进12 /看12 /停12 /重试12 /重发12（编号前的 # 和空格可有可无）
  const withId = /^(进|看|停|重试|重发)\s*#?(\d+)$/.exec(body);
  if (withId) return { kind: { '进': 'enter', '看': 'show', '停': 'stop', '重试': 'retry', '重发': 'resend' }[withId[1]], id: Number(withId[2]) };
  if (/^(进|看|停|重试|重发)$/.test(body)) return { kind: 'reply', text: `要接任务编号，不加空格，例：/${body}12。发 /历史 查看历史任务的编号。` };
  // /新 开新任务（默认是接着上一个）；管理员：/模型 /模型2 选 AI，/电脑 /电脑2 看设备、选电脑（service 里校验身份）
  if (/^(新|新开|新任务|新对话|new)$/i.test(body)) return { kind: 'new' };
  if (body === '设备') return { kind: 'devices' };            // 现查一次在线情况
  // 管理员切换：/工作 用办公助手的引导流程，/管理 回到管理员助理，/模式 看当前（service 里校验身份）
  if (/^(工作|工作模式)$/.test(body)) return { kind: 'mode', mode: 'work' };
  if (/^(管理|管理员|管理模式|管理员模式)$/.test(body)) return { kind: 'mode', mode: 'admin' };
  if (body === '模式') return { kind: 'mode', mode: null };
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

// 管理员在工作模式下看的帮助：普通帮助 + 怎么切回去。
const WORK_HELP = HELP.replace('【办公助手 · 指令】', '【工作模式 · 指令】') + '\n管理员：/管理 切回管理员模式（/1～/4 换 AI、操作电脑）；/模式 看当前模式。';

module.exports = { TIERS, TIER_LABEL, TIER_MENU, HELP, ADMIN_HELP, WORK_HELP, START_WORDS, DONE_WORDS, parseCommand, route, composeDraft, tierChoice };
