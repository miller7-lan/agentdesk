// The bar above the input of a single chat that works in its own Git worktree (session-worktrees.js):
// which branch it is on, and buttons to see the changes, merge them back or throw the worktree away.
(() => {
  const A = window.__desk;
  if (!A?.LIVE || !window.desk?.worktrees) { window.__worktreeBar = () => {}; return; }
  const { $, esc, sess, state, toast } = A;
  const bar = $('#worktreeBar');
  const api = window.desk.worktrees;
  let busy = false;

  const looked = new Set();
  function render(s) {
    // A conversation reopened after a restart finds its worktree again by its thread.
    if (s?.threadId && !s.worktree && !looked.has(s.threadId)) {
      looked.add(s.threadId);
      api.forThread(s.threadId).then((record) => { if (record) { s.worktree = record; s.localRoot = record.path; A.renderAll(); } });
    }
    const record = !state.group && s?.worktree;
    bar.hidden = !record;
    if (!record) return;
    const key = s.id + ':' + record.branch + ':' + busy;
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    bar.innerHTML = `<span class="wt-branch" title="${esc(record.path)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/></svg>${esc(record.branch)}<small>→ ${esc(record.baseBranch)}</small></span>
      <span class="grow"></span>
      <button type="button" class="wt-btn" data-wt="diff" ${busy ? 'disabled' : ''}>查看差异</button>
      <button type="button" class="wt-btn" data-wt="merge" ${busy ? 'disabled' : ''}>合回 ${esc(record.baseBranch)}</button>
      <button type="button" class="wt-btn danger" data-wt="discard" ${busy ? 'disabled' : ''}>丢弃</button>`;
  }

  function showDiff(result) {
    const dialog = document.createElement('dialog');
    dialog.className = 'worktree-diff';
    dialog.innerHTML = `<h2>工作树改动 · ${result.files.length} 个文件</h2>
      ${result.files.length ? `<ul class="mono">${result.files.slice(0, 50).map((file) => `<li>${esc(file)}</li>`).join('')}</ul><pre>${esc(result.text)}</pre>` : '<p>还没有改动。</p>'}
      <button class="btn" type="button">关闭</button>`;
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog); dialog.showModal();
  }

  bar.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-wt]')?.dataset.wt;
    const s = sess(state.active);
    if (!action || !s?.worktree || busy) return;
    if (s.busy && action !== 'diff') { toast('会话还在运行，结束后再合回或丢弃'); return; }
    if (action === 'merge' && !window.confirm(`把 ${s.worktree.branch} 的改动合回 ${s.worktree.baseBranch}？\n\n会先在工作树里提交未提交的改动，再合并到项目目录。项目目录需要是干净的；有冲突会撤回合并。`)) return;
    if (action === 'discard' && !window.confirm(`丢弃工作树 ${s.worktree.branch}？\n\n工作树目录和这个分支都会删除，里面未合回的改动会丢失。会话记录保留，之后改回在项目目录里工作。`)) return;
    busy = true; render(s);
    try {
      const r = await api[action](s.worktree.key || s.id);
      if (!r.ok) { toast((action === 'merge' ? '合回失败：' : action === 'discard' ? '丢弃失败：' : '读取差异失败：') + r.error); return; }
      if (action === 'diff') showDiff(r);
      if (action === 'merge') toast(r.merged ? `已合回 ${s.worktree.baseBranch}：${r.files.length} 个文件` : '没有新的改动需要合回');
      if (action === 'discard') {
        delete s.worktree;
        s.threadId = undefined;   // the next message starts a conversation in the project folder
        toast('已丢弃工作树；下一条消息会在项目目录里开新的会话');
        A.renderAll();
      }
    } finally {
      busy = false; bar.dataset.key = ''; render(sess(state.active));
    }
  });

  window.__worktreeBar = render;
})();
