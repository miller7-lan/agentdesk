const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

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
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file, args, options) => spawn(process.execPath, [file, ...args], options));
  const { runAdapter } = require('../orchestrator/adapters');
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

test('a model profile narrows the effort levels it accepts', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-model-effort-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = await fakeCli(dir);
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file, args, options) => spawn(process.execPath, [file, ...args], options));
  const { runAdapter } = require('../orchestrator/adapters');
  const config = {
    bin, env: { PATH: process.env.PATH },
    template: { prompt: 'arg', output: 'plain', args: ['-p', '{prompt}'], modelArgs: ['--model', '{model}'],
      efforts: ['low', 'high'], effortArgs: ['--effort', '{effort}'] },
    // agy encodes the level in the model ID: the low model only accepts low.
    profiles: { models: { 'm-low': { efforts: ['low'], billing: 'subscription' }, 'm-high': { billing: 'subscription' } } },
  };
  const run = async (model, effort) => {
    const { output } = await runAdapter({ name: 'antigravity', config, cwd: dir, prompt: 'p', readonly: true,
      timeout: 10000, signal: new AbortController().signal, log: path.join(dir, 'model.log'), onSession() {}, model, effort });
    return JSON.parse(output.trim().split('\n').at(-1));
  };
  const narrowed = await run('m-low', 'high');
  assert.ok(!narrowed.args.includes('--effort'));                // conflicting level is dropped, not passed
  const declared = await run('m-low', 'low');
  assert.equal(declared.args[declared.args.indexOf('--effort') + 1], 'low');
  const fallback = await run('m-high', 'high');
  assert.equal(fallback.args[fallback.args.indexOf('--effort') + 1], 'high');   // model without efforts uses the role list
});

test('an exit code keeps the CLI line that explains it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bad-cli.js');
  await fs.writeFile(bin, `#!${process.execPath}
process.stderr.write('error: invalid model selection (--model "gemini-4-hydrogen" --effort "medium"): --effort is not supported for model "gemini-4-hydrogen"\\n');
process.exit(1);
`, { mode: 0o755 });
  const { runAdapter } = require('../orchestrator/adapters');
  await assert.rejects(runAdapter({ name: 'codex', config: { bin, env: { PATH: process.env.PATH } }, cwd: dir, prompt: 'p',
    readonly: true, timeout: 10000, signal: new AbortController().signal, log: path.join(dir, 'error.log'), onSession() {} }),
  (error) => {
    assert.match(error.message, /^cli_exit_1: error: invalid model selection/);
    return true;
  });
});
