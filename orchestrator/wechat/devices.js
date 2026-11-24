'use strict';
// 管理员关联的电脑：在线监测 + 远程操作（截屏、读写文件、执行命令）。
// 走主控的 admin.sock（与 admin.js 相同），由主控按 Bridge 名转发给对应电脑；本服务不直接连电脑。
// 在线 = 主控到该 Bridge 的 SSH 或 Relay 通道任一可用，并且 Bridge 真的应答了一次请求（睡眠的电脑通道可能还挂着）。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CHUNK_LIMIT = 40 * 1024 * 1024;

// wechat.json 的 devices：{ "mac": { "label": "Mac", "bridge": "mac", "workspace": "mac" } }；没写就默认只有 Mac。
function deviceList(config = {}) {
  const raw = config.devices || { mac: { label: 'Mac' } };
  return Object.entries(raw).map(([id, item]) => ({ id, label: item.label || id, bridge: item.bridge || id, workspace: item.workspace || id }));
}

class Devices {
  constructor({ config, socket, request = require('../mcp').request, now = Date.now, log = () => {} }) {
    this.list = deviceList(config);
    this.socket = socket;
    this.request = request;
    this.now = now;
    this.log = log;
    this.state = new Map();      // id → { online, since, misses, hits }
    this.offlineAfter = config.deviceOfflineChecks ?? 2;   // 连续几次查不到才算离线，免得网络抖动刷屏
    // 连续几次查到才算上线：Mac 合盖睡眠时会定时短暂醒来（Power Nap/维护唤醒）几十秒，Bridge 能应答，但随即又睡。
    this.onlineAfter = config.deviceOnlineChecks ?? 3;
    this.pingTimeout = config.devicePingTimeoutMs ?? 8_000;
  }

  find(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return this.list[0] || null;
    return this.list.find((device) => device.id.toLowerCase() === key || device.label.toLowerCase() === key) || null;
  }

  // 通道「连着」不等于电脑醒着：Mac 合盖/睡眠时 TCP 不会断，VPS2 的 SSH 要 45 分钟、Relay 也要很久才发现。
  // 所以通道可用后再真的问 Bridge 一次（只读的 locations，几百毫秒），答不上来就算离线。
  async probe(device) {
    try {
      const value = await this.request(this.socket, { kind: 'task.status', task_id: randomUUID(), bridge: device.bridge, body: { operation: 'route_status' } }, 10_000);
      if (!(value?.ssh || value?.relay)) return false;
      await this.bridge(device, 'file.read', { operation: 'locations' }, this.pingTimeout);
      return true;
    } catch (error) {
      this.log('device probe failed', device.id, error?.message || error);
      return false;
    }
  }

  // 查一轮，返回状态变化 [{ device, online }]。第一次查到的状态只记下，不算变化。
  async poll() {
    const changes = [];
    for (const device of this.list) {
      const online = await this.probe(device);
      const previous = this.state.get(device.id);
      if (!previous) { this.state.set(device.id, { online, since: this.now(), misses: online ? 0 : this.offlineAfter, hits: online ? this.onlineAfter : 0 }); continue; }
      if (online) {
        const hits = (previous.hits || 0) + 1;
        if (previous.online) this.state.set(device.id, { ...previous, misses: 0, hits });
        else if (hits >= this.onlineAfter) {
          changes.push({ device, online: true, offlineFor: this.now() - previous.since });
          this.state.set(device.id, { online: true, since: this.now(), misses: 0, hits });
        } else this.state.set(device.id, { ...previous, hits });
      } else {
        const misses = previous.misses + 1;
        if (previous.online && misses >= this.offlineAfter) {
          changes.push({ device, online: false });
          this.state.set(device.id, { online: false, since: this.now(), misses, hits: 0 });
        } else this.state.set(device.id, { ...previous, misses, hits: 0 });
      }
    }
    return changes;
  }

  // 现查所有电脑（不等定时轮询、不做防抖），返回 [{ device, online }]。
  async check() {
    return Promise.all(this.list.map(async (device) => ({ device, online: await this.probe(device) })));
  }

  snapshot() {
    return this.list.map((device) => ({ device, ...(this.state.get(device.id) || { online: null, since: null }) }));
  }

  bridge(device, kind, body, timeout = 60_000, taskId = randomUUID()) {
    return this.request(this.socket, { operation: 'bridge', bridge: device.bridge, task_id: taskId, kind, body: { workspace: device.workspace, ...body } }, timeout, CHUNK_LIMIT);
  }

  // 截屏：返回保存到本地的 PNG 路径。
  async screenshot(device, dir) {
    const taskId = randomUUID();
    const reply = await this.bridge(device, 'task.request', { operation: 'desktop', tool: 'desktop_screenshot', arguments: {} }, 60_000, taskId);
    const image = reply?.contentItems?.find((item) => item.type === 'artifact');
    if (!image) throw new Error(reply?.contentItems?.find((item) => item.type === 'text')?.text?.slice(0, 200) || 'no_image');
    const chunks = [];
    for (let offset = 0, size = image.size || Infinity; offset < size;) {
      const part = await this.request(this.socket, { operation: 'bridge', bridge: device.bridge, task_id: taskId, kind: 'file.read', body: { operation: 'artifact', stream_id: image.stream_id, offset } }, 30_000, CHUNK_LIMIT);
      const data = Buffer.from(part?.data || part?.content || '', 'base64');
      if (!data.length) break;
      chunks.push(data);
      offset += data.length;
      if (part.eof || part.done) break;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${device.id}-屏幕-${new Date(this.now()).toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`);
    fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
    return file;
  }

  // 在电脑上写一个文本文件（绝对路径或 ~/…）；需要 Bridge 配置 readAnyFolder + writeAnyFolder。
  // version：覆盖已有文件时传它当前的版本（stat 拿），新文件传 null。
  async writeFile(device, target, content, version = null) {
    // 单个 write 只收流式内容；write_batch 可以直接带文字。
    const reply = await this.bridge(device, 'file.write', { operation: 'write_batch', root: 'computer', anyFolder: true, backup: true, items: [{ path: target, version, content, encoding: 'utf8' }] });
    const result = reply?.results?.[0];
    if (result?.status !== 'written') throw new Error(result?.error || 'write_failed');
    return result;
  }

  listDir(device, target) {
    return this.bridge(device, 'file.read', { operation: 'list', root: 'computer', anyFolder: true, path: target });
  }
}

function since(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.round(minutes / 6) / 10;
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

function changeText({ device, online, offlineFor }) {
  return online
    ? `🟢 ${device.label} 已上线${offlineFor ? `（离线了 ${since(offlineFor)}）` : ''}，可以远程操作了。`
    : `🔴 ${device.label} 离线了。电脑开机并登录后 Bridge 会自动连上（不用打开 AgentDesk）；长时间不上线请检查电脑是否睡眠、断网。`;
}

function statusText(snapshot, now = Date.now()) {
  return '【设备】\n' + snapshot.map(({ device, online, since: at }) => {
    if (online === null) return `⚪ ${device.label}：还没查到`;
    return `${online ? '🟢' : '🔴'} ${device.label}：${online ? '在线' : '离线'}${at != null ? `（${since(now - at)}）` : ''}`;
  }).join('\n');
}

module.exports = { Devices, deviceList, changeText, statusText, since };
