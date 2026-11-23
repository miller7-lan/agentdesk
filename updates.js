'use strict';
// Client updates: VPS2 announces a version (client_update over the existing SSH control channel), electron-updater
// downloads it through the loopback feed (update-transport.js) — differentially when its block maps allow, otherwise
// in full — and checks it (sha512; Authenticode when the app has a publisherName). Nothing here installs on its own:
// a finished download only becomes "ready", and installing needs the person's click plus the main-process safety gate
// (update-gate.js) twice, after which the app quits through electron-updater's installer. Exiting the app normally
// never installs (autoInstallOnAppQuit stays false), and a server cannot make a client restart.

const { validateManifest, updateDecision, compareVersions } = require('./orchestrator/update-manifest');
const { loopbackFeedUrl } = require('./update-transport');

const DAY = 24 * 60 * 60_000;
const FIRST_CHECK = 30_000;
const NETWORK_RECHECK_GAP = 10 * 60_000;
const SERVER_NOTICE_GAP = 60_000;
const GATE_WATCH = 30_000;

const STATES = new Set(['idle', 'checking', 'current', 'available', 'downloading', 'download_failed', 'ready', 'deferred_busy',
  'installing', 'install_failed', 'updated', 'disabled']);

// Error categories only: updater messages can carry URLs, paths or HTTP details, which never reach logs or the UI.
function errorCategory(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'signature_invalid';
  if (/sha512 checksum mismatch|checksum/i.test(message)) return 'checksum_mismatch';
  if (code === 'ERR_UPDATER_INVALID_VERSION' || /invalid_manifest|manifest_/.test(message)) return 'invalid_metadata';
  if (/feed_mismatch/.test(message)) return 'feed_mismatch';
  if (/cancel/i.test(message) || error?.name === 'CancellationError') return 'cancelled';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|net::|bridge_offline|sign_in_required|timeout/i.test(code + ' ' + message)) return 'network';
  if (/update_read|invalid_update_chunk|update_file|update_version/i.test(message)) return 'transfer';
  if (/unsupported_operation/.test(message)) return 'server_unsupported';
  if (/无权操作主控线路/.test(message)) return 'no_control_channel';
  return 'failed';
}

// The updater's own log lines are dropped except the two that say how a download went; those are reduced to numbers.
function updaterLog(report) {
  const sink = (line) => {
    const text = String(line || '');
    const sizes = /Full: ([\d,.]+) KB, To download: ([\d,.]+) KB/.exec(text);
    if (sizes) {
      report.updaterFullKB = Number(sizes[1].replace(/,/g, ''));
      report.updaterDownloadKB = Number(sizes[2].replace(/,/g, ''));
    }
    if (/fallback to full download/i.test(text)) report.updaterFallback = true;
  };
  return { info: sink, warn: sink, error: sink, debug: () => {} };
}

