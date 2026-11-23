'use strict';
// 企业微信自建应用：回调验签与加解密、access_token 缓存、发消息、上传和下载素材。
// 只用 Node 内置模块。协议见 https://developer.work.weixin.qq.com/document/path/90968（加解密）
// 和 /90236（发送应用消息）、/90253（上传临时素材）、/90254（获取临时素材）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://qyapi.weixin.qq.com/cgi-bin';
const TEXT_LIMIT = 2048;                     // message/send 的 text.content 上限（字节）
const FILE_LIMIT = 20 * 1024 * 1024;         // media/upload type=file
const IMAGE_LIMIT = 10 * 1024 * 1024;        // media/upload type=image

// ---------- 加解密 ----------

function aesKey(encodingAesKey) {
  const key = Buffer.from(String(encodingAesKey) + '=', 'base64');
  if (key.length !== 32) throw new Error('wecom_bad_aes_key');
  return key;
}

function signature(token, timestamp, nonce, encrypted) {
  return crypto.createHash('sha1').update([String(token), String(timestamp), String(nonce), String(encrypted)].sort().join('')).digest('hex');
}

function verifySignature(token, { msg_signature, timestamp, nonce }, encrypted) {
  if (!msg_signature || !timestamp || !nonce) return false;
  const expected = Buffer.from(signature(token, timestamp, nonce, encrypted));
  const given = Buffer.from(String(msg_signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// 明文 = 16 字节随机串 + 4 字节网络序长度 + 消息 + receiveid，PKCS#7 按 32 字节补齐，AES-256-CBC，iv 为 key 前 16 字节。
function encrypt(encodingAesKey, receiveId, message, random = crypto.randomBytes(16)) {
  const key = aesKey(encodingAesKey);
  const body = Buffer.from(String(message));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const plain = Buffer.concat([random, length, body, Buffer.from(String(receiveId))]);
  const pad = 32 - (plain.length % 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
}

function decrypt(encodingAesKey, receiveId, encrypted) {
  const key = aesKey(encodingAesKey);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([decipher.update(Buffer.from(String(encrypted), 'base64')), decipher.final()]);
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('wecom_bad_padding');
  plain = plain.subarray(0, plain.length - pad);
  if (plain.length < 20) throw new Error('wecom_bad_payload');
  const length = plain.readUInt32BE(16);
  if (20 + length > plain.length) throw new Error('wecom_bad_payload');
  const message = plain.subarray(20, 20 + length).toString('utf8');
  const tail = plain.subarray(20 + length).toString('utf8');
  if (receiveId && tail !== String(receiveId)) throw new Error('wecom_receiver_mismatch');
  return message;
}

// ---------- XML ----------

// 回调 XML 只有一层，字段要么是 CDATA 要么是纯文本，用正则足够；不处理嵌套。
function parseXml(xml) {
  const out = {};
  const pattern = /<([A-Za-z_][\w.-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  for (const match of String(xml).matchAll(pattern)) out[match[1]] = match[2] !== undefined ? match[2] : unescapeXml(match[3]);
  return out;
}

function unescapeXml(text) {
  return String(text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// 解密后的消息 → 统一结构。只保留需要的字段；未知类型照样返回 type。
function normalizeMessage(fields) {
  const message = {
    type: fields.MsgType || '',
    from: fields.FromUserName || '',
    to: fields.ToUserName || '',
    agentId: fields.AgentID || '',
    createTime: Number(fields.CreateTime) || 0,
    msgId: fields.MsgId || '',
  };
  if (message.type === 'text') message.text = fields.Content || '';
  if (['image', 'voice', 'video', 'file'].includes(message.type)) {
    message.mediaId = fields.MediaId || '';
    if (fields.FileName) message.fileName = fields.FileName;
    if (fields.Format) message.format = fields.Format;
    if (fields.Recognition) message.text = fields.Recognition;   // 语音开了转文字时
  }
  if (message.type === 'event') {
    message.event = fields.Event || '';
    message.eventKey = fields.EventKey || '';
  }
  // 去重键：普通消息用 MsgId；事件没有 MsgId，用发送人 + 时间 + 事件名。
  message.dedupeKey = message.msgId || [message.from, message.createTime, message.type, message.event || ''].join(':');
  return message;
}

// ---------- 回调处理（与 HTTP 框架无关） ----------

// GET 校验：返回解密后的 echostr；验签失败抛错。
function verifyUrl(config, query) {
  if (!verifySignature(config.token, query, query.echostr)) throw new Error('wecom_bad_signature');
  return decrypt(config.encodingAesKey, config.corpId, query.echostr);
}

// POST 消息：返回 normalizeMessage 的结果；验签或解密失败抛错。
function readCallback(config, query, body) {
  const outer = parseXml(body);
  if (!outer.Encrypt) throw new Error('wecom_no_encrypt');
  if (!verifySignature(config.token, query, outer.Encrypt)) throw new Error('wecom_bad_signature');
  return normalizeMessage(parseXml(decrypt(config.encodingAesKey, config.corpId, outer.Encrypt)));
}

// ---------- API 客户端 ----------

class WecomError extends Error {
  constructor(errcode, errmsg, where) {
    super(`wecom_${where}_${errcode}: ${errmsg || ''}`.trim());
    this.errcode = errcode;
  }
}

// 按 UTF-8 字节切分长文本，尽量在换行处断开。
function splitText(text, limit = TEXT_LIMIT) {
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

class WecomClient {
  constructor({ corpId, secret, agentId, apiBase = API, fetchImpl = globalThis.fetch, now = Date.now }) {
    if (!corpId || !secret || !agentId) throw new Error('wecom_config_incomplete');
    Object.assign(this, { corpId, secret, agentId: Number(agentId), apiBase, fetchImpl, now });
    this.token = null;
    this.tokenExpires = 0;
    this.pending = null;
  }

  async accessToken(force = false) {
    if (!force && this.token && this.now() < this.tokenExpires) return this.token;
    if (!this.pending) {
      this.pending = (async () => {
        const url = `${this.apiBase}/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.secret)}`;
        const result = await (await this.fetchImpl(url)).json();
        if (result.errcode) throw new WecomError(result.errcode, result.errmsg, 'gettoken');
        this.token = result.access_token;
        // 提前 5 分钟刷新。
        this.tokenExpires = this.now() + Math.max(60, (Number(result.expires_in) || 7200) - 300) * 1000;
        return this.token;
      })().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  // 统一调用：token 失效（40014/42001/41001）时强制刷新重试一次。
  async call(where, makeRequest) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(attempt > 0);
      const response = await makeRequest(token);
      const type = response.headers.get('content-type') || '';
      if (where === 'media_get' && !/json|text\/plain/i.test(type)) return response;
      const result = await response.json();
      if ([40014, 42001, 41001].includes(result.errcode) && attempt === 0) continue;
      if (result.errcode) throw new WecomError(result.errcode, result.errmsg, where);
      return result;
    }
    throw new WecomError(-1, 'token_retry_exhausted', where);
  }

  async send(toUser, payload) {
    return this.call('send', (token) => this.fetchImpl(`${this.apiBase}/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser: toUser, agentid: this.agentId, safe: 0, ...payload }),
    }));
  }

  async sendText(toUser, text) {
    const results = [];
    for (const content of splitText(text)) results.push(await this.send(toUser, { msgtype: 'text', text: { content } }));
    return results;
  }

  async upload(filePath, type = 'file') {
    const size = fs.statSync(filePath).size;
    const limit = type === 'image' ? IMAGE_LIMIT : FILE_LIMIT;
    if (size > limit) throw new Error('wecom_file_too_large');
    const data = fs.readFileSync(filePath);
    const result = await this.call('upload', (token) => {
      const form = new FormData();
      form.append('media', new Blob([data]), path.basename(filePath));
      return this.fetchImpl(`${this.apiBase}/media/upload?access_token=${token}&type=${type}`, { method: 'POST', body: form });
    });
    return result.media_id;
  }

  async sendFile(toUser, filePath) {
    const mediaId = await this.upload(filePath, 'file');
    return this.send(toUser, { msgtype: 'file', file: { media_id: mediaId } });
  }

  async sendImage(toUser, filePath) {
    const mediaId = await this.upload(filePath, 'image');
    return this.send(toUser, { msgtype: 'image', image: { media_id: mediaId } });
  }

  // 下载入站素材到 directory；文件名优先用消息里的 FileName，其次用响应头，最后用 mediaId。
  async download(mediaId, directory, preferredName) {
    const response = await this.call('media_get', (token) =>
      this.fetchImpl(`${this.apiBase}/media/get?access_token=${token}&media_id=${encodeURIComponent(mediaId)}`));
    const disposition = response.headers.get('content-disposition') || '';
    const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    let name = preferredName || (fromHeader && decodeURIComponent(fromHeader[1])) || mediaId;
    name = safeName(name);
    fs.mkdirSync(directory, { recursive: true });
    let target = path.join(directory, name);
    for (let n = 2; fs.existsSync(target); n += 1) {
      const ext = path.extname(name);
      target = path.join(directory, `${path.basename(name, ext)} (${n})${ext}`);
    }
    fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    return target;
  }
}

// 只保留文件名本身，去掉路径分隔符和控制字符；空名或 . / .. 换成 file。
function safeName(name) {
  const base = path.basename(String(name).replace(/\\/g, '/')).replace(/[\x00-\x1f/]/g, '_').trim().slice(0, 120);
  return !base || base === '.' || base === '..' ? 'file' : base;
}

module.exports = {
  TEXT_LIMIT, FILE_LIMIT, IMAGE_LIMIT,
  signature, verifySignature, encrypt, decrypt, parseXml, normalizeMessage,
  verifyUrl, readCallback, splitText, safeName, WecomClient, WecomError,
};
