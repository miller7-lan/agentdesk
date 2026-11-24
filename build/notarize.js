const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Without a Developer ID, the release signs the Mac app with AgentDesk's own self-signed certificate (release.yml
// imports it and sets MAC_SELF_SIGN_IDENTITY). A fixed certificate gives every version the same designated
// requirement, so macOS keeps permissions such as Screen Recording across updates; an ad-hoc signature changes with
// every build and loses them. No hardened runtime: it is only needed for notarization, and with a certificate that
// has no Team ID its library validation would refuse the app's own frameworks. Gatekeeper treats the app as before
// (opened by hand the first time), and updates are still installed by hand (build-info signed:false).
function selfSign(appPath) {
  const identity = process.env.MAC_SELF_SIGN_IDENTITY;
  const keychain = process.env.MAC_SELF_SIGN_KEYCHAIN;
  const run = (args) => {
    const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('codesign ' + args[0] + ' failed: ' + (result.stderr || result.stdout).trim());
    return result.stderr;
  };
  run(['--force', '--deep', '--timestamp=none', '--sign', identity, ...(keychain ? ['--keychain', keychain] : []), appPath]);
  run(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const requirement = spawnSync('/usr/bin/codesign', ['-d', '-r-', appPath], { encoding: 'utf8' });
  const text = (requirement.stdout || '') + (requirement.stderr || '');
  if (!/certificate leaf = H"[0-9a-f]{40}"/i.test(text)) throw new Error('self-signed app has no certificate-based designated requirement');
  console.log('Signed with the AgentDesk self-signed certificate:\n' + text.trim());
}

module.exports = async function notarizeMac({ electronPlatformName, appOutDir, packager }) {
  if (electronPlatformName !== 'darwin') return;
  const appPath = path.join(appOutDir, packager.appInfo.productFilename + '.app');
  if (!process.env.CSC_LINK) {
    if (process.env.MAC_SELF_SIGN_IDENTITY) selfSign(appPath);
    return;
  }
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
