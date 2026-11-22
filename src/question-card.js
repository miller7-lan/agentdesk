(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskQuestions = factory();
})(globalThis, function () {
  'use strict';
  // Question cards in a single chat (item/tool/requestUserInput, from Codex or from agentdesk_ask_user): every
  // question on one page, options to click, single or multiple choice, an own answer, skip. Not an approval: there is
  // no "remember for this session".
  const MAX_QUESTIONS = 10;
  const MAX_OPTIONS = 8;
  const NAMES = { codex: 'Codex', claude: 'Claude', grok: 'Grok', antigravity: 'Antigravity' };
  const TITLES = {
    codex: 'Codex 有问题要问你',
    claude: 'Claude 想确认几件事',
    grok: 'Grok 需要你选择',
    antigravity: 'Antigravity 需要你选择',
  };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

  function title(agent) { return TITLES[agent] || `${NAMES[agent] || 'AI'} 有问题要问你`; }

  function normalize(params) {
    const list = Array.isArray(params?.questions) ? params.questions.slice(0, MAX_QUESTIONS) : [];
    const ids = new Set();
    return list.map((item, index) => {
      let id = text(item?.id, 120) || 'q' + (index + 1);
      while (ids.has(id)) id += '_';
      ids.add(id);
      const seen = new Set();
      const options = (Array.isArray(item?.options) ? item.options : [])
        .map((option) => typeof option === 'string' ? { label: text(option, 200), description: '' }
          : { label: text(option?.label, 200), description: text(option?.description, 500) })
        .filter((option) => option.label && !seen.has(option.label) && seen.add(option.label))
        .slice(0, MAX_OPTIONS);
      return {
        id,
        header: text(item?.header, 60),
        question: text(item?.question, 2000) || text(item?.header, 2000) || '（没有问题文字）',
        multiSelect: item?.multiSelect === true,
        isSecret: item?.isSecret === true,
        // Without options the person can only type; Codex marks "other" explicitly, agentdesk_ask_user always allows it.
        isOther: item?.isOther === true || !options.length,
        options,
      };
    });
  }

  // picks: { [questionId]: { selected: [label…], other: '' } } → { answers } or { missing: [index…] }.
  function answer(questions, picks = {}) {
    const answers = {};
    const missing = [];
    questions.forEach((question, index) => {
      const pick = picks[question.id] || {};
      const labels = new Set(question.options.map((option) => option.label));
      const selected = (Array.isArray(pick.selected) ? pick.selected : []).filter((label) => labels.has(label));
      const values = question.multiSelect ? selected : selected.slice(0, 1);
      const other = question.isOther ? text(pick.other, 2000) : '';
      if (other) {
        if (question.multiSelect) values.push(other);
        else values.splice(0, values.length, other);
      }
      if (!values.length) missing.push(index);
      else answers[question.id] = { answers: values };
    });
    return missing.length ? { missing } : { answers };
  }

  // What the card shows after the answer went out (secrets stay hidden).
  function summary(questions, answers) {
    return questions.map((question) => {
      const values = answers?.[question.id]?.answers || [];
      const shown = question.isSecret ? (values.length ? '••••' : '') : values.join('；');
      return { question: question.question, answer: shown || '（未回答）' };
    });
  }

  function render(item, idx) {
    const pending = item.state === 'pending';
    const outcome = { answered: '已回答', skipped: '已跳过', expired: '已失效，未送达', sending: '提交中…' }[item.state] || '';
    const head = `<div class="question-title"><span>${esc(item.title || title(item.agent))}</span>${outcome
      ? `<span class="grow"></span><span class="verdict ${item.state === 'answered' ? 'ok' : 'no'}">${outcome}</span>` : ''}</div>`;
    if (!pending) {
      const rows = item.summary || [];
      return `<div class="question-card resolved" data-idx="${idx}">${head}${rows.length ? `<ol class="question-summary">${rows.map((row) =>
        `<li><span class="q">${esc(row.question)}</span><span class="a">${esc(row.answer)}</span></li>`).join('')}</ol>` : ''}</div>`;
    }
    const body = item.questions.map((question, qIndex) => {
      const name = `q${idx}-${qIndex}`;
      const type = question.multiSelect ? 'checkbox' : 'radio';
      const options = question.options.map((option, oIndex) => `<label class="question-option">
          <input type="${type}" name="${name}" value="${esc(option.label)}" data-q="${qIndex}" ${oIndex === 0 && qIndex === 0 ? 'data-first' : ''} />
          <span class="label">${esc(option.label)}</span>${option.description ? `<span class="desc">${esc(option.description)}</span>` : ''}</label>`).join('');
      const other = question.isOther ? `<input class="question-other" type="${question.isSecret ? 'password' : 'text'}" maxlength="2000"
          data-q="${qIndex}" data-other placeholder="${question.options.length ? '其他（自己填写）' : '填写你的回答'}" autocomplete="off" />` : '';
      return `<fieldset class="question-item${item.missing?.includes(qIndex) ? ' missing' : ''}" data-q="${qIndex}">
        <legend>${item.questions.length > 1 ? `<span class="question-no">${qIndex + 1}</span>` : ''}${question.header ? `<span class="question-header">${esc(question.header)}</span>` : ''}
          <span class="question-text">${esc(question.question)}</span>${question.multiSelect ? '<span class="question-hint">可多选</span>' : ''}</legend>
        ${options ? `<div class="question-options">${options}</div>` : ''}${other}</fieldset>`;
    }).join('');
    return `<form class="question-card" data-idx="${idx}" data-question-card>${head}
      <div class="question-list">${body}</div>
      <div class="question-actions">
        ${item.missing?.length ? '<span class="question-warn">还有问题没有回答</span>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-question-act="skip">跳过</button>
        <button type="submit" class="btn primary" data-question-act="submit">提交回答</button>
      </div></form>`;
  }

  // Reads a rendered card back into picks (DOM in the app; any object with querySelectorAll in tests).
  function picksFrom(form, questions) {
    const picks = {};
    questions.forEach((question, qIndex) => {
      const selected = [...form.querySelectorAll(`input[data-q="${qIndex}"]:checked`)].map((input) => input.value);
      const other = form.querySelector(`input[data-q="${qIndex}"][data-other]`)?.value || '';
      picks[question.id] = { selected, other };
    });
    return picks;
  }

  return { title, normalize, answer, summary, render, picksFrom, MAX_QUESTIONS, MAX_OPTIONS };
});
