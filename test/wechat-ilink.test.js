const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { IlinkChannel, normalizeMessage, parseJson, parseAesKey, encrypt, decrypt, splitText } = require('../orchestrator/wechat/ilink');

test('parseJson keeps large message ids exact', () => {
  assert.equal(parseJson('{"msgs":[{"message_id": 7350000000000000123}]}').msgs[0].message_id, '7350000000000000123');
});

test('normalizeMessage maps user messages and ignores bot echoes', () => {
  assert.equal(normalizeMessage({ message_type: 2, item_list: [] }), null);
  const text = normalizeMessage({ message_type: 1, message_id: '9', from_user_id: 'u1@im.wechat', context_token: 'CT', item_list: [{ type: 1, text_item: { text: ' 你好 ' } }] });
  assert.deepEqual([text.type, text.from, text.text, text.contextToken, text.chatType, text.dedupeKey], ['text', 'u1@im.wechat', '你好', 'CT', 'single', '9']);
  const file = normalizeMessage({ message_type: 1, message_id: '10', from_user_id: 'u1', item_list: [{ type: 4, file_item: { file_name: '销售.xlsx', media: { full_url: 'https://cdn/x', aes_key: 'K' } } }] });
  assert.deepEqual([file.type, file.fileName, file.media.full_url], ['file', '销售.xlsx', 'https://cdn/x']);
  const captioned = normalizeMessage({ message_type: 1, message_id: '11', from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '汇总一下' } }, { type: 4, file_item: { file_name: 'a.xlsx', media: {} } }] });
  assert.deepEqual([captioned.type, captioned.text], ['mixed', '汇总一下']);
  const image = normalizeMessage({ message_type: 1, message_id: '12', from_user_id: 'u1', item_list: [{ type: 2, image_item: { aeskey: '00112233445566778899aabbccddeeff', media: { encrypt_query_param: 'q' } } }] });
  assert.deepEqual(parseAesKey(image.media.aes_key), Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  const voice = normalizeMessage({ message_type: 1, message_id: '13', from_user_id: 'u1', item_list: [{ type: 3, voice_item: { text: '做个周报' } }] });
  assert.deepEqual([voice.type, voice.text], ['voice', '做个周报']);
});

test('AES-128-ECB round trip and both aes_key encodings', () => {
  const key = crypto.randomBytes(16);
  const data = Buffer.from('PK\x03\x04 文件内容'.repeat(50));
  assert.deepEqual(decrypt(encrypt(data, key), key), data);
  assert.deepEqual(parseAesKey(key.toString('base64')), key);
  assert.deepEqual(parseAesKey(Buffer.from(key.toString('hex')).toString('base64')), key);
  assert.throws(() => parseAesKey('abc'), /bad_aes_key/);
  assert.ok(splitText('字'.repeat(4000)).every((part) => [...part].length <= 1800));
});

// 假 iLink 服务：getupdates / sendmessage / getuploadurl / CDN 上传下载。
function fakeIlink() {
  const state = { sent: [], uploads: [], updates: [], headers: [], cdnFiles: new Map() };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/ilink/bot/getupdates') {
      state.headers.push(req.headers);
      const next = state.updates.shift();
      if (!next) return setTimeout(() => json({ ret: 0, msgs: [], get_updates_buf: 'BUF-idle' }), 30);
      return json(next);
    }
    if (url.pathname === '/ilink/bot/sendmessage') { state.sent.push(JSON.parse(body).msg); return json({ ret: 0, message_id: 1 }); }
    if (url.pathname === '/ilink/bot/getuploadurl') {
      const request = JSON.parse(body);
      state.uploads.push(request);
      return json({ upload_full_url: `http://127.0.0.1:${server.address().port}/cdn/upload?k=${request.filekey}` });
    }
    if (url.pathname === '/cdn/upload') {
      const param = 'DL-' + url.searchParams.get('k');
      state.cdnFiles.set(param, body);
      res.setHeader('x-encrypted-param', param);
      return res.end();
    }
    if (url.pathname === '/cdn/file') { res.setHeader('content-type', 'application/octet-stream'); return res.end(state.download); }
    res.statusCode = 404; res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

