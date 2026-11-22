// electron-builder configuration for a build with bundled connection settings (agentdesk-server.json and/or
// agentdesk-enrollment.json in the repository root). Used only for hand-distributed installers:
//   npm run dist:bundle                                    (Windows)
//   npx electron-builder --mac dmg zip --config build/bundle-connection.config.js
// The default configuration in package.json never packs these files, so every update package is generic; a computer
// installed from a bundled build keeps its settings in its user-data folder across updates (connection-config.js).
// Builds made with this file are never uploaded as updates (scripts/client-update-upload.js refuses them).
const base = require('../package.json').build;

module.exports = {
  ...base,
  extraResources: [
    ...base.extraResources,
    { from: '.', filter: ['agentdesk-enrollment.json', 'agentdesk-server.json'] },
  ],
};
