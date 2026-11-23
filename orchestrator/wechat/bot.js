'use strict';
// 企业微信智能机器人长连接通道（官方 SDK @wecom/aibot-node-sdk）。
// 把 SDK 的消息帧整理成服务需要的统一结构，并提供发文字、发文件、下载文件。
//
// 身份约定（不要混用）：
//   userid  —— 发消息的人（frame.body.from.userid），任务的所有者，权限和限流都按它算
//   chatid  —— 群聊 ID（只有群聊才有）；单聊没有 chatid，主动推送时会话 ID 填 userid
//   frame   —— 原始 WebSocket 帧，只用于 24 小时内的被动回复（透传 req_id），不落盘
// 任务结果（文字和文件）一律主动推送到所有者的单聊（chatid = userid），不发到群里。
//
// 官方限制（2026-11 文档 + SDK 1.0.7 源码）：
//   一个机器人同时只能有一条长连接，新连接会踢掉旧连接；
//   主动推送：用户先发过消息，每个会话 30 条/分钟、1000 条/小时；
//   临时素材：分片 512KB × 最多 100 片（SDK 上限约 50MB），普通文件 20MB，图片 10MB；media_id 3 天有效；
//   入站文件：下载链接 5 分钟有效，最大 100MB，消息里没有文件名（下载时从响应头取）。
const fs = require('node:fs');
const path = require('node:path');

const FILE_LIMIT = 20 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const MARKDOWN_LIMIT = 20480;   // 流式回复 content 上限（字节）；主动推送也按这个切

function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\x00-\x1f/]/g, '_').trim().slice(0, 120);
  return !base || base === '.' || base === '..' ? 'file' : base;
}

// 按 UTF-8 字节切分，尽量在换行处断开。
function splitText(text, limit = 4000) {
  const parts = [];
  let rest = String(text);
  while (Buffer.byteLength(rest) > limit) {
    let cut = 0;
    let bytes = 0;
    for (const ch of rest) {
      const size = Buffer.byteLength(ch);
      if (bytes + size > limit) break;
      bytes += size;
      cut += ch.length;
    }
    const newline = rest.lastIndexOf('\n', cut);
    if (newline > cut / 2) cut = newline + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length || !parts.length) parts.push(rest);
  return parts;
}

