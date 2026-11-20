const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { once } = require('node:events');

const run = promisify(execFile);

async function isMounted(directory) {
  const table = await fs.readFile('/proc/self/mountinfo', 'utf8');
  return table.split('\n').some((line) => line.split(' ')[4]?.replace(/\\([0-7]{3})/g,
    (_, code) => String.fromCharCode(parseInt(code, 8))) === directory);
}

// The caller owns and authenticates the SFTP stream. This worker never accepts a root or a
// mountpoint from an SSH payload. Create one unique mountpoint and fail closed on channel loss.
async function mountProject({
  stateDir, input, output, signal, readOnly = false, sshfs = '/usr/bin/sshfs',
  fusermount = '/usr/bin/fusermount3', spawnProcess = spawn, checkMount = isMounted, unmount,
}) {
  signal?.throwIfAborted();
  const root = path.join(stateDir, 'windows-chat-mounts');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(root, 'project-'));
  const mountOptions = ['passive', 'idmap=user', 'sshfs_sync', 'direct_io', 'dir_cache=no', 'nodev', 'nosuid',
    ...(readOnly ? ['ro'] : [])];
  let child;
  let cleanup;
  const disconnected = new AbortController();
  let failure;
  const lost = () => close(new Error('project_mount_disconnected'));
  function close(error = new Error('project_mount_closed')) {
    if (cleanup) return cleanup;
    failure = error;
    disconnected.abort(error);
    input.unpipe(child?.stdin);
    child?.stdout.unpipe(output);
    signal?.removeEventListener('abort', abort);
    cleanup = Promise.resolve().then(async () => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close').catch(() => {});
          child.kill();
          const timeout = new AbortController();
          try {
            await Promise.race([closed, delay(1500, undefined, { signal: timeout.signal })]);
          } finally { timeout.abort(); }
        }
        if (await checkMount(directory)) {
          if (unmount) await unmount(directory);
          else await run(fusermount, ['-u', '-z', directory], { timeout: 10_000 });
        }
        if (await checkMount(directory)) throw new Error('project_unmount_failed');
        await fs.rmdir(directory);
      } finally {
        input.destroy();
        if (output !== input) output.destroy();
      }
    });
    cleanup.catch(() => {});
    return cleanup;
  }
  const abort = () => close(signal.reason);
  try {
    signal?.throwIfAborted();
    child = spawnProcess(sshfs, ['-f', '-o', mountOptions.join(','), ':/', directory],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.on('error', lost);
    child.once('error', lost);
    child.once('exit', lost);
    input.once('end', lost);
    input.once('error', lost);
    input.once('close', lost);
    output.once('error', lost);
    output.once('close', lost);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    input.pipe(child.stdin);
    child.stdout.pipe(output, { end: false });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      if (await checkMount(directory)) {
        if (failure) throw failure;
        return { directory, signal: disconnected.signal, close };
      }
      await delay(100, undefined, { signal: disconnected.signal });
    }
    throw new Error('project_mount_timeout');
  } catch (error) {
    await close(error);
    throw error;
  }
}

module.exports = { mountProject, isMounted };
