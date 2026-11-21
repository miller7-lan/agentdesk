# 修改与部署：VPS2、Windows 端、Mac 端

给在本机工作的 agent（Codex、Claude Code 等）用的操作手册。有待执行的版本升级时，先看对应的升级清单（当前：[UPGRADE-2026-11.md](UPGRADE-2026-11.md)）。代码在仓库里改；每一端怎样拿到新代码、怎样改配置、怎样确认生效，见对应一节。

## CLI 运行位置

AgentDesk 的模型 CLI 和原生会话运行在 VPS2。Windows 和 Mac 运行桌面端与 Bridge，在当前授权下处理本机文件、命令和桌面操作。单聊通过 SSH 连接 VPS2 的原生 CLI，群聊由 VPS2 主控派工。本机与 VPS2 各自有工作目录，界面和工具事件应标明实际操作位置。需要接近原生 CLI 体验时，优先复用供应商的会话和流式事件协议，并在本机 Bridge 内完成批量文件操作。

## 先判断改动落在哪一端

| 改了什么 | 要部署到 |
|---|---|
| `orchestrator/*.js`（`service.js`、`scheduler.js`、`routing.js`、`adapters.js`、`activity.js`……）中主控用到的部分 | VPS2 |
| `relay/*.py` | VPS1（见 `relay/OPERATIONS.md`） |
| `main.js`、`preload.js`、`remote.js`、`src/**`，以及 Bridge 用到的 `orchestrator/windows.js`、`service.js` 的 `startBridge` | Windows 端重新打包；Mac 端应用重新打包 |
| `orchestrator/mac-bridge.js` 及它引用的 `orchestrator/*.js` | Mac 端后台 Bridge |
| `orchestrator/ssh-options.js`、`ssh-route.js`、`ssh-jump.js`、`bridge-ssh.js` | 桌面端重新打包；Mac 端后台 Bridge 同步文件（见 §4） |
| `orchestrator/sftp-readonly.js`（只读挂载的 SFTP 服务）、`ssh-gateway.js`、`home-mount.js`、`agentdesk-home-mount.service` | `sftp-readonly.js`：桌面端重新打包、Mac 后台 Bridge 同步；`ssh-gateway.js`、`home-mount.js` 和 unit：VPS2（见 `orchestrator/OPERATIONS.md`「只读挂载本机用户目录」） |
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
本机命令实时输出、停止和断线恢复的安装与验收参见 [Mac 本机命令部署](MAC-LOCAL-COMMANDS.md)。

Mac 有两个独立部分：**AgentDesk 应用**和**后台 Bridge**（launchd 启动 `mac-bridge.js`；可能直接指向仓库，也可能是 `~/Library/Application Support/AgentDesk/bridge/app/` 下的部署副本）。

### 群聊项目快照升级

先按本页更新 VPS2 主控，再更新 Mac 应用和后台 Bridge，最后重新连接。Windows 同样需要更新应用内 Bridge。使用 GitHub Actions 的同一提交构建的 `agentdesk-mac` 通用 DMG，或参照下方步骤重新打包。保留设备原有的连接配置、Bridge 配置和授权。通用产物使用 `bundle_connection=false`，设备各自配置自己的连接信息。

新群聊方案在规划前从本机获取 Git 项目快照。组长和执行成员以同一快照为起点，包含已跟踪文件的工作区改动、删除，以及没被 `.gitignore` 排除的新文件；快照在临时索引里生成，不动本机暂存区。`.env`、密钥、证书这类敏感文件不会进快照，群里会提示跳过了几个，任务照常进行。VPS2 的镜像仓库缺本机当前提交时（本机提交了还没推送），主控会让 Bridge 把缺的提交打成 Git bundle 自动同步过去，只传 VPS2 没有的部分，单次上限 20 MiB；第一次同步整个历史超过上限时手动推送一次即可。快照上限为 8 MiB。

