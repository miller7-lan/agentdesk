const fs = require('node:fs/promises');
const path = require('node:path').posix;

// The macOS (and Linux) counterpart of windows-path-guard.js, with the same interface. Every directory from the
// project folder down to the one being touched must be a real directory — a symbolic link anywhere on the way is
// refused — so a link planted in the project cannot send a read or write outside it. Files are then opened with
// O_NOFOLLOW (sftp-project-write.js). A rename never replaces an existing entry unless asked to.
function startPosixGuard(base) {
  const root = path.resolve(base);
  const check = async (folder) => {
    const relative = path.relative(root, folder);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('project_path_denied'), { code: 'EACCES' });
    let current = root;
    for (const part of ['', ...relative.split('/').filter(Boolean)]) {
      current = part ? path.join(current, part) : current;
      const stat = await fs.lstat(current).catch((error) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw Object.assign(new Error('project_path_not_found'), { code: 'ENOENT' });
        throw error;
      });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('project_path_denied'), { code: 'EACCES' });
    }
  };
  return {
    async move(source, target, replace) {
      if (!replace) {
        const existing = await fs.lstat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
        if (existing) throw Object.assign(new Error('project_file_exists'), { code: 'EEXIST' });
      }
      await fs.rename(source, target);
    },
    async withPaths(directories, leaf, action) {
      for (const folder of directories) await check(folder);
      let exists = true;
      if (leaf) {
        const stat = await fs.lstat(leaf.path).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!stat) {
          if (!leaf.optional) throw Object.assign(new Error('project_path_not_found'), { code: 'ENOENT' });
          exists = false;
        } else if (stat.isSymbolicLink() || stat.isDirectory() !== Boolean(leaf.directory) || (!leaf.directory && stat.nlink !== 1)) {
          throw Object.assign(new Error('project_path_denied'), { code: 'EACCES' });
        }
      }
      return action(exists);
    },
    close() {},
  };
}

module.exports = { startPosixGuard };
