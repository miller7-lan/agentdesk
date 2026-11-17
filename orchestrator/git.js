const { execFile } = require('node:child_process');
const { mkdir } = require('node:fs/promises');
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

module.exports = { git, worktree, patchFor };
