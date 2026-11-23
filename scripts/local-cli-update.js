#!/usr/bin/env node
// Daily update of the four model CLIs (Codex, Claude Code, Grok, Antigravity) on the owner's own Mac or Windows PC.
// The VPS2 counterpart is orchestrator/agentdesk-cli-update.sh (systemd timer); this one is for the local machines.
//
// The scheduler starts this script every hour; it only does the update once per day, on the first start at or after
// 12:00 America/New_York (DST is followed automatically, the computer's own time zone does not matter). A computer
// that was asleep or off at noon catches up on the next start. Each CLI runs its vendor's own `update`; a CLI that
// is not installed is skipped, a failed update keeps the installed version and the next CLI still runs.
//
//   node scripts/local-cli-update.js --install     register the hourly job (Mac: launchd, Windows: Task Scheduler)
//   node scripts/local-cli-update.js --uninstall   remove it
//   node scripts/local-cli-update.js --now         update immediately, ignoring the time and today's run
//   node scripts/local-cli-update.js --status      last run, next due time, log path
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLIS = [
  { name: 'codex', command: 'codex' },
  { name: 'claude', command: 'claude' },
  { name: 'grok', command: 'grok' },
  { name: 'antigravity', command: 'agy' },
];
const ZONE = 'America/New_York';
const RUN_HOUR = 12;
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const LABEL = 'local.agentdesk.cli-update';
const WIN_TASK = 'AgentDesk CLI Update';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const stateDir = process.env.AGENTDESK_CLI_UPDATE_DIR || path.join(os.homedir(), '.agentdesk');
const stateFile = path.join(stateDir, 'cli-update-state.json');
const lockFile = path.join(stateDir, 'cli-update.lock');
const logFile = path.join(stateDir, 'cli-update.log');

function zoneNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } }
function writeState(value) {
  const temporary = stateFile + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, stateFile);
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(text);
  fs.appendFileSync(logFile, text);
}

// Keep the log bounded: once it passes 1 MB, keep its newest half.
function trimLog() {
  try {
    const { size } = fs.statSync(logFile);
    if (size < 1024 * 1024) return;
    const text = fs.readFileSync(logFile, 'utf8');
    fs.writeFileSync(logFile, text.slice(text.indexOf('\n', text.length / 2) + 1));
  } catch { /* no log yet */ }
}

// One run at a time; a lock older than the longest possible run is left over from a crash.
function takeLock() {
  const stale = (CLIS.length + 1) * UPDATE_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lockFile).mtimeMs > stale) { fs.rmSync(lockFile, { force: true }); continue; } } catch { continue; }
      return false;
    }
  }
  return false;
}

