# 修改与部署：VPS2、Windows 端、Mac 端

给在本机工作的 agent（Codex、Claude Code 等）用的操作手册。有待执行的版本升级时，先看对应的升级清单（当前：[UPGRADE-2026-11.md](UPGRADE-2026-11.md)）。代码在仓库里改；每一端怎样拿到新代码、怎样改配置、怎样确认生效，见对应一节。

## 先判断改动落在哪一端

| 改了什么 | 要部署到 |
|---|---|
| `orchestrator/*.js`（`service.js`、`scheduler.js`、`routing.js`、`adapters.js`、`activity.js`……）中主控用到的部分 | VPS2 |
| `relay/*.py` | VPS1（见 `relay/OPERATIONS.md`） |
| `main.js`、`preload.js`、`remote.js`、`src/**`，以及 Bridge 用到的 `orchestrator/windows.js`、`service.js` 的 `startBridge` | Windows 端重新打包；Mac 端应用重新打包 |
| `orchestrator/mac-bridge.js` 及它引用的 `orchestrator/*.js` | Mac 端后台 Bridge |
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
sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/admin.js /var/lib/agentdesk-orchestrator/admin.sock ls   # 先看有没有正在跑的任务
sudo bash orchestrator/install-ubuntu.sh          # 复制 orchestrator/*.js 到 /opt；已有的 config.json 不会被覆盖
sudo systemctl restart agentdesk-orchestrator
```

重启时正在执行的步骤会重新排队、从头再跑（重复消耗该 CLI 的额度）；正在写回本机或跑测试的任务会转为待处理，等人核对（`ad reconcile`）。所以 `ad ls` 里有 `running`、`applying` 或 `testing` 的任务时，等它结束再重启，或先告诉用户。

### 只改配置

```sh
sudoedit /etc/agentdesk-orchestrator/config.json
sudo /opt/agentdesk-orchestrator/node -e "JSON.parse(require('fs').readFileSync('/etc/agentdesk-orchestrator/config.json','utf8'))"
sudo systemctl restart agentdesk-orchestrator
```

配置项的含义以 `orchestrator/vps2.example.json` 和 `orchestrator/OPERATIONS.md` 为准。路由、额度阈值、`writeProviders` 有校验，写错时服务启动就会失败，日志里写明是哪一项（如 `invalid_routing:implement`）。

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
| Bridge 配置（照 `orchestrator/windows-bridge.example.json`） | 授权的项目路径、`write`、`desktop`、允许运行的命令、`agentCommands`、Relay 令牌、`controlSocket` |

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

Mac 有两个独立部分：**AgentDesk 应用**和**后台 Bridge**（launchd 运行仓库里的 `orchestrator/mac-bridge.js`）。

### 更新后台 Bridge

```sh
cd <Mac 上的仓库目录> && git pull --ff-only
launchctl kickstart -k gui/$(id -u)/<Bridge 的 launchd 标签>
```

标签以本机 `~/Library/LaunchAgents/` 里的 plist 为准（`launchctl list | grep -i agentdesk` 可查）。plist 的 `ProgramArguments` 是 Node、`mac-bridge.js` 和 Bridge 配置的绝对路径；进程必须在已登录用户的 `gui/<uid>` 会话里，否则辅助功能和屏幕录制权限不生效。

### 更新应用

Apple Silicon 上 `npm ci && npm run dist:mac -- --arm64`，产物在 `dist/mac-arm64/AgentDesk.app`；或用 Actions 产物 `agentdesk-mac` 里的 DMG。替换 `/Applications/AgentDesk.app` 后打开。如果这台机器无法访问 GitHub 的 release 资源，可先设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 和 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 再构建。

### 只改配置

| 文件 | 管什么 |
|---|---|
| `~/.agentdesk/mac-remote.json` | 应用连 VPS 的地址、SSH 用户和密钥 |
| Bridge 配置（照 `orchestrator/mac-bridge.example.json`） | 授权项目、命令、`agentCommands`、Relay、`controlSocket` / `desktopSocket`（在 `~/Library/Application Support/AgentDesk/bridge/state/`） |

改 Bridge 配置后用上面的 `launchctl kickstart -k` 重启 Bridge；改 `mac-remote.json` 后重启应用。

### 确认生效

```sh
launchctl print gui/$(id -u)/<标签> | grep -E 'state|last exit'   # state = running
```

再在应用里看「线路与模型」在线，并发一个只读小任务。

本机桌面工具（辅助功能、屏幕录制、授权对象和重启要求）见 [本机桌面权限](DESKTOP-PERMISSIONS.md)。

**完成标准：** Bridge `running`，应用线路在线，小任务能看到组长方案和分工进度。

## 不变的规则

- 真实 IP、SSH 私钥、Relay 令牌、登记密码只放在各端的配置或 GitHub secret 里。仓库只放 `*.example.json`；`agentdesk-server.json`、`agentdesk-enrollment.json`、`remote.json` 都在 `.gitignore` 里。
- VPS 上动手（重启服务、改配置、改 sshd 和防火墙）之前先告诉用户要做什么；涉及 SSH 和防火墙的改动，先确认自己的管理员登录在改完后仍然可用，再断开当前会话（见 `docs/SECURITY_REVIEW.md` §3）。
- 一次只部署一端，确认生效后再动下一端，出问题时能知道是哪一步引起的。
