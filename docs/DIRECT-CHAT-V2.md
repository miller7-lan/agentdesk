# 单聊 v2（Direct Chat v2）：实现说明、部署与门禁

本文对应已审阅的《单聊重构方案规范 v4》（D1–D17、Q1–Q8、N1）。客户端接口见 [DIRECT-CHAT-V2-API.md](DIRECT-CHAT-V2-API.md)。

状态标注：**已实现**指代码和自动化测试都在本分支里；**需真机验收**指还没在 Mac/Windows 真机上走通；**门禁**指要等主人另行确认才能做的线上动作。

## 1. 开关与兼容

- **按设备开启**：`ad device v2 <deviceId> on|off` 修改设备登记表里的 `directChatV2` 字段。默认关闭。
- **v1 不受影响**：
  - 没有 `AGENTDESK_DEVICE` 的旧 key 照旧工作；
  - 已登记但未开 v2 的设备，仍用旧的 `chat-<provider>[-<tag>].json`。
- **旧客户端**：设备开了 v2 之后，不发 `device` 字段的旧客户端会收到 `UPGRADE_REQUIRED`。所以要先更新这台设备的客户端，再打开开关。
- **部署顺序**：先 VPS2，再测试设备，最后其余设备；全部设备切换之前一直保留 v1。

## 2. 七条需求的落点

| # | 需求 | 实现位置 | 状态 |
|---|---|---|---|
| 1 | 区分 Mac/Win，进入不同工作区 | `device-registry.js`、`chat-server.js`（身份、DEVICE_MISMATCH、每设备 SQLite）、`device-identity.js`（客户端 hello） | 已实现；key 行需 G1 |
| 2 | 多 writer、多 agent | `windows-project-leases.js`（共享写）、`file-locks.js`、`sftp-project-write.js`、`seat-slots.js` | 已实现；需真机验收 |
| 3 | 接近原生 CLI、远程终端 | 原生 seat（上游已有）+ `terminal-sessions.js`（node-pty）+ `local_shell` | 终端代码已实现；node-pty 需 G2 |
| 4 | 权限不够再用 MCP | `windows-native-desktop.js` 的 D14 回退 + `agentdesk/fallback` 提示 | 已实现 |
| 5 | 额度和 CLI 更新实时 | `status-hub.js`、`status/read`、`status/subscribe`、`status_snapshot`、`cli-upgrade.js` | 已实现；升级执行器需 G3 |
| 6 | 选仓库、自动建库、直接改本地 | `app-config.js` 的 `initializeWorkspace`（D7、Q3、Q4） | 已实现 |
| 7 | 附件上传成功要显示 | chat-server `attachment/begin\|chunk\|commit\|abort\|list`；`main.js` 和 `live.js` 选中即上传，回执后才显示成功 | 已实现；需真机验收 |

## 3. 设备登记（D6、Q7、N1）

登记表 `/etc/agentdesk-orchestrator/devices.json` 只放非敏感字段：deviceId、platform、label、key 指纹、state、directChatV2、bridges，以及最近 200 条变更记录。命令以 root 运行：

```sh
AD='/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/admin.js -'
$AD device list
$AD device approve <deviceId> --platform darwin|win32 --label <名称> --pubkey '<公钥>' \
   [--channels chat-claude,chat-grok,chat-antigravity,codex,bridge,seat] [--bridge mac|windows] [--legacy-tag default|windows|lenovo_actjm6t3]
$AD device v2 <deviceId> on|off
$AD device rename <deviceId> <名称>
$AD device revoke <deviceId>
```

- **approve 和 revoke 只改登记表**，然后打印建议写入的 key 行或需要删除的 key 指纹，**不读写任何 SSH 授权文件，也不重载 sshd**（N1，测试 A17）。
- **手动写入 key 行**：管理员先在 `/root/backups/` 做带北京时间戳的备份，再手动写入。这一步属于门禁 **G1**。
- **`--legacy-tag`**：首次开启 v2 时，把这台设备的旧单聊会话复制进它自己的 SQLite（只复制，原文件不动）。Mac 填 `default`，现有 Windows 填 `windows`；`lenovo_actjm6t3` 作为独立设备登记（D16）。
- **立即生效**：revoke 之后，服务端在下一个请求就拒绝该设备，不依赖 key 行是否已删。

## 4. 每台设备的数据（D17）

