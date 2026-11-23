# 部署记录

每次部署一条，最新的在最上面。只写版本、做了什么、怎样验证、怎样回滚；不写 IP、令牌和密钥。

## 2026-11-23 16:30（北京时间）· 客户端 0.2.10 · 修复项目和单聊删除

- **事故**：03:14（UTC）Mac 上删除项目「ai」时，VPS 步骤把共用的 Codex 工作目录 `/var/lib/agentdesk-orchestrator/desktop-workspace` 整个删除（项目没有单独的远程目录，代码回落到共用目录）。`codex-desktop.sh` 以 `set -eu` 进入该目录，所以之后 Codex 无法启动。本机步骤要删除整个 `~/Desktop`，被 macOS 权限拦下，桌面文件未受影响；之后每次重试都卡在同一处。已在 VPS2 以 agentdesk 属主重建该空目录。
- **修复**：
  - 项目绑定的是个人文件夹（家目录下的直接子目录，或桌面、文稿、下载等）时，只解除绑定，文件全部保留；只删除没有任何提交的空 `.git`。
  - VPS 共用工作区不再整体删除；没有其他项目在用时清空其内容，目录本身保留。只有项目单独绑定的远程目录才整个删除。旧的半途删除计划里记录的共用目录会被忽略，重试可以继续完成。
  - 单聊右键新增「删除…」：原生确认窗口说明范围，先删 VPS 上的会话记录和 CLI 会话文件，再删本机的撤销存档、命令记录和独立工作树。
  - 删除失败改为弹窗显示原因，并写入审计日志。
- **VPS2**：主控代码无变化，未重启。
- **验证**：`npm test` 528 项，522 通过，6 项环境跳过，0 失败；新增个人文件夹保留与空 `.git` 删除的测试。

## 2026-11-23 11:02（北京时间）· 项目删除联动清理

- 删除项目改为检查两端数据范围、显示原生确认窗口，再清理本机目录和 `.git`、关联工作树、会话、附件、命令与终端、撤销存档，以及 VPS 的任务、日志、上传与 CLI 会话数据。GitHub 仓库按用户选择保留。共享 Git 缓存清理本项目的工作树与分支，独占的托管副本整库删除。
- 清理计划先持久化，任一步失败保留项目入口并支持重试。设备和服务端保留删除标记，防止旧会话与群聊缓存重新出现。远程目录共享、授权目录变化、单聊仍在执行及未确认的本机写入会显示具体错误。删除确认窗口列明实际目录和记录数量。
- VPS2 在维护模式排空后更新相关运行文件，服务重启并确认控制 socket 就绪后退出维护。最终增量更新的回退文件在 `/root/backups/agentdesk-project-delete-20261123-030146`，此前整批更新备份在 `/root/backups/agentdesk-project-delete-20261123-024527`。配置、登录凭据与 systemd 单元沿用既有设置。
- Mac 后台 Bridge 同步完整 JS 运行文件，Apple Silicon 应用重新打包安装，安装与测试构建的 app.asar 哈希一致。核对旧 Worker 没有子进程与未结束命令后退休，后续由新版按需启动。
- 自动测试共 519 项，513 通过、6 项环境跳过、0 失败。新测试覆盖真实 Git 和关联工作树清理、共享项目隔离、取消、失败重试、分页、会话索引和模型记录清理，以及真实 Bridge 控制通道的两端删除流程。
- 打包版验证 zsh/bash 输出、接管、中断、调整大小、重连和项目删除后的终端及租约清理。真实窗口使用独立配置和临时项目核对两端删除范围，取消后文件、`.git` 和注册记录均存在。现网 Bridge 的预览接口通过。Codex 的真实 CLI 在全新临时配置中完成初始化、列表查询和不存在会话的删除，未调用模型。
- 本次实际删除仅针对测试数据。Windows 安装由对应设备后续更新应用，跨平台逻辑由 CI 验证。

## 2026-11-23 10:00（北京时间）· Mac 新版合并、部署与实测

