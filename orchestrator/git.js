const { execFile } = require('node:child_process');
const { mkdir, realpath } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);

async function git(cwd, args, signal) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, signal, maxBuffer: 8 * 1024 * 1024, timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

async function worktree(repository, directory, branch, base, signal) {
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await git(repository, ['worktree', 'add', '-b', branch, directory, base], signal);
}

async function patchFor(directory, base, signal) {
  await git(directory, ['add', '--all'], signal);
  const paths = await git(directory, ['diff', '--cached', '--no-renames', '--name-only', '-z', base], signal);
  const patch = await git(directory, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', base], signal);
  return { paths: paths.split('\0').filter(Boolean), patch };
}

// A linked worktree points outside its sandbox. Expose a private read-only index and objects for this step.
async function sandboxGit(repository, cwd, directory, signal) {
  const target = (await git(cwd, ['rev-parse', '--absolute-git-dir'], signal)).trim();
  const parent = path.join(await realpath(repository), 'worktrees');
  if (path.dirname(target) !== parent) throw Error('invalid_step_git_directory');
  const head = (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim();
  const tree = (await git(cwd, ['write-tree'], signal)).trim();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await git(directory, ['init', '--bare', '--quiet'], signal);
  await git(directory, ['fetch', '--quiet', '--no-tags', '--depth=1', repository, head, tree], signal);
  await git(directory, ['update-ref', '--no-deref', 'HEAD', head], signal);
  await git(directory, ['read-tree', tree], signal);
  return { directory, target };
}

module.exports = { git, worktree, patchFor, sandboxGit };
