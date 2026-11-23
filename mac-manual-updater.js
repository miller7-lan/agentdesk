// macOS updates that the user installs by hand (an unsigned app, or an unsigned new version).
//
// electron-updater's MacUpdater hands every finished download to Squirrel.Mac: it calls autoUpdater.setFeedURL(),
// which throws inside a server callback when the running app's signature is not accepted (the download then never
// finishes), and it resolves downloadUpdate() with [] so the caller never learns where the zip is. Squirrel cannot
// install such an update anyway, so this subclass skips it: the download is verified as usual (sha512, size) and the
// zip's path is returned, for "打开下载位置".
function manualMacUpdater(MacUpdater) {
  return class ManualMacUpdater extends MacUpdater {
    async updateDownloaded(_zipFileInfo, event) {
      this.dispatchUpdateDownloaded(event);
      return [event.downloadedFile];
    }

    quitAndInstall() {
      throw new Error('manual_install_required');
    }
  };
}

module.exports = { manualMacUpdater };
