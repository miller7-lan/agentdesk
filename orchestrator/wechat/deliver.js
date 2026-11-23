'use strict';
// 交付前校验成品文件、带重试地发送，并记录每个文件的发送结果。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// OOXML 必须有的部件：打不开或缺部件的文件不发，免得用户收到坏文件。
const REQUIRED_PART = { '.docx': 'word/document.xml', '.pptx': 'ppt/presentation.xml', '.xlsx': 'xl/workbook.xml' };

const CHECK_ZIP = `
import sys, zipfile
path, part = sys.argv[1], sys.argv[2]
try:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if '[Content_Types].xml' not in names: print('missing [Content_Types].xml'); sys.exit(1)
        if part not in names: print('missing ' + part); sys.exit(1)
        bad = z.testzip()
        if bad: print('corrupt member ' + bad); sys.exit(1)
except zipfile.BadZipFile as e:
    print('not a zip: ' + str(e)); sys.exit(1)
print('ok')
`;

function validateFile(file, python = 'python3') {
  return new Promise((resolve) => {
    let stat;
    try { stat = fs.statSync(file); } catch { return resolve({ ok: false, reason: '文件不存在' }); }
    if (!stat.isFile() || stat.size === 0) return resolve({ ok: false, reason: '文件为空' });
    const part = REQUIRED_PART[path.extname(file).toLowerCase()];
    if (!part) return resolve({ ok: true });
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (head.toString('latin1') !== 'PK\x03\x04') return resolve({ ok: false, reason: '不是有效的 Office 文件（不是 zip）' });
    execFile(python, ['-I', '-c', CHECK_ZIP, file, part], { timeout: 30_000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, reason: `文件损坏（${String(stdout || error.message).trim().slice(0, 80)}）` });
      resolve({ ok: true });
    });
  });
}

// 失败重试：文件过大、过小这类确定性错误不重试。
async function withRetry(action, { attempts = 3, delays = [2000, 8000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (['file_too_large', 'file_too_small'].includes(error?.code) || attempt === attempts) break;
      log('retrying after', error?.message || error);
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    }
  }
  throw lastError;
}

// 逐个校验并发送；返回每个文件的结果 [{ name, status: sent|invalid|too_large|failed, reason?, attempts, at }]
async function deliverFiles({ files, send, validate = validateFile, retry = {}, now = Date.now, log = () => {} }) {
  const results = [];
  for (const file of files) {
    const name = path.basename(file);
    const check = await validate(file);
    if (!check.ok) {
      results.push({ name, status: 'invalid', reason: check.reason, attempts: 0, at: now() });
      continue;
    }
    let attempts = 0;
    try {
      await withRetry(async (attempt) => { attempts = attempt; await send(file); }, { ...retry, log });
      results.push({ name, status: 'sent', attempts, at: now() });
    } catch (error) {
      const tooLarge = error?.code === 'file_too_large';
      results.push({ name, status: tooLarge ? 'too_large' : 'failed', reason: tooLarge ? '超过 20MB' : String(error?.message || error).slice(0, 120), attempts, at: now() });
    }
  }
  return results;
}

module.exports = { validateFile, withRetry, deliverFiles, REQUIRED_PART };