- 合入主线 `ba56ac9`，合并提交 `8320835`。解决 `main.js` 的更新状态检查冲突，保留此前 Grok 直连回复修复和右侧浅色终端。
- VPS2 运行目录的 80 个 `orchestrator/*.js` 与本次源码逐字节对应，服务 active、NRestarts=0，维护关闭且无运行中任务。本次更新部署 Mac 后台 Bridge 和 Apple Silicon 应用，Bridge 为 running，安装包与测试构建的 app.asar 哈希一致。
- 自动测试共 505 项，499 通过、6 项环境跳过、0 失败。打包版真实 zsh/bash 输出、AI 输入、人工接管、Ctrl+C、调整大小和重连恢复通过。
- 打包版真实界面完成 Grok 问答卡渲染、未回答提交阻止、选择提交及模型继续回复，Codex 的只读规划提问也完成同样往返。完全访问开关与下拉同步，右侧终端为浅色，更新弹窗经 Mac Bridge 查询成功，无页面异常。
- 真实群聊控制通道提交 Codex 只读对话并收到预期回复，任务 completed。该检查覆盖成员对话调度，不包含多成员改文件、补丁应用及验收全流程。
- 首次界面测试在项目初始化完成前选会话，实际落在 Codex，工具请求未成功。纠正测试等待条件并校验实际成员后，两家提问往返通过。
- 修正打包界面自测的配置隔离，启动和失败诊断均显式指定临时 user-data-dir，避免 macOS 忽略 HOME 而写入用户配置。清理本次生成的 CI 测试项目并恢复原项目选择。
- Claude 登录验证按用户要求延后。本次没有重测 Antigravity 真实对话。生产更新存储暂无版本，下载、差分更新和安装流程本次仅由自动测试覆盖。
- 回退可从原 `bf276db` 重新构建。替换应用时保留旧应用备份及设备配置、聊天数据。

## 2026-11-23 09:20（北京时间）· VPS2 · 客户端更新服务上线（main `837e328`）

- **源码**：`main` 上的 `837e328`（单聊问答卡合并，包含 `feat/safe-differential-updates-20261122` 的客户端更新服务端）。部署前的运行树是 06:22 那次部署的结果：`a4f24cc` 的服务端文件，已经有 `client-updates.js`、`client-update-intake.js`、`update-manifest.js`、`worker-idle.js` 以及 `client_update`、`client_update_read`、`open_tasks`，但没有存储、上传账户和强制命令。那次部署没有写进本日志；部署前核对过，运行树与它的 `runtime-after.sha256` 完全一致。
- **代码**：
  - 进维护模式，确认 `running=[]`、`queued=0`、`ready=true`，并且没有 CLI 子进程；
  - 用 `install -m 0644` 替换 5 个文件：`ask-user.js`（新增）、`chat-mcp.js`、`chat-server.js`、`windows-native-desktop.js`、`windows-native-seat.js`；逐个 `node --check`，装完 `cmp` 一致，以 agentdesk 用户试加载；
  - 09:21:04 重启 `agentdesk-orchestrator`，09:21:21 退出维护。

  现在主控用到的全部文件与 `837e328` 的 `orchestrator/` 一致。**没有运行 `install-ubuntu.sh`**，也没有改 systemd 单元、drop-in、`config.json`、nginx 或防火墙。
- **发布通道**（布局见 [AUTO-UPDATE.md](AUTO-UPDATE.md) §6）：
  - 存储 `/var/lib/agentdesk-client-updates`，加上状态目录里的符号链接 `client-updates`；
  - 系统用户 `agentdesk-update`；
  - `sshd_config.d/56-agentdesk-update.conf`（只追加 AllowUsers 和这个用户的限制）；
  - `/etc/ssh/agentdesk-update-authorized-keys`（`restrict` + 强制命令）；
  - CI 钥匙放在 root 专用目录。

  `sshd -t` 通过；`sshd -T` 显示除 AllowUsers 多了一项外，全局设置与部署前逐项一致。**sshd 还没有 reload**（本次会话的权限设置不允许执行），所以上传账户还没生效，需要主人执行 `systemctl reload ssh`。
- **验证**：
  - `npm test`（`node --test`）：505 项，499 通过，0 失败，6 跳过；
  - 部署后服务 active，NRestarts=0，没有 warning 及以上的日志，监听端口与部署前一致；
  - `doctor`：codex、claude、grok、antigravity 均 ok，`anyLead=true`，`blocked={}`；
  - 任务状态计数与部署前一致。
