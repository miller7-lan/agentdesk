const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runAdapter } = require('../orchestrator/adapters');

// A stand-in CLI that answers in each CLI's output format with the arguments and effort it was given.
async function fakeCli(dir) {
  const file = path.join(dir, 'fake-cli.js');
  await fs.writeFile(file, `#!${process.execPath}
const report = JSON.stringify({ args: process.argv.slice(2), env: process.env.CLAUDE_CODE_EFFORT_LEVEL || null });
const kind = process.env.FAKE_KIND;
if (kind === 'claude') console.log(JSON.stringify({ type: 'result', result: report, session_id: 's' }));
else if (kind === 'codex') console.log(JSON.stringify({ type: 'item.completed', thread_id: 't', item: { type: 'agent_message', text: report } }));
else console.log(report);
`, { mode: 0o755 });
  return file;
}

test('each CLI gets the reasoning effort the way it accepts it, and unknown levels are dropped', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-effort-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = await fakeCli(dir);
  const run = async (name, effort) => {
    const { output } = await runAdapter({ name, config: { bin, env: { FAKE_KIND: name, PATH: process.env.PATH } }, cwd: dir, prompt: 'p',
      readonly: true, timeout: 10000, signal: new AbortController().signal, log: path.join(dir, name + '.log'), onSession() {}, effort });
    return JSON.parse(output.trim().split('\n').at(-1));
  };
  const codex = await run('codex', 'high');
  assert.ok(codex.args.join(' ').includes('-c model_reasoning_effort="high"'));
  const claude = await run('claude', 'max');
  assert.equal(claude.env, 'max');                              // through the environment, which every version honours
  const grok = await run('grok', 'xhigh');
  assert.equal(grok.args[grok.args.indexOf('--effort') + 1], 'xhigh');
  const unknown = await run('grok', 'ultra');
  assert.ok(!unknown.args.includes('--effort'));                // never passed on
});
