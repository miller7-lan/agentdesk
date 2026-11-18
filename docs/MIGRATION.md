# 新电脑安装和接入 AgentDesk

通用迁移包可以转交给其他电脑。使用前，从服务器管理员处单独取得 VPS 2 的 SSH 地址、端口、登录账户、经核验的 ED25519 主机公钥和指纹，以及该设备的 VPS 工作目录。使用群聊时，另需管理员分配独立的 Bridge 名称和项目工作区 ID。

## 1. 安装

- Windows x64：解压迁移包，运行里面的 `AgentDesk-*-setup.exe`。安装后从开始菜单打开。可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 对照发布页校验文件。
- macOS：下载发布页对应架构的 DMG，将 `AgentDesk.app` 拖到「应用程序」。也可以在 Mac 上检出发布标签，用 Node.js 24 执行 `npm ci`、`npm run dist:mac -- --publish never`，从 `dist/mac-arm64` 或对应 Intel 输出目录安装。

## 2. 为新电脑登记 SSH 公钥

在新电脑上创建 `~/.agentdesk/keys`，在目录内按需生成独立密钥。Windows 的 `~` 对应 `$env:USERPROFILE`。已有这几个文件时，应先确认它们属于当前设备和接入用途。

```sh
ssh-keygen -t ed25519 -f codex_ed25519
ssh-keygen -t ed25519 -f claude_ed25519
ssh-keygen -t ed25519 -f grok_ed25519
ssh-keygen -t ed25519 -f antigravity_ed25519
ssh-keygen -t ed25519 -f bridge_ed25519
```

把所需的 `.pub` 文件交给管理员。私钥保存在生成它的电脑上。AgentDesk 的 SSH 以批处理模式启动，所配置私钥需要能够非交互使用。只用 Codex 单聊时登记 Codex 公钥即可。Claude、Grok 和 Antigravity 独立单聊各用一把对应公钥，群聊另用 Bridge 公钥。

管理员为 Codex 公钥配置受限的 App Server 启动脚本，为 Bridge 公钥配置对应的私有网关 socket。为其他单聊公钥登记类似下面的规则，按实际模型分别使用 `claude`、`grok` 或 `antigravity`。每台设备使用不同的 `AGENTDESK_CHAT_DEVICE`，仅用小写字母、数字和下划线，最长 20 个字符。

```text
restrict,command="/usr/bin/env AGENTDESK_CHAT_DEVICE=workstation_01 /opt/agentdesk-orchestrator/agent-chat.sh claude" ssh-ed25519 <CLAUDE_PUBLIC_KEY_BODY>
```

主控、网关和各 CLI 的服务器安装及权限配置见 [VPS 运维说明](https://github.com/miller7-lan/agentdesk/blob/main/orchestrator/OPERATIONS.md)。

## 3. 配置单聊

把管理员提供的主机公钥记录保存为本机 `.agentdesk/known_hosts`。使用 `ssh-keygen -lf <known_hosts 的绝对路径>` 检查 ED25519 指纹。SSH 端口为 22 时，记录的首字段为主机名。其他端口用 `[主机名]:端口`。

Windows 配置文件是 `~/.agentdesk/remote.json`，Mac 配置文件是 `~/.agentdesk/mac-remote.json`。下例中的地址、账户、工作目录和所有路径都要换成管理员分配的值或本机实际路径。Windows 使用 `C:/Users/你的系统用户名/...` 形式的绝对路径。

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

重启 AgentDesk，按首次运行向导核对并确认指纹。在「工作区」选择本机项目，分别在单聊发送一条只读消息验证线路。可用「附件」选择原文件，每次最多 3 个，每个最多 10 MB。文件能否被解析取决于当前 CLI 和模型。本机改动可使用「每步询问」，先在测试文件上验证审批和写入。供应商登录和订阅由 VPS 管理员处理。

## 4. 接入群聊和本机项目

1. 从迁移包 `templates` 选择对应的 Bridge 模板，另存为 `windows-bridge.json` 或 `mac-bridge.json`。填写独立的状态目录、工作区绝对路径、SSH 连接和同一份已核验的 `knownHosts`。只保留实际授权的项目和固定命令。项目要接收补丁时启用 `write`，需要桌面操作时启用 `desktop` 并在应用中打开相应权限。只使用 SSH 时可删除模板的 `relay` 配置。备用线路凭据由管理员按设备单独分配。
2. Windows 在 `remote.json` 增加 `orchestratorBridge`，填本机 `windows-bridge.json` 的绝对路径，然后重启 AgentDesk。Mac 从发布标签的源码目录用 Node.js 24 启动 `node orchestrator/mac-bridge.js /实际路径/mac-bridge.json`，确认连接后可按[部署说明](https://github.com/miller7-lan/agentdesk/blob/main/docs/DEPLOY.md)配置 launchd。若需要 Mac 单聊使用同一份本机命令授权，在 `mac-remote.json` 中增加 `agentCommandsFile`，填 `mac-bridge.json` 的绝对路径。
3. 管理员在 VPS 将工作区、Git 镜像和该设备的 Bridge 绑定。应用「工作区」填写同一个工作区 ID。以已有提交且工作区干净的 Git 项目开始，从「群聊」发送只读任务，确认能看到组长计划和分工，再验证补丁预览和确认应用。

安装版的项目和外观设置保存在各电脑的应用数据目录。给别人接入时，按上述流程创建新的连接和项目，现有会话、密钥及账户配置留在原设备上。