- **验收**（隔离目录 `/var/tmp/adcu-accept-20261123`，测试版本 0.9.x，生产存储里没有任何版本）：
  - 接收：真实强制命令程序以 `agentdesk-update` 运行，拒绝 14 种非法上传，不留残留；`receive()`（GitHub 复核用替身）通过 14 项，包括版本只增不改、并发锁，以及上传账户改不了撤回和灰度文件；真实 GitHub API 复核拒绝了「标签与提交不符」「run 不是这个标签触发的」「标签不存在」三种情况；
  - 分发：以 agentdesk 运行，配合客户端真实的回环适配器，25 项全部通过，包括 25 MB 安装包按 128 KiB 分块下载且 sha512 一致、Range 差分拼装、撤回、按设备灰度和暂停、文件被改动后拒绝提供；
  - 现网：经运行中主控的 admin socket，9 项全部通过；
  - 旧客户端兼容：claude、grok、antigravity 三家单聊服务，12 项全部通过。
- **顺带修复**（客户端，下个正式版本生效）：`update-transport.js` 在下载时每次等待背压都会加一个 `close` 监听且不移除，大文件会触发 `MaxListenersExceededWarning`。已修复并加回归测试。
- **没有验证**：
  - 经真实 SSH 的上传（要等 reload）；
  - GitHub Actions 到 VPS2 的实际上传（要等 secret 和第一个正式标签）；
  - GitHub runner 能否连到 VPS2 的 22 端口（本次会话无权读取防火墙规则）；
  - 真实 electron-updater 的 blockmap 差分；
  - 真实电脑上的下载和安装；
  - Mac Bridge 白名单。
- **回滚**：VPS2 上 `/root/backups/agentdesk-clientupdate-deploy-20261123-092044CST/rollback.sh code|channel|all`。`code` 恢复 5 个文件并重启，`channel` 拆除上传通道。

## 2026-11-22 · Mac 本机 · 合并新版并部署验收

- **源码**：主线 `bd24c0e` 合入 `codex/terminal-workspace-panel`，运行代码提交 `5daced7`；保留右侧“检查工作区 → 终端”及跟随主题的浅色配色。
- **部署**：重新构建 Apple Silicon 的 0.2.9 应用，替换本机用户 Applications 中的 AgentDesk；同步后台 Bridge 的 `orchestrator/*.js`，重启后状态为 running。保留连接配置、项目与聊天数据。按用户此前要求删除替换下来的旧应用副本。
- **验证**：
  - Node 测试共 436 项：430 通过、6 项条件跳过、0 失败。
  - 打包应用真实 zsh/bash：输出、AI 写入、接管、Ctrl+C、调整大小、重连恢复均通过。
  - 隔离测试配置下的打包窗口：xterm 渲染、添加附件成功提示、群聊项目登记后添加附件、未处理失败提示均通过。该检查调用窗口及主进程接口，不调用模型。
  - 包内 153 个源码文件与工作树逐字节一致；已安装应用与构建产物的 app.asar 哈希一致；后台 Bridge 的全部 JS 文件匹配源码。
  - 已安装应用实际窗口确认 Codex SSH 已连接，右侧浅色终端页签正常。
- **VPS2**：只读检查，未修改或重启。主控及 home-mount 为 active；chat-server、permission-prompt、windows-native-seat 与本次源码哈希相同；部署前无 running/applying/testing 任务。
- **未覆盖**：四家真实模型问权限、子代理、群聊端到端任务及真实 git push 验收；单聊 v2 未在本次启用。
- **回退**：可从此前 `db3c273` 构建上一版本；安装时保留现有设备配置和聊天数据。

## 2026-11-22 18:00 后（北京时间）· 客户端 · 添加附件的成功提示

- **问题**：「添加附件成功的提示在本机部署上没看到」。在 Claude/Grok/Antigravity 单聊、原生（provider-direct）单聊、群聊里，选择、拖入、粘贴附件成功后都没有任何提示，只有出错和打包文件夹时才有。在 v1 服务端上（没有上传回执，directChatV2 未开）就完全看不到反馈。
- **修复**（只改客户端：`src/attach-notice.js` 新增，并修改 `live.js`、`provider-direct.js`、`orchestrator.js`、`index.html`）：
  - 添加成功就提示，例如“已添加 N 个附件（先存在本机，发送消息时一起上传）”；群聊是“发送任务时一起交给组长和成员”；服务端确认会立即上传时（v2）提示“正在上传”；
  - 服务端回执到达时提示“附件已上传，服务器已校验”；
  - 消息或任务发送成功后提示“N 个附件已随消息发送 / 随任务提交”。
