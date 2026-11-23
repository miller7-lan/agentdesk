# 客户端内部更新（服务器发出、客户端接收）

适用版本：0.3.0 起（分支 `feat/safe-differential-updates-20261122`）。本文说明设计、使用、部署前置条件和已知限制。

> **当前状态（2026-11-23 09:20 CST 起）**：VPS2 服务端已按 main `837e328` 部署上线，存储、专用上传账户和强制命令已建好，已用隔离测试数据完成验收（见 [DEPLOY-LOG.md](DEPLOY-LOG.md)）。**还差主人的三步**：① 在 VPS2 上 `sshd -t && systemctl reload ssh`，让上传账户生效（本次会话的权限设置不允许执行这一步）；② 在 GitHub 建 `vps2-intake` Environment 并填 secret（§6.4）；③ 推送第一个正式 `vX.Y.Z` 标签。在此之前生产存储里没有任何版本，所有设备都得到「没有新版本」。**尚未**在任何真实电脑上安装或升级，差分下载效果**尚未在真实设备上实测**。

## 1. 架构

```
 GitHub Actions（只在推送纯 vX.Y.Z 标签时）
   build(win/mac) ─ verify ─ windows-upgrade-check ─┐
                                                    │ ssh（专用受限账户，forced command）
                                                    ▼
 VPS2  client-update-intake.js ──写入──> /var/lib/agentdesk-orchestrator/client-updates/
                                          versions/<x.y.z>/{manifest.json, 安装包, blockmap}
                                          latest.json / withdrawn.json / policy.json
         scheduler.js  client_update / client_update_read / open_tasks   （client-updates.js）
         chat-server.js  初始化回复里的 clientUpdate 提示 + agentdesk/clientUpdate 通知（只是提示）
                                                    │ 现有 SSH 控制通道（Bridge / Mac Bridge / 登记会话）
                                                    ▼
 客户端主进程
   updates.js（状态机）──> electron-updater (NsisUpdater / MacUpdater)
        │                         │ HTTP，只连 127.0.0.1
        │                         ▼
        │              update-transport.js 本机回环适配器（随机路径 + 随机口令，只提供清单列出的文件，
        │                         │        Range 请求换算成 client_update_read 分块读取）
        │                         ▼
        │              orchestratorControl ──> Bridge 控制 socket ──> VPS2
        └─> update-gate.js 安全重启门禁（全部在主进程判断） ──> quitAndInstall
   src/updates-ui.js：更新对话框（侧栏「更新」）
```

- **差分下载**：完全由 electron-updater 实现（blockmap、按区间下载、失败自动改为完整下载、sha512 校验）。本项目**没有**编写任何二进制补丁算法。回环适配器只把 HTTP 请求换算为经 SSH 控制通道的分块读取。
- **传输**：VPS2 上聊天和 Bridge 的公钥都设了 `restrict`，不能用 `ssh -L` 转发，所以文件通过现有控制通道分块读取。每块最多 128 KiB；控制通道单帧上限 192 KiB，base64 编码后约 171 KiB。这条路径与群聊产物下载（`task_artifacts`，20 MB 上限）**相互独立**。`client_update_read` 的大小以清单为准，硬上限 1 GiB。
- **多区间请求**：适配器不拼接 `multipart/byteranges`。更新器配置为一次请求一个区间（`useMultipleRangeRequest: false`）；如果仍然收到多区间请求，适配器返回整个文件，更新器随之改为完整下载。

## 2. 更新流程与按钮

| 状态 | 检查更新 | 立即下载 | 重试 | 稍后更新 | 重启并更新 |
|---|---|---|---|---|---|
| 已是最新 / 尚未检查 / 更新成功 | 可点 | — | — | — | — |
| 正在检查 | — | — | — | — | — |
| 发现新版本 | 可点 | 可点 | — | 可点 | — |
| 正在下载 | — | — | — | 可点（取消下载） | — |
| 下载失败 | 可点 | — | 可点 | 可点 | — |
| 下载完成，任务空闲 | 可点 | — | — | 可点 | **可点**（未签名的 Mac 版改为「打开下载位置」） |
| 有任务运行，或任务状态无法确认 | 可点 | — | — | 可点 | **不可点**，逐条显示原因；没有强制选项；可选「任务结束后提醒我」 |
| 正在安装 | — | — | — | — | — |
| 安装失败 | 可点 | — | — | 可点 | — |

