(function () {
  const api = window.desk?.diagnostics;
  if (!api) return;
  const $ = (id) => document.getElementById(id);
  const open = $('diagnosticsOpen');
  const save = $('diagnosticsExport');
  const dialog = $('diagnosticsDialog');
  const status = $('diagnosticsStatus');
  const report = $('diagnosticsReport');

  open.hidden = false;
  open.addEventListener('click', async () => {
    dialog.showModal();
    report.textContent = '';
    status.textContent = '正在收集诊断信息…';
    save.disabled = true;
    try {
      const result = await api.preview();
      if (!result.ok) throw new Error(result.error);
      report.textContent = JSON.stringify(result.report, null, 2);
      status.textContent = `诊断包包含 ${result.logCount} 条应用日志和 ${result.auditCount} 条审计事件。`;
      save.disabled = false;
    } catch (error) {
      status.textContent = error.message || '无法生成预览。';
    }
  });
  const update = $('updatesCheck');
  update.addEventListener('click', async () => {
    update.disabled = true;
    try {
      const result = await window.desk.updates.check();
      status.textContent = {
        available: '发现更新 ' + (result.version || ''),
        current: '当前已是最新版本。',
        disabled: '此安装未启用更新检查。',
        unsupported: '此安装包不支持更新检查。',
        failed: '更新检查失败。',
      }[result.status];
    } finally { update.disabled = false; }
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const result = await api.export();
      if (result.ok) status.textContent = '诊断包已保存。';
      else if (!result.cancelled) status.textContent = result.error || '导出失败。';
    } finally { save.disabled = false; }
  });
})();
