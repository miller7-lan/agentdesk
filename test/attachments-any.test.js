const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { writeZip, readZip } = require('../orchestrator/zipfile');
const { extractText } = require('../orchestrator/extract');
const { validAttachments, attachmentLimit, maxAttachments } = require('../orchestrator/attachments');
const { readAttachment } = require('../attachment-files');
const Store = require('../orchestrator/store');
const { Scheduler } = require('../orchestrator/scheduler');

const zipOf = (files) => writeZip(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) })));
const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-attach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a ZIP written here reads back, and other tools can open it', (t) => {
  const big = 'repeated line\n'.repeat(5000);
  const bytes = zipOf({ 'folder/a.txt': 'hello', 'folder/中文.md': '你好', 'folder/big.log': big });
  const zip = readZip(bytes);
  assert.deepEqual(zip.entries.map((entry) => entry.name), ['folder/a.txt', 'folder/中文.md', 'folder/big.log']);
  assert.equal(zip.read(zip.entries[1]).toString(), '你好');
  assert.equal(zip.read(zip.entries[2]).toString(), big);
  assert.ok(zip.entries[2].compressedSize < big.length / 10);
  const file = path.join(temporary(t), 'out.zip');
  fs.writeFileSync(file, bytes);
  try {
    assert.match(execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), z.read("folder/a.txt").decode())', file], { encoding: 'utf8' }), /None hello/);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
});

test('Word, Excel, PowerPoint and OpenDocument files get a text copy; other types do not', () => {
  const docx = zipOf({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>第一段 &amp; more</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>' });
  assert.equal(extractText('报告.docx', docx), '第一段 & more\nSecond');
  const xlsx = zipOf({
    'xl/workbook.xml': '<workbook><sheets><sheet name="预算" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>项目</t></si><si><t>金额</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>服务器</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
  });
  assert.equal(extractText('budget.xlsx', xlsx), '## 预算\n项目\t金额\n服务器\t42');
  const pptx = zipOf({
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>One</a:t></a:r></a:p></p:sld>',
  });
  assert.equal(extractText('deck.pptx', pptx), '## 幻灯片 1\nOne\n\n## 幻灯片 2\nTwo');
  assert.match(extractText('code.zip', zipOf({ 'src/a.js': 'x' })), /src\/a\.js\t1 bytes/);
  assert.equal(extractText('photo.png', Buffer.from('png')), undefined);
  assert.equal(extractText('broken.docx', Buffer.from('not a zip')), undefined);
});

test('any file type is accepted, and a folder becomes one .zip without .git or node_modules', async (t) => {
  const dir = temporary(t);
  const binary = path.join(dir, 'model.bin');
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 255]));
  const single = await readAttachment(binary, attachmentLimit);
  assert.equal(single.name, 'model.bin');
  assert.deepEqual([...single.bytes], [0, 1, 2, 255]);

  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, 'src', 'main.py'), 'print(1)');
  fs.writeFileSync(path.join(project, 'node_modules', 'x', 'index.js'), 'big');
  fs.writeFileSync(path.join(project, '.git', 'HEAD'), 'ref');
  const folder = await readAttachment(project, attachmentLimit);
  assert.equal(folder.name, 'project.zip');
  assert.deepEqual(readZip(folder.bytes).entries.map((entry) => entry.name), ['project/src/main.py']);
  assert.equal(folder.folder.files, 1);
  assert.deepEqual(folder.folder.skipped.sort(), ['project/.git', 'project/node_modules']);

  await assert.rejects(readAttachment(binary, 2), /不超过/);
  assert.equal(maxAttachments, 10);
});

test('a group task can carry attachments; the lead and members get them with a text copy', async (t) => {
  const dir = temporary(t);
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(workspace, 'init', '-q');
  fs.writeFileSync(path.join(workspace, 'README.md'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'base');
  const head = git(workspace, 'rev-parse', 'HEAD');
  git(dir, 'clone', '-q', '--bare', workspace, path.join(dir, 'mirror.git'));

  const docx = zipOf({ 'word/document.xml': '<w:p><w:t>需求说明</w:t></w:p>' });
  const item = { id: randomUUID(), name: '需求.docx', size: docx.length, sha256: createHash('sha256').update(docx).digest('hex') };
  const prompts = [];
  const scheduler = new Scheduler({
    config: {
      stateDir: dir, quota: false, acceptance: { mode: 'off' },
      adapters: Object.fromEntries(['codex', 'claude', 'grok', 'gemini'].map((name) => [name, { bin: name, env: {} }])),
      workspaces: { mac: { repository: path.join(dir, 'mirror.git') } },
    },
    store: new Store(':memory:'),
    files: { endpoint: {}, download: async () => docx },
    adapter: async ({ name, prompt }) => {
      prompts.push([name, prompt]);
      return { output: 'read it' };
    },
  });
  t.after(() => scheduler.store.close());

  assert.throws(() => scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'x', mode: 'review_only', attachments: [item] }), /invalid_attachment/);
  const task = scheduler.submit(randomUUID(), { workspace: 'mac', prompt: 'follow the attached spec', attachments: [item] });
  assert.ok(validAttachments(task.attachments));
  task.base = head;
  task.planRaw = JSON.stringify([{ id: 'look', capability: 'scout', prompt: 'read the spec', dependsOn: [] }]);
  await scheduler.run(task, new AbortController().signal);

  const [, prompt] = prompts.find(([, text]) => text.startsWith('read the spec'));
  const files = JSON.parse(prompt.slice(prompt.lastIndexOf('Files: ') + 7));
  assert.equal(files[0].name, '需求.docx');
  assert.equal(fs.readFileSync(files[0].text, 'utf8'), '需求说明');
});
