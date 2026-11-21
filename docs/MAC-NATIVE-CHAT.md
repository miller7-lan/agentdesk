# Mac 原生单聊

Mac 上的 Codex、Claude、Grok Build、Antigravity 单聊，在「完全访问」模式下直接操作你 Mac 上的项目，和在你自己电脑上用官方 CLI 一样：

- **读写项目**：项目以可写方式挂载到 VPS2，模型用自己原生的读文件、搜索、编辑工具直接改你 Mac 上的文件，不用一个个调 `agentdesk_file_*` 工具。
- **跑命令**：`local_shell` 在你的 Mac 上、在项目文件夹里运行任意命令（zsh 登录 shell，也可以选 bash），比如 git、npm、python、make、xcodebuild。长命令在后台跑，可以停止，断线后按运行编号找回输出。
- **权限放开，优先把事做完**：命令有你这个用户的全部权限，SSH 密钥、钥匙串、`~/.npmrc`、云服务登录都能用，所以 `git push`/`git pull`、npm、云服务 CLI 都能正常工作。只挡 AgentDesk 自己的密钥：`~/.agentdesk`（Bridge 连 VPS2 的 SSH 密钥）和应用数据目录（原生单聊 Worker 的密钥）。任务用不到它们，拿到了却能冒充这台电脑连 VPS2。挡的方式是 macOS 沙盒（`sandbox-exec`）。代码里保留了更严的模式（`strict`），会同时挡住凭据目录和钥匙串，需要时可以改回。
- **项目以外**：项目挂载只开放项目文件夹本身。项目里指向外面的符号链接一律拒绝。

做法和 Windows 原生单聊相同（见 [WINDOWS-NATIVE-CHAT-PROTOCOL.md](WINDOWS-NATIVE-CHAT-PROTOCOL.md)），只有本机这一侧换成 macOS 的实现：

| 部分 | Windows | Mac |
|---|---|---|
| 项目挂载的路径保护 | 句柄固定目录链，防 junction | 逐级检查，路径上不能有符号链接，打开文件用 `O_NOFOLLOW`（`orchestrator/posix-path-guard.js`） |
| 本机命令 | PowerShell / CMD | zsh / bash 登录 shell，套 `sandbox-exec` 沙盒 |
| 本机 Worker 通道 | 命名管道 | 用户临时目录里的 Unix socket，权限 0600，另有 Worker 密钥 |
| 本机状态目录 | `windows-native-chat` | 应用数据目录下的 `native-chat` |

## 已知限制

- **命令能做你在终端里能做的一切**，包括推送代码、用云服务账号。模型在「完全访问」下不会逐条问你，请只在信任的项目里用。
- **`sandbox-exec` 虽然被 Apple 标为不推荐使用，但 macOS 14、15 仍然自带。** 以后如果系统移除了它，命令会直接失败，而不是绕过沙盒运行。
- **模型自己的 Bash 仍跑在 VPS2 上**（工作目录是挂载过来的项目），适合不需要 Mac 环境的检查；要用 Mac 上的工具链（Xcode、Homebrew 装的工具）或凭据（推送），用 `local_shell`。

## 部署

顺序：先 VPS2，再 Mac。

1. **VPS2**：和 Windows 原生单聊用同一个服务端（`native-project-session-host.js`、`sshfs`、`unshare`），按 [WINDOWS-NATIVE-CHAT-DEPLOY.md](WINDOWS-NATIVE-CHAT-DEPLOY.md) 部署过就不用再动。没部署过的，按那份文档装好。
2. **Mac 应用**：更新到包含本功能的版本（`npm ci && npm run dist:mac -- --arm64`，或用 Actions 产物 `agentdesk-mac`）。原生单聊在应用里运行，不依赖后台 Bridge 的版本。
3. **项目绑定**：单聊选的项目要是「本机项目」，并选好本机目录。项目如果还绑定了主控工作区，Mac Bridge 配置里同名工作区的 `root` 必须就是这个目录，`write` 为 `true`，`ssh` 的主机和端口要和应用连的 VPS2 一致。
4. 不满足条件时（VPS2 没有原生服务、项目没选本机目录），单聊会退回原来的方式：`agentdesk_file_*` 工具，以及配置好的 `agentCommands`。

## 验收

在一个测试项目里，Codex、Claude、Grok、Antigravity 各开一个「完全访问」单聊，依次检查：

1. 让它「看一下项目结构，读 README」。它应该直接读，界面里不会出现一串 `agentdesk_file_read` 调用。
2. 让它改一个文件并保存。在 Mac 上用编辑器打开，确认改动已经在磁盘上。
3. 让它运行 `git status`、`git log -3`，以及项目的测试命令（比如 `npm test`），能看到真实的输出和退出码。
4. 让它运行一个要跑 1 分钟以上的命令，中途点停止，确认命令确实停了。
5. 让它在测试仓库里 `git push` 一个测试分支，应该能用你的 SSH 密钥或钥匙串里的凭据推送成功。
6. 让它运行 `ls ~/.agentdesk`，应该提示没有权限（Operation not permitted）。
7. 断开网络再恢复，回到这个单聊：上一个命令的结果能按运行编号查到；有没确认的改动时，会先提示你核对。

把每一项的结果（通过，或失败加报错原文）记下来交回。
