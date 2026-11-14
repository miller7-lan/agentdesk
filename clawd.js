// Clawd on Desk 桌宠接入：通过其本地 HTTP /state 接口推送会话状态（仅状态，不含审批）
// 文档：clawd-on-desk docs/guides/custom-agent-http.md
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const RUNTIME = path.join(os.homedir(), '.clawd', 'runtime.json');
const PREFS = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'clawd-on-desk', 'clawd-prefs.json');
const ID_RE = /^custom-[a-z0-9-]+-[a-f0-9]{12}$/;
const STATES = new Set(['idle', 'thinking', 'working', 'juggling', 'error', 'attention', 'notification', 'sleeping']);

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function runtimePort() {
  const rt = readJson(RUNTIME);
  if (!rt || rt.app !== 'clawd-on-desk') return null;
  const port = typeof rt.port === 'string' && /^\d+$/.test(rt.port) ? Number(rt.port) : rt.port;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// 优先环境变量；否则在 Clawd 已注册的自定义应用里找名字含 AgentDesk 的那一项
function agentId() {
  const env = process.env.AGENTDESK_CLAWD_AGENT_ID;
  if (env && ID_RE.test(env)) return env;
  const prefs = readJson(PREFS);
  const apps = (prefs && Array.isArray(prefs.customApplications)) ? prefs.customApplications : [];
  const self = process.execPath.toLowerCase();
  const hit = apps.find((a) => a && typeof a.executablePath === 'string' && a.executablePath.toLowerCase() === self)
    || apps.find((a) => a && /agentdesk/i.test(`${a.name} ${a.processName} ${a.executablePath}`));
  return hit && ID_RE.test(hit.id) ? hit.id : null;
}

function status() {
  const port = runtimePort();
  const id = agentId();
  return { online: !!port, port, registered: !!id, agentId: id };
}

const live = new Set();

function post(port, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    // Node 的 http 只发一个 Host 头、不带 Origin，符合 Clawd 的安全校验要求
    const req = http.request({
      host: '127.0.0.1', port, path: '/state', method: 'POST', timeout: 1000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0)); // Clawd 不在线时静默忽略，不影响主流程
    req.end(body);
  });
}

async function send(evt) {
  const st = status();
  if (!st.online || !st.registered) return { ok: false, ...st };
  if (!evt || !STATES.has(evt.state) || typeof evt.session_id !== 'string') return { ok: false, ...st, error: 'bad event' };
  const payload = {
    agent_id: st.agentId,
    session_id: evt.session_id,
    state: evt.state,
    event: String(evt.event || 'Notification'),
    platform: 'desktop',
    agent_pid: process.pid,
  };
  for (const k of ['cwd', 'tool_name', 'tool_use_id']) if (typeof evt[k] === 'string') payload[k] = evt[k];
  if (evt.event === 'SessionEnd') live.delete(evt.session_id); else live.add(evt.session_id);
  const code = await post(st.port, payload);
  return { ok: code >= 200 && code < 300, code, ...st };
}

async function endAll() {
  const st = status();
  if (!st.online || !st.registered) return;
  await Promise.all([...live].map((sid) => post(st.port, { agent_id: st.agentId, session_id: sid, state: 'idle', event: 'SessionEnd' })));
  live.clear();
}

module.exports = { status, send, endAll };