test('polling delivers messages, stores the cursor and context token, replies with it', async () => {
  const { server, state, base } = await fakeIlink();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilink-'));
  try {
    state.updates.push({ ret: 0, get_updates_buf: 'BUF-1', msgs: [
      { message_type: 1, message_id: '100', from_user_id: 'alice@im.wechat', context_token: 'CTX-A', item_list: [{ type: 1, text_item: { text: '你好' } }] },
      { message_type: 2, message_id: '101', from_user_id: 'bot', item_list: [{ type: 1, text_item: { text: '回显' } }] },
    ] });
    const channel = new IlinkChannel({ account: { token: 'TOKEN', baseUrl: base }, stateFile: path.join(dir, 'state.json'), cdnBaseUrl: `${base}/cdn` });
    const controller = new AbortController();
    const received = [];
    const loop = channel.start(async (message) => { received.push(message); await channel.reply(message, '收到'); controller.abort(); }, controller.signal);
    await loop;
    assert.deepEqual(received.map((m) => m.text), ['你好']);
    assert.equal(state.headers[0].authorization, 'Bearer TOKEN');
    assert.equal(state.headers[0].authorizationtype, 'ilink_bot_token');
    assert.equal(state.headers[0]['ilink-app-id'], 'bot');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([state.sent[0].to_user_id, state.sent[0].context_token, state.sent[0].item_list[0].text_item.text, state.sent[0].message_type], ['alice@im.wechat', 'CTX-A', '收到', 2]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(saved.getUpdatesBuf, 'BUF-1');
    assert.equal(saved.contextTokens['alice@im.wechat'], 'CTX-A');
    // 重启后（新实例）主动推送仍带上已保存的 context_token
    const again = new IlinkChannel({ account: { token: 'TOKEN', baseUrl: base }, stateFile: path.join(dir, 'state.json') });
    await again.sendText('alice@im.wechat', '任务完成');
    assert.equal(state.sent.at(-1).context_token, 'CTX-A');
  } finally { server.close(); }
});

test('sendFile encrypts, uploads to the CDN and sends a file item the receiver can decrypt', async () => {
  const { server, state, base } = await fakeIlink();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilink-'));
  try {
    const channel = new IlinkChannel({ account: { token: 'T', baseUrl: base }, stateFile: path.join(dir, 's.json'), cdnBaseUrl: `${base}/cdn` });
    channel.connected = true;
    const file = path.join(dir, '季度汇报.pptx');
    const content = crypto.randomBytes(3000);
    fs.writeFileSync(file, content);
    await channel.sendFile('alice', file);
    const upload = state.uploads[0];
    assert.deepEqual([upload.media_type, upload.to_user_id, upload.rawsize, upload.no_need_thumb], [3, 'alice', 3000, true]);
    assert.equal(upload.rawfilemd5, crypto.createHash('md5').update(content).digest('hex'));
    const item = state.sent[0].item_list[0];
    assert.deepEqual([item.type, item.file_item.file_name, item.file_item.len], [4, '季度汇报.pptx', '3000']);
    const stored = state.cdnFiles.get(item.file_item.media.encrypt_query_param);
    assert.equal(stored.length, upload.filesize);
    assert.deepEqual(decrypt(stored, parseAesKey(item.file_item.media.aes_key)), content);    // 收件方能解开
  } finally { server.close(); }
});

test('download fetches and decrypts an inbound file under its own name', async () => {
  const { server, state, base } = await fakeIlink();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilink-'));
  try {
    const key = crypto.randomBytes(16);
    const content = Buffer.from('PK\x03\x04 excel');
    state.download = encrypt(content, key);
    const channel = new IlinkChannel({ account: { token: 'T', baseUrl: base }, stateFile: path.join(dir, 's.json') });
    const message = { type: 'file', fileName: '../销售.xlsx', media: { full_url: `${base}/cdn/file`, aes_key: key.toString('base64') } };
    const saved = await channel.download(message, path.join(dir, 'in'));
    assert.equal(path.basename(saved), '销售.xlsx');
    assert.deepEqual(fs.readFileSync(saved), content);
  } finally { server.close(); }
});

test('session expiry (-14) pauses polling instead of hammering the server', async () => {
  const { server, state, base } = await fakeIlink();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilink-'));
  try {
    state.updates.push({ ret: -14, errmsg: 'session timeout' });
    const sleeps = [];
    const controller = new AbortController();
    const channel = new IlinkChannel({
      account: { token: 'T', baseUrl: base }, stateFile: path.join(dir, 's.json'),
      sleep: async (ms) => { sleeps.push(ms); controller.abort(); },
    });
    await channel.start(() => {}, controller.signal);
    assert.ok(channel.pausedUntil - Date.now() > 3500_000);
    assert.equal(channel.connected, false);
    assert.equal(sleeps.length, 1);
  } finally { server.close(); }
});
