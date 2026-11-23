'use strict';
// 第 0 步探路服务：验证回调 URL、微信插件里的文字/文件收发和主动推送。不调用任何 AI。
// 用法：node probe.js [/etc/agentdesk-orchestrator/wechat.json]
//   发文字      → 回「收到文字 N 字」
//   发文件/图片 → 下载到 <stateDir>/wechat/probe/，再原样发回，并报告大小
//   /push 秒数  → 过这么多秒后主动推送一条消息（验证无入站消息时能否推送）
//   /long       → 回一条 5000 字的长消息（验证分段）
// 日志只写类型、发送人、长度，不写消息正文。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const wecom = require('./wecom');

const configPath = process.argv[2] || '/etc/agentdesk-orchestrator/wechat.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
for (const key of ['corpId', 'agentId', 'secret', 'token', 'encodingAesKey']) {
  if (!config[key]) { console.error(`wechat.json 缺少 ${key}`); process.exit(2); }
}
const listen = config.listen || { host: '127.0.0.1', port: 9460 };
const allow = new Set(config.allowUsers || []);
const probeDir = path.join(config.stateDir || '/var/lib/agentdesk-orchestrator', 'wechat', 'probe');
const client = new wecom.WecomClient(config);
const seen = new Map();

function log(...parts) { console.log(new Date().toISOString(), ...parts); }

async function handle(message) {
  log('message', message.type, message.event || '', 'from', message.from, message.text ? `len=${[...message.text].length}` : '', message.fileName ? `file=${path.extname(message.fileName)}` : '');
  if (message.type === 'event') return;
  if (allow.size && !allow.has(message.from)) return client.sendText(message.from, '这个助手只为指定成员服务。');
  if (!allow.size) log('提示：allowUsers 为空，你的 userid 是', message.from, '— 写进 wechat.json 的 allowUsers');
  if (message.type === 'text') {
    const push = /^\/push\s+(\d+)/.exec(message.text.trim());
    if (push) {
      const seconds = Math.min(Number(push[1]), 6 * 3600);
      await client.sendText(message.from, `好的，${seconds} 秒后主动推送一条。`);
      setTimeout(() => client.sendText(message.from, `主动推送测试：距离你发消息已过 ${seconds} 秒。`)
        .then(() => log('push ok', seconds)).catch((error) => log('push failed', error.message)), seconds * 1000);
      return;
    }
    if (message.text.trim() === '/long') return client.sendText(message.from, Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行：长消息分段测试，内容凑够长度。`).join('\n'));
    return client.sendText(message.from, `收到文字 ${[...message.text].length} 字。可试：发 Word/Excel/PPT 文件、/push 1800、/long`);
  }
  if (message.mediaId) {
    const saved = await client.download(message.mediaId, probeDir, message.fileName);
    const size = fs.statSync(saved).size;
    log('downloaded', message.type, size, 'bytes');
    await client.sendText(message.from, `收到${message.type === 'image' ? '图片' : message.type === 'file' ? '文件' : message.type}「${path.basename(saved)}」${(size / 1024).toFixed(1)} KB，原样发回：`);
    if (message.type === 'image') return client.sendImage(message.from, saved);
    return client.sendFile(message.from, saved);
  }
  return client.sendText(message.from, `收到 ${message.type} 类型消息（探路阶段不处理）。`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.endsWith('/callback')) { res.writeHead(404); return res.end(); }
  const query = Object.fromEntries(url.searchParams);
  try {
    if (req.method === 'GET') {
      const echo = wecom.verifyUrl(config, query);
      log('url verified');
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(echo);
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const message = wecom.readCallback(config, query, await readBody(req));
    // 5 秒内必须回；回空串表示不做被动回复，企业微信也不会重试。
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('');
    const now = Date.now();
    for (const [key, at] of seen) if (now - at > 10 * 60 * 1000) seen.delete(key);
    if (seen.has(message.dedupeKey)) return log('duplicate ignored');
    seen.set(message.dedupeKey, now);
    handle(message).catch((error) => log('handle failed', error.message));
  } catch (error) {
    log('callback rejected', error.message);
    if (!res.headersSent) { res.writeHead(400); res.end(); }
  }
});

server.listen(listen.port, listen.host, () => log(`probe listening on ${listen.host}:${listen.port}`));