项目搜索、编辑和可在 VPS2 运行的检查在快照工作树里完成，项目文件只读快照这一个版本。项目以外的本机文件：开了只读挂载时，组长和成员直接读挂载（挂载里的项目目录在沙盒里隐藏，避免和快照混用）；组长另外保留只读文件工具，只能读项目以外；成员在挂载断开时才用这些工具。授权的本机命令、桌面操作或写项目以外的文件，由组长给对应步骤标出本机工具；「方案」不是「全部自动」时会等你确认方案。确认应用补丁前会重新检查本机版本，应用时保留现有暂存区。如果版本已变化，请从当前工作区新建任务。已经生成方案的任务和仍在使用旧版 Bridge 的设备沿用原来的流程。

群聊 CLI 中断时，主控优先用同一模型、会话和工作树继续一次，并把已确认的本机文件操作回执交给原会话。只有当前会话无法继续时才使用现有换模型或交接流程。应用补丁和运行测试仍按各自的请求编号查询结果。

验收时在测试项目中保留一份未提交改动，再提交一个能让组长和成员都检查该文件的群聊请求。确认方案引用了未提交内容和未提交的新文件，`.env` 的改动没有进快照（群里提示跳过）；除组长的只读工具外，普通项目步骤没有连接本机 MCP。随后本机再改一次文件，点击应用应提示工作区版本已变化。再发一个需要本机授权命令的任务，检查该命令是否只在对应步骤运行。

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

### 群聊访问 Windows 本机磁盘

在 VPS2 配置的目标工作区设置 `groupLocalDrives` 为 `["C", "D"]`，将 `deliveryDesktop` 填为这台电脑的实际桌面绝对路径（可取 Windows Bridge 的 `workspaces.<工作区>.readRoots.desktop`）。Windows Bridge 需要启用 `readAnyFolder` 与 `writeAnyFolder`。这些机器专属值保存在各端配置。

群聊计划可按步骤申请本机文件工具。指定 C、D 盘路径的本机任务和桌面任务可自动补上文件工具。要交付指定文件，步骤用 `outputPath` 声明 Windows 绝对路径，或用 `desktopOutput` 声明桌面文件名。调度器按 Bridge 写入回执验收，返工沿用目标。规划、资料查找与审查可读取授权位置；方案中明确要求本机检查时，审查、诊断、验收可执行 Bridge 配置的 `agentCommands`。项目改动继续通过工作树和补丁交付。Windows 用户权限、系统与凭据目录保护仍然生效。

### 群聊交付回执与模型接手

主控在转发本机文件改动前记录请求编号，在收到 Bridge 回复后保存每项结果。连接中断时优先查询该编号；写入内容有已知哈希时也可核对落盘版本。移动、删除结果未知时转入人工核对。旧版只有最后文件名且缺少证据的任务，需要核对已有交付后再决定是否重试。Grok 自身的无交互工具授权失败会进入成员选择。组长申请的 Bridge 临时权限在桌面端审批。

部署顺序为 VPS2 主控、Windows 客户端及 Bridge、Mac 客户端及 Bridge。Mac 使用现有群聊部署流程更新后台 Bridge 并重启，再验证仅允许一个步骤的目录或命令在下一步失效。保留每台机器原有连接配置。

#### 2026-11-21 验证记录

