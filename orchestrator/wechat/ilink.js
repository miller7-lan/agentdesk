'use strict';
// 个人微信 ClawBot 通道（腾讯 iLink 协议，与官方 OpenClaw 插件 @tencent-weixin/openclaw-weixin 2.4.10 相同的 HTTP 接口）。
// 提供与 bot.js（企业微信）相同的通道接口：reply / welcome / sendText / sendFile / sendImage / download，
// 外加 start(onMessage) 长轮询收消息。只用 Node 内置模块。
//
// 协议要点（读自插件源码 src/api、src/cdn、src/auth）：
//   POST {baseUrl}/ilink/bot/getupdates   { get_updates_buf, base_info }  长轮询约 35 秒；服务端可给 longpolling_timeout_ms
//   POST {baseUrl}/ilink/bot/sendmessage  { msg: { to_user_id, client_id, message_type: 2, message_state: 2, item_list, context_token } }
//   POST {baseUrl}/ilink/bot/getuploadurl { filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, no_need_thumb, aeskey(hex) }
//   CDN 上传：AES-128-ECB(PKCS7) 密文 POST 到 upload_full_url，响应头 x-encrypted-param 即下载参数
//   CDN 下载：full_url 或 {cdn}/download?encrypted_query_param=…，AES-128-ECB 解密
//   请求头：Authorization: Bearer <bot_token>、AuthorizationType: ilink_bot_token、X-WECHAT-UIN（随机）、iLink-App-Id、iLink-App-ClientVersion
//   errcode/ret = -14：会话失效，暂停 1 小时（插件同样处理）
//   回复要带对方最近一条消息的 context_token；没有时插件也照发，但可能被拒。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const PROTOCOL_VERSION = '2.4.10';               // 对齐的插件版本
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const BOT_AGENT = 'AgentDesk/1.0';
const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
const MEDIA = { IMAGE: 1, VIDEO: 2, FILE: 3 };
const SESSION_EXPIRED = -14;
const FILE_LIMIT = 50 * 1024 * 1024;             // 出站文件上限（协议未写明，取保守值）
const INBOUND_LIMIT = 100 * 1024 * 1024;         // 插件对入站媒体的上限
const TEXT_LIMIT = 1800;                          // 单条文字按字符切分

function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\x00-\x1f/]/g, '_').trim().slice(0, 120);
  return !base || base === '.' || base === '..' ? 'file' : base;
}

