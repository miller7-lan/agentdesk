// One permission statement for every model in a full-access native chat (Claude, Codex, Grok Build, and
// Antigravity, which shares the chat server): the same words, so each one describes — and uses — the same rights.
// The rights themselves are set per CLI in chat-server.js (Claude, Grok, Antigravity) and windows-native-seat.js
// (Codex); this text has to stay in step with them. Platform: 'darwin' or 'win32' (the person's computer).
function nativePermissionPrompt({ platform = 'win32', writable = true } = {}) {
  const mac = platform === 'darwin';
  const computer = mac ? 'Mac' : 'Windows';
  const shells = mac ? 'zsh（默认）或 bash 登录 shell' : 'PowerShell（默认）或 CMD';
  if (!writable) {
    return `[AgentDesk 原生单聊｜只读规划]
- 当前工作目录是用户 ${computer} 上的项目（只读挂载）。用你自己的读、搜索工具直接读，不要改文件。
- 可以联网搜索、读网页，可以开子代理并行查资料、读代码。本轮不能运行 local_shell。`;
  }
  return `[AgentDesk 原生单聊｜完全访问｜Claude、Codex、Grok 权限相同]
- 项目：当前工作目录是用户 ${computer} 上的项目，已挂载过来。用你自己的读、搜索、编辑、写入工具直接操作，改动立即写到用户电脑的磁盘上。
- 用户电脑上的命令：用 local_shell（${shells}，在项目文件夹里运行）。它有用户本人的全部权限：git push/pull、包管理器、编译和测试、云服务 CLI、SSH 密钥${mac ? '、钥匙串' : ''}都能用。长命令放后台，用 runId 查输出或停止；断线恢复后先用原 runId 核对结果，再决定是否重跑。
- 你自己的 shell：跑在 VPS2 上，工作目录同样是这个项目，可以联网，适合不依赖用户电脑环境的检查和下载资料。要用 ${computer} 的工具链或凭据时改用 local_shell。
- 联网搜索、读网页、开子代理并行干活都可以。
- 唯一挡住的是 AgentDesk 自己的密钥目录（~/.agentdesk 和 AgentDesk 应用数据目录）；项目里指向项目外的符号链接也会被拒绝。
- 不会有人逐条批准，也不用先问：自己把一整件事做完，再汇报结果。遇到拒绝如实说明，不要绕过。`;
}

// The same rights for a group step, in the group prompts' language.
const GROUP_PERMISSION_NOTE = '\n\nPermissions (the same for Claude, Codex and Grok): use your own shell, file tools, web search and sub-agents freely in your working folder (a sandbox on VPS2 with network access; read-only steps cannot change it). Commands on the person’s computer run with their own rights, with only AgentDesk’s own key folders closed (the read-only home mount and the windows_* file tools also leave credential folders out). Nobody approves each call: finish the whole step yourself, and report anything refused instead of working around it.';

module.exports = { nativePermissionPrompt, GROUP_PERMISSION_NOTE };
