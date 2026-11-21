# Mac 原生单聊

Mac 上的 Codex、Claude、Grok Build、Antigravity 单聊，在「完全访问」模式下直接操作你 Mac 上的项目，和在你自己电脑上用官方 CLI 一样：

- **读写项目**：项目以可写方式挂载到 VPS2，模型用自己原生的读文件、搜索、编辑工具直接改你 Mac 上的文件，不用一个个调 `agentdesk_file_*` 工具。
- **跑命令**：`local_shell` 在你的 Mac 上、在项目文件夹里运行任意命令（zsh 登录 shell，也可以选 bash），比如 git、npm、python、make、xcodebuild。长命令在后台跑，可以停止，断线后按运行编号找回输出。
- **凭据挡住**：命令跑在 macOS 沙盒（`sandbox-exec`）里。下面这些读不到也写不了：
  - `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.docker`、`~/.kube`、`~/.netrc`、`~/.npmrc`、`~/.git-credentials`；
  - 各 CLI 的登录目录（`~/.codex`、`~/.claude` 等）、`~/.agentdesk`；
  - 浏览器资料和 `~/Library/Keychains`；
  - 钥匙串服务也连不上。

  其他照常开放，和你自己打开终端一样。
- **项目以外**：项目挂载只开放项目文件夹本身。项目里指向外面的符号链接一律拒绝。

做法和 Windows 原生单聊相同（见 [WINDOWS-NATIVE-CHAT-PROTOCOL.md](WINDOWS-NATIVE-CHAT-PROTOCOL.md)），只有本机这一侧换成 macOS 的实现：

| 部分 | Windows | Mac |
|---|---|---|
| 项目挂载的路径保护 | 句柄固定目录链，防 junction | 逐级检查，路径上不能有符号链接，打开文件用 `O_NOFOLLOW`（`orchestrator/posix-path-guard.js`） |
| 本机命令 | PowerShell / CMD | zsh / bash 登录 shell，套 `sandbox-exec` 沙盒 |
| 本机 Worker 通道 | 命名管道 | 用户临时目录里的 Unix socket，权限 0600，另有 Worker 密钥 |
| 本机状态目录 | `windows-native-chat` | 应用数据目录下的 `native-chat` |

## 已知限制

- **从 Mac 的命令里 `git push` / `git pull` 做不了**：`~/.ssh` 和钥匙串都被挡住，SSH 和 HTTPS 凭据都拿不到。本地提交、分支、diff、构建、测试都可以；推送请你自己在终端里做。
- **`~/.npmrc` 被挡住**：用到 `~/.npmrc` 的 npm 命令可能报权限错误，同样是因为它可能存有令牌。项目目录里的 `.npmrc` 不受影响。
- **`sandbox-exec` 虽然被 Apple 标为不推荐使用，但 macOS 14、15 仍然自带。** 以后如果系统移除了它，命令会直接失败，而不是绕过沙盒运行。
- **模型自己的 Bash 仍跑在 VPS2 上**（工作目录是挂载过来的项目），适合不需要 Mac 环境的检查；要用 Mac 上的工具链（Xcode、Homebrew 装的工具），用 `local_shell`。

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
5. 让它运行 `cat ~/.ssh/config` 或 `ls ~/Library/Keychains`，应该提示没有权限（Operation not permitted）。
6. 让它运行 `security find-generic-password -s test`，应该失败，因为连不上钥匙串。
7. 断开网络再恢复，回到这个单聊：上一个命令的结果能按运行编号查到；有没确认的改动时，会先提示你核对。

把每一项的结果（通过，或失败加报错原文）记下来交回。
