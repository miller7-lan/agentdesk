// node-pty 1.1.0's macOS prebuilds ship spawn-helper without the execute bit when installed through npm, and every
// terminal then fails with "posix_spawnp failed". Restore it after install (npm ci) and before packaging.
const fs = require('node:fs');
const path = require('node:path');

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
let fixed = 0;
for (const folder of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
  const helper = path.join(prebuilds, folder, 'spawn-helper');
  if (!fs.existsSync(helper)) continue;
  const mode = fs.statSync(helper).mode;
  if ((mode & 0o111) !== 0o111) { fs.chmodSync(helper, mode | 0o755); fixed += 1; }
}
if (fixed) console.log(`node-pty: made ${fixed} spawn-helper executable`);
