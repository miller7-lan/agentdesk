const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeFrame, BotChannel, splitText, toMarkdown, FILE_LIMIT } = require('../orchestrator/wechat/bot');
const { validateFile, deliverFiles, withRetry } = require('../orchestrator/wechat/deliver');

const frame = (body) => ({ cmd: 'aibot_msg_callback', headers: { req_id: 'REQ-1' }, body });

test('normalizeFrame keeps userid, chatid and the raw frame apart', () => {
  const single = normalizeFrame(frame({ msgid: 'm1', aibotid: 'b', chattype: 'single', from: { userid: 'alice' }, msgtype: 'text', text: { content: '你好' } }));
  assert.deepEqual([single.type, single.from, single.chatType, single.chatId, single.text, single.dedupeKey], ['text', 'alice', 'single', null, '你好', 'm1']);
  assert.equal(single.frame.headers.req_id, 'REQ-1');
  const group = normalizeFrame(frame({ msgid: 'm2', chattype: 'group', chatid: 'CHAT9', from: { userid: 'bob' }, msgtype: 'text', text: { content: '@办公助手 做个表' } }));
  assert.deepEqual([group.from, group.chatId, group.text], ['bob', 'CHAT9', '做个表']);
  const file = normalizeFrame(frame({ msgid: 'm3', chattype: 'single', from: { userid: 'alice' }, msgtype: 'file', file: { url: 'https://x/enc', aeskey: 'K' } }));
  assert.deepEqual(file.media, { url: 'https://x/enc', aeskey: 'K' });
  const mixed = normalizeFrame(frame({ msgid: 'm4', chattype: 'single', from: { userid: 'alice' }, msgtype: 'mixed',
    mixed: { msg_item: [{ msgtype: 'text', text: { content: '看图' } }, { msgtype: 'image', image: { url: 'u', aeskey: 'k' } }] } }));
  assert.deepEqual([mixed.text, mixed.media.url], ['看图', 'u']);
  const voice = normalizeFrame(frame({ msgid: 'm5', chattype: 'single', from: { userid: 'alice' }, msgtype: 'voice', voice: { content: '做个周报' } }));
  assert.equal(voice.text, '做个周报');
  const event = normalizeFrame(frame({ msgid: 'e1', create_time: 1, chattype: 'single', from: { userid: 'alice' }, msgtype: 'event', event: { eventtype: 'enter_chat' } }));
  assert.deepEqual([event.type, event.event, event.from], ['event', 'enter_chat', 'alice']);
});

test('toMarkdown escapes markdown syntax and keeps line breaks; splitText respects the byte limit', () => {
  assert.equal(toMarkdown('a*b_c\n#1 [x]'), 'a\\*b\\_c  \n\\#1 \\[x\\]');
  const parts = splitText('行\n'.repeat(3000), 4000);
  assert.ok(parts.length > 1 && parts.every((part) => Buffer.byteLength(part) <= 4000));
});

function fakeSdk({ failReplies = false, connected = true } = {}) {
  const calls = [];
  return {
    calls,
    isConnected: connected,
    replyStream: async (f, id, content, finish) => { calls.push(['replyStream', f.headers.req_id, content, finish]); if (failReplies) throw { errcode: 40000, errmsg: 'expired' }; return {}; },
    replyWelcome: async (f, body) => { calls.push(['replyWelcome', f.headers.req_id, body.text.content]); },
    sendMessage: async (chatid, body) => { calls.push(['sendMessage', chatid, body.msgtype, body.markdown?.content]); return {}; },
    uploadMedia: async (buffer, options) => { calls.push(['uploadMedia', options.type, options.filename, buffer.length]); return { type: options.type, media_id: 'MEDIA-' + options.filename }; },
    sendMediaMessage: async (chatid, type, mediaId) => { calls.push(['sendMediaMessage', chatid, type, mediaId]); return {}; },
    downloadFile: async () => ({ buffer: Buffer.from('PKdata'), filename: '../../销售.xlsx' }),
  };
}

test('reply uses the passive stream on the original frame, falls back to an active push to the userid', async () => {
  const sdk = fakeSdk();
  const channel = new BotChannel({ client: sdk });
  const message = normalizeFrame(frame({ msgid: 'm', chattype: 'single', from: { userid: 'alice' }, msgtype: 'text', text: { content: 'x' } }));
  await channel.reply(message, '收到 #1');
  assert.deepEqual(sdk.calls[0], ['replyStream', 'REQ-1', '收到 \\#1', true]);
  const failing = fakeSdk({ failReplies: true });
  await new BotChannel({ client: failing }).reply(message, '收到', 'alice');
  assert.deepEqual(failing.calls.map((c) => c[0]), ['replyStream', 'sendMessage']);
  assert.equal(failing.calls[1][1], 'alice');
});

