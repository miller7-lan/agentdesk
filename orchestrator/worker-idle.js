'use strict';
// Update-gate probe for the native-chat Worker (windows-chat-worker.js), which runs on its own, outside the app.
// It never starts, stops or disconnects the Worker or anything in it; it only connects, asks, and reads files.
//
//  - Worker answers idleStatus (new Worker): idle / busy from its own counts.
//  - Worker is older and does not know idleStatus: what it can tell through its existing read-only operations is
//    listed, but the result stays "unknown" — the old protocol cannot list every lease, and its command list stops at
//    the latest 16 runs — so installation stays blocked until that Worker is gone.
//  - No Worker answers (ENOENT / ECONNREFUSED): not taken as idle by itself. It counts as idle only when the process
//    list shows no Worker for this state folder AND runs.json has no command left running or unconfirmed AND
//    leases.json has no file operation left open. Anything unreadable makes it unknown.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const LEGACY_REASON = '本机后台进程（Worker）是旧版本，无法确认它是否空闲。请在交互终端和后台命令都结束后，退出该后台进程，再重试更新。';

function readJsonFile(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { error: true };
  }
}

// Command lines of the processes on this computer (read-only). Throws when they cannot be listed.
function listProcessCommandLines(platform = process.platform, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const done = (error, stdout) => {
      if (error) reject(new Error('process_list_failed'));
      else resolve(String(stdout).split(/\r?\n/).filter(Boolean));
    };
    if (platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, done);
    } else if (platform === 'darwin' || platform === 'linux') {
      execFile('/bin/ps', ['-axww', '-o', 'command='], { timeout, maxBuffer: 16 * 1024 * 1024 }, done);
    } else reject(new Error('process_list_unsupported'));
  });
}

function sideEvidence({ stateDir, processes, platform }) {
  const reasons = [];
  const key = (text) => platform === 'win32' ? text.toLowerCase() : text;
  const folder = key(stateDir);
  if (processes.some((line) => key(line).includes('windows-chat-worker') && key(line).includes(folder))) {
    reasons.push('本机后台进程（Worker）仍在运行，但无法连接，无法确认它是否空闲');
  }
  const runs = readJsonFile(path.join(stateDir, 'runs.json'));
  if (runs.error || (runs.value !== undefined && !Array.isArray(runs.value))) reasons.push('本机命令记录无法读取');
  else for (const record of runs.value || []) {
    const snapshot = record?.snapshot;
    if (!snapshot || typeof snapshot !== 'object') { reasons.push('本机命令记录格式无法识别'); break; }
    if (!snapshot.finishedAt) { reasons.push('有本机命令在后台进程退出时仍未结束'); break; }
    if (snapshot.state === 'unknown') { reasons.push('有本机命令的结果尚未确认'); break; }
  }
  const leases = readJsonFile(path.join(stateDir, 'leases.json'));
  if (leases.error || (leases.value !== undefined && !Array.isArray(leases.value))) reasons.push('本机会话授权记录无法读取');
  else if ((leases.value || []).some((lease) => lease?.fileOperation)) reasons.push('有文件写入在后台进程退出时未完成');
  return reasons;
}

function fromStatus(status) {
  if (!status || typeof status !== 'object' || status.protocol !== 1 || typeof status.idle !== 'boolean') {
    return { state: 'unknown', reasons: ['本机后台进程的状态无法识别'] };
  }
  if (status.idle) return { state: 'idle', reasons: [] };
  const reasons = [];
  if (status.runningCommands) reasons.push(`本机仍有 ${status.runningCommands} 个后台命令在运行`);
  if (status.liveTerminals > 0) reasons.push(`本机仍有 ${status.liveTerminals} 个交互终端在运行`);
  if (status.liveTerminals < 0) reasons.push('无法确认交互终端状态');
  if (status.fileOperations) reasons.push('有文件写入尚未完成');
  if (status.fileLocks) reasons.push('有文件仍被单聊锁定');
  if (status.reconciling) reasons.push('有单聊会话正在核对本机状态');
  if (status.pendingStreams) reasons.push('有项目挂载正在建立');
  if (status.unknownCommands) reasons.push('有本机命令的结果尚未确认');
  const running = status.runningCommands || status.liveTerminals > 0 || status.fileOperations || status.fileLocks ||
    status.reconciling || status.pendingStreams;
  return { state: running ? 'busy' : 'unknown', reasons };
}

// connect() → { request(operation, fields), close() } without ever launching a Worker.
// legacyEvidence(connection) → reasons found through the old read-only operations (lookup, shell list, terminalRead).
async function probeWorker({ stateDir, connect, listProcesses, legacyEvidence, platform = process.platform }) {
  let connection;
  try {
    connection = await connect();
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code)) return { state: 'unknown', reasons: ['无法连接本机后台进程'] };
    let processes;
    try { processes = await listProcesses(); } catch { return { state: 'unknown', reasons: ['无法列出本机进程，不能确认后台进程已退出'] }; }
    const reasons = sideEvidence({ stateDir, processes, platform });
    return reasons.length ? { state: 'unknown', reasons } : { state: 'idle', reasons: [], detail: 'no_worker_process' };
  }
  try {
    let status;
    try { status = await connection.request('idleStatus', {}); } catch (error) {
      if (error?.message !== 'invalid_windows_chat_worker_operation') return { state: 'unknown', reasons: ['本机后台进程没有回答状态查询'] };
      let found = [];
      try { found = (await legacyEvidence?.(connection)) || []; } catch { found = ['旧版后台进程的状态查询失败']; }
      return { state: 'unknown', reasons: [...found, LEGACY_REASON], detail: 'legacy_worker' };
    }
    return fromStatus(status);
  } finally {
    try { connection.close?.(); } catch {}
  }
}

// Old Worker: walk the conversations this app knows (threads.json) with the operations an old Worker already has.
// Everything found is reported; nothing it says can make the result idle (see probeWorker).
async function legacyWorkerEvidence(connection, identities) {
  const reasons = [];
  for (const identity of identities) {
    const binding = await connection.request('lookup', { binding: identity });
    if (!binding) continue;
    const full = { ...identity, ...binding };
    try {
      const { runs } = await connection.request('shell', { binding: full, args: { action: 'list' } });
      const active = runs.filter((run) => ['running', 'cancelling', 'queued'].includes(run.state) || run.state === 'unknown');
      if (active.length) reasons.push(`会话中仍有 ${active.length} 个后台命令未结束或结果未确认`);
      if (runs.length >= 16) reasons.push('旧版后台进程只返回最近 16 条命令，较早的命令无法确认');
    } catch { reasons.push('旧版后台进程拒绝列出命令'); }
    try {
      const { terminals } = await connection.request('terminalRead', { binding: full });
      const live = terminals.filter((item) => item.state === 'running').length;
      if (live) reasons.push(`会话中仍有 ${live} 个交互终端在运行`);
    } catch { reasons.push('旧版后台进程拒绝列出终端'); }
  }
  return reasons;
}

module.exports = { probeWorker, legacyWorkerEvidence, listProcessCommandLines, sideEvidence, fromStatus, LEGACY_REASON };