```
/var/lib/agentdesk-orchestrator/direct-chat/<deviceId>/
  state.sqlite          sessions / attachments / audit（只存元数据，保留 60 天）/ migrations
  threads/<threadId>/   会话的 VPS 工作目录
  attachments/<threadId>/
  codex-workspace/      D13：这台设备重建的 Codex 工作区
  runtime/              Antigravity 每一轮的 MCP 配置
/var/lib/agentdesk-orchestrator/direct-chat/slots/   并发名额（全机共用）
```

服务端只存项目路径的 hash（`projectHash`），客户端每一轮都把路径带上来，服务端核对 hash 一致后才使用。

## 5. 多 writer 与文件锁（D1、D2、Q1、Q2）

- **共享写**：默认允许多个会话同时写同一项目；会话可以要求独占（`exclusive`）。
- **锁的位置**：每台设备一个锁管理器，放在本机 Worker 里。本机 SFTP 的所有写操作都先拿锁，包括打开写、写入、截断、改属性、重命名（源和目标都锁）、删除和建删目录。
- **等待**：最多等 120 秒，超时返回可重试的错误，并写明正在等谁（Q1）。
- **持有**：从第一次写开始，到最后一次写后空闲 30 秒或本轮结束，取先到者，最长 10 分钟（Q2）。
- **陈旧写拒绝**：拿到锁后，如果文件在这个会话读过之后被改过，拒绝写入并要求重读（`lock.staleWriteRejected`）。
- **无法强制的路径**：local_shell、终端、IDE 和网盘写盘时不经过锁，只能用 fs.watch 检测并发 `lock.bypassed`（A11），不是保证。模型可以用 `file_lock_acquire` 主动登记要改的文件。
- **检查点**（D8）：每个写入轮次开始前写一个 `refs/agentdesk/checkpoints/<会话>/<轮次>`，不改工作区、暂存区或分支；保留 50 个或 14 天。别人持锁时拒绝回退。
- **MCP 工具**：主进程的 `agentdesk_file_*` 写入还**没有**接入 Worker 锁，只受原有的读后版本检查保护。这是剩余工作，见 §11。

## 6. 并发上限（D15、Q6）

- **计数**：按“有 CLI 进程或挂载在运行的会话”计算；终端不计入。
- **上限**：全机 6 个、每台设备 4 个；超出时排队，客户端收到 `turn/queued {position}` 或 `agentdesk/seatQueued`。
- **适用范围**：v2 单聊按每一轮计数；原生 seat 只有在启动器传入 `AGENTDESK_SEAT_LIMITS=on` 时才计数（P7 启动器会传），旧启动方式不变。

## 7. 仓库选择与初始化（D7、Q3、Q4）

- **仓库根目录**：直接使用，不写 git。
- **子目录**：使用父仓库，项目记录 `workdir`。
- **全新空目录**（一个条目都没有）：执行 `git init`、写 `.gitignore`、`git add .gitignore`；有用户自己的 Git 身份时才提交“初始化仓库（AgentDesk）”。
- **已有任何条目的目录**（包括只有 `.DS_Store`、`Thumbs.db`、`desktop.ini`）：只执行 `git init`。
- **缺 Git 身份**：不提交，不写任何 gitconfig，不以 AgentDesk 名义提交。界面提示后可以点“补做首个提交”。
- **拒绝**：`.git` 损坏、磁盘根目录、用户主目录、系统目录。

## 8. 附件（D9、D10）

- **上传**：选中后，如果会话已存在就立即上传；新会话在发送时先上传，再开始这一轮。
- **成功的依据**：只有 `attachment/commit` 的回执（大小和 sha256 都一致、已落盘、已绑定设备和会话）。
- **界面状态**：附件标签依次显示“仅在本机，未上传”→“上传中 n%”→“✓ 已上传（服务器已校验）”，失败显示“上传失败，发送时会重试”。
- **存放与清理**：附件放在 VPS 上这台设备、这个会话的目录里，不复制进本机项目，7 天后过期。
- **续传**：断线后用 `attachment/list` 查 `nextOffset` 继续上传。

## 9. 状态与 CLI 升级（D11、D12、Q5）

- **状态字段**：每项都带 source、observedAt、receivedAt、freshness（fresh/stale/unknown/error）、estimated、unofficial。读不到时是 unknown，不会显示 0%。Claude 的 OAuth usage 标为 unofficial。
- **读取入口**：
  - 单聊：`status/read`、`status/subscribe`，之后推送 `status/updated`，每轮结束时也会推送；
  - 主控：`status_snapshot`，返回额度、可用性和升级状态。