- **VPS2**：没有改动，也没有重新部署（服务端不需要变化）。
- **验证**：单元测试，加上打包后应用窗口里的检查（CI 的 Terminal packaging check）。主人本机装上新的安装包后才能看到。

## 2026-11-22 17:40（北京时间）· VPS2 · 上线 2026-11-22（权限统一）

- **源码**：`main` 上的 `531b33f`，内容是 `f6d3e96` 权限统一、`45045c0` 和 `0fb7f60` 文档，加上本次 Antigravity 的改动。部署前运行树是 `80fbb2d`（群聊 v7 审计版）。
- **做法**：
  - 备份运行树、配置、单元文件和 drop-in；
  - 进维护模式；
  - 用 `install -m 0644` 只替换有变化的 `orchestrator/*.js`，共 11 个：adapters、chat-server、group-features、group-local、permission-prompt（新增）、platform-mac、scheduler、terminal-sessions、windows-native-seat、windows-project-leases、windows；装完逐字节核对一致；
  - 重启 `agentdesk-orchestrator`，然后退出维护模式。

  **没有运行 `install-ubuntu.sh`**：现网的 `agentdesk-home-mount.service` 有 drop-in，单元文件与仓库一致，`agent-chat.sh` 也没变，所以不覆盖单元、不 daemon-reload。
- **配置**：没有改。核对过 [ROLLOUT-2026-11-22.md](ROLLOUT-2026-11-22.md) §2.3 和 [UPDATE-DIRECTION.md](UPDATE-DIRECTION.md) §3 要求的各项：
  - `adapters.{claude,grok,antigravity}.sandbox` 已配置；
  - `groupFeatures` 中 `anyLead`、`localStages`、`localCopy`、`credentialSandbox`、`envFix` 都是 true（14 项全开）；
  - `routing.implement` Codex 排第一；
  - `homeMounts` 为 true，`discoverModels` 为 true；
  - `adapters.claude.models` 已列出。
- **Antigravity（ROLLOUT §5）**：
  - `execute_url` 在原生单聊（`chat-server.js`）和群聊（`adapters.js`）里都从 deny 移到了 allow；
  - 权限说明改为四家同名；
  - 子代理**没有加**：`agy --help`（1.5.14）里没有子代理或浏览器子代理工具的权限名，按文档“不要猜”跳过。
- **验证**：
  - `npm test`：427 项，`# fail 0`（Node 24 和 Node 22）；
  - 部署后服务 active，NRestarts=0；home-mount 为 active；17:40 以来没有 warning 及以上的日志；监听端口与部署前一致；配置 sha256 不变；
  - `ad doctor`：ok，codex、claude、grok、antigravity 均可用，`anyLead: true`；
  - 用已安装的代码和一个替身 CLI 核对：Antigravity 群聊步骤的 `--settings` 里 `execute_url(*)` 在 allow 中；两段权限说明都写明四家；
  - 原生单聊服务（antigravity、claude）用临时状态目录完成 initialize；
  - directChatV2 没有打开（没有 `devices.json`）。
- **主人决定**（原文「1按最新的来，2没有其他解决办法算了，3vps和软件部署好，本机我来」）：Mac 群聊命令只挡 AgentDesk 密钥目录；Antigravity 子代理跳过；VPS2 和安装包到此部署好，本机安装和验收由主人做。
- **没有验证**：ROLLOUT §6 的每台电脑验收（四家单聊问权限、`git push`、`ls ~/.agentdesk` 被拒、子代理、Mac 群聊 `git push`）要在用户的 Mac/Windows 上、装上新客户端后进行，本次没有做。原生单聊里已经打开的会话要关掉重开，才会用新权限。
- **回滚**：VPS2 上 `/root/backups/agentdesk-deploy-rollout-20261122-174040CST/ROLLBACK.md`（恢复运行树 tgz，然后重启）。
