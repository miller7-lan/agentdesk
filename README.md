# AgentDesk

AgentDesk 是一个 Windows 和 macOS 桌面客户端，通过 SSH 连接 VPS 上的 Codex App Server。客户端可转发本机桌面操作，并在「完全访问」模式下使用当前 Windows 账户的权限访问 C 盘非系统位置和 D 盘。

应用支持本机 Git 和云端项目、SSH 指纹确认、群聊调度与诊断包导出。使用「工作区」管理项目和首次运行设置，使用「诊断」预览日志与主控状态以及检查更新。详见[安装](docs/INSTALL.md)、[本地如何部署（VPS2 / Mac / Windows）](docs/LOCAL-DEPLOY.md)、[权限](docs/PERMISSIONS.md)、[故障排查](docs/TROUBLESHOOTING.md)和[签名与发布](docs/SIGNING.md)。

## 从源码运行

需要 Windows x64、Node.js、npm、Git 和 Windows OpenSSH Client。

~~~powershell
git clone https://github.com/miller7-lan/agentdesk.git
cd agentdesk
npm ci
npm start
~~~

首次运行会在用户目录的 .agentdesk 文件夹下生成 remote.json。可以从 [Windows 连接配置模板](config/remote.example.json) 开始，填入自己的 VPS 主机名、账号名和工作区。修改后重启 AgentDesk。

~~~powershell
npm run dist
~~~

构建产物位于 dist，包括便携版和安装版。构建时从 npm 的固定版本提取并校验 Windows 桌面组件。仓库内保留源码和图标，桌面组件及打包产物由构建生成。

断线后客户端会自动重试，状态栏显示重试信息。状态栏的「重新连接」按钮可立即重建 VPS 连接及启用的 SSH 隧道。电脑从休眠恢复后也会重连。连接丢失时，当前请求会结束并显示失败，重新连接后可继续原会话。超时的写入或命令可能已在远端执行，请先确认结果再重试。

~~~powershell
npm test
~~~

## 配置连接

1. 在 VPS 的专用非 root 账户下配置并登录 Codex CLI，确认该账户能运行 codex app-server。将 [启动脚本模板](config/agentdesk-app-server.example.sh) 中的 Codex 路径改成实际位置，并将它设为 AgentDesk 连接公钥的 SSH 强制命令。此公钥使用 restrict 选项。
2. 在 Windows 和 VPS 的 SSH 客户端分别校验对端的主机公钥指纹。AgentDesk 默认从 Windows 用户的 .ssh/known_hosts 读取 VPS 主机公钥，并从 .agentdesk 读取名为 codex_vps_ed25519 的客户端私钥。需要变更路径时，在本机 remote.json 中设置 codexKey 和 knownHosts。
3. 如需原有的 Windows SSH MCP 工作区，额外配置 [VPS 隧道规则](config/windows-tunnel.sshd.conf) 和 [SSH MCP profile 模板](config/windows-dev.ssh-profile.example.json)。Windows 的 sshd 仅监听 127.0.0.1:22，专用标准账户仅用于测试工作区。VPS 的 windows-tunnel 公钥可用 restrict,port-forwarding,permitlisten="127.0.0.1:2222" 限制，客户端私钥默认在 Windows 的 .agentdesk/tunnel_ed25519。VPS 使用另一把登录密钥访问 Windows，并预先登记回环端口对应的 Windows 主机公钥。修改 SSH 服务前用 sshd -t 校验。为 VPS 上的 Codex 配置名为 ssh 的 MCP 服务并使它加载该 profile，再将启动脚本里的 enable_windows_ssh_mcp 设为 true。
4. 如只用 AgentDesk 的本机桌面和文件工具，在本机 remote.json 设置 "remoteForward": "" 和 "manageSshd": false，即可省去 Windows SSH MCP 隧道。

## 权限

在 AgentDesk 新建会话可使用本机工具。通过状态栏的「本机桌面」开关启停鼠标、键盘和截图能力。发送时选「完全访问」，VPS 上的 Codex 使用无沙盒、无需审批模式，本机文件工具可操作当前系统用户本来就有权限的文件（Windows 为 `windows_file_*`，macOS 为 `agentdesk_file_*`）。本机 UAC、文件系统权限和系统目录边界仍然有效。桌面截图和文件内容会通过当前连接返回给 VPS 上的 AI。

运行时私钥、主机指纹记录和连接配置请存放在用户目录中。仓库只保存示例。

## 双 VPS Relay

VPS 1 负责转发 Windows Bridge 和 VPS 2 Orchestrator 之间的消息。详见 [Relay 通信协议](relay/PROTOCOL.md) 和 [Ubuntu 部署与运维](relay/OPERATIONS.md)。当前 Windows 客户端仍使用上述 SSH 连接方式。

## VPS 2 Orchestrator

macOS / Windows AgentDesk 优先直连 VPS 2 的 SSH 22，VPS 1 Relay 的 TLS 22022 作为手动切换备用链路。主控在 VPS 2 调度 Codex、Claude Code、Grok Build 和 Antigravity CLI。Codex、Claude、Grok、Antigravity 也各自支持单聊；单聊通过本机文件工具读写用户目录并即时生效。详见 [双 VPS 架构](docs/ARCHITECTURE.md)、[部署与运维](orchestrator/OPERATIONS.md) 和 [业务协议](orchestrator/PROTOCOL.md)。
