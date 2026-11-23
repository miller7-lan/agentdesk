const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const inside = (root, target) => target === root || target.startsWith(root + path.sep);

async function canonical(target) {
  try { return await fs.realpath(target); }
  catch (error) { if (error.code === 'ENOENT') return path.resolve(target); throw error; }
}

// Folders the system or the person owns (桌面、文稿、下载 and anything directly in the home folder). A project bound to
// one of them is unbound and its AgentDesk data removed, but the folder and its files are never deleted.
const PERSONAL = new Set(['desktop', 'documents', 'downloads', 'pictures', 'movies', 'music', 'videos', 'public',
  'library', 'applications', 'onedrive', 'icloud drive', '桌面', '文稿', '文档', '下载', '图片', '影片', '音乐']);
async function personalFolder(root, home = os.homedir()) {
  if (!root) return false;
  const own = await canonical(home);
  return path.dirname(root) === own || (inside(own, root) && PERSONAL.has(path.basename(root).toLowerCase()));
}

// A Git repository with no commit (what AgentDesk's git init leaves in a folder that was not a repository) holds no
// history, so it can go with the project. Any repository with commits stays.
// Anything it cannot check (macOS refusing access to 桌面/文稿, no git) means "keep": the folder is never touched then.
const DENIED = new Set(['EPERM', 'EACCES']);
async function emptyRepository(root) {
  const git = await fs.lstat(path.join(root, '.git')).catch(error => { if (error.code !== 'ENOENT' && !DENIED.has(error.code)) throw error; });
  if (!git?.isDirectory()) return false;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/.test(key)) delete env[key];
  try { await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], { env, timeout: 15000 }); return false; }
  catch (error) {
    if (error.code !== 1) return false;
    // Exit 1 is also what git gives when it cannot read the folder; only an empty repository has no HEAD *and* a
    // readable objects folder.
    return fs.readdir(path.join(root, '.git', 'objects')).then(() => true, () => false);
  }
}

// Every target comes from the main process's saved project, never from a renderer-supplied path.
async function projectDirectory(project, projects, protectedPaths = [], linked = false) {
  if (!project.localRoot) return null;
  const root = await canonical(project.localRoot);
  const home = await canonical(os.homedir());
  if (root === path.parse(root).root || inside(root, home) || path.dirname(root) === path.parse(root).root) {
    throw new Error('项目目录覆盖了用户目录或系统目录，请先把项目绑定到独立文件夹。');
  }
  for (const target of protectedPaths) {
    const resolved = await canonical(target);
    if (inside(root, resolved) || inside(resolved, root)) throw new Error('该目录包含 AgentDesk 程序或配置，无法作为项目删除。');
  }
  for (const other of projects) {
    if (other.id === project.id || !other.localRoot) continue;
    const resolved = await canonical(other.localRoot);
    if (inside(root, resolved) || inside(resolved, root)) throw new Error('该目录与另一个项目重叠，请先为两个项目分别绑定独立文件夹。');
  }
  // A linked worktree/submodule stores Git data outside this folder, in another repository. A personal folder the
  // app may not read (macOS privacy) is never deleted anyway, so its .git is not needed.
  const personal = !linked && await personalFolder(root);
  const git = await fs.lstat(path.join(root, '.git')).catch(error => {
    if (error.code !== 'ENOENT' && !(personal && DENIED.has(error.code))) throw error;
  });
  if (!linked && git && !git.isDirectory()) throw new Error('该项目使用外部 Git 目录，请在所属仓库的项目入口删除。');
  return root;
}

async function linkedWorktrees(project, projects, protectedPaths) {
  if (!project.localRoot || !await fs.lstat(path.join(project.localRoot, '.git')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  })) return [];
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY)$/.test(key)) delete env[key];
  const { stdout } = await exec('git', ['-C', project.localRoot, 'worktree', 'list', '--porcelain', '-z'], { env, timeout: 15000 });
  const roots = stdout.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  const own = await canonical(project.localRoot);
  const linked = [];
  for (const target of roots) {
    if (await canonical(target) === own) continue;
    linked.push(await projectDirectory({ ...project, localRoot: target }, projects, protectedPaths, true));
  }
  return linked;
}

async function purgeCheckpoints(directory, threadIds) {
  const ids = new Set(threadIds);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(directory, entry.name);
    const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    }));
    if (ids.has(manifest.threadId)) await fs.rm(folder, { recursive: true, force: true });
  }
}

// Keep the registration until all requested cleanup succeeds. A retry can finish a partially deleted project.
async function deleteProject({ project, projects, protectedPaths, preview, confirm, remote, local, unregister, savePlan = async () => {}, home }) {
  const root = await projectDirectory(project, projects, protectedPaths);
  const keepFolder = await personalFolder(root, home);
  const removeGit = keepFolder && await emptyRepository(root);
  const worktrees = keepFolder ? [] : await linkedWorktrees({ ...project, localRoot: root }, projects, protectedPaths);
  const plan = { ...await preview({ ...project, localRoot: root }), worktrees };
  if (!await confirm({ ...plan, root, keepFolder, removeGit })) return { cancelled: true };
  // Recheck registered paths after the confirmation, before the first irreversible step.
  if (root !== await projectDirectory(project, projects, protectedPaths)) throw new Error('项目目录已变化，请重新删除。');
  await savePlan(plan);
  await remote(plan);
  await local(plan);
  for (const target of worktrees) await fs.rm(target, { recursive: true, force: true });
  if (root && !keepFolder) await fs.rm(root, { recursive: true, force: true });
  else if (removeGit && await emptyRepository(root)) await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
  await unregister(project.id);
  return { deleted: true, threadIds: plan.threadIds || [] };
}

module.exports = { inside, canonical, personalFolder, emptyRepository, projectDirectory, purgeCheckpoints, linkedWorktrees, deleteProject };