规则：

- 下载完成只会把状态推进到「等待安装」。普通退出不会安装（`autoInstallOnAppQuit=false`），也不做静默安装。服务器不能让客户端重启。
- 点击「重启并更新」后，主进程按以下顺序执行：
  1. 向 VPS2 再确认一次这个版本没有被撤回；
  2. 第一次门禁检查；
  3. 关闸，拒绝新开单聊轮次、终端输入、群聊提交和本机文件变更；
  4. 第二次门禁检查；
  5. 让 Worker 在确认空闲时自行退出；
  6. 设置 `updateQuit`，使 `before-quit` 不再拦截、也没有任何东西需要中止；
  7. 调用 `quitAndInstall(false, true)`。

  任何一步失败都会开闸，状态变为「安装失败」，当前版本照常可用。
- **签名与安装**：
  - 已签名构建：启动 30 秒后检查一次，之后每 24 小时检查一次，网络恢复后也会重查（间隔至少 10 分钟）；发现已签名的新版本时自动后台下载（可在对话框里关闭）。
  - 未签名构建：不会自己定时检查，也不会自动下载。收到服务器通知或手动检查后只显示「发现新版本」，由用户点「立即下载」。
  - Windows 未签名包：下载完成、门禁通过后，由用户点击「重启并更新」运行安装包。
  - macOS 未签名包：Squirrel.Mac 要求签名，无法由更新器安装，只能打开下载位置手动替换。
    下载照常校验（sha512、大小），但不交给 Squirrel.Mac：`mac-manual-updater.js` 直接返回下载好的 zip 路径。原版 MacUpdater 会先调用 `autoUpdater.setFeedURL`（签名不被认可时在回调里抛错，下载一直停在「正在下载」），并且返回空列表，导致「打开下载位置」找不到文件。0.2.9 及更早的构建还没有这个修复：在这些版本上下载完成后若打不开下载位置，zip 在 `~/Library/Caches/agentdesk-ui-updater/pending/`。

## 3. 安全重启门禁（`update-gate.js`）

门禁只读取主进程自己的状态，或者由主进程直接查询，不采信窗口的上报。每一项的结果是空闲、忙或未知三者之一。只有全部为空闲才放行；出错、超时（5 秒）或返回无法识别的结果，都算未知，**未知时不能安装**。

| 项 | 来源 |
|---|---|
| Codex 单聊 | `turn/started` / `turn/completed` 全量跟踪，加上 `remote.pendingReqs`（待审批） |
| Claude / Grok / Antigravity 单聊 | 每个连接的 `activeTurns`、`serverIds`（待审批）、`pending`（请求未回），加上 `chatTurns` |
| 原生单聊 | 原生会话事件中的轮次 |
| 本机后台进程（Worker） | `orchestrator/worker-idle.js`，见下 |
| 本机命令 | `commandRuns` 中所有作用域里未结束的命令 |
| Windows 进程内 Bridge | `startBridge()` 返回值上的 `activity()` |
| 群聊 | 由主进程调用 VPS2 的 `open_tasks`，返回本设备的全部未结束任务，不像 `project_tasks` 只列最近 30 个 |
| 审批与文件 | `fileTurns`、`desktop.active`、正在确认的本机文件变更 |

**Worker（D6）**：