// 纯文本放进 markdown 消息：转义会被当成 markdown 的字符，换行用两个空格+换行保持分行。
function toMarkdown(text) {
  return String(text).replace(/([\\`*_[\]#>|])/g, '\\$1').replace(/\n/g, '  \n');
}

// SDK 帧 → 统一消息。
function normalizeFrame(frame) {
  const body = frame?.body || {};
  const type = body.msgtype || '';
  const message = {
    type,
    from: body.from?.userid || '',
    chatType: body.chattype || 'single',
    chatId: body.chatid || null,
    msgId: body.msgid || '',
    createTime: Number(body.create_time) || 0,
    frame,
  };
  if (type === 'text') message.text = body.text?.content || '';
  if (type === 'voice') message.text = body.voice?.content || '';   // 长连接下语音已转成文字
  if (type === 'file') message.media = { url: body.file?.url, aeskey: body.file?.aeskey };
  if (type === 'image') message.media = { url: body.image?.url, aeskey: body.image?.aeskey };
  if (type === 'video') message.media = { url: body.video?.url, aeskey: body.video?.aeskey };
  if (type === 'mixed') {
    // 图文混排：文字拼起来，图片取第一张当附件。
    const items = body.mixed?.msg_item || [];
    message.text = items.filter((item) => item.msgtype === 'text').map((item) => item.text?.content || '').join('\n').trim();
    const image = items.find((item) => item.msgtype === 'image');
    if (image) message.media = { url: image.image?.url, aeskey: image.image?.aeskey };
  }
  if (type === 'event') {
    message.event = body.event?.eventtype || body.event?.event_type || '';
    message.from = body.from?.userid || '';
  }
  // 群里 @机器人 的文字会带 @机器人名 前缀，去掉。
  if (message.chatType === 'group' && message.text) message.text = message.text.replace(/^@\S+\s*/, '');
  message.dedupeKey = message.msgId || [message.from, message.createTime, type, message.event || ''].join(':');
  return message;
}

class BotChannel {
  // client：SDK 的 WSClient（测试时传假对象）
  constructor({ client, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.client = client;
    this.log = log;
    this.sleep = sleep;
  }

  get connected() { return Boolean(this.client.isConnected); }

  // 断线时等重连（SDK 自动重连），最多等 maxMs。
  async waitConnected(maxMs = 120_000) {
    const started = Date.now();
    while (!this.connected) {
      if (Date.now() - started > maxMs) throw new Error('wecom_not_connected');
      await this.sleep(2000);
    }
  }

  // 被动回复（有原始帧时用；一次性结束的流式消息）。失败时退回主动推送。
  async reply(message, text, toUser) {
    if (message?.frame) {
      try {
        const id = `stream_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
        await this.client.replyStream(message.frame, id, toMarkdown(text).slice(0, MARKDOWN_LIMIT), true);
        return;
      } catch (error) {
        this.log('reply failed, falling back to push', describe(error));
      }
    }
    await this.sendText(toUser || message.from, text);
  }

  // 进入会话欢迎语：必须用 enter_chat 事件帧、5 秒内回复。
  async welcome(message, text) {
    if (!message?.frame) return;
    await this.client.replyWelcome(message.frame, { msgtype: 'text', text: { content: text } });
  }

  // 主动推送文字到单聊（chatid = userid）。
  async sendText(userid, text) {
    await this.waitConnected();
    for (const part of splitText(text)) {
      await this.client.sendMessage(userid, { msgtype: 'markdown', markdown: { content: toMarkdown(part) } });
    }
  }

  async upload(filePath, type) {
    const limit = type === 'image' ? IMAGE_LIMIT : FILE_LIMIT;
    const size = fs.statSync(filePath).size;
    if (size > limit) throw Object.assign(new Error('file_too_large'), { code: 'file_too_large', size, limit });
    if (size < 5) throw Object.assign(new Error('file_too_small'), { code: 'file_too_small' });
    await this.waitConnected();
    const result = await this.client.uploadMedia(fs.readFileSync(filePath), { type, filename: path.basename(filePath) });
    if (!result?.media_id) throw new Error('upload_no_media_id');
    return result.media_id;
  }

  async sendFile(userid, filePath) {
    const mediaId = await this.upload(filePath, 'file');
    await this.client.sendMediaMessage(userid, 'file', mediaId);
    return mediaId;
  }

  async sendImage(userid, filePath) {
    const mediaId = await this.upload(filePath, 'image');
    await this.client.sendMediaMessage(userid, 'image', mediaId);
    return mediaId;
  }

  // 下载入站文件并解密，写到 directory；同名自动加 (2)。
  async download(message, directory) {
    if (!message.media?.url) throw new Error('no_media_url');
    const { buffer, filename } = await this.client.downloadFile(message.media.url, message.media.aeskey);
    const fallback = message.type === 'image' ? `图片_${Date.now()}.jpg` : `文件_${Date.now()}`;
    const name = safeName(filename || fallback);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ext = path.extname(name);
    let target = path.join(directory, name);
    for (let n = 2; fs.existsSync(target); n += 1) target = path.join(directory, `${path.basename(name, ext)} (${n})${ext}`);
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    return target;
  }
}

function describe(error) {
  if (!error) return 'unknown';
  if (error instanceof Error) return error.message;
  if (error.errcode !== undefined) return `errcode ${error.errcode} ${error.errmsg || ''}`.trim();
  try { return JSON.stringify(error).slice(0, 200); } catch { return String(error); }
}

// 创建 SDK 客户端并接好事件。onMessage(message) 处理统一消息。
function createBotClient({ botId, secret, onMessage, log }) {
  const { WSClient } = require('@wecom/aibot-node-sdk');
  const logger = {
    debug: () => {},
    info: (msg) => log('sdk', String(msg).slice(0, 300)),
    warn: (msg) => log('sdk warn', String(msg).slice(0, 300)),
    error: (msg) => log('sdk error', String(msg).slice(0, 300)),
  };
  const client = new WSClient({ botId, secret, maxReconnectAttempts: -1, logger });
  // SDK 认证失败若干次后就不再重试，但进程还在：连续 5 次认证失败（Bot ID/Secret 错或被重置）时退出，交给 systemd 稍后重启。
  let authFailures = 0;
  client.on('authenticated', () => { authFailures = 0; log('wecom authenticated'); });
  client.on('error', (error) => {
    if (!/Authentication failed|853000/.test(describe(error))) return;
    authFailures += 1;
    if (authFailures >= 5) { log('wecom auth failed 5 times, exiting (check WECOM_BOT_ID / WECOM_BOT_SECRET)'); process.exit(78); }
  });
  client.on('disconnected', (reason) => log('wecom disconnected', describe(reason)));
  client.on('reconnecting', (attempt) => log('wecom reconnecting', attempt));
  client.on('error', (error) => log('wecom error', describe(error)));
  const dispatch = (frame) => {
    let message;
    try { message = normalizeFrame(frame); } catch (error) { return log('bad frame', describe(error)); }
    Promise.resolve(onMessage(message)).catch((error) => log('message failed', error?.stack || describe(error)));
  };
  client.on('message', dispatch);
  client.on('event', dispatch);
  return client;
}

module.exports = { FILE_LIMIT, IMAGE_LIMIT, BotChannel, normalizeFrame, createBotClient, splitText, toMarkdown, safeName, describe };
