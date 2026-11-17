# AgentDesk 密码登记

密码登录构建只使用 App 内窗口。应用启动时生成或重用本机身份，凭 HTTPS 请求校验密码。服务按设备签发有效期八小时的 SSH 证书和 Relay 令牌。服务器从设备记录动态创建 Bridge，现有永久配对可以并行工作。

## VPS 2

- 创建 `agentdesk-enroll` 专用服务用户和同名组。将 [服务配置示例](enrollment.example.json) 放入 `/etc/agentdesk-enrollment/config.json` 并填入地址。SSH 证书 CA 和 Relay 登记私钥只允许该用户读取。HTTPS 证书按发布包里的受信 CA 签发，SAN 匹配实际 HTTPS 主机名或 IP。
- 以权限 2750 创建 `/var/lib/agentdesk-shared-enrollment`，属主 `agentdesk-enroll`，属组 `agentdesk`。在现有 Orchestrator 配置追加 `enrollmentSessions`，填入 `directory`、`repository`、`relayHost` 和 `relayCaFile`。其中 `repository` 指向用于新设备的 Git 裸仓库，`seedBundle` 是该仓库的初始化 bundle。
- 在现有 AgentDesk 公钥文件增加 CA 公钥，选项为 `restrict,cert-authority,principals="agentdesk-app"`。Bridge 和聊天证书各自带固定的强制命令。保留现有 root 和静态设备登录规则。
- 将 `enrollment.js`、`expiring-chat.sh`、`write-password-verifier.js` 安装到 `/opt/agentdesk-orchestrator`。为 `expiring-chat.sh` 设置可执行权限，通过它启动现有 `codex-desktop.sh`。部署 [登记服务](agentdesk-enrollment.service) 后检查 HTTPS。
- 通过无回显终端输入 App 密码，将它经标准输入交给 `write-password-verifier.js /etc/agentdesk-enrollment/password.json`。给校验文件设置 `root:agentdesk-enroll` 和 0640，再启动服务。更改密码后重启登记进程。

## VPS 1

- 独立用户 `agentdesk-relay-enroll` 专门接收 VPS 2 的登记请求。为它配置仅信任 VPS 2 公钥的 SSH 入口，授权选项包含 `restrict`、VPS 2 的来源地址和固定执行命令 `/usr/bin/python3 /opt/agentdesk-relay-enrollment/register-device.py`。
- 用 `agentdesk-relay-enroll:agentdesk-relay` 和 2750 建立 `/var/lib/agentdesk-relay-registration`。将旧的 `devices.json` 复制到该目录，保留静态配对，权限 0640。让 Relay 读取新位置。部署支持 `expires_at` 的 Relay 模块后重新启动 Relay。登记命令原子更新配对并用文件锁串行化写入。
- 每个新设备占两条 Relay 连接。样例登记上限为六台，保留现有静态配对容量。

## 应用构建

构建前在仓库根目录创建本机忽略的 `agentdesk-enrollment.json`。其中包含 `url`、`host`、受信 HTTPS CA `ca`、固定的 SSH `knownHosts`、`relayHost` 及 `relayCA`。打包时它会进入应用资源目录。该文件只包含公开连接参数。构建后的应用在首次启动和会话过期时弹出密码窗口。