- 查询时只连接，从不启动、结束或断开 Worker。
- 新版 Worker 提供只读的 `idleStatus`，以及原子操作 `shutdownIfIdle`：在同一步内检查，空闲才退出。
- 旧版 Worker 不认识这两个操作。程序会用它已有的只读操作（`lookup`、`shell list`、`terminalRead`）列出查到的活动，但结果**一律为未知**，原因有两个：旧协议无法列出全部会话；命令列表最多只返回最近 16 条。
- 连不上 Worker（ENOENT / ECONNREFUSED）**不能直接算空闲**。必须同时满足三条旁证：
  1. 进程列表里没有这个状态目录对应的 Worker 进程。Windows 用 `Get-CimInstance Win32_Process`，macOS 用 `ps`，都是只读查询；列不出进程时算未知。
  2. `runs.json` 里没有未结束或结果未确认的命令。
  3. `leases.json` 里没有未完成的文件写入。

  任何一条不满足就算未知。
- 已知行为：`runs.json` 里有「结果未确认」的命令时会一直阻止更新，直到该会话恢复并确认这个命令的结果。

## 4. 连接配置（bundle_connection 构建）

- 可推送的安装包**不包含** `agentdesk-server.json` 和 `agentdesk-enrollment.json`，由三道检查保证：
  1. `package.json` 的默认打包配置不收这两个文件。内置连接的构建另用 `build/bundle-connection.config.js`（`npm run dist:bundle`）。
  2. 流水线运行 `scripts/verify-update-artifacts.js` 检查产物。
  3. `scripts/client-update-upload.js` 发现连接文件或私钥时拒绝上传；VPS2 接收程序也会拒绝这些文件名。
- 首个带更新功能的版本启动时，会把安装目录里的连接文件复制到 `<userData>/bundled-connection/`（权限 0600，不覆盖已有副本）。此后**本机副本优先**，所以更新替换安装目录后，仍然连接原来的服务器，登录方式也不变。
- 如果以后手动安装了内置**不同**连接配置的安装包，程序会询问是否改用。默认保留本机配置；选择改用时会先备份旧副本，重新启动后生效。
- 更新前后会核对 `config.json`、本机连接副本、`~/.agentdesk/remote.json` 和 Bridge 配置的 sha256。只比较哈希，不读取或上传内容；如有不一致，只记录并提示。
- NSIS 打包配置明确写了 `deleteAppDataOnUninstall: false`。CI 的 `windows-upgrade-check` 会先装 vN，写入测试数据，再以 `--updated` 方式覆盖安装 vN+1，然后核对这些数据没有变化、安装目录里没有连接文件。这是在 CI 运行器上完成的检查，**不等于**在主人电脑上实测过。

## 5. 发布与自动推送（主人决定：CI 通过即自动推送）

- **只有推送纯 `vX.Y.Z` 标签**，并且标签与 `package.json` 的 version 一致时，才会构建可推送的包并上传到 VPS2。普通 main 提交、PR、`-win.<sha>` 之类的标签、手动运行的 workflow 都不会上传。
- **风险**：上传用的 SSH 私钥（GitHub secret）或者能推送版本标签的 GitHub 账户一旦泄露，攻击者可能让客户端收到一个能运行的**未签名安装包**。用户点击「重启并更新」后，这个安装包会被执行。以下措施只能降低这个风险，不能消除：
  1. VPS2 上的专用账户使用 `restrict,command="…client-update-intake.js"`，没有 shell、转发或 PTY。
  2. 接收程序只能新增、不能覆盖，版本号必须比已有的都高（已撤回的也算在内）；文件名按固定模式检查，限制大小，逐字节校验 sha512；全部检查通过后才通过一次改名让新版本可见。
  3. 接收程序会通过 GitHub 公开 API 复核：标签存在于官方仓库且指向该 commit；这次运行确实是官方仓库的 `release.yml`，由该标签的推送触发。这能防住「只偷到 SSH 钥匙」，防不住 GitHub 账户本身被盗。
  4. 上传用的 secret 只放在 `vps2-intake` Environment 里。部署规则只允许 `v*.*.*` 标签，按主人决定不设审批人。
  5. 客户端不接受降级，也不接受 prerelease；未签名版本必须手动下载、手动点击安装；对话框会显示 commit 和是否已签名。
  6. 撤回：在 VPS2 的 `client-updates/withdrawn.json` 里加上版本号即可。客户端安装前会重新确认，已撤回的版本不会安装。
