const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTask, parsePlan } = require('../orchestrator/wechat/runner');
const { WechatService } = require('../orchestrator/wechat/service');
const { QuotaGate } = require('../orchestrator/wechat/quota');

const adapters = { claude: { bin: 'claude' }, codex: { bin: 'codex' }, antigravity: { bin: 'agy' }, grok: { bin: 'grok' } };

function taskDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-task-'));
  for (const sub of ['in', 'work', 'out']) fs.mkdirSync(path.join(dir, sub));
  return dir;
}

// 假 runAdapter：按 name+readonly 返回脚本里的结果；可写调用时在 out/ 生成文件。
function fakeAdapter(script) {
  const calls = [];
  const fn = async (options) => {
    calls.push({ name: options.name, readonly: options.readonly, session: options.session, model: options.model, prompt: options.prompt });
    const step = script.shift();
    if (!step) throw new Error('unexpected call');
    if (step.session) options.onSession(step.session);
    if (step.error) throw Object.assign(new Error(step.error), { code: step.error });
    if (step.file) fs.writeFileSync(path.join(options.cwd, 'out', step.file), 'x');
    if (step.wait) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
    return { output: step.output || '' };
  };
  fn.calls = calls;
  return fn;
}

const plan = (tier, brief = '按部门汇总') => ({ output: '分析完毕\n```json\n' + JSON.stringify({ tier, brief }) + '\n```', session: 'plan-1' });

test('parsePlan takes the last JSON block and tolerates junk', () => {
  assert.deepEqual(parsePlan('```json\n{"tier":"low","brief":"a"}\n```\n```json\n{"tier":"mid","brief":"b"}\n```'), { tier: 'mid', brief: 'b' });
  assert.deepEqual(parsePlan('{"tier":"weird","brief":"c"}'), { tier: null, brief: 'c' });
  assert.equal(parsePlan('no json'), null);
});

