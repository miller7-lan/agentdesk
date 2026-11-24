const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planTask, executeTask, parsePlan, estimateText, overdueAfterMs } = require('../orchestrator/wechat/runner');
const { WechatService, plainSummary } = require('../orchestrator/wechat/service');
const { QuotaGate } = require('../orchestrator/wechat/quota');

const adapters = { claude: { bin: 'claude' }, codex: { bin: 'codex' }, antigravity: { bin: 'agy' }, grok: { bin: 'grok' } };

function taskDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-task-'));
  for (const sub of ['in', 'work', 'out']) fs.mkdirSync(path.join(dir, sub));
  return dir;
}

// 假 runAdapter：按顺序返回脚本里的结果；可写调用时在 out/ 生成文件。
function fakeAdapter(script) {
  const calls = [];
  const fn = async (options) => {
    calls.push({ name: options.name, readonly: options.readonly, session: options.session, model: options.model, prompt: options.prompt, mcp: options.mcp });
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

const plan = (text = '1. 做一份 Word\n2. 五个部分', brief = 'BRIEF', minutes = 4, session = 'plan-1') =>
  ({ output: '好的\n```json\n' + JSON.stringify({ plan: text, brief, estimate_minutes: minutes }) + '\n```', session });

test('parsePlan reads plan, brief and estimate; rejects junk', () => {
  assert.deepEqual(parsePlan(plan('P', 'B', 7).output), { plan: 'P', brief: 'B', estimateMinutes: 7 });
  assert.deepEqual(parsePlan('{"brief":"b","estimate_minutes":"abc"}'), { plan: '', brief: 'b', estimateMinutes: null });
  assert.equal(parsePlan('no json'), null);
  assert.equal(estimateText({ estimateMinutes: 6 }), '约 6 分钟');
  assert.equal(estimateText({ tier: 'mid' }), '约 3～10 分钟');
  assert.equal(overdueAfterMs({ estimateMinutes: 4 }), 6 * 60_000);
});

test('planTask: first plan is read-only; revision resumes the planner session', async () => {
  const dir = taskDir();
  const run = fakeAdapter([plan('v1'), plan('v2', 'B2', 5, 'plan-1')]);
  const first = await planTask({ task: { id: 1, text: '写通知', tier: 'mid' }, dir, signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.deepEqual([first.status, first.plan, first.sessions.planner], ['planned', 'v1', 'plan-1']);
  assert.match(run.calls[0].prompt, /中档/);
  const second = await planTask({ task: { id: 1, text: '写通知', tier: 'mid', sessions: first.sessions, plan: 'v1' }, dir, signal: new AbortController().signal,
    deps: { adapters, runAdapter: run }, revision: { feedback: '标题改大', newInputs: ['新.xlsx'] } });
  assert.deepEqual([run.calls[1].readonly, run.calls[1].session], [true, 'plan-1']);
  assert.match(run.calls[1].prompt, /标题改大[\s\S]*新\.xlsx/);
  assert.equal(second.plan, 'v2');
});

test('executeTask: mid uses Codex with the confirmed brief; low switches on quota', async () => {
  const run = fakeAdapter([{ output: '完成', file: '通知.docx' }]);
  const done = await executeTask({ task: { id: 2, text: '写通知', tier: 'mid', brief: 'BRIEF-OK' }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.deepEqual([done.status, run.calls[0].name, run.calls[0].readonly], ['succeeded', 'codex', false]);
  assert.match(run.calls[0].prompt, /BRIEF-OK/);
  assert.deepEqual(done.outputs.map((f) => path.basename(f)), ['通知.docx']);
  const low = fakeAdapter([{ error: 'cli_quota_exhausted' }, { output: 'ok', file: 'a.pptx' }]);
  const switched = await executeTask({ task: { id: 3, text: 'x', tier: 'low', brief: 'B' }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: low } });
  assert.deepEqual(low.calls.map((c) => c.name), ['antigravity', 'grok']);
  assert.match(switched.note, /额度用尽/);
});

test('executeTask: high continues in the planner session when the planner is also Claude', async () => {
  const run = fakeAdapter([{ output: 'done', file: '方案.docx' }]);
  await executeTask({ task: { id: 4, text: 'x', tier: 'high', brief: 'B', sessions: { planner: 'plan-9' } }, dir: taskDir(), signal: new AbortController().signal, deps: { adapters, runAdapter: run } });
  assert.deepEqual([run.calls[0].name, run.calls[0].session, run.calls[0].readonly], ['claude', 'plan-9', false]);
  const codexPlanner = fakeAdapter([{ output: 'done' }]);
  await executeTask({ task: { id: 5, text: 'x', tier: 'high', brief: 'B', sessions: { planner: 'p' } }, dir: taskDir(), signal: new AbortController().signal,
    deps: { adapters, runAdapter: codexPlanner, settings: { planner: { provider: 'codex' } } } });
  assert.equal(codexPlanner.calls[0].session, undefined);                     // 组长不是 Claude：Opus 按简报重新开会话
  assert.match(codexPlanner.calls[0].prompt, /B/);
});

test('executeTask: continuation resumes the executor session', async () => {
  const dir = taskDir();
  fs.writeFileSync(path.join(dir, 'out', '汇总.xlsx'), 'v1');
  const run = fakeAdapter([{ output: '改好了', file: '汇总-v2.xlsx' }]);
  const result = await executeTask({ task: { id: 6, text: '汇总', tier: 'low', executor: { provider: 'antigravity' }, sessions: { executor: 'conv-9' } },
    dir, signal: new AbortController().signal, continuation: { text: '表头加粗', newInputs: [] }, deps: { adapters, runAdapter: run } });
  assert.deepEqual([run.calls[0].name, run.calls[0].session], ['antigravity', 'conv-9']);
  assert.deepEqual(result.outputs.map((f) => path.basename(f)), ['汇总-v2.xlsx']);
});

// ---------- 服务：引导流程 ----------

function fakeChannel() {
  const sent = [];
  return {
    sent,
    reply: async (message, text, user) => { sent.push(['text', user || message.from, text]); },
    welcome: async () => {},
    sendText: async (user, text) => { sent.push(['text', user, text]); },
    sendFile: async (user, file) => { sent.push(['file', user, path.basename(file)]); },
    sendImage: async (user, file) => { sent.push(['image', user, path.basename(file)]); },
    download: async (message, dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, message.fileName || 'file');
      fs.writeFileSync(target, 'data');
      return target;
    },
  };
}

async function settle(service) {
  for (let i = 0; i < 400 && (service.running || service.queue.length || service.planning.size); i += 1) await new Promise((r) => setTimeout(r, 5));
}

function newService(script, { users = ['me'], extra = {} } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-state-'));
  const channel = fakeChannel();
  const run = fakeAdapter(script);
  const service = new WechatService({ config: { stateDir, allowUsers: users, sendPreview: false, deliveryRetry: { sleep: async () => {} } }, adapters, channel, runAdapter: run, validate: async () => ({ ok: true }), ...extra });
  let n = 0;
  const from = (user, fields) => service.onMessage({ from: user, chatType: 'single', dedupeKey: 'k' + (++n), ...fields });
  const say = async (content, user = 'me') => { await from(user, { type: 'text', text: content }); await settle(service); };
  const last = (user = 'me') => channel.sent.filter(([kind, to]) => kind === 'text' && to === user).at(-1)?.[2] || '';
  return { service, channel, run, from, say, last };
}

test('guided flow: need → pick tier (wrong digit re-prompts) → collect → plan → revise → 完成 → files delivered', async () => {
  const { service, channel, run, from, say, last } = newService([
    plan('1. 一页通知', 'B1', 3), plan('1. 一页通知，标题加大', 'B2', 4, 'plan-1'), { output: '通知已完成', file: '消防通知.docx' },
  ]);
  await say('写一份消防检查通知');
  assert.match(last(), /收到需求[\s\S]*1 低档[\s\S]*2 中档[\s\S]*3 高档/);
  await say('5');
  assert.match(last(), /没看懂，请回复数字 1、2 或 3[\s\S]*1 低档/);
  await say('2');
  assert.match(last(), /已选中档（约 3～10 分钟）/);
  await from('me', { type: 'file', media: { url: 'u' }, fileName: '模板.docx' });
  assert.match(last(), /已收到「模板\.docx」/);
  await say('正式公文格式');
  assert.equal(run.calls.length, 0);                                               // 没发「开始」不动
  await say('开始');
  assert.match(channel.sent.find(([, , t]) => /组长正在出方案/.test(t))[2], /收到 #1（中档）/);
  assert.match(last(), /📋 #1 方案（中档 · 执行预计约 3 分钟）[\s\S]*一页通知[\s\S]*满意就发「完成」/);
  assert.match(run.calls[0].prompt, /1\. 写一份消防检查通知\n2\. 正式公文格式/);
  assert.deepEqual(fs.readdirSync(path.join(service.store.taskDir('me', 1), 'in')), ['模板.docx']);
  await say('标题再大一点');
  assert.match(last(), /📋 #1 修改后的方案（中档 · 执行预计约 4 分钟）[\s\S]*标题加大/);
  assert.equal(run.calls[1].session, 'plan-1');
  await say('开始');
  assert.match(last(), /现在不需要「开始」[\s\S]*等你确认/);
  await say('完成');
  const task = service.store.get('me', 1);
  assert.equal(task.status, 'succeeded');
  assert.deepEqual([run.calls[2].name, run.calls[2].readonly], ['codex', false]);
  assert.match(run.calls[2].prompt, /B2/);                                           // 用最新方案
  assert.ok(channel.sent.some(([kind, , name]) => kind === 'file' && name === '消防通知.docx'));
  assert.match(last(), /✅ #1 完成（中档 · GPT · 用时[\s\S]*通知已完成[\s\S]*开新任务发 \/新/);
  assert.equal(service.draft('me').stage, 'idle');                                   // 提交后回到新任务
});

test('/2 cancels at any step; while planning other text waits', async () => {
  const { service, say, last } = newService([{ wait: true }]);
  await say('3');
  await say('写个方案');
  const started = say('开始');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(service.draft('me').stage, 'planning');
  await service.onMessage({ from: 'me', chatType: 'single', dedupeKey: 'w1', type: 'text', text: '快点' });
  assert.match(last(), /组长还在出方案/);
  await service.onMessage({ from: 'me', chatType: 'single', dedupeKey: 'w2', type: 'text', text: '/2' });
  await started;
  assert.match(last(), /已取消 #1/);
  assert.equal(service.store.get('me', 1).status, 'cancelled');
  assert.equal(service.draft('me').stage, 'idle');
  await say('/2');
  assert.match(last(), /现在没有进行中的步骤/);
});

test('wrong-stage commands remind the current step; unknown commands too', async () => {
  const { say, last } = newService([]);
  await say('/完成');
  assert.match(last(), /现在没有等确认的方案[\s\S]*发需求或文件开始/);
  await say('/乱七八糟');
  assert.match(last(), /没有这个命令（\/0/);
  await say('做个表');
  await say('开始');                                                              // 还没选档：重新提示选档
  assert.match(last(), /没看懂，请回复数字 1、2 或 3[\s\S]*1 低档/);
  await say('/0');
  assert.match(last(), /\/新 新任务[\s\S]*\/进12 接着改 #12/);
});

test('/进 continues an old task with its executor, no plan; /1 and /看 show history', async () => {
  const { service, run, say, last } = newService([plan(), { output: 'v1', file: 'a.docx', session: 'ex-1' }, { output: 'v2', file: 'a-v2.docx' }]);
  await say('1'); await say('写通知'); await say('开始'); await say('完成');
  assert.equal(service.store.get('me', 1).status, 'succeeded');
  await say('/1');
  assert.match(last(), /【最近任务】\n#1 ✅完成 低档·Antigravity[\s\S]*\/看编号 → 详情/);
  await say('/看1');
  assert.match(last(), /方案：/);
  await say('/进1');
  assert.match(last(), /已进入 #1/);
  await say('3');                                                                 // 老任务不能换档
  assert.match(last(), /不能换档/);
  await say('标题加粗');
  await say('开始');
  assert.deepEqual([run.calls[2].name, run.calls[2].session], ['antigravity', 'ex-1']);
  assert.equal(service.store.get('me', 1).turns, 2);
});

test('slow execution gets one reminder', async () => {
  const { service, channel, say } = newService([plan('p', 'b', 1), { wait: true }]);
  await say('1'); await say('x'); await say('开始');
  service.store.update('me', 1, { estimateMinutes: 0.0001 });
  const original = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => original(fn, ms > 1000 ? 20 : ms, ...args);
  try {
    service.onMessage({ from: 'me', chatType: 'single', dedupeKey: 'slow', type: 'text', text: '完成' });
    await new Promise((r) => original(r, 80));
  } finally { global.setTimeout = original; }
  assert.ok(channel.sent.some(([, , t]) => /比预估慢一些，还在做[\s\S]*\/停1/.test(t)));
  await say('/停1');
});

test('plan failure ends the task with /重试; retry re-plans', async () => {
  const { service, say, last } = newService([{ output: 'not json' }, plan()]);
  await say('2'); await say('x'); await say('开始');
  assert.match(last(), /组长没出成方案[\s\S]*\/重试1/);
  assert.equal(service.draft('me').stage, 'idle');
  await say('/重试1');
  assert.match(last(), /📋 #1 方案/);
});

test('low quota blocks before the planner runs', async () => {
  const quotaStatus = async () => [{ provider: 'claude', state: 'available', buckets: [{ id: 'c', fiveHour: { usedPercent: 95, resetsAt: 1795460549 } }] }];
  const { run, say, last } = newService([], { extra: { quota: new QuotaGate({ adapters, quotaStatus, ttlMs: 0 }) } });
  await say('3'); await say('写方案'); await say('开始');
  assert.equal(run.calls.length, 0);
  assert.match(last(), /额度不够[\s\S]*Claude 5 小时额度只剩 5%/);
});

test('two users: separate flows, tasks and files; results only to the owner', async () => {
  const { service, channel, from, say } = newService([plan('A'), plan('B'), { output: 'A', file: 'A.docx' }, { output: 'B', file: 'B.pptx' }], { users: ['alice', 'bob'] });
  await from('alice', { type: 'file', media: { url: 'u' }, fileName: 'alice.xlsx' });
  await say('2', 'alice'); await say('2', 'bob');
  await say('alice 的需求', 'alice'); await say('bob 的需求', 'bob');
  await say('开始', 'alice'); await say('开始', 'bob');
  await say('完成', 'alice'); await say('完成', 'bob');
  // 每人自己的编号和目录
  assert.deepEqual([service.store.get('alice', 1).text, service.store.get('bob', 1).text], ['alice 的需求', 'bob 的需求']);
  assert.deepEqual(fs.readdirSync(path.join(service.store.taskDir('alice', 1), 'in')), ['alice.xlsx']);
  assert.deepEqual(fs.readdirSync(path.join(service.store.taskDir('bob', 1), 'in')), []);
  assert.notEqual(service.store.taskDir('alice', 1), service.store.taskDir('bob', 1));
  const files = channel.sent.filter(([kind]) => kind === 'file').map(([, user, name]) => [user, name]);
  assert.deepEqual(files, [['alice', 'A.docx'], ['bob', 'B.pptx']]);
  assert.match(service.showText('bob', 2), /没有 #2/);
  assert.match(service.showText('bob', 1), /bob 的需求/);
  assert.doesNotMatch(service.showText('bob', 1), /alice/);
});

test('failed delivery is recorded and /重发 sends again', async () => {
  const { service, channel, say, last } = newService([plan(), { output: '好了', file: '方案.docx' }]);
  let fail = true;
  const original = channel.sendFile;
  channel.sendFile = async (user, file) => { if (fail) throw new Error('upload failed'); return original(user, file); };
  await say('1'); await say('x'); await say('开始'); await say('完成');
  assert.equal(service.store.get('me', 1).deliveries[0].status, 'failed');
  assert.match(last(), /方案\.docx（upload failed）.*\/重发1/s);
  fail = false;
  await say('/重发1');
  assert.equal(service.store.get('me', 1).deliveries[0].status, 'sent');
});

test('你好 replies with help; /3 answers with a cheap model without a task', async () => {
  const { service, run, say, last } = newService([{ output: '**今天**是周一' }]);
  await say('你好');
  assert.match(last(), /你好！\n【办公助手】[\s\S]*\/0 帮助/);
  await say('/3今天周几');
  assert.deepEqual([run.calls[0].name, run.calls[0].readonly], ['antigravity', true]);
  assert.equal(last(), '今天是周一');
  assert.equal(service.store.data.tasks.length, 0);
});

test('plainSummary strips links, paths and progress lines', () => {
  assert.equal(plainSummary('交付 [汇总.xlsx](file:///var/lib/a/out/汇总.xlsx)，**新增** `部门汇总`，见 /var/lib/x/out/a.docx。'), '交付 汇总.xlsx，新增 部门汇总，见 a.docx。');
  assert.equal(plainSummary('正在生成预览，请稍候。\n已完成 5 页 PPT。'), '已完成 5 页 PPT。');
});

test('store gc keeps 30 days and cancels stale unconfirmed plans', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-state-'));
  const service = new WechatService({ config: { stateDir }, adapters, channel: fakeChannel(), runAdapter: fakeAdapter([]) });
  const done = service.store.create({ user: 'me', text: 'x' });
  service.store.update('me', done.id, { status: 'succeeded', finishedAt: Date.now() - 4 * 86400_000 });
  const stale = service.store.create({ user: 'me', text: 'y', status: 'review' });
  service.store.update('me', stale.id, { createdAt: Date.now() - 4 * 86400_000 });
  service.gc();
  assert.equal(fs.existsSync(service.store.taskDir('me', done.id)), true);
  assert.equal(service.store.get('me', stale.id).status, 'cancelled');
  service.store.update('me', done.id, { finishedAt: Date.now() - 31 * 86400_000 });
  service.gc();
  assert.equal(service.store.get('me', done.id), null);
});

test('after a task, the next message continues it by default; /新 starts a new one', async () => {
  const { service, run, say, last } = newService([plan(), { output: 'v1', file: 'a.docx', session: 'ex-1' }, { output: 'v2', file: 'a-v2.docx' }]);
  await say('1'); await say('写通知'); await say('开始'); await say('完成');
  await say('标题加粗');
  assert.match(last(), /接着改 #1[\s\S]*开新任务发 \/新/);
  await say('开始');
  assert.deepEqual([run.calls[2].name, run.calls[2].session], ['antigravity', 'ex-1']);
  assert.equal(service.store.get('me', 1).turns, 2);
  await say('/新');
  assert.match(last(), /开新任务/);
  await say('另一个需求');
  assert.match(last(), /收到需求[\s\S]*1 低档/);
});

test('admin assistant: chosen CLI, continuing session, remote tools granted per turn, /新 resets', async () => {
  const granted = [];
  const remote = { grant: (g) => { granted.push(g); return 'cap' + granted.length; }, revoke: () => {}, mcp: (cap) => ({ socket: 's', capability: cap, scope: 'remote', scopeArg: true }) };
  const devices = { list: [{ id: 'mac', label: 'Mac' }], find: () => ({ id: 'mac', label: 'Mac' }), state: new Map([['mac', { online: true }]]), snapshot: () => [] };
  const { service, run, say, last, channel } = newService([
    { output: '已截屏', file: 'mac-屏幕.png', session: 'chat-1' }, { output: '已建好' }, { output: '新对话' }, { output: 'grok 回复' },
  ], { extra: { devices, remote } });
  service.admins.add('me');
  await say('截个屏发我');
  assert.equal(run.calls[0].name, 'claude');
  assert.match(run.calls[0].prompt, /管理员的微信助理[\s\S]*「Mac」[\s\S]*remote_save_screenshot[\s\S]*管理员：截个屏发我/);
  assert.deepEqual(run.calls[0].mcp, { socket: 's', capability: 'cap1', scope: 'remote', scopeArg: true });
  assert.ok(channel.sent.some(([kind, , name]) => kind === 'file' && name === 'mac-屏幕.png'));
  assert.equal(last(), '已截屏');
  await say('在桌面建个 a.txt');
  assert.equal(run.calls[1].session, 'chat-1');                                     // 默认接着聊
  assert.doesNotMatch(run.calls[1].prompt, /管理员的微信助理/);                       // 后续轮只发新消息，提示词短
  assert.equal(granted[1].dir, granted[0].dir);
  await say('/新');
  await say('你是谁');
  assert.equal(run.calls[2].session, undefined);
  assert.notEqual(granted[2].dir, granted[0].dir);
  await say('/模型');
  assert.match(last(), /1 Claude Opus（当前）[\s\S]*4 Grok/);
  await say('/模型4');
  await say('用 grok 回答');
  assert.equal(run.calls[3].name, 'grok');
  assert.match(service.listText('me'), /#1/);
});
