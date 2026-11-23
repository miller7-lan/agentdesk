const test = require('node:test');
const assert = require('node:assert/strict');
const { parseText, route, composeDraft } = require('../orchestrator/wechat/router');

const me = 'zhangsan';
const base = { allowUsers: new Set([me]) };
const text = (content, from = me) => ({ type: 'text', from, text: content });

test('开始 starts, optionally with a tier; sentences that begin with 开始 are content', () => {
  assert.deepEqual(parseText('开始'), { kind: 'start', tier: null });
  assert.deepEqual(parseText('/开始'), { kind: 'start', tier: null });
  assert.deepEqual(parseText('开始 高'), { kind: 'start', tier: 'high' });
  assert.deepEqual(parseText('开始低'), { kind: 'start', tier: 'low' });
  assert.deepEqual(parseText('开始做一个季度PPT'), { kind: 'append', text: '开始做一个季度PPT' });
});

test('tier commands set the tier and may carry content', () => {
  assert.deepEqual(parseText('/低'), { kind: 'tier', tier: 'low', text: '' });
  assert.deepEqual(parseText('/高 写方案'), { kind: 'tier', tier: 'high', text: '写方案' });
  assert.deepEqual(parseText('／中做个表'), { kind: 'tier', tier: 'mid', text: '做个表' });
  assert.deepEqual(parseText('/M 做 PPT'), { kind: 'tier', tier: 'mid', text: '做 PPT' });
});

test('task commands', () => {
  assert.deepEqual(parseText('/进 12'), { kind: 'enter', id: 12 });
  assert.deepEqual(parseText('/切 #3'), { kind: 'enter', id: 3 });
  assert.deepEqual(parseText('/新'), { kind: 'fresh' });
  assert.deepEqual(parseText('/清空'), { kind: 'clear' });
  assert.deepEqual(parseText('/重试 4'), { kind: 'retry', id: 4 });
  assert.deepEqual(parseText('/s 12'), { kind: 'show', id: 12 });
  assert.deepEqual(parseText('/stop #3'), { kind: 'stop', id: 3 });
  assert.deepEqual(parseText('/进'), { kind: 'list' });
  assert.deepEqual(parseText('/ls'), { kind: 'list' });
  assert.deepEqual(parseText('/usr/bin 路径是什么'), { kind: 'append', text: '/usr/bin 路径是什么' });
  assert.deepEqual(parseText('帮我做个周报'), { kind: 'append', text: '帮我做个周报' });
  assert.deepEqual(parseText('你好'), { kind: 'greet' });
  assert.deepEqual(parseText('你好，帮我做个周报'), { kind: 'append', text: '你好，帮我做个周报' });
  assert.deepEqual(parseText('/问 今天几号'), { kind: 'ask', text: '今天几号' });
  assert.deepEqual(parseText('/重发 5'), { kind: 'resend', id: 5 });
});

test('route denies strangers and handles media and events', () => {
  assert.equal(route(text('hi', 'lisi'), base).kind, 'deny');
  assert.equal(route({ type: 'event', event: 'enter_chat', from: me, chatType: 'single' }, base).kind, 'welcome');
  assert.equal(route({ type: 'event', event: 'disconnected_event', from: '' }, base).kind, 'kicked');
  assert.equal(route(text('hi'), { allowUsers: new Set() }).kind, 'deny');                  // 白名单为空 = 全部拒绝
  assert.equal(route({ ...text('做个表'), chatType: 'group', chatId: 'g1' }, base).kind, 'reply');   // 群里不处理任务
  assert.equal(route({ type: 'file', from: me, mediaId: 'm' }, base).kind, 'file');
  assert.equal(route({ type: 'image', from: me, mediaId: 'm' }, base).kind, 'file');
  assert.equal(route({ type: 'voice', from: me }, base).kind, 'reply');
  assert.deepEqual(route({ type: 'voice', from: me, text: '做个表' }, base), { kind: 'append', text: '做个表' });
  assert.equal(route(text('   '), base).kind, 'ignore');
});

test('composeDraft numbers multiple messages', () => {
  assert.equal(composeDraft(['只有一条']), '只有一条');
  assert.equal(composeDraft(['按部门汇总', '加柱状图', ' ']), '1. 按部门汇总\n2. 加柱状图');
});
