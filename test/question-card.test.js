'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/question-card');

const codex = { questions: [
  { id: 'scope', header: '范围', question: '改哪些文件？', isOther: false, options: [{ label: '只改 A', description: '最小' }, { label: '全部' }] },
  { id: 'token', header: '口令', question: '测试口令？', isSecret: true, isOther: true, options: null },
] };

test('titles follow the agent', () => {
  assert.equal(Q.title('codex'), 'Codex 有问题要问你');
  assert.equal(Q.title('claude'), 'Claude 想确认几件事');
  assert.equal(Q.title('grok'), 'Grok 需要你选择');
  assert.equal(Q.title('antigravity'), 'Antigravity 需要你选择');
});

test('normalize keeps ids, limits sizes, allows typing when there are no options', () => {
  const qs = Q.normalize(codex);
  assert.deepEqual(qs.map((q) => q.id), ['scope', 'token']);
  assert.equal(qs[0].isOther, false);
  assert.equal(qs[1].isOther, true);
  assert.equal(qs[1].isSecret, true);
  const many = Q.normalize({ questions: Array.from({ length: 13 }, () => ({ id: 'x', question: 'q', options: Array.from({ length: 11 }, (_, i) => 'o' + i) })) });
  assert.equal(many.length, 10);
  assert.equal(new Set(many.map((q) => q.id)).size, 10);
  assert.equal(many[0].options.length, 8);
});

test('every question is answered separately; multi-select and own answers', () => {
  const qs = Q.normalize({ questions: [
    { id: 'a', question: '单选', options: ['x', 'y'], isOther: true },
    { id: 'b', question: '多选', multiSelect: true, options: ['m', 'n'], isOther: true },
  ] });
  assert.deepEqual(Q.answer(qs, { a: { selected: ['y', 'x'] }, b: { selected: ['m', 'n', 'zz'], other: '自填' } }),
    { answers: { a: { answers: ['y'] }, b: { answers: ['m', 'n', '自填'] } } });
  assert.deepEqual(Q.answer(qs, { a: { selected: ['x'], other: '别的' }, b: { selected: [] } }), { missing: [1] });
  assert.deepEqual(Q.answer(qs, { a: { selected: ['x'], other: '别的' }, b: { selected: ['n'] } }).answers.a, { answers: ['别的'] });
});

test('all questions render on one page, with no "remember" option, and secrets stay hidden in the summary', () => {
  const item = { t: 'question', agent: 'codex', state: 'pending', questions: Q.normalize({ questions: [
    ...Array.from({ length: 9 }, (_, i) => ({ id: 'q' + i, question: '问题' + i, options: ['是', '否'] })), codex.questions[1]] }) };
  const html = Q.render(item, 3);
  assert.equal((html.match(/<fieldset/g) || []).length, 10);
  assert.doesNotMatch(html, /不再询问|remember/);
  assert.match(html, /type="password"/);
  assert.match(html, /跳过/);
  const summary = Q.summary(item.questions, { token: { answers: ['hunter2'] }, q0: { answers: ['是'] } });
  assert.equal(summary.at(-1).answer, '••••');
  assert.equal(summary[0].answer, '是');
  const done = Q.render({ ...item, state: 'answered', summary }, 3);
  assert.doesNotMatch(done, /hunter2/);
  assert.match(done, /已回答/);
});

test('text from the model is escaped', () => {
  const html = Q.render({ agent: 'claude', state: 'pending', questions: Q.normalize({ questions: [{ question: '<img src=x onerror=alert(1)>', options: ['"><b>'] }] }) }, 0);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /"><b>/);
});

test('picksFrom reads checked options and own answers', () => {
  const inputs = [
    { q: '0', value: 'x', checked: true }, { q: '0', value: 'y', checked: false },
    { q: '1', value: 'm', checked: true }, { q: '1', value: 'n', checked: true },
  ];
  const form = {
    querySelectorAll: (sel) => inputs.filter((i) => sel.includes(`"${i.q}"`) && i.checked),
    querySelector: (sel) => (sel.includes('"1"') ? { value: ' 自填 ' } : null),
  };
  const qs = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(Q.picksFrom(form, qs), { a: { selected: ['x'], other: '' }, b: { selected: ['m', 'n'], other: ' 自填 ' } });
});
