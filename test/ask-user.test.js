'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ASK_TOOL, QUESTION_TIMEOUT, normalizeQuestions, formatAnswer } = require('../orchestrator/ask-user');

test('agentdesk_ask_user: 15-minute wait, read-only, schema with multiSelect', () => {
  assert.equal(QUESTION_TIMEOUT, 15 * 60_000);
  assert.equal(ASK_TOOL.annotations.readOnlyHint, true);
  assert.equal(ASK_TOOL.inputSchema.properties.questions.items.properties.multiSelect.type, 'boolean');
});

test('questions are numbered, trimmed, de-duplicated and limited', () => {
  const questions = normalizeQuestions({ questions: [
    { question: '  哪个？ ', header: 'H', options: [{ label: 'A', description: 'd' }, 'B', { label: 'B' }, { label: '' }] },
    { question: '' },
    { question: '多选', multiSelect: true, options: Array.from({ length: 12 }, (_, i) => 'o' + i) },
  ] });
  assert.deepEqual(questions.map((q) => q.id), ['q1', 'q2']);
  assert.equal(questions[0].question, '哪个？');
  assert.deepEqual(questions[0].options, [{ label: 'A', description: 'd' }, { label: 'B' }]);
  assert.equal(questions[0].isOther, true);
  assert.equal(questions[1].multiSelect, true);
  assert.equal(questions[1].options.length, 8);
  assert.throws(() => normalizeQuestions({ questions: [] }), /至少一个问题/);
  assert.equal(normalizeQuestions({ questions: Array.from({ length: 14 }, (_, i) => ({ question: 'q' + i })) }).length, 10);
});

test('answers and skips read naturally for the model', () => {
  const questions = normalizeQuestions({ questions: [{ question: '颜色？' }, { question: '功能？', multiSelect: true }] });
  const text = formatAnswer(questions, { answers: { q1: { answers: ['蓝'] }, q2: { answers: ['导出', '打印'] } } });
  assert.match(text, /颜色？\n   → 蓝/);
  assert.match(text, /导出；打印/);
  assert.match(formatAnswer(questions, { answers: {}, cancelled: true }), /跳过/);
  assert.match(formatAnswer(questions, { answers: {} }), /跳过/);
  assert.match(formatAnswer(questions, { answers: { q1: { answers: ['红'] } } }), /未回答/);
});
