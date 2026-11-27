#!/usr/bin/env node
// ProxyCommand helper：外层 ssh 用 stdin/stdout 和这里通信，这里再用一条
// 受限 ssh 连接 VPS1，通过 -W 把字节转发到 VPS2。它只做管道，不解析 SSH。
const { spawn } = require('node:child_process');

const MAX_PAYLOAD = 64 * 1024;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, name, { max = 4096 } = {}) {
  if (typeof value !== 'string' || value === '' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`跳板参数 ${name} 格式不对`);
  }
  return value;
}

function safePort(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`跳板参数 ${name} 端口不对`);
  return value;
}

function decodePayload(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_PAYLOAD) {
    throw new Error('缺少跳板参数');
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('跳板参数无法解析');
  }
  if (!plain(value) || value.v !== 1 || !plain(value.jump) || !plain(value.target)) {
    throw new Error('跳板参数版本不对');
  }
  const jump = value.jump;
  const target = value.target;
  return {
    v: 1,
    ssh: safeString(value.ssh, 'ssh'),
    jump: {
      host: safeString(jump.host, 'host', { max: 253 }),
      port: safePort(jump.port, 'jump'),
      user: safeString(jump.user, 'user', { max: 64 }),
      key: safeString(jump.key, 'key'),
      knownHosts: safeString(jump.knownHosts, 'knownHosts'),
      ...(jump.certificate === undefined ? {} : { certificate: safeString(jump.certificate, 'certificate') }),
    },
    target: {
      host: safeString(target.host, 'target host', { max: 253 }),
      port: safePort(target.port, 'target'),
    },
  };
}

// 打包后的 helper 在 asar 外，不能 require asar 里的 ssh-options。这段必须与
// ssh-options.jumpArguments 保持一致，test/ssh-jump.test.js 会逐项对照。
const sshPath = (value) => JSON.stringify(process.platform === 'win32' && typeof value === 'string' ? value.replace(/\\/g, '/') : value);

function formatTarget(host, port) {
  const value = String(host || '');
  if (value.startsWith('[') && value.endsWith(']')) return `${value}:${port}`;
  if (value.includes(':')) return `[${value}]:${port}`;
  return `${value}:${port}`;
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

function buildJumpArgs(payload) {
  return jumpArguments(payload);
}

function linePrefixer(stderr) {
  let buffer = '';
  const write = (line) => {
    try { stderr.write('jump: ' + line + '\n'); } catch {}
  };
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) write(line);
    },
    flush() {
      if (buffer) write(buffer);
      buffer = '';
    },
  };
}

function main(env = process.env, {
  spawnProcess = spawn, stdin = process.stdin, stdout = process.stdout,
  stderr = process.stderr, onExit,
} = {}) {
  let payload;
  try {
    payload = decodePayload(env.AGENTDESK_SSH_JUMP);
  } catch (error) {
    try { stderr.write('jump: ' + error.message + '\n'); } catch {}
    if (onExit) onExit(1);
    else process.exitCode = 1;
    return null;
  }

  let child;
  try {
    child = spawnProcess(payload.ssh, buildJumpArgs(payload), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
    });
  } catch (error) {
    try { stderr.write('jump: 无法启动跳板 SSH：' + error.message + '\n'); } catch {}
    if (onExit) onExit(1);
    else process.exitCode = 1;
    return null;
  }

  const prefix = linePrefixer(stderr);
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    prefix.flush();
    try { stdin.unpipe?.(child.stdin); } catch {}
    try { stdin.pause?.(); } catch {}
    try { child.stdin?.end(); } catch {}
    if (onExit) onExit(code ?? 1);
    else process.exitCode = code ?? 1;
  };

  child.once('error', (error) => {
    try { stderr.write('jump: 跳板 SSH 启动失败：' + error.message + '\n'); } catch {}
    finish(1);
  });
  child.once('close', (code) => finish(code));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => prefix.push(String(chunk)));
  child.stdout?.pipe(stdout);
  stdout?.on?.('error', () => {});
  if (stdin?.pipe) stdin.pipe(child.stdin);
  child.stdin?.on?.('error', () => {});
  // The outer ssh gone (it timed out or was stopped; on Windows that does not stop this helper): its end of stdin
  // closes. An inner ssh still in its handshake would not notice and keep this helper alive for good, so it is
  // ended after a short grace period. Seen on Windows: one leftover helper per failed jump attempt.
  let ending = null;
  const outerGone = () => {
    if (ending || finished) return;
    ending = setTimeout(() => { try { child.kill(); } catch {} }, 3000);
  };
  stdin?.on?.('end', outerGone);
  stdin?.on?.('close', outerGone);
  child.once('close', () => clearTimeout(ending));

  const forward = (signal) => () => {
    try { child.kill(signal); } catch {}
  };
  process.once('SIGTERM', forward('SIGTERM'));
  process.once('SIGINT', forward('SIGINT'));
  process.once('SIGHUP', forward('SIGHUP'));
  return child;
}

if (require.main === module) main(process.env);

module.exports = { buildJumpArgs, decodePayload, main };