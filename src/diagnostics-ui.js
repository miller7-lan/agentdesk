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
  // "检查更新" opens the update dialog (updates-ui.js), where every update action lives.
  $('updatesCheck').addEventListener('click', () => {
    dialog.close();
    document.getElementById('updatesOpen')?.click();
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
