// The platform half of group chat on the person's computer: platform-mac.js or platform-win.js (Q6).
// Linux is used for tests only and behaves like Windows (no enforcement), with POSIX shells.
const fs = require('node:fs/promises');
const path = require('node:path');

function forPlatform(platform = process.platform) {
  if (platform === 'darwin') return require('./platform-mac');
  const win = require('./platform-win');
  if (platform === 'win32') return win;
  return { ...win, platform: 'linux', shell: (script, kind = 'bash') => [kind === 'zsh' ? '/bin/zsh' : '/bin/bash', '-c', script],
    copyProject: async (source, target) => fs.cp(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }) };
}

// M3 (recommendation): a copy at most 2 GB, and free space at least twice its size. Counted without following links.
const COPY_LIMIT = 2 * 1024 * 1024 * 1024;
async function folderSize(root, limit = COPY_LIMIT, maxEntries = 400000) {
  let total = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length) {
    const folder = stack.pop();
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (++entries > maxEntries) return { size: total, tooLarge: true };
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) stack.push(filename);
      else if (entry.isFile()) {
        total += (await fs.lstat(filename)).size;
        if (total > limit) return { size: total, tooLarge: true };
      }
    }
  }
  return { size: total, tooLarge: false };
}

async function freeSpace(folder) {
  const info = await fs.statfs(folder);
  return Number(info.bavail) * Number(info.bsize);
}

module.exports = { forPlatform, folderSize, freeSpace, COPY_LIMIT };
