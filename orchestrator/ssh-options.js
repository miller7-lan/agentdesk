// SSH 参数、跳板配置和失败分类。桌面端、单聊、独立 Bridge 和 ssh-jump helper 共用。
// 这里不依赖 Electron，也不读取任何密钥内容，只处理路径和参数。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODES = new Set(['auto', 'direct', 'jump']);
const DEFAULT_JUMP = Object.freeze({ mode: 'auto', port: 22, probeMinutes: 10 });
const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9.:[\]_-]{1,253}$/;

const bundledSSH = process.resourcesPath && path.join(process.resourcesPath, 'desktop-backend', 'openssh', 'ssh.exe');
const SSH = process.env.AGENTDESK_SSH || (process.platform === 'win32'
  ? bundledSSH && fs.existsSync(bundledSSH) ? bundledSSH
    : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  : '/usr/bin/ssh');

const sshPath = (value) => JSON.stringify(process.platform === 'win32' && typeof value === 'string' ? value.replace(/\\/g, '/') : value);
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const text = (value) => typeof value === 'string' && value.trim() !== '';

function expandHome(value, home) {
  if (!text(value)) return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

function unsafe(value) {
  return typeof value !== 'string' || /[\0\r\n]/.test(value) || value.length > 4096;
}

function unavailable(reason, raw = {}) {
  return {
    ...DEFAULT_JUMP,
    ...(plain(raw) && MODES.has(raw.mode) ? { mode: raw.mode } : {}),
    unavailable: true,
    unavailableReason: reason,
  };
}

// 返回 { mode, host, port, user, key, knownHosts, certificate?, probeMinutes }；
// 配置缺失/非法时返回带 unavailable 的对象。调用方把不可用理解为“只走直连”，
// 这样本机写错跳板不会把原本正常的直连一起弄断。
function normalizeJump(raw, { home = os.homedir(), checkFiles = false } = {}) {
  if (raw === undefined || raw === null) return null;
  if (!plain(raw)) return unavailable('跳板配置必须是一个 JSON 对象');
  const mode = raw.mode === undefined ? DEFAULT_JUMP.mode : raw.mode;
  if (!MODES.has(mode)) return unavailable('跳板 mode 只能是 auto、direct 或 jump', raw);
  if (mode === 'direct') return { mode, port: DEFAULT_JUMP.port, probeMinutes: DEFAULT_JUMP.probeMinutes };

  if (!text(raw.host) || !HOST_RE.test(raw.host.trim())) return unavailable('跳板 host 缺失或格式不对', raw);
  if (!text(raw.user) || !USER_RE.test(raw.user)) return unavailable('跳板 user 缺失或格式不对', raw);
  if (!text(raw.key) || unsafe(raw.key)) return unavailable('跳板 key 缺失或格式不对', raw);
  if (!text(raw.knownHosts) || unsafe(raw.knownHosts)) return unavailable('跳板 knownHosts 缺失或格式不对', raw);
  const port = raw.port === undefined ? DEFAULT_JUMP.port : raw.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return unavailable('跳板 port 必须是 1–65535 的整数', raw);
  const probeMinutes = raw.probeMinutes === undefined ? DEFAULT_JUMP.probeMinutes : raw.probeMinutes;
  if (!Number.isInteger(probeMinutes) || probeMinutes < 1 || probeMinutes > 1440) {
    return unavailable('跳板 probeMinutes 必须是 1–1440 的整数', raw);
  }
  if (raw.certificate !== undefined && (!text(raw.certificate) || unsafe(raw.certificate))) return unavailable('跳板 certificate 格式不对', raw);

  const jump = {
    mode,
    host: raw.host.trim(),
    port,
    user: raw.user,
    key: expandHome(raw.key, home),
    knownHosts: expandHome(raw.knownHosts, home),
    probeMinutes,
    ...(raw.certificate ? { certificate: expandHome(raw.certificate, home) } : {}),
  };
  if (checkFiles) {
    if (!fs.existsSync(jump.key)) return unavailable('找不到跳板密钥文件', raw);
    if (!fs.existsSync(jump.knownHosts)) return unavailable('找不到跳板 known_hosts 文件', raw);
    if (jump.certificate && !fs.existsSync(jump.certificate)) return unavailable('找不到跳板 certificate 文件', raw);
  }
  return jump;
}

function isJumpConfigured(jump) {
  return Boolean(jump) && !jump.unavailable && jump.mode !== 'direct' &&
    text(jump.host) && text(jump.user) && text(jump.key) && text(jump.knownHosts);
}

// 安装包负责“连哪台 VPS1”，本机负责“用哪把钥匙、信哪份 known_hosts”。
// mode 本机优先，方便把 jump.mode 改成 direct 做紧急回滚。
function mergeJump(local, bundled) {
  const l = plain(local) ? local : null;
  const b = plain(bundled) ? bundled : null;
  if (!l && !b) return null;
  const result = { ...DEFAULT_JUMP };
  for (const key of ['key', 'knownHosts', 'certificate', 'probeMinutes']) {
    if (l && own(l, key)) result[key] = l[key];
  }
  for (const key of ['host', 'port', 'user']) {
    if (b && own(b, key)) result[key] = b[key];
    else if (l && own(l, key)) result[key] = l[key];
  }
  if (l && own(l, 'mode')) result.mode = l.mode;
  else if (b && own(b, 'mode')) result.mode = b.mode;
  return result;
}

// 与 remote.js 原有参数逐字一致，避免没有跳板时行为回归。
function buildSshBase(cfg = {}, key, certificate, { connectTimeout = 15 } = {}) {
  return [
    '-F', 'none', '-T',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${sshPath(cfg.knownHosts)}`, '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
    '-o', `ConnectTimeout=${connectTimeout}`, '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-i', key,
    ...(certificate ? ['-o', 'CertificateFile=' + sshPath(certificate)] : []),
  ];
}

function formatTarget(host, port) {
  const value = String(host || '');
  if (value.startsWith('[') && value.endsWith(']')) return `${value}:${port}`;
  if (value.includes(':')) return `[${value}]:${port}`;
  return `${value}:${port}`;
}

function jumpPayload(jump, target, ssh = SSH) {
  return {
    v: 1,
    jump: {
      host: jump.host,
      port: jump.port,
      user: jump.user,
      key: jump.key,
      knownHosts: jump.knownHosts,
      ...(jump.certificate ? { certificate: jump.certificate } : {}),
    },
    target: { host: target.host, port: target.port },
    ssh,
  };
}

function jumpEnvironment(payload, runtime = jumpRuntime()) {
  return {
    AGENTDESK_SSH_JUMP: Buffer.from(JSON.stringify(payload)).toString('base64url'),
    ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}

function jumpArguments(payload) {
  const jump = payload.jump;
  const target = payload.target;
  return [
    '-F', 'none', '-T',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${sshPath(jump.knownHosts)}`, '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-i', jump.key,
    ...(jump.certificate ? ['-o', 'CertificateFile=' + sshPath(jump.certificate)] : []),
    '-p', String(jump.port),
    '-W', formatTarget(target.host, target.port),
    '--', jump.user + '@' + jump.host,
  ];
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function proxyCommandFor({ nodePath, helperPath, platform = process.platform } = {}) {
  if (!text(nodePath) || !text(helperPath)) throw new Error('找不到 SSH 跳板运行文件');
  if (platform === 'win32') {
    for (const [label, value] of [['node', nodePath], ['helper', helperPath]]) {
      if (/["\r\n%]/.test(value)) throw new Error(`SSH 跳板 ${label} 路径包含 Windows 不支持的字符（引号、换行或 %）`);
    }
    return `"${nodePath}" "${helperPath}"`;
  }
  // OpenSSH 在交给 shell 之前会展开 ProxyCommand 里的 %，路径中的 % 要写成 %%。
  const escape = (value) => String(value).replace(/%/g, '%%');
  return `${posixQuote(escape(nodePath))} ${posixQuote(escape(helperPath))}`;
}

// Windows 命令行的一个参数（CommandLineToArgvW / MSVCRT 规则）：需要时加引号，引号前的反斜杠加倍。
function windowsArg(value) {
  const textValue = String(value);
  if (textValue !== '' && !/[\s"]/.test(textValue)) return textValue;
  return '"' + textValue.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

// Windows 上 ProxyCommand 直接运行 ssh.exe -W，不经 ssh-jump.js：AgentDesk.exe 是图形界面程序，
// 以 ELECTRON_RUN_AS_NODE 运行时读不到 ssh 传来的标准输入，外层握手永远到不了 VPS2（0.5.8 实测）。
// ssh -W 在标准输入关闭时自己退出，外层 ssh 结束后不会留下进程。
function windowsJumpCommand(payload) {
  const raw = [payload.ssh, payload.jump.key, payload.jump.knownHosts, payload.jump.certificate].filter((v) => v !== undefined);
  for (const value of raw) {
    if (/["%\r\n]/.test(String(value))) throw new Error('SSH 跳板路径包含 Windows 不支持的字符（引号、换行或 %）');
  }
  return [payload.ssh, ...jumpArguments(payload)].map(windowsArg).join(' ');
}

// 打包后的 Electron 必须从 asar 外执行 helper；开发态、独立 Bridge 和测试从仓库/部署目录执行。
function jumpHelperPath({ packaged = Boolean(process.versions.electron && !process.defaultApp), resourcesPath = process.resourcesPath, moduleDir = __dirname } = {}) {
  if (packaged && resourcesPath) {
    const bundled = path.join(resourcesPath, 'ssh-jump.js');
    return fs.existsSync(bundled) ? bundled : null;
  }
  for (const candidate of [path.join(moduleDir, 'orchestrator', 'ssh-jump.js'), path.join(moduleDir, 'ssh-jump.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function jumpRuntime() {
  return { nodePath: process.execPath, electron: Boolean(process.versions && process.versions.electron) };
}

function buildSshInvocation({
  cfg = {}, key, certificate, port, target, targetHost,
  route = 'direct', extraArgs = [], afterTarget = [], jump = cfg.jump,
  connectTimeout = 15, runtime = jumpRuntime(), helperPath, platform = process.platform,
} = {}) {
  const args = buildSshBase(cfg, key, certificate, { connectTimeout });
  let env = {};
  if (route === 'jump' && platform === 'win32') {
    if (!isJumpConfigured(jump)) throw new Error('跳板配置不完整，无法建立跳板连接');
    args.push('-o', 'ProxyCommand=' + windowsJumpCommand(jumpPayload(jump, { host: targetHost, port: port || 22 })));
  } else if (route === 'jump') {
    if (!isJumpConfigured(jump)) throw new Error('跳板配置不完整，无法建立跳板连接');
    const helper = helperPath || jumpHelperPath();
    if (!helper) throw new Error('找不到 ssh-jump.js，无法建立跳板连接');
    const payload = jumpPayload(jump, { host: targetHost, port: port || 22 });
    args.push('-o', 'ProxyCommand=' + proxyCommandFor({ nodePath: runtime.nodePath, helperPath: helper }));
    env = jumpEnvironment(payload, runtime);
  }
  if (port) args.push('-p', String(port));
  args.push(...extraArgs, target, ...afterTarget);
  return { args, env, route };
}

function jumpSignature(jump) {
  if (!isJumpConfigured(jump)) return `direct:${jump?.mode || 'auto'}`;
  return JSON.stringify({
    mode: jump.mode, host: jump.host, port: jump.port, user: jump.user,
    key: jump.key, knownHosts: jump.knownHosts,
    certificate: jump.certificate || '', probeMinutes: jump.probeMinutes,
  });
}

// 只根据 stderr 文本分类；退出码 255 本身不足以证明是传输故障。
function classifySshFailure({ stderr = '', code, signal, route } = {}) {
  const value = String(stderr || '').toLowerCase();
  const jumpSide = /(^|\n)\s*jump:/.test(value);
  let kind = 'unknown';
  if (/host key verification failed|remote host identification has changed|no .* host key is known|host key for .* has changed/.test(value)) {
    kind = 'hostkey';
  } else if (/permission denied|too many authentication failures|no supported authentication|authentication failed|invalid key|load key .* invalid/.test(value)) {
    kind = 'auth';
  } else if (/remote port forwarding failed|administratively prohibited|forwarding failed|cannot listen to port|command not found/.test(value)) {
    kind = 'forward';
  } else if (/bad configuration option|unable to negotiate|bad permissions|bad certificate|no matching host key type|invalid certificate|incorrect passphrase|identity file .* not accessible|no such identity|error in libcrypto|enoent|eacces|spawn .* enoent/.test(value)) {
    kind = 'config';
  } else if (/could not resolve hostname|name or service not known|nodename nor servname|temporary failure in name resolution|getaddrinfo/.test(value)) {
    kind = 'dns';
  } else if (/connection timed out|connection refused|connection closed|connection reset|broken pipe|no route to host|network is unreachable|operation timed out|timeout, server .* not responding|kex_exchange_identification|banner exchange|packet_write_wait|connection attempt failed|ssh_exchange_identification|connection aborted|socket is not connected|proxycommand .* exited|connection to .* closed/.test(value)) {
    kind = 'transport';
  }
  return { kind, jumpSide, text: value, code, signal, route };
}

module.exports = {
  DEFAULT_JUMP,
  MODES,
  SSH,
  buildSshBase,
  buildSshInvocation,
  classifySshFailure,
  formatTarget,
  isJumpConfigured,
  jumpArguments,
  jumpEnvironment,
  jumpHelperPath,
  jumpPayload,
  jumpRuntime,
  jumpSignature,
  mergeJump,
  normalizeJump,
  proxyCommandFor,
  sshPath,
  windowsArg,
  windowsJumpCommand,
};