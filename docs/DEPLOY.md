# 修改与部署：VPS2、Windows 端、Mac 端

给在本机工作的 agent（Codex、Claude Code 等）用的操作手册。有待执行的版本升级时，先看对应的升级清单（当前：[UPGRADE-2026-11.md](UPGRADE-2026-11.md)）。代码在仓库里改；每一端怎样拿到新代码、怎样改配置、怎样确认生效，见对应一节。

## 先判断改动落在哪一端

| 改了什么 | 要部署到 |
|---|---|
| `orchestrator/*.js`（`service.js`、`scheduler.js`、`routing.js`、`adapters.js`、`activity.js`……）中主控用到的部分 | VPS2 |
| `relay/*.py` | VPS1（见 `relay/OPERATIONS.md`） |
| `main.js`、`preload.js`、`remote.js`、`src/**`，以及 Bridge 用到的 `orchestrator/windows.js`、`service.js` 的 `startBridge` | Windows 端重新打包；Mac 端应用重新打包 |
| `orchestrator/mac-bridge.js` 及它引用的 `orchestrator/*.js` | Mac 端后台 Bridge |
| `orchestrator/ssh-options.js`、`ssh-route.js`、`ssh-jump.js`、`bridge-ssh.js` | 桌面端重新打包；Mac 端后台 Bridge 同步文件（见 §4） |
| 只改配置（路由顺序、可改代码的成员、CLI 路径、额度阈值） | 只改对应那一端的配置文件，不用发版 |

同一个文件常常几端都用（`service.js` 既是 VPS2 主控，也是两端 Bridge 的实现）。逐个看改动的文件被谁 `require`，列全受影响的端。

**部署顺序：先 VPS2，再 Windows / Mac。** 新客户端调用旧主控不认识的操作会报 `unsupported_operation`；旧客户端调用新主控没有问题。

## 0. 在仓库里改并验证（每次都做）

1. 在开发分支上改代码。
2. 新增一种主控操作时，三处白名单都要加：`orchestrator/service.js` 的操作列表、`main.js` 的 `orchestrationOperations`、`orchestrator/scheduler.js` 里处理它的分支。漏一处，请求会在那一层被拒。
3. 运行 `npm test`；改了 `relay/` 再运行 `cd relay && python3 -m unittest discover -s tests`。
4. 改了界面：用 Playwright 打开 `src/index.html` 截图核对，`window.__boot.freeze(t)` 可把开机动画定在任意时刻。
5. 提交、推送，确认 GitHub Actions 的 CI 在 Ubuntu、Windows、macOS 上都通过。

**完成标准：** 测试全绿，CI 三个系统全绿，受影响的端已列清。

## 1. VPS2（主控）

需要一个能 `sudo` 的管理员 SSH 登录。`agentdesk` 用户的密钥是强制命令、不能开 shell，管理用不了它。

### 更新代码

```sh
ssh <管理员>@<VPS2>
cd <VPS2 上的仓库目录> && git pull --ff-only
ADMIN='sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/admin.js /var/lib/agentdesk-orchestrator/admin.sock'
$ADMIN ls                                                            # 先看有没有正在跑的任务
$ADMIN maintenance on "deploy <版本或提交>"                           # 排空：不再领取新任务，正在执行的步骤继续跑完
$ADMIN maintenance                                                   # 等到 enabled=true 且 running 为空、ready=true
sudo bash orchestrator/install-ubuntu.sh          # 复制 orchestrator/*.js 到 /opt；已有的 config.json 不会被覆盖
sudo systemctl restart agentdesk-orchestrator
$ADMIN maintenance off                                               # 确认新服务正常后再恢复领取任务
```

排空后已有任务的当前步骤不会被重启，所有可中断的部署都应在 `ready=true` 之后进行。维护状态持久化在数据库里，**重启后不会自动解除**；忘记执行 `maintenance off` 时，新任务会一直排队。旧版本没有 `maintenance` 命令时，只能按下面的规则等待。

重启时正在执行的步骤会重新排队、从头再跑（重复消耗该 CLI 的额度）；正在写回本机或跑测试的任务会转为待处理，等人核对（`ad reconcile`）。所以 `ad ls` 里有 `running`、`applying` 或 `testing` 的任务时，等它结束再重启，或先告诉用户。

