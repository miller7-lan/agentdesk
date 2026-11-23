'use strict';
// agentdesk_ask_user: the question tool every chat-server CLI (Claude, Grok, Antigravity) can call when it needs the
// person to choose. chat-server turns the call into an item/tool/requestUserInput request (the same method Codex
// sends), the client shows a question card, and the answer comes back here as the tool result. Questions never
// count as approvals: nothing here is remembered for the session.

// How long a question waits for the person (owner decision: 15 minutes).
const QUESTION_TIMEOUT = Number(process.env.AGENTDESK_CHAT_QUESTION_TIMEOUT || 15 * 60_000);
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 8;

const ASK_TOOL = {
  name: 'agentdesk_ask_user',
  description: 'Ask the person one or more questions and wait for the answers (up to 15 minutes). Use it when you need ' +
    'the person to choose between options or to confirm details before you continue; do not list the options in ' +
    'your reply and stop instead. Give each question 2-8 short options when you can; the person can also type ' +
    'another answer. Set multiSelect when several options may be chosen. Returns the answers, or that the person skipped.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: MAX_QUESTIONS,
        items: {
          type: 'object', additionalProperties: false, required: ['question'],
          properties: {
            question: { type: 'string', description: 'The full question' },
            header: { type: 'string', description: 'A very short label (2-4 words)' },
            multiSelect: { type: 'boolean', description: 'Several options may be chosen' },
            options: {
              type: 'array', maxItems: MAX_OPTIONS,
              items: {
                type: 'object', additionalProperties: false, required: ['label'],
                properties: { label: { type: 'string' }, description: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  annotations: { readOnlyHint: true },
};

const text = (value, limit) => (typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, limit) : '');

// The tool arguments → the questions[] of item/tool/requestUserInput. Ids are assigned here (q1..qN).
function normalizeQuestions(args) {
  const list = Array.isArray(args?.questions) ? args.questions.slice(0, MAX_QUESTIONS) : [];
  const questions = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const question = text(item.question, 2000);
    if (!question) continue;
    const seen = new Set();
    const options = (Array.isArray(item.options) ? item.options : []).map((option) =>
      typeof option === 'string' ? { label: text(option, 200) } : { label: text(option?.label, 200), description: text(option?.description, 500) })
      .filter((option) => option.label && !seen.has(option.label) && seen.add(option.label))
      .slice(0, MAX_OPTIONS)
      .map((option) => (option.description ? option : { label: option.label }));
    questions.push({
      id: 'q' + (questions.length + 1),
      header: text(item.header, 60),
      question,
      multiSelect: item.multiSelect === true,
      isOther: true,
      options,
    });
  }
  if (!questions.length) throw new Error('agentdesk_ask_user 需要至少一个问题');
  return questions;
}

// The client's answer → the text the model reads.
function formatAnswer(questions, result) {
  const answers = result && typeof result.answers === 'object' && result.answers ? result.answers : {};
  if (result?.cancelled === true || !Object.keys(answers).length) {
    return '用户跳过了这些问题，没有作答。不要再问同样的问题；按你的最佳判断继续，或说明需要用户补充什么。';
  }
  return '用户的回答：\n' + questions.map((question, index) => {
    const values = Array.isArray(answers[question.id]?.answers)
      ? answers[question.id].answers.filter((value) => typeof value === 'string').map((value) => value.slice(0, 2000)) : [];
    return `${index + 1}. ${question.question}\n   → ${values.length ? values.join('；') : '（未回答）'}`;
  }).join('\n');
}

module.exports = { ASK_TOOL, QUESTION_TIMEOUT, MAX_QUESTIONS, MAX_OPTIONS, normalizeQuestions, formatAnswer };
