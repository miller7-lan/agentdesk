'use strict';
// 把一条企业微信消息解析成要做的动作。纯函数：不读写文件、不发消息，便于测试。
// 交互方式：文字和文件先攒进草稿，发「开始」才执行，草稿里的全部内容一次交给 AI。

const TIERS = { '低': 'low', '中': 'mid', '高': 'high', l: 'low', m: 'mid', h: 'high', low: 'low', mid: 'mid', high: 'high' };
const TIER_LABEL = { low: '低档', mid: '中档', high: '高档' };
const START_WORDS = new Set(['开始', '开始吧', '开始执行', '执行', 'go', 'start']);

const HELP = [
  '办公助手用法：',
  '1. 发需求文字和 Word/Excel/PPT 文件（可以分多条发）',
  '2. 发「开始」，把攒下的内容一起交给 AI',
  '档位（开始前任何时候发）：/低 /中 /高，不选由组长判断',
  '  低：组长规划 → Antigravity 或 Grok 完成',
  '  中：组长规划 → GPT 完成',
  '  高：Claude Opus 直接做',
  '其它：/清空 放弃草稿　/ls 最近任务　/进 编号 回到老任务接着改',
  '　　　/新 退出老任务　/s 编号 详情　/stop 编号 停止　/重试 编号',
  '任务记录和文件保留 30 天。',
].join('\n');

function tierOf(word) { return TIERS[String(word).toLowerCase()] || TIERS[word] || null; }

// 文本 → 动作（不看状态）。
function parseText(raw) {
  const text = String(raw || '').trim();
  const bare = text.replace(/^[/／]/, '');
  const startWithTier = /^(\S+?)\s*([低中高])?$/.exec(bare);
  if (startWithTier && START_WORDS.has(startWithTier[1].toLowerCase())) {
    return { kind: 'start', tier: startWithTier[2] ? tierOf(startWithTier[2]) : null };
  }
  const command = /^[/／]([低中高])\s*([\s\S]*)$/.exec(text) || /^[/／](\S+?)(?:\s+([\s\S]*))?$/.exec(text);
  if (!command) return { kind: 'append', text };
  const word = command[1];
  const rest = (command[2] || '').trim();
  const name = word.toLowerCase();
  const tier = tierOf(word);
  if (tier) return { kind: 'tier', tier, text: rest };
  if (name === '新' || name === 'new') return { kind: 'fresh' };
  if (name === '清空' || name === 'clear') return { kind: 'clear' };
  if (name === 'ls' || name === '列表') return { kind: 'list' };
  if (name === 'help' || name === '帮助' || name === '?') return { kind: 'help' };
  const id = /^#?(\d+)$/.exec(rest);
  if ((name === '进' || name === 'open' || name === '切') && id) return { kind: 'enter', id: Number(id[1]) };
  if ((name === 's' || name === '详情') && id) return { kind: 'show', id: Number(id[1]) };
  if ((name === 'stop' || name === '停') && id) return { kind: 'stop', id: Number(id[1]) };
  if ((name === '重试' || name === 'retry') && id) return { kind: 'retry', id: Number(id[1]) };
  if (['进', 'open', '切', 's', '详情', 'stop', '停', '重试', 'retry'].includes(name)) return { kind: 'list' };
  // 不认识的斜杠开头（如 /usr/bin），当普通内容。
  return { kind: 'append', text };
}

// 消息 → 动作。state = { allowUsers:Set, hasHistory }
function route(message, state) {
  if (message.type === 'event') return { kind: message.event === 'enter_agent' && !state.hasHistory ? 'help' : 'ignore' };
  if (state.allowUsers.size && !state.allowUsers.has(message.from)) return { kind: 'deny' };
  if (['file', 'image'].includes(message.type)) return { kind: 'file' };
  if (message.type === 'voice' && !message.text) return { kind: 'reply', text: '语音没有转成文字，请打字或在企业微信里开启语音转文字。' };
  if (message.type === 'video') return { kind: 'reply', text: '暂不处理视频，请发文件或文字。' };
  if (!['text', 'voice'].includes(message.type)) return { kind: 'ignore' };
  const parsed = parseText(message.text);
  if (parsed.kind === 'append' && !parsed.text) return { kind: 'ignore' };
  return parsed;
}

// 草稿里的多条内容合成一段给 AI 的需求。
function composeDraft(texts) {
  const items = texts.map((text) => String(text).trim()).filter(Boolean);
  if (items.length <= 1) return items[0] || '';
  return items.map((text, index) => `${index + 1}. ${text}`).join('\n');
}

module.exports = { TIERS, TIER_LABEL, HELP, START_WORDS, parseText, route, composeDraft };
