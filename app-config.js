const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const VERSION = 1;
const projectId = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function contained(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function remoteDirectory(value) {
  return typeof value === 'string' && value.length <= 1024 && path.posix.isAbsolute(value) &&
    !/[\x00-\x1f\\]/.test(value) && !value.split('/').includes('..');
}

async function validateDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('请选择工作区的绝对目录。');
  const resolved = await fs.realpath(value);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error('工作区必须是目录。');
  return resolved;
}

function gitOptions() {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY)$/i.test(key)) delete env[key];
  }
  return { timeout: 10000, windowsHide: true, env };
}

// Folders that are never a project (spec §7.1): the disk root, the home folder itself and system folders.
function refusedRoot(root, { home = require('node:os').homedir(), platform = process.platform } = {}) {
  const normal = path.resolve(root);
  const fold = platform === 'win32' || platform === 'darwin' ? (value) => value.toLowerCase() : (value) => value;
  if (normal === path.parse(normal).root || fold(normal) === fold(path.resolve(home))) return true;
  const system = platform === 'win32'
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'C:\\ProgramData']
    : ['/System', '/Library', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/dev', '/proc', '/sys', '/boot', '/Applications'];
  return system.some((folder) => { const rel = path.relative(fold(folder), fold(normal)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
}

const GITIGNORE = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '*.log', '.env', '.env.*', '!.env.example', 'node_modules/', ''].join('\n');

// The person's own Git identity, from their configuration. Q4: without it nothing is committed, and AgentDesk
// neither writes any gitconfig nor commits under its own name.
async function gitIdentity(root, options = gitOptions()) {
  const read = async (key) => {
    try { return (await exec('git', ['-C', root, 'config', '--get', key], options)).stdout.trim(); } catch { return ''; }
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return name && email ? { name, email } : null;
}

async function initialCommit(root, options = gitOptions()) {
  if (!await gitIdentity(root, options)) return { committed: false, reason: 'missing_identity' };
  try {
    await exec('git', ['-C', root, 'add', '--', '.gitignore'], options);
    // Hooks and signing are not bypassed; when they fail, the repository stays initialized without the commit.
    await exec('git', ['-C', root, 'commit', '--quiet', '-m', '初始化仓库（AgentDesk）', '--', '.gitignore'], options);
    return { committed: true };
  } catch (error) {
    return { committed: false, reason: 'commit_failed', detail: String(error.stderr || error.message).trim().slice(0, 300) };
  }
}

// D7 / Q3 / Q4 (spec §7). Returns what was done so the app can tell the person:
//   repository   the folder is a repository root: nothing written
//   subdirectory the folder is inside a repository: the parent repository is used, nothing written
//   empty        a brand-new empty folder: git init, .gitignore, and a first commit when the identity exists
//   existing     a folder with any entry (even only .DS_Store / Thumbs.db / desktop.ini): git init only
async function initializeWorkspace(root) {
  const options = gitOptions();
  if (refusedRoot(root)) throw new Error('不能把磁盘根目录、用户主目录或系统目录作为项目。');
  // Both sides through the native realpath: on Windows a path may arrive in 8.3 form (RUNNER~1) while Git
  // reports the long form, and comparing them as text would make a repository root look like a subfolder.
  const chosen = await fs.realpath(root);
  try {
    const { stdout } = await exec('git', ['-C', chosen, 'rev-parse', '--show-toplevel'], options);
    const top = await fs.realpath(stdout.trim());
    const same = process.platform === 'win32' || process.platform === 'darwin' ? top.toLowerCase() === chosen.toLowerCase() : top === chosen;
    if (same) return { kind: 'repository', gitRoot: top };
    return { kind: 'subdirectory', gitRoot: top, subdirectory: path.relative(top, chosen) };
  } catch (error) {
    if (error.code !== 128 || !/not a git repository/i.test(error.stderr || '')) throw error;
    // A broken repository must not be silently reinitialized.
    try {
      await fs.lstat(path.join(root, '.git'));
      throw error;
    } catch (statError) {
      if (statError !== error && statError.code !== 'ENOENT') throw statError;
      if (statError === error) throw new Error('该目录里的 .git 已损坏，AgentDesk 不会重新初始化它，请先修复。');
    }
  }
  // Q3: only a folder with no entry at all counts as brand new; hidden and system files count as content.
  const empty = (await fs.readdir(root)).length === 0;
  await exec('git', ['-C', root, 'init', '--quiet'], options);
  if (!empty) return { kind: 'existing', gitRoot: root, gitignore: false, committed: false };
  await fs.writeFile(path.join(root, '.gitignore'), GITIGNORE, { flag: 'wx' });
  const commit = await initialCommit(root, options);
  return { kind: 'empty', gitRoot: root, gitignore: true, ...commit };
}

// The "已设置，补做首个提交" button: only for a repository AgentDesk initialized empty that still has no commit.
async function retryInitialCommit(root) {
  const options = gitOptions();
  try { await exec('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD'], options); return { committed: false, reason: 'already_has_commits' }; }
  catch {}
  const entries = (await fs.readdir(root)).filter((name) => name !== '.git');
  if (entries.length !== 1 || entries[0] !== '.gitignore') return { committed: false, reason: 'not_a_fresh_repository' };
  return initialCommit(root, options);
}

async function validateGitRoot(value) {
  const resolved = await validateDirectory(value);
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-C', resolved, 'rev-parse', '--show-toplevel'], gitOptions());
    if (await fs.realpath(stdout.trim()) !== resolved) throw new Error('nested_workspace');
  } catch {
    throw new Error('请选择 Git 仓库的根目录。');
  }
  return resolved;
}

async function readJson(file) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_config');
  return value;
}

