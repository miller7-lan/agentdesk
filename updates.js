function feedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function createUpdateChecks({ app, settings, logger, platform = process.platform, createUpdater }) {
  const url = feedUrl(settings?.feedUrl);
  if (!app.isPackaged || settings?.enabled !== true || !url || !['darwin', 'win32'].includes(platform)) return null;
  const create = createUpdater || ((options) => {
    const { MacUpdater, NsisUpdater } = require('electron-updater');
    const Updater = platform === 'darwin' ? MacUpdater : NsisUpdater;
    return new Updater(options);
  });
  const updater = create({ provider: 'generic', url });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  // Updater messages may contain URLs or HTTP details. Record only the checked outcome.
  updater.logger = null;
  updater.on('error', () => {});
  let pending;

  function check() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await updater.checkForUpdates();
        const status = !result ? 'unsupported' : result.isUpdateAvailable ? 'available' : 'current';
        logger?.audit('update_check', { status });
        return { ok: true, status, ...(status === 'available' && { version: result.updateInfo?.version }) };
      } catch {
        logger?.audit('update_check', { status: 'failed' });
        return { ok: false, status: 'failed' };
      }
    })().finally(() => { pending = undefined; });
    return pending;
  }

  return { check };
}

module.exports = { createUpdateChecks, feedUrl };
