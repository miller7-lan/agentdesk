// 「帮助」 for native CLI single chats: how they work, keys, reconnecting, history, going back to this computer
// (`ssh pc`), and how a computer is enabled. Opened from the ? button in the CLI bar.
(() => {
  const mac = (window.desk?.system?.os || navigator.platform || '').toLowerCase().includes('mac');
  const keys = mac
    ? [['⌃C', '中断 CLI 当前的操作'], ['⌘C / ⌘V', '复制选中的文字 / 粘贴'], ['⇧⏎', '在输入框里换行'], ['⌥', '当作 Meta 键（CLI 里的 Alt 组合键）'], ['⌘K', '清屏（只清本地画面）']]
    : [['Ctrl+C', '中断 CLI 当前的操作；选中了文字时是复制'], ['Ctrl+Shift+C', '复制选中的文字'], ['Ctrl+V', '粘贴'], ['Shift+Enter', '在输入框里换行']];
  const commands = [
    ['Claude Code', '/help 全部命令 · /model 换模型 · /usage 看额度 · /resume 打开以前的对话 · /clear 新对话 · /compact 压缩上下文'],
    ['Codex', '/status 看额度和设置 · /model 换模型 · /resume 打开以前的对话 · /new 新对话 · /approvals 批准方式'],
    ['Grok Build', '/help 全部命令 · /model 换模型 · Shift+Tab 切换模式 · Ctrl+x 快捷键列表'],
    ['Antigravity', '/help 全部命令 · /model 换模型 · Shift+Tab 切换模式'],
  ];
  const html = `
    <header class="qv-head"><h2>原生 CLI 帮助</h2><button type="button" class="qv-close" data-help-close aria-label="关闭">×</button></header>
    <div class="cli-help">
      <section><h3>这是什么</h3>
        <p>单聊打开的是各家官方的命令行界面（Claude Code、Codex、Grok Build、Antigravity），和你自己在终端里 <code>ssh</code> 到 VPS2 再运行它们完全一样：斜杠命令、模型切换、批准提示都是官方原样。AgentDesk 负责连接、保活、上传和这些说明。</p>
        <p>新建单聊时先选 AI，打开就会自动启动。每台电脑用自己的专用钥匙登录 VPS2，只能打开这 4 个 CLI，没有 root 权限；不同的人、不同的电脑互相看不到对方的文件夹和记录。</p></section>
      <section><h3>在哪里干活</h3>
        <p>CLI 运行在 VPS2 上，工作目录是 <code>/work/项目名</code>：这台电脑、这个项目在 VPS2 上的专属文件夹。拖进来或粘贴的文件会上传到这个文件夹的 <code>.uploads/</code>，路径自动填进输入框。</p></section>
      <section><h3>回到你的电脑</h3>
        <p>需要你电脑上的文件、程序或环境时，CLI 会用 <code>ssh pc '命令'</code> 在你电脑上执行（走反向 ssh）。这条通道要先开通：Windows 需要 AgentDesk 的反向隧道在线；Mac 需要在「系统设置 → 通用 → 共享」里打开「远程登录」。还没开通时，CLI 会告诉你。</p></section>
      <section><h3>断线和保活</h3>
        <p>网络断了 CLI 不会停，会在 VPS2 上继续运行；AgentDesk 自动重连（1、2、5、10、20、30 秒后各试一次），连上后回到同一个 CLI，画面按窗口大小重画。关掉 AgentDesk 也只是断开，下次打开单聊会接回去。要真正停止，点「结束」。</p></section>
      <section><h3>对话记录</h3>
        <p>每个单聊打开时继续它自己的那段对话；在 CLI 里用 <code>/resume</code> 可以看到这台电脑的全部对话（Codex 只列当前项目文件夹里的）。删除单聊会结束它的 CLI。</p></section>
      <section><h3>模式与批准</h3>
        <p>全部用 CLI 自己的方式：Claude Code 和 Grok 按 <kbd>Shift+Tab</kbd> 切换模式（含只读的计划模式），Codex 用 <code>/approvals</code>，Antigravity 按 <kbd>Shift+Tab</kbd>。每个操作要不要批准，由 CLI 在界面里问你。</p></section>
      <section><h3>底部工具栏</h3>
        <p>「附件」上传文件；「模型」先清空你正在输入的那一行，再替你在 CLI 里打开 <code>/model</code>；「额度」打开额度与分工；「帮助」打开本页。</p></section>
      <section><h3>按键（${mac ? 'Mac' : 'Windows'}）</h3>
        <table>${keys.map(([key, text]) => `<tr><td><kbd>${key}</kbd></td><td>${text}</td></tr>`).join('')}</table>
        <p>在 CLI 里按的组合键只发给 CLI，不会触发 AgentDesk 自己的快捷键（Ctrl+Tab 切换对话除外）。</p></section>
      <section><h3>常用命令</h3>
        <table>${commands.map(([name, text]) => `<tr><td>${name}</td><td>${text}</td></tr>`).join('')}</table></section>
      <section><h3>额度</h3>
        <p>「额度与分工」每 1 分钟自动刷新一次，读的是各 CLI 的 <code>/usage</code>、<code>/status</code> 同一份数据；点「刷新」立即读取。</p></section>
      <section><h3>开通一台新电脑（管理员）</h3>
        <p>新电脑第一次打开 CLI 单聊会显示「这台电脑还没开通」，点按钮复制它的公钥发给管理员。管理员在 VPS2 上以 root 运行：</p>
        <pre>node /opt/agentdesk-orchestrator/agentdesk-cli-keys.js add &lt;设备名&gt; &lt;win32|darwin&gt; '&lt;公钥&gt;'</pre>
        <p>撤销用 <code>remove &lt;设备名&gt;</code>，查看用 <code>list</code>。开通后在单聊里点「重新连接」。</p></section>
    </div>`;
  let dialog;
  function open() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'quota-dialog cli-help-dialog';
      dialog.innerHTML = html;
      dialog.addEventListener('click', (event) => { if (event.target.closest('[data-help-close]') || event.target === dialog) dialog.close(); });
      document.body.appendChild(dialog);
    }
    dialog.showModal();
  }
  window.AgentDeskNativeCliHelp = { open };
})();