async function migrate(legacyFiles, defaults) {
  const legacy = {};
  for (const filename of legacyFiles) {
    try { Object.assign(legacy, await readJson(filename)); } catch { /* 旧配置留在原位置。 */ }
  }
  const localRoot = [legacy.localRoot, legacy.localWorkspace, legacy.workspaceRoot, legacy.root, defaults.localRoot]
    .find((value) => typeof value === 'string' && path.isAbsolute(value));
  const remoteCwd = [legacy.remoteCwd, legacy.workspace, defaults.remoteCwd].find(remoteDirectory);
  const workspace = legacy.orchestratorWorkspace ?? defaults.orchestratorWorkspace;
  return {
    version: VERSION,
    onboardingComplete: false,
    appearance: {},
    projects: [{ id: 'live', name: defaults.name || '工作区', kind: localRoot ? 'local' : 'remote',
      localRoot, remoteCwd, ...(projectId.test(workspace || '') && { orchestratorWorkspace: workspace }) }],
    activeProject: 'live',
    // Optional: autoCheck / autoDownload (updates.js). Without them, signed builds check and download by themselves and
    // unsigned builds only check when asked or told by VPS2. The old enabled / feedUrl keys are no longer read.
    update: {},
  };
}

async function atomicWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

class AppConfig {
  constructor(filename, { legacyFiles = [], ...defaults } = {}) {
    this.filename = filename;
    this.legacyFiles = legacyFiles;
    this.defaults = defaults;
    this.pending = Promise.resolve();
  }

  async load() {
    try {
      const value = await readJson(this.filename);
      if (value.version !== VERSION || !Array.isArray(value.projects) ||
          value.projects.some((project) => !project || !projectId.test(project.id) || typeof project.name !== 'string')) {
        throw new Error('invalid_config');
      }
      this.value = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.value = await migrate(this.legacyFiles, this.defaults);
      await atomicWrite(this.filename, this.value);
    }
    return this.value;
  }

  get active() {
    return this.value.projects.find(({ id }) => id === this.value.activeProject);
  }

  list() {
    const { projects, activeProject } = this.value;
    return { projects: structuredClone(projects), activeProject,
      ...(this.value.deletedProjects?.length && { deletedProjects: [...this.value.deletedProjects] }) };
  }

  mutate(apply) {
    const operation = this.pending.then(async () => {
      const draft = structuredClone(this.value);
      const updated = await apply(draft);
      if (updated === false) return this.list();
      await atomicWrite(this.filename, draft);
      this.value = draft;
      return this.list();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async saveProject(id, fields, localRoot, groupId) {
    return this.mutate(async (draft) => {
      const current = draft.projects.find((project) => project.id === id);
      if (id && !current) throw new Error('找不到该项目。');
      if (groupId !== undefined && (id || !/^group-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(groupId) ||
          draft.projects.some(project => project.id === groupId))) throw new Error('项目绑定已更改，请重新打开项目。');
      const candidate = { ...current, ...fields };
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const { kind, remoteCwd, orchestratorWorkspace } = candidate;
      if (!name || name.length > 60 || !['local', 'remote'].includes(kind)) throw new Error('请填写有效的项目名称和类型。');
      if (remoteCwd && !remoteDirectory(remoteCwd)) throw new Error('远程目录必须是服务器上的绝对路径。');
      if (orchestratorWorkspace && (typeof orchestratorWorkspace !== 'string' || !projectId.test(orchestratorWorkspace))) throw new Error('主控工作区标识无效。');
      let root = kind === 'local' ? await validateDirectory(localRoot ?? current?.localRoot) : undefined;
      let workdir = current?.workdir;
      if (root && localRoot) {
        this.lastInit = await initializeWorkspace(root);
        // D7: a folder inside a repository uses the parent repository; the chosen folder is the working folder.
        if (this.lastInit.kind === 'subdirectory') { root = this.lastInit.gitRoot; workdir = this.lastInit.subdirectory; }
        else workdir = undefined;
      }
      const project = {
        id: id || groupId || randomUUID(), name, kind,
        ...(root && { localRoot: root }),
        ...(root && workdir && { workdir }),
        ...(remoteCwd && { remoteCwd }),
        ...(orchestratorWorkspace && { orchestratorWorkspace }),
      };
      draft.projects = current ? draft.projects.map((item) => item.id === id ? project : item) : [...draft.projects, project];
      draft.activeProject = project.id;
    });
  }

  remove(id, { purged = false } = {}) {
    return this.mutate((draft) => {
      if (!draft.projects.some((project) => project.id === id)) throw new Error('找不到该项目。');
      draft.projects = draft.projects.filter((project) => project.id !== id);
      if (purged) draft.deletedProjects = [...new Set([...(draft.deletedProjects || []), id])];
      if (draft.activeProject === id) draft.activeProject = draft.projects[0]?.id ?? null;
    });
  }

  select(id) {
    return this.mutate((draft) => {
      if (draft.activeProject === id) return false;
      if (!draft.projects.some((project) => project.id === id)) throw new Error('找不到该项目。');
      draft.activeProject = id;
    });
  }
}

module.exports = { AppConfig, atomicWrite, migrate, contained, remoteDirectory, validateDirectory, validateGitRoot, initializeWorkspace, retryInitialCommit, refusedRoot, GITIGNORE };