test('/高 skips planning and lets Opus do the work', async () => {
  const run = fakeAdapter([{ output: '做好了', file: '周报.docx', session: 'ex-1' }]);
  const result = await runTask({ task: { id: 1, text: '写周报', tier: 'high' }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(run.calls.map((c) => [c.name, c.readonly, c.model]), [['claude', false, 'claude-opus-5-5']]);
  assert.deepEqual(result.outputs.map((f) => path.basename(f)), ['周报.docx']);
  assert.equal(result.sessions.executor, 'ex-1');
});

test('/中 plans with Opus read-only, then Codex does everything with the brief', async () => {
  const run = fakeAdapter([plan('low', 'BRIEF-TEXT'), { output: '完成', file: '汇总.xlsx' }]);
  const result = await runTask({ task: { id: 2, text: '汇总', tier: 'mid' }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.equal(result.tier, 'mid');                       // 用户指定的档位优先
  assert.deepEqual(run.calls.map((c) => [c.name, c.readonly]), [['claude', true], ['codex', false]]);
  assert.match(run.calls[1].prompt, /BRIEF-TEXT/);
  assert.equal(result.brief, 'BRIEF-TEXT');
});

test('auto tier: planner picks low → Antigravity; quota switches to Grok with a note', async () => {
  const run = fakeAdapter([plan('low'), { error: 'cli_quota_exhausted' }, { output: 'ok', file: 'a.xlsx' }]);
  const result = await runTask({ task: { id: 3, text: '整理', tier: null }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(run.calls.map((c) => c.name), ['claude', 'antigravity', 'grok']);
  assert.match(result.note, /额度用尽/);
  assert.equal(result.executor.provider, 'grok');
});

test('auto tier: planner picks high and continues in its own session with write access', async () => {
  const run = fakeAdapter([plan('high'), { output: 'done', file: '方案.docx' }]);
  const result = await runTask({ task: { id: 4, text: '写方案', tier: null }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.deepEqual(run.calls.map((c) => [c.name, c.readonly, c.session]), [['claude', true, undefined], ['claude', false, 'plan-1']]);
  assert.equal(result.tier, 'high');
});

test('mid-tier failure is not switched; status maps from the error code', async () => {
  const run = fakeAdapter([plan('mid'), { error: 'cli_auth_required' }]);
  const result = await runTask({ task: { id: 5, text: 'x', tier: null }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.equal(result.status, 'auth_expired');
  assert.equal(run.calls.length, 2);
});

test('continuation resumes the same executor session without planning', async () => {
  const dir = taskDir();
  fs.writeFileSync(path.join(dir, 'out', '汇总.xlsx'), 'v1');
  const run = fakeAdapter([{ output: '改好了', file: '汇总-v2.xlsx' }]);
  const task = { id: 6, text: '汇总', tier: 'low', executor: { provider: 'antigravity', model: 'm' }, sessions: { executor: 'conv-9' }, turns: 2 };
  const result = await runTask({ task, dir, signal: new AbortController().signal, continuation: { text: '表头加粗', newInputs: [] }, deps: { adapters, runAdapter: run } });
  assert.deepEqual(run.calls.map((c) => [c.name, c.session]), [['antigravity', 'conv-9']]);
  assert.match(run.calls[0].prompt, /表头加粗/);
  assert.match(run.calls[0].prompt, /汇总\.xlsx/);
  assert.deepEqual(result.outputs.map((f) => path.basename(f)), ['汇总-v2.xlsx']);
});

test('stop aborts the running CLI and reports cancelled', async () => {
  const run = fakeAdapter([{ wait: true }]);
  const controller = new AbortController();
  const pending = runTask({ task: { id: 7, text: 'x', tier: 'high' }, dir: taskDir(), signal: controller.signal, deps: { adapters, runAdapter: run } });
  setTimeout(() => controller.abort(new Error('cancelled')), 20);
  assert.equal((await pending).status, 'cancelled');
});

// ---------- 服务层：文件配对、排队、交付 ----------

function fakeClient() {
  const sent = [];
  return {
    sent,
    sendText: async (user, text) => { sent.push(['text', user, text]); },
    sendFile: async (user, file) => { sent.push(['file', user, path.basename(file)]); },
    sendImage: async (user, file) => { sent.push(['image', user, path.basename(file)]); },
    download: async (mediaId, dir, name) => {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name || mediaId);
      fs.writeFileSync(target, 'data');
      return target;
    },
  };
}

async function settle(service) {
  for (let i = 0; i < 200 && (service.running || service.queue.length); i += 1) await new Promise((r) => setTimeout(r, 5));
}

function newService(script, extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-state-'));
  const client = fakeClient();
  const run = fakeAdapter(script);
  const service = new WechatService({ config: { stateDir, allowUsers: ['me'], sendPreview: false }, adapters, client, runAdapter: run, ...extra });
  let n = 0;
  const msg = (fields) => service.onMessage({ from: 'me', dedupeKey: 'k' + (++n), ...fields });
  const say = (content) => msg({ type: 'text', text: content });
  return { service, client, run, msg, say };
}

test('service: messages collect in a draft and only 开始 runs them, all at once', async () => {
  const { service, client, run, msg, say } = newService([plan('low'), { output: '汇总好了', file: '部门汇总.xlsx', session: 'conv-1' }]);
  await say('按部门汇总');
  assert.match(client.sent.at(-1)[2], /已记下/);
  await msg({ type: 'file', mediaId: 'M1', fileName: '销售.xlsx' });
  assert.match(client.sent.at(-1)[2], /已收到「销售\.xlsx」/);
  const before = client.sent.length;
  await say('再加一张柱状图');
  assert.equal(client.sent.length, before);             // 后续文字不逐条回复
  assert.equal(run.calls.length, 0);                     // 没发「开始」不执行
  await say('开始');
  await settle(service);
  assert.equal(run.calls.length, 2);
  assert.match(run.calls[0].prompt, /1\. 按部门汇总\n2\. 再加一张柱状图/);
  assert.deepEqual(fs.readdirSync(path.join(service.store.taskDir(1), 'in')), ['销售.xlsx']);
  assert.ok(client.sent.some(([kind, , name]) => kind === 'file' && name === '部门汇总.xlsx'));
  assert.match(client.sent.at(-1)[2], /✅ #1 完成（低档 · Antigravity/);
  assert.match(client.sent.at(-1)[2], /\/进 1/);
  // 重复的消息键不再处理
  await service.onMessage({ from: 'me', dedupeKey: 'k4', type: 'text', text: '开始' });
  assert.equal(run.calls.length, 2);
});

test('service: after a task the next message is a new task; /进 returns to an old one', async () => {
  const { service, client, run, say } = newService([
    { output: 'v1', file: '方案.docx', session: 's-1' },
    { output: '另一个', file: '别的.docx', session: 's-2' },
    { output: 'v2', file: '方案-v2.docx' },
  ]);
  await say('/高 写方案');
  await say('开始');
  await settle(service);
  await say('写个通知');
  await say('开始 高');
  await settle(service);
  assert.equal(service.store.get(2).text, '写个通知');    // 新任务，不是续做 #1
  assert.equal(run.calls[1].session, undefined);
  assert.match(service.enter('me', 1), /已进入 #1/);
  await say('标题改大');
  assert.match(client.sent.at(-1)[2], /接着改 #1/);
  await say('开始');
  await settle(service);
  assert.equal(run.calls[2].session, 's-1');
  assert.equal(service.store.get(1).turns, 2);
  assert.deepEqual(service.store.get(1).outputs, ['方案.docx', '方案-v2.docx']);
  assert.equal(service.store.draft('me').target, null);   // 执行后回到新任务
  assert.match(service.listText('me'), /#1 ✅ 高档·Claude Opus/);
});

test('service: /清空 drops the draft, /新 leaves an old task, empty 开始 explains', async () => {
  const { service, client, run, msg, say } = newService([{ output: 'ok', session: 's' }]);
  await say('开始');
  assert.match(client.sent.at(-1)[2], /草稿是空的/);
  await msg({ type: 'file', mediaId: 'M', fileName: 'a.xlsx' });
  await say('开始');
  assert.match(client.sent.at(-1)[2], /还没说要做什么/);
  await say('/清空');
  assert.equal(service.store.draft('me').files.length, 0);
  await say('/高 x');
  await say('开始');
  await settle(service);
  service.enter('me', 1);
  assert.match(service.leave('me'), /已退出 #1/);
  assert.equal(run.calls.length, 1);
});

test('service: second task queues while the first runs, /stop removes it from the queue', async () => {
  const { service, client, say } = newService([{ wait: true }]);
  await say('/高 一'); await say('开始');
  await say('/高 二'); await say('开始');
  assert.match(client.sent.at(-1)[2], /排队中/);
  await say('/stop 2');
  assert.match(client.sent.at(-1)[2], /已从队列移除/);
  await say('/stop 1');
  await settle(service);
  assert.equal(service.store.get(1).status, 'cancelled');
  assert.equal(service.store.get(2).status, 'cancelled');
  assert.match(client.sent.at(-1)[2], /#1 已停止/);
});

test('service: low quota stops before any CLI runs; /重试 runs it later', async () => {
  let codexUsed = 95;
  const quotaStatus = async () => [
    { provider: 'claude', state: 'available', buckets: [{ id: 'c', fiveHour: { usedPercent: 10 } }] },
    { provider: 'codex', state: 'available', buckets: [{ id: 'x', fiveHour: { usedPercent: codexUsed, resetsAt: 1795460549 } }] },
  ];
  const quota = new QuotaGate({ adapters, quotaStatus, ttlMs: 0 });
  const { service, client, run, say } = newService([plan('mid'), plan('mid'), { output: 'ok', file: 'a.xlsx' }], { quota });
  await say('/中 做表'); await say('开始');
  await settle(service);
  assert.equal(service.store.get(1).status, 'quota_low');
  assert.match(client.sent.at(-1)[2], /额度不够.*GPT 5 小时额度只剩 5%/);
  assert.deepEqual(run.calls.map((c) => c.name), ['claude']);     // 规划了，但没有交给 Codex
  codexUsed = 20;
  await say('/重试 1');
  await settle(service);
  assert.equal(service.store.get(1).status, 'succeeded');
});

test('store gc removes expired task folders and marks them archived', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-state-'));
  const service = new WechatService({ config: { stateDir }, adapters, client: fakeClient(), runAdapter: fakeAdapter([]) });
  const task = service.store.create({ user: 'me', text: 'x' });
  service.store.update(task.id, { status: 'succeeded', finishedAt: Date.now() - 4 * 86400_000 });
  service.gc();
  assert.equal(fs.existsSync(service.store.taskDir(task.id)), true);    // 30 天内保留
  service.store.update(task.id, { finishedAt: Date.now() - 31 * 86400_000 });
  service.gc();
  assert.equal(fs.existsSync(service.store.taskDir(task.id)), false);
  assert.equal(service.store.get(task.id), null);                         // 记录也删
});
