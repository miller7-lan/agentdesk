# Mac 本机命令部署

先升级 VPS2，再升级 Mac 的 Bridge 和 AgentDesk.app。三端应使用同一发布提交。模型 CLI 和模型账号保留在 VPS2，Mac 上使用当地登录用户运行 AgentDesk 和 Bridge。

## 1. 更新应用和 Bridge

1. 打开仓库的 Actions，在目标提交的 **Build release artifacts** 中下载通用 `agentdesk-mac` 产物。根据 `uname -m` 选择 Apple Silicon 或 Intel 版本。如果对应架构没有产物，可以在目标 Mac 上检出目标提交，用 Node.js 24 执行 `npm ci`，然后执行 `npm run dist:mac -- --arm64 --publish never` 或 `npm run dist:mac -- --x64 --publish never`。
2. 退出 AgentDesk，备份旧的 `AgentDesk.app` 后替换应用，再打开新版。供其他电脑安装时使用通用构建，保管好 Mac 自己的连接配置、SSH 密钥与 Relay 令牌。签名和分发见 [签名与发布](SIGNING.md)。
3. 用 `launchctl list | grep -i agentdesk` 查 Bridge 标签，再用 `launchctl print gui/$(id -u)/<标签>` 核对脚本和配置路径。Bridge 指向仓库时更新到目标提交，指向部署副本时同步目标提交的整个 `orchestrator/` 脚本目录，包含 `command-runs.js`、`windows.js` 和 `service.js`。现有的配置、状态目录和 launchd plist 继续用于该用户。
4. 用 `launchctl kickstart -k gui/$(id -u)/<标签>` 重启 Bridge。确认 `state = running`，并检查 AgentDesk 状态栏里的主控和单聊线路。

## 2. 配置项目命令

在 Mac 上的 `~/.agentdesk/mac-remote.json` 中设置 `agentCommandsFile`，值为本机 Bridge JSON 配置的绝对路径。Bridge 的 `workspaces.<项目>.root` 应与 AgentDesk 项目里选的本机目录对应。命令写在同一工作区的 `commands`，模型可用的命令名写在 `agentCommands`。群聊的工作区 ID 以 VPS2 管理员分配的值为准。

建议先加两个固定参数的验收命令。把下面的字段合并到既有工作区，保留已经配置的命令。

```json
{
  "commands": {
    "git-status": ["/usr/bin/git", "status", "--short"],
    "verify-wait": ["/bin/sleep", "70"]
  },
  "agentCommands": ["git-status", "verify-wait"]
}
```

正式启用构建和测试时，使用固定的程序路径和参数。Homebrew 程序可在终端里用 `command -v <程序名>` 找到实际绝对路径。launchd 启动的 Bridge 使用自己的环境，命令所需的工具也应能从该环境找到。配置更改后重启 Bridge 和应用。

## 3. 验收与回滚

- 单聊先运行 `git-status`，核对命令卡显示的 Mac 路径、输出和退出码。独立工作树会话应显示该工作树路径。
- 运行 `verify-wait`，确认超过 65 秒后能完成。再运行一次并点「停止命令」，确认状态变成「已停止」。验收后可移除临时命令。
- 在可控测试项目里验证群聊的本机测试输出。核对执行位置、退出码，以及测试记录中的「当前工作区」或「补丁应用后」。
- 断线重连后查看原运行记录。若应用重启时缺少退出凭据，界面显示「结果待确认」。
- 回滚时先退出应用，恢复上一版 `AgentDesk.app` 和对应的 Bridge 脚本，再用原 launchd 标签重启 Bridge。

其他连接设置和故障排查见 [部署说明](DEPLOY.md#3-mac-端) 和 [迁移与接入](MIGRATION.md)。
