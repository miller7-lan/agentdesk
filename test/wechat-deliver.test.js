const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateFile, deliverFiles, withRetry } = require('../orchestrator/wechat/deliver');

const linuxOnly = process.platform === 'win32' ? test.skip : test;

function makeZip(file, entries) {
  execFileSync('python3', ['-I', '-c', 'import sys, zipfile, json\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    for n in json.loads(sys.argv[2]): z.writestr(n, "<x/>")', file, JSON.stringify(entries)]);
}

linuxOnly('validateFile accepts real OOXML packages and rejects broken ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-val-'));
  const docx = path.join(dir, 'a.docx');
  makeZip(docx, ['[Content_Types].xml', 'word/document.xml']);
  assert.deepEqual(await validateFile(docx), { ok: true });
  const pptx = path.join(dir, 'b.pptx');
  makeZip(pptx, ['[Content_Types].xml', 'word/document.xml']);       // 扩展名是 pptx，内容却是 Word
  assert.equal((await validateFile(pptx)).ok, false);
  const fake = path.join(dir, 'c.docx');
  fs.writeFileSync(fake, 'not a zip');
  assert.equal((await validateFile(fake)).ok, false);
  const empty = path.join(dir, 'd.txt');
  fs.writeFileSync(empty, '');
  assert.equal((await validateFile(empty)).ok, false);
  const pdf = path.join(dir, 'e.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4');
  assert.deepEqual(await validateFile(pdf), { ok: true });
});

test('deliverFiles retries transient failures, not oversize, and reports each file', async () => {
  let tries = 0;
  const results = await deliverFiles({
    files: ['/x/a.docx', '/x/b.pptx', '/x/c.pptx', '/x/bad.docx'],
    validate: async (file) => (file.includes('bad') ? { ok: false, reason: '文件损坏' } : { ok: true }),
    send: async (file) => {
      if (file.endsWith('a.docx') && ++tries < 3) throw new Error('ws closed');
      if (file.endsWith('b.pptx')) throw Object.assign(new Error('too big'), { code: 'file_too_large' });
      if (file.endsWith('c.pptx')) throw new Error('system error');
    },
    retry: { sleep: async () => {} },
  });
  assert.deepEqual(results.map((r) => [r.name, r.status, r.attempts]), [
    ['a.docx', 'sent', 3], ['b.pptx', 'too_large', 1], ['c.pptx', 'failed', 3], ['bad.docx', 'invalid', 0],
  ]);
  await assert.rejects(withRetry(async () => { throw new Error('x'); }, { attempts: 2, sleep: async () => {} }), /x/);
});