function createUpdateManager({
  app, platform = process.platform, arch = process.arch, buildInfo = {}, settings = {}, logger, transport, createUpdater,
  gate, prepareForQuit, abortPrepare, stateStore, snapshotData, reveal, newCancellationToken, onState = () => {}, timers = globalThis,
  now = Date.now,
  // How long to wait for the app to quit after handing over to the installer. On macOS, Squirrel first copies the
  // downloaded zip from electron-updater's local server, so it gets longer.
  installTimeout = platform === 'darwin' ? 10 * 60_000 : 60_000,
}) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : null;
  const supported = Boolean(app.isPackaged && os && transport);
  const signedBuild = buildInfo.signed === true;
  // D2: only signed builds check on their own and download by themselves; unsigned builds check when asked or when
  // VPS2 announces a version (Q3), and download only on the person's click.
  const automaticChecks = signedBuild && settings.autoCheck !== false;
  let autoDownload = signedBuild && settings.autoDownload !== false;
  let state = { status: supported ? 'idle' : 'disabled', currentVersion: app.getVersion(), signedBuild, autoDownload };
  let manifest;
  let updater;
  let downloadedFile;
  let checking;
  let downloading;
  let cancelToken;
  let installing = false;
  let lastCheckAt = 0;
  let lastServerNoticeAt = 0;
  let timer;
  let watchTimer;
  let stopped = false;

  function set(status, fields = {}) {
    if (!STATES.has(status)) throw new Error('invalid_update_state');
    const keep = { currentVersion: state.currentVersion, signedBuild, autoDownload };
    state = { ...keep, ...(manifest && !['current', 'disabled', 'checking', 'updated'].includes(status) && {
      targetVersion: manifest.version, size: manifest.installer.size, targetSigned: manifest.signed,
      commit: manifest.commit.slice(0, 12), ...(manifest.notes && { notes: manifest.notes }),
      manualInstall: platform === 'darwin' && !(signedBuild && manifest.signed),
    }), ...fields, status, at: now() };
    try { onState({ ...state }); } catch {}
    return { ...state };
  }

  async function fetchManifest() {
    const reply = await transport.manifest({ platform: os, arch, appVersion: app.getVersion() });
    if (!reply?.ok) throw new Error(reply?.error || 'update_check_failed');
    if (!reply.value || reply.value.available === false) return null;
    const checked = validateManifest(reply.value.manifest ?? reply.value, { platform: os, arch });
    if (!checked.ok) throw new Error(checked.error);
    return checked.manifest;
  }

  function check({ reason = 'manual' } = {}) {
    if (!supported) return Promise.resolve(set('disabled'));
    if (downloading || installing || ['downloading', 'installing'].includes(state.status)) return Promise.resolve({ ...state });
    if (checking) return checking;
    checking = (async () => {
      const previous = state;
      set('checking');
      lastCheckAt = now();
      try {
        const found = await fetchManifest();
        if (!found || !updateDecision(app.getVersion(), found).update) {
          manifest = undefined;
          updater = undefined;
          logger?.audit('update_check', { status: 'current', reason });
          return set('current');
        }
        if (previous.status === 'ready' && manifest?.version === found.version && manifest.installer.sha512 === found.installer.sha512) {
          logger?.audit('update_check', { status: 'ready', reason, version: found.version });
          return set('ready', { downloaded: previous.downloaded });
        }
        manifest = found;
        updater = undefined;
        logger?.audit('update_check', { status: 'available', reason, version: found.version, signed: found.signed });
        const result = set('available');
        if (autoDownload && found.signed) queueMicrotask(() => download({ automatic: true }).catch(() => {}));
        return result;
      } catch (error) {
        logger?.audit('update_check', { status: 'failed', reason, error: errorCategory(error) });
        if (previous.status === 'ready') return set('ready', { downloaded: previous.downloaded, checkError: errorCategory(error) });
        return set(manifest ? 'available' : 'idle', { checkError: errorCategory(error) });
      }
    })().finally(() => { checking = undefined; });
    return checking;
  }

  function download({ automatic = false } = {}) {
    if (!supported) return Promise.resolve({ ok: false, error: 'disabled' });
    if (downloading) return downloading;
    if (!manifest || !['available', 'download_failed'].includes(state.status)) return Promise.resolve({ ok: false, error: 'nothing_to_download' });
    if (automatic && !(autoDownload && manifest.signed)) return Promise.resolve({ ok: false, error: 'manual_download_required' });
    const target = manifest;
    downloading = (async () => {
      const report = {};
      const started = now();
      const samples = [];
      let feed;
      set('downloading', { progress: { percent: 0, transferred: 0, total: target.installer.size, bytesPerSecond: null, etaSeconds: null } });
      logger?.audit('update_download', { status: 'started', version: target.version, automatic });
      try {
        feed = await transport.openFeed(target);
        const url = loopbackFeedUrl(feed.url);
        if (!url) throw new Error('feed_mismatch');
        const manualInstall = platform === 'darwin' && !(signedBuild && target.signed);
        updater = createUpdater({ provider: 'generic', url, useMultipleRangeRequest: false, channel: 'latest' }, { manualInstall });
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowDowngrade = false;
        updater.allowPrerelease = false;
        updater.requestHeaders = { ...(feed.headers || {}) };
        updater.logger = updaterLog(report);
        updater.on('error', () => {});
        // The downloaded file's path also comes with this event; MacUpdater resolves downloadUpdate() without it.
        let eventFile;
        updater.on('update-downloaded', (info) => { if (typeof info?.downloadedFile === 'string') eventFile = info.downloadedFile; });
        updater.on('download-progress', (progress) => {
          samples.push(progress.bytesPerSecond);
          const total = Number(progress.total) || 0;
          const transferred = Number(progress.transferred) || 0;
          const speed = samples.length >= 3 && progress.bytesPerSecond > 0 ? Math.round(progress.bytesPerSecond) : null;
          set('downloading', { progress: {
            percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)), transferred, total,
            bytesPerSecond: speed, etaSeconds: speed && total > transferred ? Math.ceil((total - transferred) / speed) : null,
          } });
        });
        const result = await updater.checkForUpdates();
        if (!result?.updateInfo || result.updateInfo.version !== target.version || result.isUpdateAvailable === false) {
          throw new Error('feed_mismatch');
        }
        cancelToken = newCancellationToken?.();
        const files = await updater.downloadUpdate(cancelToken);
        const listed = Array.isArray(files) && typeof files[0] === 'string' ? files[0] : undefined;
        const file = listed || eventFile;
        downloadedFile = file;
        const fromServer = feed.stats?.perFile?.[target.installer.name] ?? null;
        const ranged = (feed.stats?.rangeRequests || 0) > 0;
        // Measured on this side of the feed: what actually came from VPS2 for the installer. Differential is reported
        // as such only when range requests were made and less than the whole installer crossed the channel.
        const differential = fromServer === null ? 'unknown'
          : ranged && fromServer < target.installer.size ? true
            : !ranged && fromServer >= target.installer.size ? false
              : fromServer === 0 ? 'unknown' : (report.updaterFallback ? false : 'unknown');
        const downloaded = {
          file, fullSize: target.installer.size, bytesFromServer: feed.stats?.bytesFromServer ?? null,
          installerBytesFromServer: fromServer, differential, fallback: report.updaterFallback === true,
          ...(report.updaterFullKB !== undefined && { updaterReport: { fullKB: report.updaterFullKB, downloadKB: report.updaterDownloadKB } }),
          seconds: Math.round((now() - started) / 1000),
        };
        logger?.audit('update_download', { status: 'ok', version: target.version, differential: String(differential),
          fullSize: target.installer.size, bytes: downloaded.bytesFromServer, fallback: downloaded.fallback });
        const { file: _path, ...visible } = downloaded;
        set('ready', { downloaded: visible });
        return { ok: true };
      } catch (error) {
        const category = errorCategory(error);
        logger?.audit('update_download', { status: category === 'cancelled' ? 'cancelled' : 'failed', version: target.version, error: category });
        updater = category === 'cancelled' ? undefined : updater;
        if (category === 'cancelled') { set('available', { deferred: true }); return { ok: false, error: category }; }
        set('download_failed', { error: category });
        return { ok: false, error: category };
      } finally {
        cancelToken = undefined;
        await feed?.close?.().catch?.(() => {});
      }
    })().finally(() => { downloading = undefined; });
    return downloading;
  }

  function cancelDownload() {
    if (!downloading || !cancelToken) return false;
    cancelToken.cancel();
    return true;
  }

  function later() {
    stopWatch();
    if (state.status === 'downloading') return { ok: cancelDownload() };
    if (['available', 'ready', 'deferred_busy', 'download_failed', 'install_failed'].includes(state.status)) {
      set(state.status === 'deferred_busy' ? 'ready' : state.status, { ...pick(state), deferred: true });
      return { ok: true };
    }
    return { ok: false, error: 'nothing_to_defer' };
  }

  const pick = (value) => ({ ...(value.downloaded && { downloaded: value.downloaded }), ...(value.error && { error: value.error }) });

  function stopWatch() { if (watchTimer) { timers.clearInterval(watchTimer); watchTimer = undefined; } }

  // "任务结束后提醒我": checks the gate every 30 s and only tells the window when everything is idle; never installs.
  function watchUntilIdle() {
    stopWatch();
    watchTimer = timers.setInterval(async () => {
      if (state.status !== 'deferred_busy') return stopWatch();
      const result = await gate.evaluate().catch(() => ({ state: 'unknown', reasons: [] }));
      if (result.state === 'idle') {
        stopWatch();
        set('ready', { ...pick(state), tasksFinished: true });
      } else set('deferred_busy', { ...pick(state), gate: result });
    }, GATE_WATCH);
    watchTimer.unref?.();
    return { ok: true };
  }

  async function install() {
    if (installing) return { ok: false, error: 'already_installing' };
    if (state.status !== 'ready' && state.status !== 'deferred_busy' || !manifest || !updater) return { ok: false, error: 'not_ready' };
    if (platform === 'darwin' && !(signedBuild && manifest.signed)) return { ok: false, error: 'manual_install_required' };
    installing = true;
    const ready = { ...pick(state) };
    try {
      // The version must still be offered: one withdrawn on VPS2 after the download is not installed.
      let current;
      try { current = await fetchManifest(); } catch (error) {
        set('ready', { ...ready, gate: { state: 'unknown', reasons: ['无法向服务器确认此版本仍然有效：' + errorCategory(error)] } });
        return { ok: false, error: 'update_unconfirmed' };
      }
      if (!current || current.version !== manifest.version || current.installer.sha512 !== manifest.installer.sha512) {
        logger?.audit('update_install', { status: 'withdrawn', version: manifest.version });
        manifest = undefined;
        updater = undefined;
        set('current', { withdrawn: true });
        return { ok: false, error: 'update_withdrawn' };
      }
      const first = await gate.evaluate().catch(() => ({ state: 'unknown', reasons: ['无法完成任务检查'] }));
      if (first.state !== 'idle') {
        logger?.audit('update_install', { status: 'deferred', version: manifest.version, gate: first.state });
        set('deferred_busy', { ...ready, gate: first });
        return { ok: false, error: first.state === 'busy' ? 'tasks_running' : 'task_state_unknown', gate: first };
      }
      // Phase two: no new turns, commands, terminals or group submissions start while the gate is closed.
      gate.lock();
      let locked = true;
      try {
        const second = await gate.evaluate().catch(() => ({ state: 'unknown', reasons: ['无法完成任务检查'] }));
        if (second.state !== 'idle') {
          gate.unlock();
          locked = false;
          set('deferred_busy', { ...ready, gate: second });
          return { ok: false, error: second.state === 'busy' ? 'tasks_running' : 'task_state_unknown', gate: second };
        }
        set('installing', ready);
        let before = null;
        try { before = await snapshotData?.(); } catch {}
        await stateStore?.write({ pending: { from: app.getVersion(), target: manifest.version, at: new Date(now()).toISOString(),
          signed: manifest.signed, ...(before && { data: before }) } });
        await prepareForQuit();
        const failed = new Promise((resolve) => updater.once('error', (error) => resolve(error)));
        updater.quitAndInstall(false, true);
        const outcome = await Promise.race([failed, new Promise((resolve) => timers.setTimeout(() => resolve('timeout'), installTimeout).unref?.())]);
        throw outcome instanceof Error ? outcome : new Error('install_did_not_quit');
      } catch (error) {
        if (locked) gate.unlock();
        try { await abortPrepare?.(); } catch {}
        await stateStore?.write({}).catch?.(() => {});
        logger?.audit('update_install', { status: 'failed', version: manifest?.version, error: errorCategory(error) });
        set('install_failed', { ...ready, error: errorCategory(error) });
        return { ok: false, error: 'install_failed' };
      }
    } finally {
      installing = false;
    }
  }

  // After a restart: did the pending installation produce the expected version, and is the user data unchanged?
  async function verifyPreviousInstall() {
    let record;
    try { record = await stateStore?.read(); } catch { return null; }
    const pending = record?.pending;
    if (!pending?.target) return null;
    const version = app.getVersion();
    const ok = compareVersions(version, pending.target) === 0;
    let changed = [];
    if (ok && pending.data) {
      try {
        const after = await snapshotData?.();
        changed = Object.keys(pending.data).filter((name) => after && after[name] !== pending.data[name]);
      } catch { changed = ['unreadable']; }
    }
    logger?.audit('update_install', { status: ok ? 'installed' : 'not_installed', from: pending.from, to: pending.target,
      at: pending.at, ...(changed.length && { dataChanged: changed.length }) });
    await stateStore?.write({ last: { ok, from: pending.from, to: pending.target, at: pending.at, checkedAt: new Date(now()).toISOString(), dataChanged: changed } });
    if (ok) set('updated', { previousVersion: pending.from, dataChanged: changed });
    else set('install_failed', { error: 'version_unchanged', previousTarget: pending.target });
    return { ok, changed };
  }

  function revealDownload() {
    if (!(state.status === 'ready' && state.manualInstall) || !updater) return { ok: false };
    if (!downloadedFile) return { ok: false };
    try { reveal?.(downloadedFile); return { ok: true }; } catch { return { ok: false }; }
  }

  function schedule(delay) {
    timer = timers.setTimeout(async () => {
      await check({ reason: 'scheduled' }).catch(() => {});
      if (!stopped) schedule(DAY);
    }, delay);
    timer.unref?.();
  }

  return {
    get state() { return { ...state }; },
    get automaticChecks() { return automaticChecks; },
    start() {
      if (!supported) return;
      if (automaticChecks) schedule(FIRST_CHECK);
    },
    stop() { stopped = true; timers.clearTimeout(timer); stopWatch(); },
    check,
    download: () => download(),
    retry: () => state.status === 'download_failed' ? download() : Promise.resolve({ ok: false, error: 'nothing_to_retry' }),
    later,
    install,
    watchUntilIdle: () => state.status === 'deferred_busy' ? watchUntilIdle() : { ok: false },
    revealDownload,
    verifyPreviousInstall,
    setAutoDownload(value) {
      // An unsigned build cannot switch automatic download on (D2, Q3).
      if (value === true && !signedBuild) return { ok: false, error: 'unsigned_build' };
      autoDownload = value === true;
      set(state.status, { ...pick(state) });
      return { ok: true, autoDownload };
    },
    // Network back: signed builds look again (at most every 10 minutes).
    networkRestored() {
      if (!automaticChecks || now() - lastCheckAt < NETWORK_RECHECK_GAP) return null;
      return check({ reason: 'network' });
    },
    // VPS2 said a version is available (Q3): look it up through the control channel; the notice itself is not trusted.
    serverNotice() {
      if (!supported || now() - lastServerNoticeAt < SERVER_NOTICE_GAP) return null;
      lastServerNoticeAt = now();
      return check({ reason: 'server' });
    },
  };
}

module.exports = { createUpdateManager, errorCategory, updaterLog, STATES };
