const fs = require('node:fs/promises');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { runAdapter } = require('./adapters');
const { providerSettings } = require('./service');
const { git } = require('./git');

async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const folder = await fs.mkdtemp(path.join(config.stateDir, 'smoke-'));
  const cancel = new AbortController();
  process.once('SIGINT', () => cancel.abort(new Error('cancelled')));
  process.once('SIGTERM', () => cancel.abort(new Error('cancelled')));
  const group = readFileSync('/proc/self/cgroup', 'utf8').split('\n')
    .find((line) => line.startsWith('0::'))?.slice(3);
  const memory = group && path.join('/sys/fs/cgroup', group, 'memory.peak');
  const providers = ['codex', 'claude', 'grok'];
  try {
    const results = await Promise.allSettled(providers.map(async (name) => {
      const cwd = path.join(folder, name);
      await fs.mkdir(cwd, { mode: 0o700 });
      await git(cwd, ['init'], cancel.signal);
      const adapter = providerSettings(config.adapters[name], name, path.join(config.stateDir, 'homes', name));
      let session;
      const { output } = await runAdapter({
        name, config: adapter, cwd, prompt: 'Reply with the single word ready. Do not use any tools.',
        readonly: true, timeout: 180000, signal: cancel.signal,
        log: path.join(folder, name + '.log'), onSession: (value) => { session = value; },
      });
      if (!session || !/\bready\b/i.test(output)) throw new Error('unexpected_smoke_response');
      return { provider: name, ready: true };
    }));
    const resultsByProvider = results.map((result, index) => result.status === 'fulfilled' ? result.value : {
      provider: providers[index], ready: false, error: result.reason.code || 'smoke_failed',
    });
    const peak = memory && await fs.readFile(memory, 'utf8').catch(() => '');
    console.log(JSON.stringify({ results: resultsByProvider, peakMemoryBytes: Number(peak) || null }, null, 2));
    if (resultsByProvider.some((result) => !result.ready)) process.exitCode = 1;
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('smoke:', error.code || 'smoke_failed');
  process.exitCode = 1;
});
