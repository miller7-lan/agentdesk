# AgentDesk

AgentDesk 是一个 Windows 桌面客户端，通过 SSH 连接 VPS 上的 Codex App Server。客户端可转发本机桌面操作，并在「完全访问」模式下使用当前 Windows 账户的权限访问 C 盘非系统位置和 D 盘。

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

## 配置连接

1. 在 VPS 的专用非 root 账户下配置并登录 Codex CLI，确认该账户能运行 codex app-server。将 [启动脚本模板](config/agentdesk-app-server.example.sh) 中的 Codex 路径改成实际位置，并将它设为 AgentDesk 连接公钥的 SSH 强制命令。此公钥使用 restrict 选项。
2. 在 Windows 和 VPS 的 SSH 客户端分别校验对端的主机公钥指纹。AgentDesk 默认从 Windows 用户的 .ssh/known_hosts 读取 VPS 主机公钥，并从 .agentdesk 读取名为 codex_vps_ed25519 的客户端私钥。需要变更路径时，在本机 remote.json 中设置 codexKey 和 knownHosts。
3. 如需原有的 Windows SSH MCP 工作区，额外配置 [VPS 隧道规则](config/windows-tunnel.sshd.conf) 和 [SSH MCP profile 模板](config/windows-dev.ssh-profile.example.json)。Windows 的 sshd 仅监听 127.0.0.1:22，专用标准账户仅用于测试工作区。VPS 的 windows-tunnel 公钥可用 restrict,port-forwarding,permitlisten="127.0.0.1:2222" 限制，客户端私钥默认在 Windows 的 .agentdesk/tunnel_ed25519。VPS 使用另一把登录密钥访问 Windows，并预先登记回环端口对应的 Windows 主机公钥。修改 SSH 服务前用 sshd -t 校验。为 VPS 上的 Codex 配置名为 ssh 的 MCP 服务并使它加载该 profile，再将启动脚本里的 enable_windows_ssh_mcp 设为 true。
4. 如只用 AgentDesk 的本机桌面和文件工具，在本机 remote.json 设置 "remoteForward": "" 和 "manageSshd": false，即可省去 Windows SSH MCP 隧道。

## 权限

在 AgentDesk 新建会话可使用本机工具。通过状态栏的「本机桌面」开关启停鼠标、键盘和截图能力。发送时选「完全访问」，VPS 上的 Codex 使用无沙盒、无需审批模式，本机文件工具可操作 Windows 用户本来就有权限的文件。本机 UAC、文件系统权限和系统目录边界仍然有效。桌面截图和文件内容会通过当前连接返回给 VPS 上的 Codex。

运行时私钥、主机指纹记录和连接配置请存放在用户目录中。仓库只保存示例。
