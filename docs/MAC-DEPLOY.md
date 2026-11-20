# AgentDesk macOS 单聊与群聊部署

适用于新 Mac 接入现有 VPS2，以及已接入设备更新。单聊由 Mac 应用通过 SSH 连接 VPS2 的官方 CLI。群聊由 Mac 后台 Bridge 连接 VPS2 主控，组长规划、模型调度和 Git Worktree 都在 VPS2。Mac 保管本机项目，按项目授予文件和命令权限，用户确认后才应用群聊补丁。

## 1. 安装应用并选定版本

1. 向 VPS2 管理员确认线上提交、SSH 主机和端口，以及从服务器控制台核验过的 ED25519 主机公钥和指纹。更新顺序为 **VPS2 主控 → Mac Bridge → Mac 应用**。只用单聊时可以跳过 Bridge。
2. 在 Mac 执行 `uname -m`。Apple Silicon 使用 `arm64`，Intel 使用 `x86_64` 对应的 `x64` 构建。已上线的群聊版本为 `6402f7687864fac61d52331cfe514aa948253a5b`，其通用 [macOS 安装包](https://github.com/miller7-lan/agentdesk/actions/runs/44749806359/artifacts/14635410265) 由 GitHub Actions 构建，连接参数由各设备自行配置。
3. 解压 Actions 产物，打开对应架构的 DMG。更新已有安装时先退出 AgentDesk，备份旧版 `/Applications/AgentDesk.app` 到独立目录，再将新版拖入「应用程序」。沿用 `~/.agentdesk` 和 `~/Library/Application Support/AgentDesk` 中已有的数据。
4. 如果缺少目标架构的安装包，用 Node.js 24 在 Mac 从同一提交构建。

```sh
git clone https://github.com/miller7-lan/agentdesk.git "$HOME/AgentDesk-src"
cd "$HOME/AgentDesk-src"
git switch --detach 6402f7687864fac61d52331cfe514aa948253a5b
npm ci
# Apple Silicon
npm run dist:mac -- --arm64 --publish never
# Intel 机器改用 npm run dist:mac -- --x64 --publish never
```

本机编译时从 `dist` 中对应架构的目录安装 `AgentDesk.app`。分发包的签名和公证见 [签名与发布](SIGNING.md)。

## 2. 登记设备 SSH 公钥

每台 Mac 使用自己的密钥和设备标识。单聊只生成所用模型的密钥，群聊另外使用 `bridge_ed25519`。下例只生成缺失的密钥。SSH 连接以批处理模式启动，示例生成可非交互使用的专用密钥，服务器按各自用途限制强制命令。

```sh
umask 077
mkdir -p "$HOME/.agentdesk/keys"
chmod 700 "$HOME/.agentdesk/keys"
for role in codex claude grok antigravity bridge; do
  key="$HOME/.agentdesk/keys/${role}_ed25519"
  if [ ! -e "$key" ] && [ ! -e "$key.pub" ]; then
    ssh-keygen -t ed25519 -N '' -C "agentdesk-mac-$role" -f "$key"
  fi
done
```

把要登记的 `.pub` 交给管理员，私钥留在本机。将管理员给出的主机公钥记录写入 `~/.agentdesk/known_hosts`，执行 `ssh-keygen -lf "$HOME/.agentdesk/known_hosts"` 并和管理员核对指纹。标准端口的记录以主机名开头，其他端口使用 `[主机名]:端口`。主机密钥变化时先从 VPS 控制台重新核验。

管理员将 Codex 公钥绑定 App Server 启动脚本，将 Claude、Grok、Antigravity 公钥分别绑定 `agent-chat.sh` 的对应参数。共享服务账号时，为每台设备设置独立的 `AGENTDESK_CHAT_DEVICE`，避免使用同一个会话标识。群聊公钥绑定该 Mac 的私有 Bridge socket。各模型登录仍由 VPS2 的实际服务账号管理。 [VPS2 运维说明](../orchestrator/OPERATIONS.md)

## 3. 接通单聊

将以下字段合并到 `~/.agentdesk/mac-remote.json`。将 `yourname`、主机、账号、VPS 目录和路径替换为真实分配值。JSON 内的路径填写绝对路径。

```json
{
  "host": "orchestrator.example.invalid",
  "port": 22,
  "codexUser": "agentdesk",
  "chatUser": "agentdesk",
  "workspace": "/srv/agentdesk/device-workspace",
  "knownHosts": "/Users/yourname/.agentdesk/known_hosts",
  "codexKey": "/Users/yourname/.agentdesk/keys/codex_ed25519",
  "claudeKey": "/Users/yourname/.agentdesk/keys/claude_ed25519",
  "grokKey": "/Users/yourname/.agentdesk/keys/grok_ed25519",
  "antigravityKey": "/Users/yourname/.agentdesk/keys/antigravity_ed25519",
  "remoteForward": "",
  "manageSshd": false
}
```

- `workspace` 是 VPS2 上的绝对路径，以管理员为此设备分配的值为准。应用中的「本机目录」选择 Mac 的项目目录。「群聊工作区」填下一节的工作区 ID。三处各有独立作用。
- 重开应用，按向导确认指纹。在测试项目分别打开已登记的单聊，先读文件或检查附件，再用「每步询问」修改测试文件并核对实际落盘。
- 单聊在 Mac 上读写项目时使用应用提供的本机工具，模型 CLI 的原生命令在 VPS2 执行。如果要让单聊执行 Mac 命令，在 `mac-remote.json` 里设置 `agentCommandsFile`，指向下面的 Bridge 配置绝对路径。对应工作区的 `root` 需匹配应用选择的项目，`commands` 定义固定程序及参数，`agentCommands` 列出可用命令。 [Mac 本机命令验收](MAC-LOCAL-COMMANDS.md)

## 4. 接通群聊和 Mac Bridge

### VPS2 管理员

为 Mac 分配独立的 Bridge 名称和项目工作区 ID。以下为 VPS2 现有配置中的追加示例。已有设备和工作区条目继续保留。为工作区准备 Git 镜像，并确认镜像已包含 Mac 项目的当前 HEAD。部分群聊接入还需在项目成员配置中登记该 Bridge。

```json
{
  "sshBridges": ["mac01"],
  "workspaces": {
    "mac_project": {
      "repository": "/var/lib/agentdesk-orchestrator/repos/mac_project.git",
      "sshBridge": "mac01"
    }
  }
}
```

将该 Mac 的 Bridge 公钥绑定到对应网关，例如以下授权行中的 `<MAC_BRIDGE_PUBLIC_KEY>` 替换为完整公钥记录。需要重启主控时按部署手册先停领新任务、等运行中的任务排空，然后更新配置并确认主控恢复。 [VPS2 更新与回滚](DEPLOY.md#1-vps2主控)

```text
restrict,command="/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/ssh-gateway.js /var/lib/agentdesk-orchestrator/bridge-mac01.sock" <MAC_BRIDGE_PUBLIC_KEY>
```

### Mac 用户

检出与线上匹配的源码，后台运行时保留完整目录结构，`orchestrator/mac-bridge.js` 还依赖仓库顶层的 `desktop.js`。在 `~/.agentdesk/mac-bridge.json` 配置以下内容。设备只使用 SSH 时采用此配置即可。工作区键 `mac_project` 应等于 VPS2 的分配值。

```json
{
  "stateDir": "/Users/yourname/Library/Application Support/AgentDesk/bridge/state",
  "controlSocket": "/Users/yourname/Library/Application Support/AgentDesk/bridge/state/control.sock",
  "controlWorkspace": "mac_project",
  "git": "/usr/bin/git",
  "workspaces": {
    "mac_project": {
      "root": "/Users/yourname/Projects/demo",
      "write": true,
      "commands": {
        "git-status": ["/usr/bin/git", "status", "--short"]
      },
      "agentCommands": ["git-status"]
    }
  },
  "ssh": {
    "host": "orchestrator.example.invalid",
    "port": 22,
    "user": "agentdesk",
    "key": "/Users/yourname/.agentdesk/keys/bridge_ed25519",
    "knownHosts": "/Users/yourname/.agentdesk/known_hosts"
  }
}
```

`write` 用于允许所列工作区接收补丁。只读接入可设为 `false`。应用在 Mac 默认通过上述位置的 `control.sock` 连接后台 Bridge。先在终端前台验证，再设置常驻。

```sh
cd "$HOME/AgentDesk-src"
node --version
node -e 'for (const file of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(file, "utf8"))' \
  "$HOME/.agentdesk/mac-remote.json" "$HOME/.agentdesk/mac-bridge.json"
node orchestrator/mac-bridge.js "$HOME/.agentdesk/mac-bridge.json"
```

前台验证时打开 AgentDesk，在「工作区」选择 `/Users/yourname/Projects/demo` 对应的真实项目，并填写工作区 ID `mac_project`。打开「主控线路」确认在线，再在测试项目发送只读群聊任务，查看组长方案和成员进度。确认后用 Ctrl+C 停掉前台 Bridge，再交给 launchd，避免两个 Bridge 竞争同一连接。

### 设置开机后自动启动

已有 LaunchAgent 时可沿用原标签。新安装先执行 `mkdir -p "$HOME/Library/LaunchAgents"`，再将下面的模板保存为 `~/Library/LaunchAgents/local.agentdesk.bridge.plist`。将第一个路径换成 `command -v node` 返回的 Node.js 24 绝对路径，余下两处换成实际脚本、配置路径。LaunchAgent 在已登录的 Mac 用户会话中运行。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.agentdesk.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/yourname/AgentDesk-src/orchestrator/mac-bridge.js</string>
    <string>/Users/yourname/.agentdesk/mac-bridge.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/yourname/.agentdesk/mac-bridge.log</string>
  <key>StandardErrorPath</key><string>/Users/yourname/.agentdesk/mac-bridge-error.log</string>
</dict>
</plist>
```

```sh
plist="$HOME/Library/LaunchAgents/local.agentdesk.bridge.plist"
domain="gui/$(id -u)"
plutil -lint "$plist"
launchctl bootstrap "$domain" "$plist"
launchctl print "$domain/local.agentdesk.bridge"
```

只更新脚本或 Bridge JSON 时，执行 `launchctl kickstart -k "gui/$(id -u)/local.agentdesk.bridge"`。调整了 plist 的启动路径时先 `bootout` 旧服务，再用上面的 `bootstrap` 载入。使用现有标签的设备将命令中的标签替换成自己的。VPS1 跳板、Relay 和 Mac 桌面权限按启用范围单独配置。 [VPS1 跳板与 Relay](DEPLOY.md#4-vps1-ssh-跳板直连-vps2-失败时自动回退) · [本机桌面权限](DESKTOP-PERMISSIONS.md)

## 5. 验收与回滚

| 检查项 | 通过条件 |
| --- | --- |
| 单聊 | 已登记的模型能打开独立会话。测试文件可读，批准写入后能在 Mac 上看到改动。授权命令显示本机工作目录和真实退出码。 |
| 群聊 | Bridge 显示 `running`，应用主控线路在线。同一个测试项目能看到组长计划、成员进度和补丁预览。正式应用前核对版本，点击确认后才写回。 |
| 快照 | VPS2 镜像包含本机 HEAD。测试尚未提交的变更时，在临时项目用 `git add -N -- path/to/file` 纳入需要的新文件。群聊计划后再修改本机文件，旧补丁应被版本检查拦住。 |
| 异常恢复 | 主控或线路中断时，已确认操作可通过原请求记录核对。界面显示结果待核对时，先查看实际文件和命令结果。 |

本版群聊调度、调用归属及恢复能力适用于 Mac。Windows 原生单聊 Worker、Windows 隔离构建执行器和 EXE 验收使用各自的 Windows 部署流程。Mac 的本机验证使用上述授权命令与群聊补丁流程。 [Windows 群聊构建说明](GROUP-WINDOWS-TESTS.md)

回滚时先退出 AgentDesk，恢复备份的应用和上一版 Bridge 源码，重启原 LaunchAgent。若 VPS2 也需回滚，由管理员先排空活动任务，再从备份恢复代码；保留 Mac 和 VPS2 的状态数据、已建 Worktree、会话与待应用补丁。单聊认证异常时分别检查 SSH 公钥登记、主机指纹和 VPS2 服务账号的模型登录。群聊离线时检查 LaunchAgent 日志、Bridge socket 和 VPS2 工作区绑定。