- 按设备或平台推送（Q5）：在 VPS2 的 `client-updates/policy.json` 中配置：

```json
{ "hold": { "devices": ["mac"], "platforms": [] },
  "versions": { "0.3.1": { "devices": ["windows"], "platforms": ["win"] } } }
```

  设备名是 Bridge 名（例如 `mac`、`windows`，或登记设备 ID）。

## 6. VPS2 部署（2026-11-23 已执行，实际布局如下）

1. **代码**：`orchestrator/` 中主控用到的文件与 main 一致（`client-updates.js`、`client-update-intake.js`、`update-manifest.js`、`scheduler.js`、`service.js`、`chat-server.js` 等）。按 `docs/DEPLOY.md` 只替换有变化的文件，不运行 `install-ubuntu.sh`（它会改写 systemd 单元和 drop-in）。
2. **存储**：真实目录是 `/var/lib/agentdesk-client-updates`，`/var/lib/agentdesk-orchestrator/client-updates` 是指向它的符号链接，所以主控（`scheduler.js` 默认根目录）和单聊（`chat-server.js` 默认 `STATE_DIR/client-updates`）都不需要改配置。不放在状态目录里面，是因为单元的 `StateDirectoryMode=0700` 每次启动都会把 `/var/lib/agentdesk-orchestrator` 改回 0700，上传账户进不去。权限：

   | 路径 | 属主 | 模式 | 说明 |
   |---|---|---|---|
   | `/var/lib/agentdesk-client-updates/` | `root:agentdesk-update` | `1775` | 粘滞位：上传账户能新建 `latest.json`、`intake.lock`，但删不掉、改不了 root 的文件 |
   | `versions/` | `agentdesk-update` | `0755` | 每个版本一个目录，文件 0644 |
   | `incoming/` | `agentdesk-update` | `0700` | 接收中的临时目录 |
   | `withdrawn.json`、`policy.json` | `root` | `0644` | 只有 root 能改（撤回、灰度），上传账户改不了 |

3. **上传账户**：系统用户 `agentdesk-update`（密码锁定，shell `/bin/sh` 只为执行强制命令）。
   - sshd：`/etc/ssh/sshd_config.d/56-agentdesk-update.conf` 只追加 `AllowUsers agentdesk-update`（AllowUsers 是累加的，root、agentdesk 的设置不变，已用 `sshd -T -C` 核对），并对这个用户设置：只允许公钥、`DisableForwarding`、`PermitTTY no`、`PermitUserRC no`、`ForceCommand`。
   - 钥匙文件：`/etc/ssh/agentdesk-update-authorized-keys`（root 0644，不在用户家目录，用户改不了），一行：
     `restrict,command="/usr/bin/env AGENTDESK_CLIENT_UPDATES=/var/lib/agentdesk-client-updates /opt/agentdesk-node24/bin/node /opt/agentdesk-orchestrator/client-update-intake.js" ssh-ed25519 … agentdesk-ci-upload`
   - 改完 drop-in 要 `sshd -t && systemctl reload ssh` 才生效。
   - CI 用的私钥、`known_hosts`、目标和端口在 VPS2 的 `/root/agentdesk-ci-upload/`（root 0700）。主人填进 GitHub 后可以把私钥 `shred -u` 掉。
4. **GitHub**（主人本人操作）：建 Environment `vps2-intake`。Deployment branches and tags 选 Selected，只加标签规则 `v*.*.*`，不设审批人。在其中配置 secret：

   | secret | 取值（都在 VPS2 `/root/agentdesk-ci-upload/`） |
   |---|---|
   | `VPS2_UPDATE_SSH_KEY` | `vps2_update_ed25519` 的全部内容（私钥） |
   | `VPS2_UPDATE_KNOWN_HOSTS` | `known_hosts` 的全部内容（VPS2 的主机公钥） |
   | `VPS2_UPDATE_TARGET` | `target` 的内容（`agentdesk-update@<VPS2 地址>`） |
   | `VPS2_UPDATE_PORT` | 可选；`port`，现为 22 |

   没配好时，`upload-vps2` 只打 notice 并跳过，产物仍留在 workflow artifacts。