// Windows needs the real file (codex.cmd, claude.exe, ...); `where` returns them in PATHEXT order.
function locate(command) {
  const result = IS_WIN
    ? spawnSync('where', [command], { encoding: 'utf8', windowsHide: true })
    : spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function run(file, args, timeout) {
  // .cmd/.bat shims (npm installs on Windows) can only be started through the shell.
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(file);
  const quoted = shell ? `"${file}"` : file;
  return spawnSync(quoted, args, { encoding: 'utf8', timeout, shell, windowsHide: true, env: process.env });
}

function versionOf(file) {
  const result = run(file, ['--version'], 30 * 1000);
  return result.status === 0 ? (result.stdout || '').trim().split(/\r?\n/)[0] || 'unknown' : 'unknown';
}

function updateAll() {
  let failed = 0;
  for (const cli of CLIS) {
    const file = locate(cli.command);
    if (!file) { log(`[${cli.name}] not installed, skipped`); continue; }
    const before = versionOf(file);
    log(`[${cli.name}] before: ${before} (${file})`);
    const result = run(file, ['update'], UPDATE_TIMEOUT_MS);
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (output) for (const line of output.split(/\r?\n/).slice(-20)) log(`[${cli.name}]   ${line}`);
    const after = versionOf(file);
    const code = result.error ? result.error.code : result.status;
    log(`[${cli.name}] after: ${after} (exit ${code})`);
    if (result.error || result.status !== 0) { failed++; log(`[${cli.name}] update failed; the installed version is kept`); }
  }
  return failed;
}

function main(argv) {
  fs.mkdirSync(stateDir, { recursive: true });
  if (argv.includes('--install')) return install();
  if (argv.includes('--uninstall')) return uninstall();
  const now = zoneNow();
  const state = readState();
  if (argv.includes('--status')) {
    console.log(`上次更新：${state.lastRun || '还没有'}${state.lastDay ? `（美东日期 ${state.lastDay}，失败 ${state.failed} 个）` : ''}`);
    console.log(`计划：美东时间每天 ${RUN_HOUR}:00 之后更新一次；今天（美东 ${now.day}）${state.lastDay === now.day ? '已更新' : '还没更新'}`);
    console.log(`日志：${logFile}`);
    return 0;
  }
  const force = argv.includes('--now');
  if (!force && (now.hour < RUN_HOUR || state.lastDay === now.day)) return 0;
  if (!takeLock()) { console.log('another update is running'); return 0; }
  try {
    trimLog();
    log(`=== CLI update start (${force ? 'manual' : `daily, ${ZONE} ${now.day}`}) ===`);
    const failed = updateAll();
    writeState({ lastDay: now.day, lastRun: new Date().toISOString(), failed });
    log(`=== CLI update done, ${failed} failed ===`);
    return failed ? 1 : 0;
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

function install() {
  const script = path.resolve(__filename);
  const node = process.execPath;
  if (IS_MAC) {
    const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const plist = path.join(agents, LABEL + '.plist');
    const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // launchd starts jobs with a minimal PATH; keep the one the CLIs were found with now (Homebrew, npm, ~/.local/bin).
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin')}</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'cli-update.launchd.err'))}</string>
</dict>
</plist>
`);
    const domain = `gui/${process.getuid()}`;
    spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
    const loaded = spawnSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
    if (loaded.status !== 0) { console.error('launchctl bootstrap 失败'); return 1; }
    console.log(`已安装：${plist}\n每小时检查一次，美东时间每天 ${RUN_HOUR}:00 后更新一次。日志：${logFile}`);
    return 0;
  }
  if (IS_WIN) {
    // wscript starts node without a console window, so the hourly check does not flash a window.
    const launcher = path.join(stateDir, 'cli-update.vbs');
    fs.writeFileSync(launcher, `CreateObject("WScript.Shell").Run """${node}"" ""${script}""", 0, False\r\n`);
    const created = spawnSync('schtasks', ['/Create', '/F', '/TN', WIN_TASK, '/SC', 'HOURLY', '/MO', '1',
      '/TR', `wscript.exe "${launcher}"`], { stdio: 'inherit', windowsHide: true });
    if (created.status !== 0) { console.error('schtasks 创建任务失败'); return 1; }
    console.log(`已安装计划任务「${WIN_TASK}」：每小时检查一次，美东时间每天 ${RUN_HOUR}:00 后更新一次。日志：${logFile}`);
    return 0;
  }
  console.error('Linux 服务器请用 orchestrator/agentdesk-cli-update.sh 和它的 systemd 定时器（见 orchestrator/OPERATIONS.md）。');
  return 1;
}

function uninstall() {
  if (IS_MAC) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
    fs.rmSync(plist, { force: true });
  } else if (IS_WIN) {
    spawnSync('schtasks', ['/Delete', '/F', '/TN', WIN_TASK], { stdio: 'inherit', windowsHide: true });
    fs.rmSync(path.join(stateDir, 'cli-update.vbs'), { force: true });
  }
  console.log('已移除定时任务（日志和状态文件保留在 ' + stateDir + '）');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { zoneNow, main };
