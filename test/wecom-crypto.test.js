const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const wecom = require('../orchestrator/wechat/wecom');

const config = { token: 'QDG6eK', encodingAesKey: 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C', corpId: 'wx5823bf96d3bd56c7' };

function signed(encrypted, timestamp = '1409659813', nonce = '1372623149') {
  return { msg_signature: wecom.signature(config.token, timestamp, nonce, encrypted), timestamp, nonce };
}

test('encrypt/decrypt round trip with Chinese text and receiver check', () => {
  const xml = '<xml><Content><![CDATA[你好，把这个表汇总一下]]></Content></xml>';
  const encrypted = wecom.encrypt(config.encodingAesKey, config.corpId, xml);
  assert.equal(wecom.decrypt(config.encodingAesKey, config.corpId, encrypted), xml);
  assert.throws(() => wecom.decrypt(config.encodingAesKey, 'other-corp', encrypted), /receiver_mismatch/);
});

test('padding covers exact multiples of 32 bytes', () => {
  for (let size = 0; size < 70; size += 1) {
    const message = 'x'.repeat(size);
    const encrypted = wecom.encrypt(config.encodingAesKey, config.corpId, message);
    assert.equal(wecom.decrypt(config.encodingAesKey, config.corpId, encrypted), message);
  }
});

test('signature is SHA1 of the sorted parts', () => {
  const crypto = require('node:crypto');
  const expected = crypto.createHash('sha1').update(['b', 'a', 'c', 'd'].sort().join('')).digest('hex');
  assert.equal(wecom.signature('b', 'a', 'c', 'd'), expected);
});

test('verifyUrl returns echostr and rejects a bad signature', () => {
  const echostr = wecom.encrypt(config.encodingAesKey, config.corpId, '1616140317555161061');
  assert.equal(wecom.verifyUrl(config, { ...signed(echostr), echostr }), '1616140317555161061');
  assert.throws(() => wecom.verifyUrl(config, { ...signed(echostr), msg_signature: '0'.repeat(40), echostr }), /bad_signature/);
});

test('readCallback parses text, file and event messages', () => {
  const inner = (body) => `<xml><ToUserName><![CDATA[${config.corpId}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1348831860</CreateTime>${body}<AgentID>1000002</AgentID></xml>`;
  const post = (xml) => {
    const encrypted = wecom.encrypt(config.encodingAesKey, config.corpId, xml);
    const body = `<xml><ToUserName><![CDATA[${config.corpId}]]></ToUserName><AgentID><![CDATA[1000002]]></AgentID><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
    return wecom.readCallback(config, signed(encrypted), body);
  };
  const text = post(inner('<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/高 做个周报 & 汇总]]></Content><MsgId>1234567890123456</MsgId>'));
  assert.deepEqual([text.type, text.from, text.text, text.msgId, text.dedupeKey], ['text', 'zhangsan', '/高 做个周报 & 汇总', '1234567890123456', '1234567890123456']);
  const file = post(inner('<MsgType><![CDATA[file]]></MsgType><MediaId><![CDATA[MEDIA1]]></MediaId><FileName><![CDATA[销售.xlsx]]></FileName><MsgId>99</MsgId>'));
  assert.deepEqual([file.type, file.mediaId, file.fileName], ['file', 'MEDIA1', '销售.xlsx']);
  const event = post(inner('<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[enter_agent]]></Event>'));
  assert.equal(event.event, 'enter_agent');
  assert.equal(event.dedupeKey, 'zhangsan:1348831860:event:enter_agent');
});

test('splitText keeps each part within the byte limit and prefers newlines', () => {
  const text = ('第一行内容\n'.repeat(300)) + '尾巴';
  const parts = wecom.splitText(text, 2048);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(Buffer.byteLength(part) <= 2048);
  assert.equal(parts.join(''), text);
  assert.ok(parts[0].endsWith('\n'));
  assert.deepEqual(wecom.splitText(''), ['']);
});

test('safeName strips paths', () => {
  assert.equal(wecom.safeName('../../etc/passwd'), 'passwd');
  assert.equal(wecom.safeName('a\\b\\报告.docx'), '报告.docx');
  assert.equal(wecom.safeName('..'), 'file');
});

function fakeApi(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      handler(req, Buffer.concat(chunks), res);
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('client caches the token, refreshes on 42001, sends, uploads and downloads', async () => {
  const calls = [];
  let tokens = 0;
  let expireOnce = true;
  const server = await fakeApi((req, body, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push(url.pathname);
    const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/gettoken') return json({ errcode: 0, access_token: 'T' + (++tokens), expires_in: 7200 });
    if (url.pathname === '/message/send') {
      if (expireOnce) { expireOnce = false; return json({ errcode: 42001, errmsg: 'expired' }); }
      const payload = JSON.parse(body);
      assert.equal(payload.agentid, 1000002);
      return json({ errcode: 0, token: url.searchParams.get('access_token'), msgtype: payload.msgtype });
    }
    if (url.pathname === '/media/upload') {
      assert.match(body.toString('latin1'), /name="media"; filename="/);
      return json({ errcode: 0, media_id: 'M-' + url.searchParams.get('type') });
    }
    if (url.pathname === '/media/get') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="data.xlsx"');
      return res.end(Buffer.from('PK-fake'));
    }
    json({ errcode: 404 });
  });
  try {
    const client = new wecom.WecomClient({ corpId: 'c', secret: 's', agentId: '1000002', apiBase: `http://127.0.0.1:${server.address().port}` });
    const [sent] = await client.sendText('me', '你好');
    assert.equal(sent.token, 'T2');           // 42001 forced a refresh
    await client.sendText('me', 'again');
    assert.equal(tokens, 2);                  // cached afterwards
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-'));
    const file = path.join(dir, '报告.docx');
    fs.writeFileSync(file, 'doc');
    assert.equal((await client.sendFile('me', file)).msgtype, 'file');
    const saved = await client.download('MEDIA', path.join(dir, 'in'));
    assert.equal(path.basename(saved), 'data.xlsx');
    assert.equal(fs.readFileSync(saved, 'utf8'), 'PK-fake');
    const again = await client.download('MEDIA', path.join(dir, 'in'), '表.xlsx');
    assert.equal(path.basename(again), '表.xlsx');
    const dup = await client.download('MEDIA', path.join(dir, 'in'), '表.xlsx');
    assert.equal(path.basename(dup), '表 (2).xlsx');
  } finally {
    server.close();
  }
});
