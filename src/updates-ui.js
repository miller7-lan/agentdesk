(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskUpdates = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The update dialog. What each button may do in each state is decided here from the state the main process sends
  // (updates.js); the main process checks again on every click, so this only decides what is clickable and shown.

  const STATUS_TEXT = {
    disabled: '此安装不支持在应用内更新（开发版本，或系统不受支持）。',
    idle: '尚未检查更新。',
    checking: '正在检查更新…',
    current: '当前已是最新版本。',
    available: '发现新版本。',
    downloading: '正在下载更新…',
    download_failed: '下载失败，可以重试。',
    ready: '下载完成，等待安装。',
    deferred_busy: '有任务正在运行，暂缓更新。',
    installing: '正在安装更新，AgentDesk 将重新启动…',
    install_failed: '更新失败，当前版本仍可正常使用。',
    updated: '更新成功。',
  };
  const ERROR_TEXT = {
    network: '网络或主控线路不可用',
    no_control_channel: '此电脑没有连接主控线路，无法获取更新',
    server_unsupported: '服务器或 Mac Bridge 版本过旧，暂不支持更新（Bridge 需要单独升级）',
    checksum_mismatch: '更新包校验失败，已拒绝',
    signature_invalid: '更新包签名校验失败，已拒绝',
    invalid_metadata: '服务器提供的更新信息无效',
    feed_mismatch: '更新信息与服务器清单不一致',
    transfer: '传输中断',
    version_unchanged: '重新启动后版本没有变化，可能安装被取消或失败',
    cancelled: '下载已取消',
    failed: '未知错误',
  };

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '未知';
    if (value < 1024) return value + ' B';
    const units = ['KB', 'MB', 'GB'];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return size.toFixed(size >= 100 ? 0 : 1) + ' ' + units[unit];
  }

  function formatSeconds(value) {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value < 60) return value + ' 秒';
    if (value < 3600) return Math.ceil(value / 60) + ' 分钟';
    return (value / 3600).toFixed(1) + ' 小时';
  }

  // Which buttons are clickable (the table agreed in the plan, D5). "重启并更新" is never clickable while a task runs
  // or the task state cannot be confirmed, and there is no override.
  function buttonsFor(state) {
    const status = state?.status || 'disabled';
    const manual = state?.manualInstall === true;
    const b = { check: false, download: false, retry: false, later: false, install: false, reveal: false, watch: false };
    switch (status) {
      case 'idle': case 'current': case 'updated': b.check = true; break;
      case 'available': Object.assign(b, { check: true, download: true, later: !state.deferred }); break;
      case 'downloading': b.later = true; break;
      case 'download_failed': Object.assign(b, { check: true, retry: true, later: true }); break;
      case 'ready': Object.assign(b, { check: true, later: !state.deferred, install: !manual, reveal: manual }); break;
      case 'deferred_busy': Object.assign(b, { check: true, later: true, watch: true }); break;
      case 'install_failed': Object.assign(b, { check: true, retry: false, later: true }); break;
      default: break;
    }
    return b;
  }

  function describe(state) {
    const status = state?.status || 'disabled';
    const lines = [];
    if (state?.currentVersion) lines.push('当前版本 ' + state.currentVersion);
    if (state?.targetVersion) {
      lines.push('目标版本 ' + state.targetVersion + (state.commit ? '（' + state.commit + '）' : '') +
        (state.targetSigned ? '，已签名' : '，未签名测试版'));
      if (Number.isFinite(state.size)) lines.push('更新包大小 ' + formatBytes(state.size));
    }
    const progress = state?.progress;
    let progressText = '';
    if (status === 'downloading' && progress) {
      progressText = Math.round(progress.percent) + '%，' + formatBytes(progress.transferred) + ' / ' + formatBytes(progress.total);
      if (progress.bytesPerSecond) progressText += '，' + formatBytes(progress.bytesPerSecond) + '/s';
      const eta = formatSeconds(progress.etaSeconds);
      if (eta) progressText += '，约剩 ' + eta;
    }
    const downloaded = state?.downloaded;
    if (downloaded && ['ready', 'deferred_busy', 'installing'].includes(status)) {
      const mode = downloaded.differential === true ? '差分下载' : downloaded.differential === false ? '完整下载' : '下载方式未知';
      lines.push(mode + '：经主控线路传输 ' + (Number.isFinite(downloaded.installerBytesFromServer)
        ? formatBytes(downloaded.installerBytesFromServer) : '未知') + '，完整包 ' + formatBytes(downloaded.fullSize));
    }
    const reasons = status === 'deferred_busy' || state?.gate ? (state.gate?.reasons || []) : [];
    let notice = '';
    if (status === 'ready' && state.manualInstall) notice = '此版本需要手动安装：macOS 未签名的应用不能由更新器安装。请打开下载位置，退出 AgentDesk 后用新版本替换。';
    else if (status === 'ready' && state.targetSigned === false) notice = '这是未签名的测试版本。只有在你点击「重启并更新」且所有任务都已结束时才会安装。';
    if (status === 'deferred_busy') notice = state.gate?.state === 'unknown'
      ? '无法确认任务状态，暂不能安装。确认以下各项结束后再试：'
      : '以下任务仍在运行，结束后才能安装：';
    if (state?.tasksFinished) notice = '任务都已结束，可以重启并更新。';
    if (state?.withdrawn) notice = '该版本已被服务器撤回，不再安装。';
    const error = state?.error || state?.checkError;
    return {
      status, title: STATUS_TEXT[status] || STATUS_TEXT.disabled, lines, progressText,
      percent: status === 'downloading' && progress ? Math.max(0, Math.min(100, progress.percent)) : null,
      reasons, notice, error: error ? (ERROR_TEXT[error] || ERROR_TEXT.failed) : '',
      autoDownload: state?.autoDownload === true, autoDownloadAvailable: state?.signedBuild === true,
    };
  }

  function mount(document, api) {
    const $ = (id) => document.getElementById(id);
    const open = $('updatesOpen');
    const dialog = $('updatesDialog');
    if (!open || !dialog || !api) return null;
    const els = {
      title: $('updatesTitleStatus'), lines: $('updatesLines'), bar: $('updatesProgress'), progress: $('updatesProgressText'),
      notice: $('updatesNotice'), reasons: $('updatesReasons'), error: $('updatesError'), auto: $('updatesAutoDownload'),
      buttons: {
        check: $('updatesCheckNow'), download: $('updatesDownload'), retry: $('updatesRetry'), later: $('updatesLater'),
        install: $('updatesInstall'), reveal: $('updatesReveal'), watch: $('updatesWatch'),
      },
    };
    let state = { status: 'disabled' };
    let busy = false;
    function render(next) {
      state = next || state;
      const view = describe(state);
      els.title.textContent = view.title;
      els.lines.replaceChildren(...view.lines.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
      els.bar.hidden = view.percent === null;
      if (view.percent !== null) els.bar.value = view.percent;
      els.progress.textContent = view.progressText;
      els.notice.textContent = view.notice;
      els.reasons.replaceChildren(...view.reasons.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
      els.error.textContent = view.error;
      els.auto.checked = view.autoDownload;
      els.auto.disabled = !view.autoDownloadAvailable;
      els.auto.title = view.autoDownloadAvailable ? '' : '未签名的版本不会自动下载更新';
      const allowed = buttonsFor(state);
      for (const [name, button] of Object.entries(els.buttons)) {
        button.disabled = busy || !allowed[name];
        button.hidden = (name === 'reveal' && !state.manualInstall) || (name === 'watch' && state.status !== 'deferred_busy') ||
          (name === 'install' && state.manualInstall === true);
      }
      open.classList.toggle('has-update', ['available', 'ready', 'deferred_busy'].includes(state.status));
    }
    const act = (name, call) => els.buttons[name].addEventListener('click', async () => {
      busy = true;
      render();
      try { const result = await call(); if (result && result.status) state = result; } catch {}
      busy = false;
      render(await api.state().catch(() => state));
    });
    act('check', () => api.check());
    act('download', () => api.download());
    act('retry', () => api.retry());
    act('later', () => api.later());
    act('install', () => api.install());
    act('reveal', () => api.reveal());
    act('watch', () => api.watch());
    els.auto.addEventListener('change', async () => {
      const result = await api.setAutoDownload(els.auto.checked).catch(() => null);
      if (!result?.ok) els.auto.checked = !els.auto.checked;
      render(await api.state().catch(() => state));
    });
    api.onState((next) => render(next));
    open.hidden = false;
    open.addEventListener('click', async () => {
      render(await api.state().catch(() => state));
      dialog.showModal();
    });
    if (typeof window !== 'undefined') window.addEventListener('online', () => api.online());
    api.state().then(render, () => render());
    return { render };
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.desk && window.desk.updates) {
    mount(document, window.desk.updates);
  }

  return { buttonsFor, describe, formatBytes, mount, STATUS_TEXT };
});
