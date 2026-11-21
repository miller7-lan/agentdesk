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

async function validateGitRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('请选择工作区的绝对目录。');
  const resolved = await fs.realpath(value);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error('工作区必须是目录。');
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-C', resolved, 'rev-parse', '--show-toplevel'], {
      timeout: 5000, windowsHide: true,
    });
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
    update: { enabled: false, feedUrl: '' },
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
    return { projects: structuredClone(projects), activeProject };
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
      const root = kind === 'local' ? await validateGitRoot(localRoot ?? current?.localRoot) : undefined;
      const project = {
        id: id || groupId || randomUUID(), name, kind,
        ...(root && { localRoot: root }),
        ...(remoteCwd && { remoteCwd }),
        ...(orchestratorWorkspace && { orchestratorWorkspace }),
      };
      draft.projects = current ? draft.projects.map((item) => item.id === id ? project : item) : [...draft.projects, project];
      draft.activeProject = project.id;
    });
  }

  remove(id) {
    return this.mutate((draft) => {
      if (!draft.projects.some((project) => project.id === id)) throw new Error('找不到该项目。');
      draft.projects = draft.projects.filter((project) => project.id !== id);
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

module.exports = { AppConfig, atomicWrite, migrate, contained, remoteDirectory, validateGitRoot };