运行版本 `71181c9` 包含主线 `562da84`。本机 Windows 测试 294 项通过，33 项按平台条件跳过。Ubuntu、macOS、Windows 的 Node 测试及 Relay 测试均通过。[三平台 CI](https://github.com/miller7-lan/agentdesk/actions/runs/44774873228)

在 VPS2 以服务账户运行真实 bubblewrap，工作树同时包含已暂存和未暂存的改动，`git status --short` 返回 `MM`，两类 diff 均可读。SSH 网关、主控、Bridge 联调验证了写入前后的回执使用同一请求编号。实际 Windows Bridge 在两块磁盘的临时目录通过创建、读回、编辑、批量版本冲突、移动和回收测试。未使用模型订阅额度。

群聊的文件交付由组长在既有规划轮次解析上下文。方案列出读取、写入或群内回复，文件操作附用户原话和解析后的目的地。改口后重排未完成的文件步骤，主控在发送新写入前校验目标与方案版本。已发往 Bridge 的操作通过回执核对。桌面别名使用工作区的 `deliveryDesktop`；其他位置使用这台电脑的绝对路径。管理端和桌面端沿用既有方案和回执界面。

#### 单聊模型与项目绑定（Windows、macOS）

在自建项目第一次发起原生单聊时，选择该项目对应的本机文件夹（Windows 支持 C 盘和 D 盘）。普通目录自动初始化本地 Git 仓库，无需预先建仓；已有仓库及其子目录沿用原仓库。应用不会自动提交或推送。独立工作树需要选中已有提交的仓库根目录。取消选择会返回原界面。绑定后再次打开项目沿用同一项目编号和目录。原来演示会话中的示例补丁、测试结果和审批记录不能用作实际执行凭证。

Grok、Claude 和 Antigravity 从主控提供的各自模型列表选择模型。发送时锁定本轮的提供商、模型和推理强度，等待连接时切换会话也保留原选择。Windows 和 macOS 都需要更新桌面应用。本次单聊修复不要求重装 VPS 服务或重新登录 CLI。

Windows 隔离窗口验证覆盖取消目录选择、绑定同一项目、三家 CLI 的模型菜单，以及发送后立即切换到 Codex 的情况。验证捕获了创建线程与发送轮次的 IPC 参数，未调用计费模型。

#### 群聊收尾与单聊切换

群聊任务全部成功时，旧群保留消息、派遣记录和输出，只显示「新建群聊」。失败、取消或待确认的任务保留原群输入框。失败和取消后可直接补充要求，也可从任务卡重新安排；后续成功的任务按引用关系结清对应的旧尝试。另一个无关任务成功时，未处理的失败仍可继续。

桌面客户端在当前进程中按单聊分别保存草稿和待发附件。一次发送绑定发起时的项目、会话和附件；连接建立期间重复点击不会再创建一轮。Windows 隔离窗口回归覆盖了草稿和附件切换、双击发送、成功收尾、新建群聊、待确认、失败、取消、重试成功和同群多个独立任务。

Antigravity 单聊打开时和发送前会通过本轮所用账号运行 `agy models`，从 Gemini 组读取可选模型。这项查询不发送聊天消息。已选型号下架时，客户端保留待发内容、刷新列表并提示重新选择。更新时需同步 VPS2 的 `orchestrator/chat-server.js` 与桌面应用，再重新连接单聊。群聊主控可用管理命令 `catalog` 刷新路由模型。

#### VPS2 单文件绑定挂载自动恢复

当 CLI 通过替换文件保存配置时，单文件绑定挂载可能仍然指向旧 inode。若 bubblewrap 在挂载根目录时报 remount 错误，用 `findmnt -rn -M "$target" -o FSROOT` 查看挂载；用 `stat -Lc '%d:%i' "$source" "$target"` 比较设备号和 inode。此处只需检查元数据。

已有这类挂载的主机可安装以下组件。源文件与目标必须和该主机现有 fstab 的 bind 项一致。

1. 将 `orchestrator/refresh-file-bind.sh` 安装到 `/usr/local/libexec/agentdesk-refresh-file-bind`（0755），将同目录的 `agentdesk-file-bind.service`、`agentdesk-file-bind.timer` 安装到 `/etc/systemd/system/`。
2. 创建 root 所有、权限 0600 的 `/etc/agentdesk-file-bind.conf`，两行分别设置 `BIND_SOURCE`、`BIND_TARGET` 为实际绝对路径。把 `agentdesk-file-bind.path.example` 安装为 `/etc/systemd/system/agentdesk-file-bind.path`，将 `PathChanged` 改为同一源路径。
3. 执行 `systemctl daemon-reload`、`systemctl enable --now agentdesk-file-bind.path agentdesk-file-bind.timer` 和 `systemctl start agentdesk-file-bind.service`。监听器响应文件变化，定时器每 30 秒左右补查一次。设备号和 inode 相同时直接返回；若卸载报告忙，保留挂载，等待重试。
4. 用 `systemctl is-active agentdesk-file-bind.path agentdesk-file-bind.timer` 和 `systemctl show agentdesk-file-bind.service -p Result` 检查。用实际服务账户执行 `bwrap --ro-bind / / --dev /dev --proc /proc /bin/true` 验证启动。

回滚自动监控时执行 `systemctl disable --now agentdesk-file-bind.path agentdesk-file-bind.timer`。现有 fstab 条目和已恢复的挂载继续生效。
