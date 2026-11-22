// "添加附件成功的提示在本机部署上没看到": every way of adding attachments in Claude/Grok/Antigravity chats, provider-direct
// chats and group chats was silent on success (only errors and packed folders were announced), so on a v1 server
// (no upload receipts) nothing at all told the person the file was added. These texts are now shown on success.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const notice = require('../src/attach-notice');

test('adding attachments is announced, saying where the files are', () => {
  assert.equal(notice.added([{ name: 'a.txt' }], 'chat'), '已添加 1 个附件（先存在本机，发送消息时一起上传）');
  assert.match(notice.added([{ name: 'a' }, { name: 'b' }], 'upload'), /^已添加 2 个附件，正在上传到 VPS2/);
  assert.match(notice.added([{ name: 'a' }], 'group'), /发送任务时一起交给组长和成员/);
  assert.match(notice.added([{ name: 'src.zip', folder: { files: 12, skipped: ['.env'] } }], 'chat'), /src\.zip：已打包 12 个文件（跳过 \.env）/);
  assert.equal(notice.added([], 'chat'), '');
  assert.equal(notice.sent(3), '3 个附件已随消息发送');
  assert.equal(notice.sent(2, 'group'), '2 个附件已随任务提交');
  assert.equal(notice.sent(0), '');
  assert.equal(notice.received('a.txt'), '附件已上传，服务器已校验：a.txt');
});

test('every way of adding attachments announces success, and the page loads the notices first', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
  const html = read('index.html');
  const at = (name) => html.indexOf(`<script src="${name}"></script>`);
  assert.ok(at('attach-notice.js') >= 0 && at('attach-notice.js') < at('live.js') && at('attach-notice.js') < at('provider-direct.js') && at('attach-notice.js') < at('orchestrator.js'));
  assert.match(read('live.js'), /notice\.added\(accepted, uploading \? 'upload' : 'chat'\)/);
  assert.match(read('live.js'), /notice\.sent\(attachments\.length\)/);
  assert.match(read('live.js'), /notice\.received\(file\.name\)/);
  assert.match(read('provider-direct.js'), /AgentDeskAttachNotice\.added\(added, 'chat'\)/);
  assert.match(read('orchestrator.js'), /AgentDeskAttachNotice\.added\(added, 'group'\)/);
  assert.match(read('orchestrator.js'), /AgentDeskAttachNotice\.sent\(sentIds\.size, 'group'\)/);
});