function splitText(text, limit = TEXT_LIMIT) {
  const chars = [...String(text)];
  if (chars.length <= limit) return [String(text)];
  const parts = [];
  let rest = chars;
  while (rest.length > limit) {
    let cut = limit;
    const newline = rest.slice(0, limit).lastIndexOf('\n');
    if (newline > limit / 2) cut = newline + 1;
    parts.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  if (rest.length) parts.push(rest.join(''));
  return parts;
}

// 把 JSON 里的大整数 ID（message_id 等）按字符串解析，避免精度丢失。
function parseJson(text) {
  return JSON.parse(String(text).replace(/"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g, '"$1":"$2"'));
}

function encrypt(buffer, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

function decrypt(buffer, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

// aes_key 是 base64：要么是 16 字节原始密钥，要么是 32 位 hex 字符串的 base64。
function parseAesKey(base64) {
  const decoded = Buffer.from(String(base64 || ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw new Error('ilink_bad_aes_key');
}

// iLink 消息 → 统一消息。只处理用户发来的（message_type 1），机器人自己的回显忽略。
function normalizeMessage(raw) {
  if (Number(raw.message_type) !== 1) return null;
  const items = raw.item_list || [];
  const textItem = items.find((item) => item.type === ITEM.TEXT);
  const voice = items.find((item) => item.type === ITEM.VOICE);
  const file = items.find((item) => item.type === ITEM.FILE);
  const image = items.find((item) => item.type === ITEM.IMAGE);
  const video = items.find((item) => item.type === ITEM.VIDEO);
  const message = {
    type: 'text',
    from: raw.from_user_id || '',
    chatType: raw.group_id ? 'group' : 'single',
    chatId: raw.group_id || null,
    msgId: raw.message_id ? String(raw.message_id) : '',
    createTime: Number(raw.create_time_ms) || 0,
    contextToken: raw.context_token || null,
    text: (textItem?.text_item?.text || voice?.voice_item?.text || '').trim(),
  };
  if (file) {
    Object.assign(message, { type: 'file', fileName: file.file_item?.file_name || '', media: { ...file.file_item?.media } });
  } else if (image) {
    const media = { ...image.image_item?.media };
    // image_item.aeskey（hex）优先于 media.aes_key
    if (image.image_item?.aeskey) media.aes_key = Buffer.from(image.image_item.aeskey, 'hex').toString('base64');
    Object.assign(message, { type: 'image', media });
  } else if (video) {
    Object.assign(message, { type: 'video', media: { ...video.video_item?.media } });
  } else if (voice) {
    message.type = 'voice';      // 语音转出的文字在 message.text；没有文字时 router 会提示打字
  }
  // 文件/图片带文字说明时走 mixed：router 把文字一起放进草稿。
  if (message.media && message.text) message.type = 'mixed';
  message.dedupeKey = message.msgId || `${message.from}:${message.createTime}:${items.length}`;
  return message;
}

class IlinkChannel {
  constructor({ account, stateFile, fetchImpl = globalThis.fetch, log = () => {}, sleep = (ms, signal) => sleepFor(ms, signal), cdnBaseUrl = CDN_BASE_URL }) {
    if (!account?.token) throw new Error('ilink_not_logged_in');
    this.account = account;
    this.baseUrl = (account.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.cdnBaseUrl = cdnBaseUrl;
    this.stateFile = stateFile;
    this.fetch = fetchImpl;
    this.log = log;
    this.sleep = sleep;
    this.state = { getUpdatesBuf: '', contextTokens: {} };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch {}
    this.connected = false;
    this.pausedUntil = 0;
  }

  saveState() {
    if (!this.stateFile) return;
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.account.token}`,
      'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString('base64'),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': CLIENT_VERSION,
    };
  }

  async post(endpoint, body, { timeoutMs = 15_000, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetch(`${this.baseUrl}/${endpoint}`, {
        method: 'POST', headers: this.headers(), signal: controller.signal,
        body: JSON.stringify({ ...body, base_info: { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT } }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`ilink_http_${response.status}`);
      return parseJson(text || '{}');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // 长轮询收消息，直到 signal 中止。
  async start(onMessage, signal) {
    let failures = 0;
    let timeoutMs = 35_000;
    this.log('ilink polling started');
    while (!signal?.aborted) {
      if (Date.now() < this.pausedUntil) { await this.sleep(Math.min(60_000, this.pausedUntil - Date.now()), signal); continue; }
      let response;
      try {
        response = await this.post('ilink/bot/getupdates', { get_updates_buf: this.state.getUpdatesBuf || '' }, { timeoutMs: timeoutMs + 5_000, signal });
      } catch (error) {
        if (signal?.aborted) break;
        if (error?.name === 'AbortError') continue;          // 客户端超时：正常，再拉一次
        failures += 1;
        this.connected = false;
        this.log('ilink getupdates failed', error?.message || error, `(${failures})`);
        await this.sleep(failures >= 3 ? 30_000 : 2_000, signal);
        continue;
      }
      const code = response.errcode || response.ret || 0;
      if (code === SESSION_EXPIRED) {
        this.connected = false;
        this.pausedUntil = Date.now() + 3600_000;
        this.log('ilink session expired (-14): paused 1 hour; if it persists, log in again with login.js');
        continue;
      }
      if (code) {
        failures += 1;
        this.connected = false;
        this.log('ilink getupdates error', code, response.errmsg || '', `(${failures})`);
        await this.sleep(failures >= 3 ? 30_000 : 2_000, signal);
        continue;
      }
      if (!this.connected) this.log('ilink connected');
      this.connected = true;
      failures = 0;
      if (response.longpolling_timeout_ms > 0) timeoutMs = response.longpolling_timeout_ms;
      if (response.get_updates_buf) this.state.getUpdatesBuf = response.get_updates_buf;
      let changed = Boolean(response.get_updates_buf);
      for (const raw of response.msgs || []) {
        const message = normalizeMessage(raw);
        if (!message) continue;
        if (message.contextToken && message.from) { this.state.contextTokens[message.from] = message.contextToken; changed = true; }
        Promise.resolve(onMessage(message)).catch((error) => this.log('message failed', error?.stack || error));
      }
      if (changed) this.saveState();
    }
    this.log('ilink polling stopped');
  }

  async waitConnected(maxMs = 120_000) {
    const started = Date.now();
    while (!this.connected) {
      if (Date.now() - started > maxMs) throw new Error('ilink_not_connected');
      await this.sleep(2000);
    }
  }

  async sendItem(userid, item) {
    const response = await this.post('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '', to_user_id: userid, client_id: `agentdesk-${crypto.randomUUID()}`,
        message_type: 2, message_state: 2, item_list: [item],
        context_token: this.state.contextTokens[userid] || undefined,
      },
    });
    if (response.ret && response.ret !== 0) throw new Error(`ilink_send_ret_${response.ret}${response.errmsg ? ': ' + response.errmsg : ''}`);
    return response;
  }

  async reply(message, text, toUser) {
    if (message?.contextToken && message.from) this.state.contextTokens[message.from] = message.contextToken;
    await this.sendText(toUser || message.from, text);
  }

  async welcome() {}

  async sendText(userid, text) {
    for (const part of splitText(text)) await this.sendItem(userid, { type: ITEM.TEXT, text_item: { text: part } });
  }

  async upload(filePath, userid, mediaType) {
    const plain = fs.readFileSync(filePath);
    if (plain.length > FILE_LIMIT) throw Object.assign(new Error('file_too_large'), { code: 'file_too_large' });
    if (plain.length < 5) throw Object.assign(new Error('file_too_small'), { code: 'file_too_small' });
    await this.waitConnected();
    const key = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString('hex');
    const cipher = encrypt(plain, key);
    const target = await this.post('ilink/bot/getuploadurl', {
      filekey, media_type: mediaType, to_user_id: userid,
      rawsize: plain.length, rawfilemd5: crypto.createHash('md5').update(plain).digest('hex'),
      filesize: cipher.length, no_need_thumb: true, aeskey: key.toString('hex'),
    });
    const url = target.upload_full_url?.trim() ||
      (target.upload_param && `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(target.upload_param)}&filekey=${encodeURIComponent(filekey)}`);
    if (!url) throw new Error('ilink_no_upload_url');
    const response = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(cipher) });
    if (response.status !== 200) throw new Error(`ilink_cdn_upload_${response.status}${response.headers.get('x-error-message') ? ': ' + response.headers.get('x-error-message') : ''}`);
    const downloadParam = response.headers.get('x-encrypted-param');
    if (!downloadParam) throw new Error('ilink_cdn_no_download_param');
    // 与插件一致：aes_key 填 hex 字符串的 base64。
    return { media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, size: plain.length, cipherSize: cipher.length };
  }

  async sendFile(userid, filePath) {
    const uploaded = await this.upload(filePath, userid, MEDIA.FILE);
    return this.sendItem(userid, { type: ITEM.FILE, file_item: { media: uploaded.media, file_name: path.basename(filePath), len: String(uploaded.size) } });
  }

  async sendImage(userid, filePath) {
    const uploaded = await this.upload(filePath, userid, MEDIA.IMAGE);
    return this.sendItem(userid, { type: ITEM.IMAGE, image_item: { media: uploaded.media, mid_size: uploaded.cipherSize } });
  }

  async download(message, directory) {
    const media = message.media || {};
    const url = media.full_url || (media.encrypt_query_param && `${this.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`);
    if (!url) throw new Error('no_media_url');
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`ilink_cdn_download_${response.status}`);
    const encrypted = Buffer.from(await response.arrayBuffer());
    if (encrypted.length > INBOUND_LIMIT) throw new Error('file_too_large');
    const buffer = media.aes_key ? decrypt(encrypted, parseAesKey(media.aes_key)) : encrypted;
    const fallback = message.type === 'image' ? `图片_${Date.now()}.jpg` : message.type === 'video' ? `视频_${Date.now()}.mp4` : `文件_${Date.now()}`;
    const name = safeName(message.fileName || fallback);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ext = path.extname(name);
    let target = path.join(directory, name);
    for (let n = 2; fs.existsSync(target); n += 1) target = path.join(directory, `${path.basename(name, ext)} (${n})${ext}`);
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    return target;
  }
}

function sleepFor(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// ---------- 扫码登录 ----------

async function fetchQrCode({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL } = {}) {
  const response = await fetchImpl(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION },
    body: JSON.stringify({ local_token_list: [] }),
  });
  if (!response.ok) throw new Error(`ilink_qrcode_http_${response.status}`);
  return response.json();   // { qrcode, qrcode_img_content }
}

async function pollQrStatus({ qrcode, verifyCode, fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL }) {
  const query = `qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetchImpl(`${baseUrl}/ilink/bot/get_qrcode_status?${query}`, {
      headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION }, signal: controller.signal,
    });
    if (!response.ok) return { status: 'wait' };
    return await response.json();
  } catch {
    return { status: 'wait' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_BASE_URL, CDN_BASE_URL, FILE_LIMIT, ITEM, MEDIA,
  IlinkChannel, normalizeMessage, parseJson, parseAesKey, encrypt, decrypt, splitText, safeName, fetchQrCode, pollQrStatus,
};
