const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Workspace } = require('../workspace');

async function makeSkill(root, folder, name, description = '测试技能') {
  const dir = path.join(root, folder);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return dir;
}

// skills-manager 等工具用符号链接安装技能；Windows 用 junction 避免管理员权限。
async function linkDir(target, link) {
  try {
    await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}

test('localSkills follows installed symlinks and drops duplicate names', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdesk-skills-'));
  try {
    const managed = path.join(dir, 'managed');
    await makeSkill(managed, 'linked-skill', 'linked-skill');
    await makeSkill(managed, 'same-name', 'shared');

    const codex = path.join(dir, 'codex');
    const agents = path.join(dir, 'agents');
    await fsp.mkdir(codex);
    await fsp.mkdir(agents);

    if (!await linkDir(path.join(managed, 'linked-skill'), path.join(codex, 'linked-skill'))) {
      return t.skip('当前系统不允许创建目录符号链接');
    }
    await linkDir(path.join(managed, 'same-name'), path.join(codex, 'same-name'));

    await makeSkill(codex, 'real', 'real-skill', '真实目录');
    await makeSkill(agents, 'shared', 'shared', '重复名称');
    await makeSkill(codex, '.system', 'hidden');
    await fsp.mkdir(path.join(codex, 'no-skill-md'));
    await fsp.writeFile(path.join(codex, 'plain-file'), 'not a skill');
    if (process.platform !== 'win32') {
      await fsp.symlink(path.join(managed, 'missing'), path.join(codex, 'broken'), 'dir');
    }

    const ws = new Workspace(null, { skillRoots: [codex, agents] });
    const list = await ws.localSkills();

    assert.deepEqual(list.map((skill) => skill.name).sort(), ['linked-skill', 'real-skill', 'shared']);
    assert.equal(list.find((skill) => skill.name === 'linked-skill').dir, path.join(codex, 'linked-skill'));
    assert.equal(list.find((skill) => skill.name === 'shared').dir, path.join(codex, 'same-name'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('packSkill follows symlinked directories without looping', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdesk-skill-pack-'));
  try {
    const real = await makeSkill(dir, 'real', 'linked');
    const refs = path.join(dir, 'refs');
    await fsp.mkdir(refs);
    await fsp.writeFile(path.join(refs, 'notes.txt'), 'hello');

    if (!await linkDir(refs, path.join(real, 'references'))) return t.skip('当前系统不允许创建目录符号链接');
    await linkDir(real, path.join(real, 'loop'));

    const root = path.join(dir, 'root');
    await fsp.mkdir(root);
    await linkDir(real, path.join(root, 'linked'));

    const ws = new Workspace(null, { skillRoots: [root] });
    const pack = await ws.packSkill(path.join(root, 'linked'));

    assert.deepEqual(pack.files.map((file) => file.rel).sort(), ['SKILL.md', 'references/notes.txt']);
    assert(pack.total > 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});