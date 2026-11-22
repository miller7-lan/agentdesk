// What the person is told after adding attachments, and after they went out with a message. Every way of adding a
// file (choose, drop, paste) in a Claude/Grok/Antigravity chat, a provider-direct chat and a group chat used to
// stay silent on success — only errors and packed folders were announced — so a file added on a v1 server (no
// upload receipts; directChatV2 off) showed nothing at all. The texts say honestly where the file is: on this
// computer until the message is sent, or being uploaded when the server confirms uploads (direct chat v2).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentDeskAttachNotice = factory();
})(globalThis, function () {
  'use strict';

  const folderNote = (files) => files.filter((file) => file && file.folder).map((file) => {
    const skipped = file.folder.skipped || [];
    return `${file.name}：已打包 ${file.folder.files} 个文件${skipped.length ? `（跳过 ${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}）` : ''}`;
  });

  // where: 'chat' (until the message is sent), 'upload' (uploading now, receipts follow), 'group' (until the task is sent)
  function added(files, where = 'chat') {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return '';
    const head = `已添加 ${list.length} 个附件`;
    const tail = where === 'upload' ? '，正在上传到 VPS2，完成后附件上会显示“已上传”'
      : where === 'group' ? '（先存在本机，发送任务时一起交给组长和成员）'
        : '（先存在本机，发送消息时一起上传）';
    return [head + tail, ...folderNote(list)].join('；');
  }

  function sent(count, where = 'chat') {
    if (!Number.isSafeInteger(count) || count < 1) return '';
    return where === 'group' ? `${count} 个附件已随任务提交` : `${count} 个附件已随消息发送`;
  }

  function received(name) {
    return `附件已上传，服务器已校验：${name}`;
  }

  return { added, sent, received };
});