### 只改配置

```sh
sudoedit /etc/agentdesk-orchestrator/config.json
sudo /opt/agentdesk-orchestrator/node -e "JSON.parse(require('fs').readFileSync('/etc/agentdesk-orchestrator/config.json','utf8'))"
sudo systemctl restart agentdesk-orchestrator
```

配置项的含义以 `orchestrator/vps2.example.json` 和 `orchestrator/OPERATIONS.md` 为准。路由、额度阈值、`writeProviders` 有校验，写错时服务启动就会失败，日志里写明是哪一项（如 `invalid_routing:implement`）。

单步 CLI 时限是顶层 `cliTimeoutMs`（毫秒，默认 2700000，即 45 分钟），改完重启服务生效。CLI 自己的 print 时限会提前 5%（最多 60 秒）结束，留出保存会话和续跑的时间；`printTimeoutMs` 可单独指定，但会被限制在总时限内。长时间没有输出的步骤仍由 `stallTimeoutMs`（默认 10 分钟）先停掉。

### 60 天保留与系统日志

`retention` 的默认值已经包含 `historyDays: 60` 和 `uploadDays: 7`；需要显式写进配置时，在 `/etc/agentdesk-orchestrator/config.json` 顶层加：

```json
"retention": { "completedDays": 3, "failedDays": 7, "historyDays": 60, "uploadDays": 7, "minFreePercent": 15 }
```

任务记录、单聊线程元数据、上传缓存和无主 worktree/日志到期后由主控和单聊服务自动删除；项目文件、技能、登录凭据和配置不受影响。系统日志由单独的定时器清理：

```sh
sudo install -m 0644 orchestrator/agentdesk-journal-retention.service orchestrator/agentdesk-journal-retention.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentdesk-journal-retention.timer
systemctl list-timers agentdesk-journal-retention.timer
```

定时器每天执行一次 `journalctl --vacuum-time=60d`；立即执行一次用 `sudo systemctl start agentdesk-journal-retention.service`。

### 确认生效

```sh
systemctl is-active agentdesk-orchestrator          # active
sudo journalctl -u agentdesk-orchestrator -n 50      # 没有启动错误
ad doctor                                            # 各 CLI 可启动、登录有效、分配顺序是你刚改的
```

`ad` 的定义见 `orchestrator/OPERATIONS.md`「任务与切换」。

**完成标准：** 服务 `active`，日志无报错，`ad doctor` 显示的路由和成员与预期一致，桌面端「主控线路」显示在线。

### 回滚

`git checkout <上一个提交>`，再执行一次安装脚本并重启。配置改坏了就恢复改之前的内容（改之前先 `sudo cp config.json config.json.bak`）。

## 2. Windows 端

Windows 的 Bridge 运行在 AgentDesk 应用进程里，所以**代码改动要重新打包安装**，配置改动重启应用即可。

### 更新应用

- 正式安装包：在 GitHub Actions 手动运行 **Build release artifacts**，下载 `agentdesk-windows` 产物里的 `AgentDesk-<版本>-setup.exe` 覆盖安装。服务器地址和 SSH 主机指纹来自仓库 secret `AGENTDESK_SERVER_JSON`（见 `docs/SIGNING.md`），不要把真实 IP 写进仓库。
- 开发机直接跑：仓库目录里 `npm ci`，然后 `npm start`。

### 只改配置

