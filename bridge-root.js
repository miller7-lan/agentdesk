'use strict';
// A project bound to an orchestrator workspace is where that workspace's AI works, so the Bridge's root for the
// workspace follows the project's folder. Without this the Bridge kept the folder it was installed with
// (~/AgentDeskWorkspace): group steps worked there instead of in the project, and full-access single chats were
// refused with 「该项目的 Bridge 写入授权与本机目录不匹配」. One workspace serves one project at a time (the window
// only offers a free workspace), so moving the root never takes it from another project.
const fs = require('node:fs');
const path = require('node:path');
const { refusedRoot } = require('./app-config');

const real = (target) => { try { return fs.realpathSync.native(target); } catch { return null; } };
const same = (left, right) => {
  const a = real(left);
  const b = real(right);
  if (!a || !b) return false;
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

// Which project each workspace should follow: the active project wins when two claim one (should not happen).
function wanted(projects, activeId) {
  const byWorkspace = new Map();
  for (const project of projects || []) {
    if (project?.kind !== 'local' || !project.localRoot || typeof project.orchestratorWorkspace !== 'string') continue;
    if (!byWorkspace.has(project.orchestratorWorkspace) || project.id === activeId) byWorkspace.set(project.orchestratorWorkspace, project);
  }
  return byWorkspace;
}

// Rewrites the Bridge configuration file so each bound workspace's root is its project's folder. Returns
// { changed: [workspace…], problems: [{ workspace, project, error }] }; the caller restarts the Bridge when changed.
function syncBridgeRoots({ file, projects, activeId, options = {} }) {
  const result = { changed: [], problems: [] };
  if (!file) return result;
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  for (const [workspace, project] of wanted(projects, activeId)) {
    const current = settings.workspaces?.[workspace];
    if (!current) continue; // A workspace of another computer, or a Bridge that does not serve it: nothing to move.
    if (current.root && same(current.root, project.localRoot)) continue;
    const root = real(project.localRoot);
    // Compare real paths on both sides: a home folder reached through a link (macOS /var → /private/var) would
    // otherwise not recognise its own Desktop.
    const home = options.home ?? require('node:os').homedir();
    const problem = !root ? '项目文件夹不存在' : refusedRoot(root, { ...options, home: real(home) || home }) ? '项目文件夹是桌面、文稿、下载、用户主目录等个人文件夹或系统目录' : '';
    if (problem) { result.problems.push({ workspace, project: project.id, error: problem }); continue; }
    settings.workspaces[workspace] = { ...current, root };
    result.changed.push(workspace);
  }
  if (!result.changed.length) return result;
  const backup = file + '.bak-root-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, backup);
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { mode, flag: 'w' });
  fs.renameSync(temp, file);
  return result;
}

module.exports = { syncBridgeRoots, wanted };
