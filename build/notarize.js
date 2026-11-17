const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async function notarizeMac({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== 'darwin' || !process.env.CSC_LINK) return;

  const appPath = path.join(appOutDir, packager.appInfo.productFilename + '.app');
  const detail = spawnSync('/usr/bin/codesign', ['-dvv', appPath], { encoding: 'utf8' });
  if (detail.status !== 0 || !/^Authority=Developer ID Application:/m.test(detail.stderr)) {
    throw new Error('A Developer ID Application signature is required for notarization.');
  }

  const { APPLE_KEYCHAIN_PROFILE, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  const credentials = APPLE_KEYCHAIN_PROFILE ? { keychainProfile: APPLE_KEYCHAIN_PROFILE }
    : APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID
      ? { appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID }
      : null;
  if (!credentials) {
    console.log('Skipping macOS notarization: credentials are not configured.');
    return;
  }

  const { notarize } = await import('@electron/notarize');
  await notarize({ appPath, ...credentials });
};