| 文件（`%USERPROFILE%\.agentdesk\`） | 管什么 |
|---|---|
| `remote.json` | VPS 地址、端口、SSH 用户和密钥路径、`orchestratorBridge`（指向 Bridge 配置的绝对路径）。安装包内带服务器配置时，地址和端口以安装包为准 |
| Bridge 配置（照 `orchestrator/windows-bridge.example.json`） | 授权的项目路径、`write`、`desktop`、允许运行的命令、`agentCommands`、Relay 令牌、`controlSocket`；顶层 `readAnyFolder: true` 额外允许组长只读整机（家目录与本地盘符，不含系统与凭据目录） |

项目、外观、向导进度在 `%APPDATA%\AgentDesk\config.json`，一般在应用里改，不手改。

改完退出 AgentDesk（托盘里也要退出）再打开。

### 确认生效

- 应用底部状态栏显示 SSH 主用（或 Relay）在线，群聊顶部「主控线路」在线。
- 「诊断」里没有配置错误；需要时导出诊断包。
- 在一个项目的群聊里发一个只读的小任务（如「总结 README」），能看到组长方案和分工进度。
- 桌面工具的完整性级别、会话和截图限制见 [本机桌面权限](DESKTOP-PERMISSIONS.md)。

**完成标准：** 以上三项都满足。

## 3. Mac 端

模型列表配置、Mac 同步和本机文件验收步骤参见 [模型选择与本机文件](MODELS-AND-LOCAL-FILES.md)。

Mac 有两个独立部分：**AgentDesk 应用**和**后台 Bridge**（launchd 启动 `mac-bridge.js`；可能直接指向仓库，也可能是 `~/Library/Application Support/AgentDesk/bridge/app/` 下的部署副本）。

### 更新后台 Bridge

```sh
launchctl print gui/$(id -u)/<Bridge 的 launchd 标签> | grep -A3 program
```

标签以本机 `~/Library/LaunchAgents/` 里的 plist 为准（`launchctl list | grep -i agentdesk` 可查）。plist 的 `ProgramArguments` 是 Node、`mac-bridge.js` 和 Bridge 配置的绝对路径；进程必须在已登录用户的 `gui/<uid>` 会话里，否则辅助功能和屏幕录制权限不生效。

- 指向仓库：`cd <仓库目录> && git pull --ff-only`。
- 指向部署副本：把仓库里的 `orchestrator/mac-bridge.js` 及它 `require` 的 `orchestrator/*.js`（含 `service.js`、`ssh-options.js`、`ssh-route.js`、`bridge-ssh.js`、`ssh-jump.js`）复制到部署副本的 `orchestrator/`，不要只复制 `mac-bridge.js`。

改完执行：

```sh
launchctl kickstart -k gui/$(id -u)/<Bridge 的 launchd 标签>
```

### 更新应用

Apple Silicon 上 `npm ci && npm run dist:mac -- --arm64`，产物在 `dist/mac-arm64/AgentDesk.app`；或用 Actions 产物 `agentdesk-mac` 里的 DMG。替换 `/Applications/AgentDesk.app` 后打开。如果这台机器无法访问 GitHub 的 release 资源，可先设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 和 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 再构建。

### 只改配置

| 文件 | 管什么 |
|---|---|
| `~/.agentdesk/mac-remote.json` | 应用连 VPS 的地址、SSH 用户和密钥 |
| Bridge 配置（照 `orchestrator/mac-bridge.example.json`） | 授权项目、命令、`agentCommands`、Relay、`controlSocket` / `desktopSocket`（在 `~/Library/Application Support/AgentDesk/bridge/state/`）；顶层 `readAnyFolder: true` 额外允许组长只读整机（家目录、`/Volumes` 与临时目录，不含系统与凭据目录） |

改 Bridge 配置后用上面的 `launchctl kickstart -k` 重启 Bridge；改 `mac-remote.json` 后重启应用。

### 确认生效

```sh
launchctl print gui/$(id -u)/<标签> | grep -E 'state|last exit'   # state = running
```

再在应用里看「线路与模型」在线，并发一个只读小任务。

本机桌面工具（辅助功能、屏幕录制、授权对象和重启要求）见 [本机桌面权限](DESKTOP-PERMISSIONS.md)。

**完成标准：** Bridge `running`，应用线路在线，小任务能看到组长方案和分工进度。

## 4. VPS1 SSH 跳板（直连 VPS2 失败时自动回退）

VPS1 的 22022 是应用层 TLS Relay，只传 JSON 数据帧，不能承载 SSH stdio。SSH 跳板是另一条独立线路：客户端外层 SSH 仍然直连并校验 VPS2 的主机指纹，只在 TCP 层经 VPS1 的专用受限账号转发到 `VPS2:22`。VPS1 看不到 SSH 内容，也没有新增监听端口。

适用对象：桌面端的 Codex、Claude/Grok/Antigravity 单聊、应用内 Bridge，以及 Mac/Windows 独立 Bridge。没有配置 `jump` 的旧客户端完全按直连工作。

### 4.1 VPS1：专用跳板账号

以 root 在 VPS1 执行（示例；`<VPS2_HOST>`、`<VPS1>` 用实际值替换，不要写进仓库）：

```sh
useradd --system --create-home --shell /usr/sbin/nologin agentdesk-jump
install -d -m 700 -o agentdesk-jump -g agentdesk-jump /home/agentdesk-jump/.ssh
```

把客户端公钥追加到 `/home/agentdesk-jump/.ssh/authorized_keys`，一行，选项不能省：

```text
restrict,port-forwarding,permitopen="<VPS2_HOST>:22" ssh-ed25519 <PUBKEY> agentdesk-jump-mac
```

- `restrict` 关闭 PTY、agent、X11、user-rc 等一切非转发能力；`port-forwarding` 只重新打开 TCP 转发。
- `permitopen` 只允许转发到 VPS2 的 22。若客户端 `port`（Codex/单聊用的目标端口）不是 22，再加一个 `permitopen="<VPS2_HOST>:<TARGET_PORT>"`；反向隧道固定连 22。
- 不需要改 `sshd_config`、不需要 reload，下一次连接即生效。

```sh
chown agentdesk-jump:agentdesk-jump /home/agentdesk-jump/.ssh/authorized_keys
chmod 600 /home/agentdesk-jump/.ssh/authorized_keys
```

### 4.2 客户端：密钥和 known_hosts

跳板密钥与目标 VPS2 密钥完全分开（不要复用 `codex_vps_ed25519` 等）：

```sh
ssh-keygen -t ed25519 -a 100 -f ~/.agentdesk/jump_ed25519 -N '' -C agentdesk-jump-mac
ssh-keygen -F <VPS1> -f ~/.ssh/known_hosts > ~/.agentdesk/jump_known_hosts
chmod 600 ~/.agentdesk/jump_ed25519 ~/.agentdesk/jump_known_hosts
```

- 只用本机已信任的 `known_hosts` 提取记录，不要用未核对的 `ssh-keyscan`。VPS1 的 SSH 端口不是 22 时，`-F '[<VPS1>]:<PORT>'`。
- 公钥交给有 VPS1 管理权限的人写入上面的 `authorized_keys`；私钥只留本机。
- 代码不用 `-J`：`-J` 可能把目标密钥/证书复用给 VPS1。跳板这一跳使用独立 key/known_hosts/证书，并设置 `IdentityAgent=none`。

### 4.3 配置

桌面端 `~/.agentdesk/mac-remote.json`（Windows 为 `%USERPROFILE%\.agentdesk\remote.json`）顶层：

```json
{
  "jump": {
    "mode": "auto",
    "host": "<VPS1>",
    "port": 22,
    "user": "agentdesk-jump",
    "key": "/Users/<you>/.agentdesk/jump_ed25519",
    "knownHosts": "/Users/<you>/.agentdesk/jump_known_hosts",
    "probeMinutes": 10
  }
}
```

独立 Bridge 的配置放在 `ssh.jump` 下，键名相同：

```json
{
  "ssh": {
    "jump": {
      "mode": "auto",
      "host": "<VPS1>",
      "port": 22,
      "user": "agentdesk-jump",
      "key": "/Users/<you>/.agentdesk/jump_ed25519",
      "knownHosts": "/Users/<you>/.agentdesk/jump_known_hosts",
      "probeMinutes": 10
    }
  }
}
```

- `mode`：`auto`（默认，先直连，传输/DNS 故障切跳板，定期探测直连恢复）、`direct`（强制直连，紧急回滚）、`jump`（强制跳板，验收用）。
- `key`、`knownHosts`、`certificate`、`probeMinutes` 只从本机配置读取。安装包里的 `agentdesk-server.json` 最多提供 `host`、`port`、`user`、`mode`；`host/port/user` 安装包优先，`mode` 本机优先。
- 本机 `jump` 写错（缺 key/knownHosts、端口非法）时只禁用跳板并给出原因，直连不受影响。
- 目标 VPS2 的 `knownHosts` 是另一份文件，二者不要混用。

### 4.4 部署新代码

- 桌面端：重新打包。`package.json` 的 `extraResources` 会把自包含的 `ssh-jump.js` 放到 asar 外；`ssh-options.js` 仍随主进程打进 asar。打包后确认 `AgentDesk.app/Contents/Resources/ssh-jump.js` 及 Windows `resources\ssh-jump.js` 存在。
- Mac 后台 Bridge：按 §3 判断 launchd 指向仓库还是部署副本；部署副本要一并复制 `mac-bridge.js`、`ssh-options.js`、`ssh-route.js`、`bridge-ssh.js`、`ssh-jump.js`。
- VPS1 不需要部署代码；VPS2 不需要改代码或重启。

### 4.5 验证

跳板这一跳能打印 VPS2 的 SSH banner：

```sh
ssh -F none -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=~/.agentdesk/jump_known_hosts -o HostKeyAlgorithms=ssh-ed25519 \
  -o IdentitiesOnly=yes -o IdentityAgent=none -i ~/.agentdesk/jump_ed25519 \
  -p <JUMP_PORT> -W <VPS2_HOST>:22 agentdesk-jump@<VPS1> < /dev/null
```

- 输出以 `SSH-2.0-` 开头即成功。
- 负向：`-W <其他主机>:22` 或 `-W <VPS2_HOST>:<其他端口>` 必须被 `permitopen` 拒绝；`ssh ... agentdesk-jump@<VPS1> id` 必须因 nologin 失败。
- 应用状态栏和 `/status` 在跳板时显示「VPS1 跳板」；诊断报告的 `remote.route` 只会是 `direct`/`jump`/`suspended`，不含主机、路径或密钥。
- 强制 `mode: "jump"` 跑一轮 Codex、三个单聊、附件和 Bridge；再改回 `auto`，阻断直连确认一次重试内切换，恢复后约 `probeMinutes` 分钟回到直连。

### 4.6 故障排查

- 跳板报 VPS1 指纹错误：`jump_known_hosts` 与 VPS1 实际 ED25519 指纹不一致；重新用已信任记录提取，核对后再连。
- 跳板报 VPS2 指纹错误：目标 `knownHosts` 或目标主机密钥变了；不要改 `StrictHostKeyChecking`，先核对指纹。
- `administratively prohibited`：VPS1 `permitopen` 与 `jump.host`/目标端口不一致。
- 跳板认证/主机密钥失败后自动重试被拉长到 10 分钟：这是保护 VPS1 源 IP 不被 VPS2 fail2ban 封禁；修好配置后点「重新连接」立即重试。
- VPS1 的 22 不稳定时可改用已验证的 22222：同步修改 `jump.port`、`[<VPS1>]:22222` 的 known_hosts 记录和 `permitopen` 的目标端口（`permitopen` 限制的是 VPS2 目标，不是 VPS1 端口）。
- Windows 打包版 `ssh.exe` 的 ProxyCommand 引号或 `%` 报错：见 §4.3，路径不要含 `"`、换行或 `%`。

### 4.7 回滚

1. 本机把 `jump.mode` 改成 `"direct"`（或删除 `jump`，或恢复 `*.bak-<日期>`），重启应用和 Bridge；无需改代码。
2. 需要移除 VPS1 权限时，恢复 `authorized_keys` 备份或删掉跳板那一行。
3. 应用/Bridge 可回滚到备份副本；VPS2 没有改动。

## 不变的规则

- 真实 IP、SSH 私钥、Relay 令牌、登记密码只放在各端的配置或 GitHub secret 里。仓库只放 `*.example.json`；`agentdesk-server.json`、`agentdesk-enrollment.json`、`remote.json` 都在 `.gitignore` 里。
- VPS 上动手（重启服务、改配置、改 sshd 和防火墙）之前先告诉用户要做什么；涉及 SSH 和防火墙的改动，先确认自己的管理员登录在改完后仍然可用，再断开当前会话（见 `docs/SECURITY_REVIEW.md` §3）。
- 一次只部署一端，确认生效后再动下一端，出问题时能知道是哪一步引起的。