- **升级流程**：
  1. 已登记设备经自己的 Bridge 调用 `cli_upgrade {provider}`（Q5）；
  2. 只能升到 latest，同一 provider 的重复请求会合并；
  3. 请求写入 `/var/lib/agentdesk-orchestrator/cli-upgrade/requests/`；
  4. 执行器 `node cli-upgrade.js run-pending` 必须以 root 运行，并与每日定时任务共用 `/run/agentdesk-cli-update.lock`。它会写升级标记，让新的单聊轮次排队、运行中的轮次照常跑完；然后备份（npm 包目录或二进制）、运行官方 update、检查 `--version` 和 doctor（不调用模型），失败就恢复备份。每一步都写入 `results/<id>.json`，事件包括 `cli.upgrade.*`。
- **门禁 G3**：执行器的 root 单元**没有安装**，所以现在升级请求只会排队，`runnerInstalled: false`。

## 10. 窄启动器（D5、P7）

- **作用**：`agentdesk-seat.js` 只接受 `agentdesk-seat <provider> <read|write> <64 位十六进制会话键>`，并且设备必须已批准、平台一致；它只启动 `unshare` 和 `native-project-session-host.js`，环境变量最小化。
- **登记表**：可以打印 `seat` 通道的 root key 行，但默认不打印。
- **门禁 G4**：客户端仍走原来的 `command/exec` 通道；root 的 `codex app-server` key **没有动**。切换步骤：
  1. 只读核对两把 root key 分别属于哪台设备；
  2. 确认有备用登录；
  3. 备份 key 文件；
  4. 新增 seat 行，与旧通道并行；
  5. 客户端改用 SSH seat 传输（这部分代码**尚未实现**）；
  6. 测试设备通过 A9；
  7. 逐把撤掉旧 key，每撤一把都验证一次。

## 11. 尚未完成或需要确认

- **G1**：手动写入设备 key 行。完成之前所有设备都还是 v1。
- **G2**：node-pty。候选版本是 npm 上 Microsoft 发布的 `node-pty` 1.1.0（2025-12-22，仓库 microsoft/node-pty）；与 Electron 45 的兼容性、预编译包和签名尚未核实。为保持 `package-lock.json` 一致、不让 `npm ci` 失败，现在没有写进 `package.json`。确认后用 `npm install node-pty@<版本>` 更新 lock，再构建。没有 node-pty 时终端能力自动关闭，`capabilities.pty=false`。
- **Windows 的 AgentDesk 密钥目录保护**（D3）：Mac 已用 sandbox-exec；Windows 同等保护（受限令牌或 ACL）**尚未实现**，需要在 P4 实测后决定方案，必要时用原生扩展（受 G2 约束）。
- **G3**：CLI 升级执行器的 root 单元。
- **G4**：窄启动器上线，以及客户端 SSH seat 传输。
- **MCP 文件工具接入 Worker 文件锁**：主进程的 `agentdesk_file_*` 还没调用 Worker 的 `lockFiles`。
- **终端界面**：Worker 已有 `terminalRead`、`terminalTakeover`、`terminalInput`；xterm 视图还没有做进前端。
- **真机验收**：A1、A3（挂载隔离）、A10、A12、A13 需要在 Mac 和 Windows 测试设备上走一遍。

## 12. 部署（VPS2）与回滚

1. 按 [DEPLOY.md](DEPLOY.md) §1 操作：先备份运行树和配置；确认没有进行中的任务、单聊轮次、命令或终端；`ad maintenance on`；运行 `install-ubuntu.sh`（不覆盖 config.json）；重启 `agentdesk-orchestrator`；`ad doctor`；`ad maintenance off`。
2. 单聊服务由 SSH 按会话拉起，不需要重启；新连接自动使用新代码。
3. 部署后不要开任何设备的 v2，直到 G1 完成、该设备的客户端也已更新。
4. 回滚：恢复运行树备份并重启服务。登记表、`direct-chat/` 和旧的 `chat-*.json` 都保留；旧的 `desktop-workspace/`、`lab6/` 从未被改动。

## 13. 自动化测试与验收对应

| 验收 | 测试 |
|---|---|
| A2、A3、A7、A15、A16、v1 兼容、Q5 排队 | `test/direct-chat-v2.test.js` |
| A15、A17 | `test/device-registry.test.js` |
| A4、A5、A11、Q1、Q2、共享租约 | `test/file-locks.test.js` |
| A6、A6b、A6c、D7 | `test/workspace-init.test.js` |
| A10（假 pty）、D8、A16 名额、状态语义 | `test/direct-chat-local.test.js` |
| A14（执行器逻辑） | `test/cli-upgrade.test.js` |
| A9（启动器逻辑） | `test/agentdesk-seat.test.js` |
| D14 | `test/windows-native-desktop.test.js` |
