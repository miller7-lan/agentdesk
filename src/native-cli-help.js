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
        <p>新建单聊时先选 AI，打开就会自动启动。每台电脑用自己的专用钥匙登录 VPS2，只能打开这 4 个 CLI，没有 root 权限；不同的人、不同的电脑互相看不到对方的文件夹和记录。</p>
        <p>CLI 运行在一个隔离的沙盒里：只看得到运行程序所需的系统文件、这台电脑的家目录和项目文件夹，看不到也改不了 VPS2 上的其他东西，也连不到 VPS2 本机的服务；可以正常上网（模型、搜索、安装软件包）。每台电脑第一次打开某个 CLI 时，会看到它自己的首次设置（如信任文件夹、选主题），按提示选一次即可。</p></section>
      <section><h3>在哪里干活</h3>
        <p>CLI 运行在 VPS2 上，但<b>你的整台电脑</b>都挂载给它，权限和你本人一样（系统不让你动的，它也动不了）。打开单聊时它就在当前项目里；路径和你电脑上一致：Mac 是 <code>/Users/…</code>、<code>/Volumes/…</code>，Windows 各盘是 <code>/c</code>、<code>/d</code>…（<code>C:\Users\你</code> 即 <code>/c/Users/你</code>，有时也显示为 <code>/pc/C:/Users/你</code>）。改动立刻在你电脑上生效。</p>
        <p>CLI 自己执行的命令在 VPS2 的 Linux 上，隔着网络读写你的文件，较慢；要用你电脑上的程序和环境（git、npm、编译、装软件）时，它会用下面的 pc 命令在你电脑上执行。没选本机文件夹的项目，工作目录是 VPS2 上为这台电脑单独准备的文件夹。拖进来或粘贴的文件放在 <code>/uploads/</code>。断线时文件会暂时看不到，重连后自动恢复。</p></section>
      <section><h3>回到你的电脑：pc 命令和共用终端</h3>
        <p>需要你电脑上的文件、程序或环境时，CLI 用 <code>pc '命令'</code> 在你电脑上执行（Windows 用 PowerShell，Mac 用 zsh）。命令在这个单聊的<b>共用终端</b>里运行：点底部「终端」就能看到，输出和退出码会返回给 CLI。</p>
        <ul>
          <li>AI 的命令以它头像的主色显示（Claude 橙、Codex 绿、Antigravity 蓝、Grok 黑），你自己敲的命令是黑底白字。</li>
          <li>「接管」：先中断 AI 正在运行的命令，然后终端归你，AI 的输入会被拒绝；点「交还给 AI」，AI 继续。</li>
          <li>AI 遇到要输密码、确认的地方，会用 <code>pc --ask</code> 请你接管：终端自动打开并写明要你做什么，AI 的命令不会被中断；你操作完交还，AI 会看到终端内容接着做。</li>
          <li>长时间运行的程序（开发服务器等）CLI 会用 <code>pc --new</code> 另开终端，每个单聊最多 4 个。</li>
        </ul>
        <p>这条通道只在 AgentDesk 打开时可用，走的是这台电脑自己的专用钥匙；VPS2 上的其他人和其他电脑用不了它。</p></section>
      <section><h3>断线和保活</h3>
        <p>网络一断，VPS2 上的 CLI 会在约 30 秒内停下，不会在你看不到的时候继续操作。AgentDesk 自动重连（1、2、5、10、20、30 秒后各试一次），连上后 CLI 接着上一次的对话继续，之前的内容会重新显示。关掉 AgentDesk 也一样：CLI 停下，下次打开单聊接着继续。断线时正在进行的那一步会被打断，重连后可以让它接着做</p></section>
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