test('sendFile uploads then pushes the media to the owner userid; oversize files are refused before upload', async () => {
  const sdk = fakeSdk();
  const channel = new BotChannel({ client: sdk });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-bot-'));
  const file = path.join(dir, '季度汇报.pptx');
  fs.writeFileSync(file, 'PK' + 'x'.repeat(100));
  await channel.sendFile('alice', file);
  assert.deepEqual(sdk.calls, [['uploadMedia', 'file', '季度汇报.pptx', 102], ['sendMediaMessage', 'alice', 'file', 'MEDIA-季度汇报.pptx']]);
  const big = path.join(dir, 'big.docx');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, FILE_LIMIT + 1);
  await assert.rejects(channel.sendFile('alice', big), (error) => error.code === 'file_too_large');
  assert.equal(sdk.calls.length, 2);
});

test('sending waits for reconnection and gives up after the limit', async () => {
  const sdk = fakeSdk({ connected: false });
  let slept = 0;
  const channel = new BotChannel({ client: sdk, sleep: async () => { slept += 1; if (slept === 3) sdk.isConnected = true; } });
  await channel.sendText('alice', 'hi');
  assert.equal(slept, 3);
  const never = new BotChannel({ client: fakeSdk({ connected: false }), sleep: async () => {} });
  await assert.rejects(never.waitConnected(-1), /wecom_not_connected/);
});

test('download decrypts through the SDK and strips path components from the name', async () => {
  const channel = new BotChannel({ client: fakeSdk() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-dl-'));
  const message = { type: 'file', media: { url: 'u', aeskey: 'k' } };
  assert.equal(path.basename(await channel.download(message, dir)), '销售.xlsx');
  assert.equal(path.basename(await channel.download(message, dir)), '销售 (2).xlsx');
});

const linuxOnly = process.platform === 'win32' ? test.skip : test;

function makeZip(file, entries) {
  execFileSync('python3', ['-I', '-c', 'import sys, zipfile, json\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    for n in json.loads(sys.argv[2]): z.writestr(n, "<x/>")', file, JSON.stringify(entries)]);
}

linuxOnly('validateFile accepts real OOXML packages and rejects broken ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-val-'));
  const docx = path.join(dir, 'a.docx');
  makeZip(docx, ['[Content_Types].xml', 'word/document.xml']);
  assert.deepEqual(await validateFile(docx), { ok: true });
  const pptx = path.join(dir, 'b.pptx');
  makeZip(pptx, ['[Content_Types].xml', 'word/document.xml']);       // 扩展名是 pptx，内容却是 Word
  assert.equal((await validateFile(pptx)).ok, false);
  const fake = path.join(dir, 'c.docx');
  fs.writeFileSync(fake, 'not a zip');
  assert.equal((await validateFile(fake)).ok, false);
  const empty = path.join(dir, 'd.txt');
  fs.writeFileSync(empty, '');
  assert.equal((await validateFile(empty)).ok, false);
  const pdf = path.join(dir, 'e.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4');
  assert.deepEqual(await validateFile(pdf), { ok: true });
});

test('deliverFiles retries transient failures, not oversize, and reports each file', async () => {
  let tries = 0;
  const results = await deliverFiles({
    files: ['/x/a.docx', '/x/b.pptx', '/x/c.pptx', '/x/bad.docx'],
    validate: async (file) => (file.includes('bad') ? { ok: false, reason: '文件损坏' } : { ok: true }),
    send: async (file) => {
      if (file.endsWith('a.docx') && ++tries < 3) throw new Error('ws closed');
      if (file.endsWith('b.pptx')) throw Object.assign(new Error('too big'), { code: 'file_too_large' });
      if (file.endsWith('c.pptx')) throw new Error('system error');
    },
    retry: { sleep: async () => {} },
  });
  assert.deepEqual(results.map((r) => [r.name, r.status, r.attempts]), [
    ['a.docx', 'sent', 3], ['b.pptx', 'too_large', 1], ['c.pptx', 'failed', 3], ['bad.docx', 'invalid', 0],
  ]);
  await assert.rejects(withRetry(async () => { throw new Error('x'); }, { attempts: 2, sleep: async () => {} }), /x/);
});
