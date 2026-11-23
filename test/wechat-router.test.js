const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, route, composeDraft, HELP } = require('../orchestrator/wechat/router');

const me = 'zhangsan';
const at = (stage) => ({ allowUsers: new Set([me]), stage });
const text = (content, from = me) => ({ type: 'text', from, chatType: 'single', text: content });
const file = { type: 'file', from: me, chatType: 'single', media: { url: 'u' }, fileName: 'a.xlsx' };

test('numbered commands are "/" plus digit, no space needed', () => {
  assert.deepEqual(parseCommand('/0'), { kind: 'help' });
  assert.deepEqual(parseCommand('/1'), { kind: 'list' });
  assert.deepEqual(parseCommand('/2'), { kind: 'cancel' });
  assert.deepEqual(parseCommand('/3今天星期几'), { kind: 'ask', text: '今天星期几' });
  assert.equal(parseCommand('/3').kind, 'reply');
  assert.deepEqual(parseCommand('／1'), { kind: 'list' });
});

test('task commands take the id right after the word', () => {
  assert.deepEqual(parseCommand('/进12'), { kind: 'enter', id: 12 });
  assert.deepEqual(parseCommand('/看12'), { kind: 'show', id: 12 });
  assert.deepEqual(parseCommand('/停3'), { kind: 'stop', id: 3 });
  assert.deepEqual(parseCommand('/重试4'), { kind: 'retry', id: 4 });
  assert.deepEqual(parseCommand('/重发5'), { kind: 'resend', id: 5 });
  assert.deepEqual(parseCommand('/进 #12'), { kind: 'enter', id: 12 });          // 带空格和 # 也认
  assert.match(parseCommand('/进').text, /\/进12/);
  assert.deepEqual(parseCommand('/乱写'), { kind: 'unknown' });
  assert.deepEqual(parseCommand('你好'), { kind: 'greet' });
  assert.equal(parseCommand('帮我做个表'), null);
});

test('help lists every command with its mapping', () => {
  for (const line of ['/0 → ', '/1 → ', '/2 → ', '/3问题 → ', '/进12 → ', '/看12 → ', '/停12 → ', '/重试12 → ', '/重发12 → ']) assert.ok(HELP.includes(line), line);
});

test('idle: content begins a task, a digit picks the tier', () => {
  assert.deepEqual(route(text('做一个季度汇报 PPT'), at('idle')), { kind: 'append', text: '做一个季度汇报 PPT' });
  assert.deepEqual(route(text('2'), at('idle')), { kind: 'tier', tier: 'mid' });
  assert.equal(route(file, at('idle')).kind, 'file');
});

test('tier stage accepts 1/2/3 only and re-prompts anything else', () => {
  assert.deepEqual(route(text('1'), at('tier')), { kind: 'tier', tier: 'low' });
  assert.deepEqual(route(text('3。'), at('tier')), { kind: 'tier', tier: 'high' });
  assert.deepEqual(route(text('高'), at('tier')), { kind: 'tier', tier: 'high' });
  assert.deepEqual(route(text('4'), at('tier')), { kind: 'remind', why: 'tier' });
  assert.deepEqual(route(text('随便'), at('tier')), { kind: 'remind', why: 'tier' });
  assert.equal(route(file, at('tier')).kind, 'file');                            // 文件先收下，再提示选档
});

test('collect: content appends, 开始 asks for a plan; 完成 here is a mistake', () => {
  assert.deepEqual(route(text('加一页总结'), at('collect')), { kind: 'append', text: '加一页总结' });
  assert.deepEqual(route(text('开始'), at('collect')), { kind: 'start' });
  assert.deepEqual(route(text('/开始'), at('collect')), { kind: 'start' });
  assert.deepEqual(route(text('完成'), at('collect')), { kind: 'append', text: '完成' });
  assert.deepEqual(route(text('3'), at('collect')), { kind: 'tier', tier: 'high' });
  assert.deepEqual(route(text('/完成'), at('collect')), { kind: 'remind', why: 'confirm' });
});

test('planning: everything waits; review: feedback revises, 完成 submits, digits change tier', () => {
  assert.deepEqual(route(text('快点'), at('planning')), { kind: 'wait' });
  assert.deepEqual(route(text('/1'), at('planning')), { kind: 'list' });           // 命令随时可用
  assert.deepEqual(route(text('标题改成年度总结'), at('review')), { kind: 'revise', text: '标题改成年度总结' });
  assert.deepEqual(route(text('完成'), at('review')), { kind: 'confirm' });
  assert.deepEqual(route(text('/完成'), at('review')), { kind: 'confirm' });
  assert.deepEqual(route(text('3'), at('review')), { kind: 'tier', tier: 'high' });
  assert.deepEqual(route(text('开始'), at('review')), { kind: 'remind', why: 'start' });
});

test('access: strangers denied, groups refused, events mapped', () => {
  assert.equal(route(text('hi', 'lisi'), at('idle')).kind, 'deny');
  assert.equal(route(text('hi'), { allowUsers: new Set(), stage: 'idle' }).kind, 'deny');
  assert.equal(route({ ...text('做个表'), chatType: 'group' }, at('idle')).kind, 'reply');
  assert.equal(route({ type: 'event', event: 'enter_chat', from: me, chatType: 'single' }, at('idle')).kind, 'welcome');
  assert.equal(route({ type: 'voice', from: me, chatType: 'single' }, at('idle')).kind, 'reply');
  assert.equal(route(text('  '), at('idle')).kind, 'ignore');
});

test('composeDraft numbers multiple messages', () => {
  assert.equal(composeDraft(['只有一条']), '只有一条');
  assert.equal(composeDraft(['按部门汇总', '加柱状图', ' ']), '1. 按部门汇总\n2. 加柱状图');
});