5. **撤回与灰度**：以 root 编辑 `withdrawn.json`（例如 `["0.3.1"]`）或 `policy.json`（格式见 §5）。不需要重启，下一次请求就生效。
6. Mac：独立运行的 Mac Bridge 需要升级到包含 `client_update`、`client_update_read`、`open_tasks` 白名单的版本，否则客户端会提示「服务器或 Mac Bridge 版本过旧」。程序不会自动升级 Bridge。

## 7. 用户步骤

- **首次安装**：手动安装一次 0.3.0 或更高版本。旧版本没有更新功能，必须手动安装。内置连接配置会在这次首次启动时复制到本机。
- **以后升级**：
  1. 打开侧栏「更新」；
  2. 看到「发现新版本」后点「立即下载」（已签名版本会自动下载）；
  3. 下载完成后，等所有任务结束，点「重启并更新」。
  - 有任务运行时按钮不可点，对话框会写明是哪些任务。
  - 未签名的 Mac 版需要手动替换 app。

## 8. 测试分层

| 层级 | 内容 | 位置 |
|---|---|---|
| 单元 / 模拟测试 | 清单校验、semver、回环适配器（真实 HTTP，包括 Range、口令、路径）、超过 20 MB 的分块读取、状态机（伪 electron-updater）、门禁、旧 Worker 和旁证、按钮可用性、连接配置迁移、接收程序和存储、上传流 | `test/updates.test.js`、`test/client-update-server.test.js`、`test/update-packaging.test.js` |
| 真实 Worker（本机进程） | `idleStatus` 和 `shutdownIfIdle`：有命令运行时拒绝退出，结束后才退出 | `test/updates.test.js`（POSIX） |
| CI 打包测试 | `latest*.yml` 与 sha512 一致、blockmap、`app-update.yml`、无连接文件、Windows 覆盖安装后保留数据；用真实 NsisUpdater 经回环适配器下载 vN+1 并测量字节数（仅供参考，失败不阻断） | `.github/workflows/release.yml`（只有推送标签或手动运行时才执行） |
| 真实设备端到端 | **未做**：需要 VPS2 部署、两个正式版本和主人的电脑 | — |

## 9. 已知限制

- **差分效果**：没有在真实设备上实测。
  - Windows：首次更新能否差分，取决于安装器是否把自己缓存到更新器的缓存目录，CI 会输出这一项。
  - macOS：首次自动更新一定是完整下载（还没有缓存的 `update.zip`）。
  - 下载中断后不会续传，只会复用已经完整下载并校验通过的文件。
  - 速度受 SSH 控制通道往返次数限制，尚未测量。
- **macOS**：没有 Developer ID 签名就无法由更新器安装，签名需要付费账号。Mac 上 Squirrel 安装和退出的配合也只在代码层面处理过，没有在真机上验证。
- **Mac 构建只有 arm64**：CI 只构建 arm64 版（macos-latest），Intel Mac 收不到更新。
- **Worker 与安装器**：NSIS 在 `--updated` 模式下会不会结束同名进程，没有在真实设备上验证。门禁要求安装前 Worker 已经不存在，以此规避这个问题。
- **换服务器地址**：不能通过更新更换服务器地址，需要手动安装新的内置连接构建，或者修改 `remote.json`。
- **不再读取的配置**：旧的 `update.enabled` 和 `update.feedUrl` 设置不再读取。

## 10. Bridge 后续自动更新建议

- Mac Bridge 是独立组件，本阶段不会自动重启、覆盖或升级它。
- 建议沿用这套方案：VPS2 的版本目录中增加 Bridge 产物；Bridge 提供只读的 `bridge_info`（版本、协议号）和 `idleStatus`；升级前同样两次确认空闲；由用户在客户端里点击发起，并且只在 launchd 能够重启 Bridge 时进行。
- 在实现之前，客户端只会显示「Bridge 版本过旧」。
