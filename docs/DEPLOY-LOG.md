# 部署记录

每次部署一条，最新的在最上面。只写版本、做了什么、怎样验证、怎样回滚；不写 IP、令牌和密钥。

## 2026-11-24 02:40（北京时间）· VPS2 · 微信办公助手删除企业微信通道，只保留个人微信 ClawBot

- **改动**：删除企业微信智能机器人通道（`bot.js`、`wechat.env.example`、`@wecom/aibot-node-sdk` 依赖、对应测试；文件校验测试移到 `test/wechat-deliver.test.js`）；`service.js` 只用 ClawBot；unit 去掉 `EnvironmentFile`。文档改为只描述 ClawBot。
- **VPS2**：删除 `/etc/agentdesk-orchestrator/wechat.env`（企业微信 Bot ID / Secret）和 `wechat.json` 的旧备份；`wechat.json` 去掉 `channel` 和企业微信 userid；`/opt/agentdesk-orchestrator/wechat/` 重新部署（`node_modules` 只剩 `qrcode-terminal`）；重启 `agentdesk-wechat`，日志 `ilink connected`，白名单 1 人（扫码人）。企业微信后台的 AgentDesk 机器人需管理员自行删除或停用。
- **验证**：微信相关测试 39 项全部通过。
- **回滚**：git 回到 df4dd89 重新部署；企业微信机器人需在后台重新获取 Secret。

## 2026-11-24 02:30（北京时间）· VPS2 · 微信办公助手改为个人微信 ClawBot + 引导式流程，合并到 main

- **通道**：新增 `ilink.js`（个人微信 ClawBot，腾讯 iLink 协议，对齐官方插件 2.4.10）并设为默认；`login.js` 终端扫码登录，扫码人自动为管理员。企业微信智能机器人通道（`bot.js`）保留，`wechat.json` 的 `channel` 切换。用户已扫码，服务已连上。
- **流程**：引导式——需求/文件 → 回 1/2/3 选档（回错重提示）→ 收集 →「开始」组长出方案（附预计用时）→ 改方案可多轮 →「完成」执行交付；执行超出预计 1.5 倍提醒一次。命令统一为「/」紧跟数字或词：`/0` 帮助、`/1` 历史、`/2` 取消、`/3问题`、`/进12`、`/看12`、`/停12`、`/重试12`、`/重发12`。
- **VPS2**：替换 `/opt/agentdesk-orchestrator/wechat/*.js`，`npm ci` 增加 `qrcode-terminal`；unit 的 `EnvironmentFile` 改为可选；`wechat.json` 设 `channel: "ilink"`，保留临时 `tiers.planner = codex`（Claude 登录过期）。重启 `agentdesk-wechat`；主控未动。
- **验证**：`npm test` 590 项，583 通过，7 跳过，0 失败（微信相关 45 项，含假 iLink 服务的收发与 AES 往返）。
- **回滚**：`wechat.json` 改 `channel: "wecom"` 并重启，或按上一条整体回滚。

## 2026-11-24 01:40（北京时间）· VPS2 · 微信办公助手（企业微信智能机器人长连接）预部署

- **改动**：新增独立服务 `agentdesk-wechat`（分支 `feat/wechat-lite`，`orchestrator/wechat/`）。通道为企业微信智能机器人 API 模式长连接，官方 SDK `@wecom/aibot-node-sdk` 1.0.7；取代当天早些时候的自建应用 HTTP 回调方案（`wecom.js`、`probe.js` 已删除）。草稿 +「开始」、三档执行、额度闸门（剩余低于 8% 不开工）、白名单与限流、按 userid 隔离、docx/pptx/xlsx 校验后上传并主动推送给任务所有者、失败重试与 `/重发`。
- **VPS2**：
  - 办公工具链：apt 装 LibreOffice（writer/calc/impress）、pandoc、fonts-noto-cjk；`/opt/agentdesk-office/{venv,bin,GUIDE.md}`（`install-office.sh`）。
  - 代码：`/opt/agentdesk-orchestrator/wechat/`（含 `node_modules`，`npm ci --omit=dev --ignore-scripts`）。
  - 配置：`/etc/agentdesk-orchestrator/wechat.env`（Bot ID / Secret，root:agentdesk 0640，**尚未填写**）、`wechat.json`（`allowUsers` 为空）。
  - systemd：`/etc/systemd/system/agentdesk-wechat.service` 已安装，**未启用、未启动**。
  - Caddy：早些时候为 HTTP 回调加的 `/wecom/*` 路由已撤回，恢复原配置（备份 `Caddyfile.bak-20261123-161719-wecom`），重启 Caddy 两次，各断约 1 秒。
  - 主控 `agentdesk-orchestrator`、enrollment：未改动、未重启。
- **验证**：`npm test` 581 项，574 通过，7 跳过，0 失败（微信相关 36 项）。用假凭据启动服务：VPS2 能连上长连接，官方返回 853000 认证失败，日志与重连行为正确。真实 CLI 端到端：低档（组长临时换 Codex，因 Claude 登录过期）把 40 行销售明细做成带公式、柱状图、排名的 xlsx，约 8.6 分钟。
- **待办**：填写机器人凭据后启用服务并做手机端实测；Claude 在 `homes/claude` 的登录已过期（11-22），需管理员重新登录（主控群聊和单聊同样受影响）。
- **回滚**：`systemctl disable --now agentdesk-wechat`，删除 `/etc/systemd/system/agentdesk-wechat.service`、`/opt/agentdesk-orchestrator/wechat/`、`/etc/agentdesk-orchestrator/wechat.{env,json}`；工具链可保留或 `apt remove` 并删除 `/opt/agentdesk-office`。

## 2026-11-23 23:10（北京时间）· 客户端 0.4.1 · 更新下载先走 VPS1、失败退回 VPS2

- **改动**：Windows Bridge 处理 `client_update` / `client_update_read` 时先走 Relay（VPS1），Relay 不在线或读取出错时同一请求改走直连 SSH（VPS2），并在 1 分钟内跳过 Relay；线路状态每 5 秒查一次，不再每块都查；单块超时 10 秒改 30 秒；客户端并发读取 4 块改 8 块。
- **背景**：Lenovo 0.3.10 → 0.4.0 下载约 28–70 KB/s，Mac 29 秒完成；每块读取前多一次线路查询，往返翻倍。
- **测试目的**：Lenovo 已在 22:53 自动安装 0.4.0（`update_install installed`），这是第一次验证 Windows 自动检查、自动后台下载。0.4.0 → 0.4.1 仍按 0.4.0 的方式（直连）下载。
- **VPS2**：无改动（主控按 `relay:<名字>` 识别设备，原本就接受经 Relay 的更新读取）。
- **验证**：`npm test` 543 项，536 通过，7 项跳过，0 失败。

## 2026-11-23 22:45（北京时间）· VPS2 · 单聊沙箱偶发「bwrap: Can't bind mount /oldroot/」、Antigravity 全部模型

- **问题**：Antigravity / Claude / Grok 单聊偶发「本轮失败：bwrap: Can't bind mount /oldroot/ on /newroot/ … remount "/newroot/srv/claude-shared/.claude.json": No such file or directory」，6 小时内 17 次。`/srv/claude-shared/.claude.json` 是 `/root/.claude.json` 的单文件 bind；root 的 Claude Code 每次替换该文件后挂载指向已删除的文件，AppArmor 拒绝 bwrap 重新挂载它（"deleted entry"），整个沙箱起不来。
- **修复**：`sandbox.js` 不再整体 `--ro-bind / /`，改为逐个只读挂载根目录下的文件夹、重建 bin/lib 等符号链接，跳过 `/srv`（没有 CLI 需要），最后把新根设为只读。在 VPS2 上人为制造 `/srv` 下的失效单文件挂载复现：旧沙箱报同样错误，新沙箱正常，`/usr` 与根目录仍只读。
- **Antigravity**：单聊服务的 agy 登录换成能用 Gemini 4 的账号（旧凭据备份 `/root/backups/agy-chat-token.bak-20261123`）；`chat-server.js` / `model-catalog.js` 部署，单聊菜单列出 agy 全部 23 个模型（主控派活目录仍只用 Gemini）。
- **VPS2**：替换 `/opt/agentdesk-orchestrator/{sandbox.js,chat-server.js,model-catalog.js}`，旧文件备份在 `/root/backups/orchestrator-20261123-sandbox-agy/`。单聊服务按连接启动，新连接即用新代码；**主控（群聊）需重启 `agentdesk-orchestrator` 才用新沙箱，尚未重启**。
- **验证**：`npm test` 542 项，535 通过，7 项跳过，0 失败。
- **回滚**：把备份的三个文件拷回 `/opt/agentdesk-orchestrator/`。

## 2026-11-23 22:20（北京时间）· 客户端 0.4.0 · 更新日志、自动下载更新、刷新模型、额度离线显示

- **更新日志**：新增 `CHANGELOG.md`，每版一节；发版时取出这一节作为更新说明随包上传，「更新」对话框显示「X.Y.Z 更新内容」，更新后显示「本版更新内容」。没有这一节的版本，release.yml 在 meta 步骤就停止。
- **自动下载**：未签名的 Windows / Mac 构建也自动检查（启动 30 秒、每 24 小时、网络恢复、服务器通知）并后台下载；安装规则不变（Windows 点「重启并更新」，Mac 手动替换）。0.3.x → 0.4.0 仍需手动点一次下载。
- **刷新模型**：输入框模型选择旁新增刷新按钮，重新读取当前单聊的模型列表。
- **Antigravity 单聊模型**：`chat-server.js` 的 model/list 改为列出 agy 的全部模型（主控派活目录仍只用 Gemini）。**VPS2 尚未部署这两个文件**，待主人确认。
- **删除项目**：与其他项目共用远程目录时，只删属于本项目的会话，不再报「多个项目共用这个远程目录」。
- **额度离线**：主控连不上时额度窗口只显示「离线」（去掉示例数据）；快照来源的额度显示离线；Codex 断开时状态栏显示「用量 离线」。
- **VPS2**：无改动。
- **验证**：`npm test` 541 项，534 通过，7 项跳过，0 失败。未在真机上点验。

## 2026-11-23 21:10（北京时间）· VPS1 / VPS2 · 第二台 Windows（Lenovo）接入群聊主控

- **背景**：有两台 Windows。原来那台（工作区 `windows`）今天没连 VPS2；Lenovo（`lenovo_actjm6t3`）只登记了单聊钥匙，没有 Bridge，也就没有群聊主控。
- **VPS2**：新建空仓库 `repos/lenovo.git`；`config.json` 的 `sshBridges`、`quotaBridges` 加 `lenovo`，`workspaces` 加 `lenovo`，`relayBridges` 加 `lenovo`；新增 `relay-lenovo.token`；重启主控和 `agentdesk-home-mount`，`bridge-lenovo.sock`、`bridge-lenovo-mount.sock` 已建立。改前备份 `config.json.bak-20261123-lenovo`。
- **VPS1**：Relay 注册表新增 `lenovo-bridge` ↔ `vps2-orchestrator-lenovo`，主控一端已上线。
- **待办**：Lenovo 运行配置脚本生成 Bridge 钥匙，把公钥发回后，在 `/etc/ssh/agentdesk-authorized-keys` 加一行（限定 `ssh-gateway.js bridge-lenovo.sock bridge-lenovo-mount.sock`）。
- **回滚**：恢复 `config.json.bak-20261123-lenovo` 并重启两个服务；VPS1 删掉这两条配对。

## 2026-11-23 21:01（北京时间）· VPS1 / VPS2 · Windows 接入备用线路（Relay）主控

- **问题**：Windows 只有 SSH 主线路，Relay 上没有它的配对，VPS2 的 `relayBridges` 里也只有 mac，所以 Windows 没有备用线路的主控。另外发现 Mac Bridge 的 `relay.host` 还是 VPS1 的旧 IP，Mac 一端从未连上 Relay（要在 Mac 上改，见对话记录）。
- **VPS1**：Relay 注册表新增永久配对 `windows-bridge` ↔ `vps2-orchestrator-windows`（只写令牌摘要）。改前备份在 VPS1 `/root/relay-devices.json.bak-20261123-*`。
- **VPS2**：新增 `/etc/agentdesk-orchestrator/relay-windows.token`（root:agentdesk 0640），`config.json` 的 `relayBridges` 加 `windows`，重启主控。改前备份 `config.json.bak-20261123-win-relay`。Relay 日志确认 `vps2-orchestrator-windows` 已上线。
- **Windows**：待在本机运行配置脚本（写 Bridge 令牌、CA，并在 Bridge 配置加 `relay`），重启应用后 Relay 日志应出现 `connected device=windows-bridge`。
- **回滚**：VPS2 恢复 `config.json.bak-20261123-win-relay` 并重启主控；VPS1 从注册表删掉这两条（或恢复备份），服务 2 秒内自动生效。

## 2026-11-23 21:10（北京时间）· 客户端 0.3.10 · 0.3.9 重发、清理残留的原生单聊记录

- **0.3.9 未发出**：Windows 打包前的测试失败。新加的测试比较临时目录路径时没有统一 Windows 的 8.3 短路径（`RUNNER~1`）；功能代码无问题。测试改用 `realpathSync.native` 后以 0.3.10 重发，内容包含 0.3.9 的全部改动（见下条）。标签 v0.3.9 保留。
- **Mac 报错「载入历史失败：该单聊属于另一个已授权的本机项目」「删除失败：找不到本机项目目录」**：Mac 的 `native-chat/threads.json` 里有 16 条原生单聊记录，属于已不在配置里的旧项目（`~/Desktop`）。「ict」用的是共用的云端目录，所以这些旧 Codex 会话被列到了它下面；打开时记录指向别的项目，删除时又找不到那个项目。
- **修复**：配置正常载入后，启动时清掉所属项目已不存在的原生单聊记录和租约（配置读不出或为空时不清）；删除单聊或项目时，所属项目不存在的记录直接移除本机记录，不再报错。审计事件 `native_orphan_prune`。
- **VPS2**：无改动。
- **验证**：`npm test` 534 项，527 通过，7 项跳过，0 失败。

## 2026-11-23 21:00（北京时间）· 客户端 0.3.9 · 新建项目先建本机 Git 仓库、附件上传进度条

- **新建项目**：「新建项目」对话框里多了「本机文件夹」，可先点「选择…」；没选的话点「创建」时会弹出选择框，取消则不创建。所选文件夹按原有规则处理 Git：普通文件夹 `git init`，空文件夹另建 `.gitignore` 并做首个提交，已在仓库里的沿用父仓库。主控项目绑定照旧保留，群聊不受影响；绑定的文件夹只是工作目录，群聊和单聊读取其他位置文件的权限不变。
- **群聊里的单聊**：以前建的、还没登记的群聊项目，第一次开单聊时也先选本机文件夹并初始化 Git（以前只登记成云端项目，单聊因缺本机目录无法开始），主控绑定保留。
- **附件上传进度条**：Claude / Grok / Antigravity 单聊（含群聊里开的）的附件按服务器已收字节填充进度条；Codex 单聊附件一个文件一次请求，显示「第几个/共几个」和流动进度条。另外所有进行中的上传都显示在右下角浮动的上传面板里，面板放在最上层（有弹窗时放进弹窗里，和提示条同一规则），在群聊界面或打开弹窗时也看得到。群聊附件随消息发送，本次未改。
- **VPS2**：无改动。
- **验证**：`npm test` 532 项，525 通过，7 项跳过，0 失败。未在真机上点验。

## 2026-11-23 20:00 后（北京时间）· 客户端 0.3.8 · 删除时跳过未加载的会话

- **问题**：Mac 上删除项目「ai」报「删除项目没有完成：thread not loaded: 01a20661-…」。删除前会向 VPS2 的 Codex 查每个原生单聊的工作目录；这个会话在 Codex 那边未加载，回的是 `thread not loaded`，只有 `not found` 被当作可跳过，删除整体中止。
- **修复**：`thread not loaded` 与 `not found` 同样视为会话已不存在（项目删除的预览和远程步骤、单聊删除）。原生会话一侧另外放行「Codex 尚无可恢复的历史记录」。
- **VPS2**：主控代码无改动。同日把 autumnmoon.top / claude.autumnmoon.top 的 HTTPS 从宝塔 nginx 443 迁到 Caddy 8443，443 交还 AgentDesk 密码登录服务（见服务器备份 `/root/backups/site-443-to-8443-*`，内含 ROLLBACK.sh）。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败。

## 2026-11-23 20:50（北京时间）· 客户端 0.3.7 · 缩放快捷键

- **问题**：Windows 上 Ctrl+`-` 能缩小，Ctrl+`=` 不能放大。Electron 默认菜单的放大键是 Ctrl+Plus，在 Windows 键盘上需要 Shift。
- **修复**：主进程统一处理缩放键：Ctrl（macOS 为 ⌘）加 `=`/`+` 放大、`-` 缩小、`0` 恢复，主键盘和小键盘都可用，每次半档，限制在 -3～4 级。未在真实 Windows 上验证。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败。

## 2026-11-23 20:30（北京时间）· 客户端 0.3.6 · 推送更新下载提速与重试

- **问题**：Mac 0.3.2 → 0.3.4 推送下载很慢，14 秒和 44 秒后失败。安装包约 122 MB，按 128 KiB 一块经 SSH 控制通道逐块读取（约 930 次往返，经 VPS1 跳板），任一块超时整个下载失败、不重试。
- **修复**：本机下载源同时保持 4 块读取，按顺序输出；单块读取在线路类错误时重试，最多 5 次、间隔递增；明确拒绝（版本已不提供、文件已变化等）不重试。新增重试与拒绝的测试。只对已装 0.3.6 及以后的客户端生效；更早的版本需手动安装一次。
- **Windows**：Windows Bridge 当天没有连接 VPS2；`agentdesk-enrollment`（密码登录）自 11-18 起因 443 被宝塔 nginx 占用而无法启动，未处理，待主人决定。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，521 通过，7 项跳过，1 项失败为 VPS2 环境偶发（沙盒挂载时 `/srv/claude-shared/.claude.json` 正被定时服务替换），单独重跑通过。

## 2026-11-23 20:10（北京时间）· 客户端 0.3.5 · 群聊项目可以删除

- **问题**：群聊里建的项目（没有绑定本机目录，如 ICT、ict、is）不在「删除项目」范围内，右键和「···」都没有删除；只能逐个删群聊，且 VPS 上的群聊任务不会删除。
- **修复**：这类项目的项目行也有「···」和右键「删除项目…」。先向 VPS2 预览任务数量，原生确认窗口说明范围，确认后删除 VPS2 上该项目的群聊任务（日志、工作树、CLI 会话、项目分支），再清本机补丁、群聊、派遣记录和单聊会话。`project_delete` 由主进程发出时保留该项目自己的工作区，不再被当前项目的工作区覆盖。
- **发布**：0.3.4 已推送（Mac、Windows），本版用于第二次推送更新测试。0.3.3 上传时 GitHub 到 VPS2 连接超时未上传，已由 0.3.4 取代。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败。

## 2026-11-23 19:30（北京时间）· 客户端 0.3.4 · 桌面无访问权限时也能删除项目

- **问题**：Mac 0.3.2 上删除项目「ai」（绑定 `~/Desktop`）两次失败，均未连接 VPS2。AgentDesk 没有 macOS「桌面文件夹」访问权限，0.3.2 新增的「桌面 `.git` 是否为空仓库」检查读取桌面时被拒绝，直接报错。
- **修复**：个人文件夹无法读取时视为保留：不碰文件夹和 `.git`，只解除绑定并清理 AgentDesk 数据和 VPS 工作区。新增测试以无权读取的目录验证（root 环境跳过，CI 执行）。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败；以非 root 用户单独运行删除测试 12 项全部通过。

## 2026-11-23 19:00（北京时间）· 客户端 0.3.3 · 推送更新测试版

- **用途**：验证 Mac 从 0.3.2 经 VPS2 推送更新到 0.3.3。0.2.9 → 0.3.2 的推送下载在 Mac 上 0.1 秒内失败，VPS2 未收到读取请求；审计日志过滤了 `error` 字段，原因未知，主人随后手动安装了 0.3.2。
- **改动**：
  - 审计日志保留 `error`（错误类别）、`version`、`agent`；下载失败另记错误码，下次失败可直接定位。
  - 侧栏项目行悬停显示「···」，点开即「删除项目…」，不再只靠右键；菜单里的删除项与其他项用分隔线隔开。
  - 提示条加层级，弹窗打开时显示在弹窗内，不再被挡住（例如附件超过 25 MB 的失败提示）；长提示停留时间按长度延长，最多 6 秒。
- **VPS2**：无改动。
- **验证**：`npm test` 528 项，522 通过，6 项环境跳过，0 失败。

## 2026-11-23 16:30（北京时间）· 客户端 0.3.2 · 修复项目和单聊删除

- **事故**：03:14（UTC）Mac 上删除项目「ai」时，VPS 步骤把共用的 Codex 工作目录 `/var/lib/agentdesk-orchestrator/desktop-workspace` 整个删除（项目没有单独的远程目录，代码回落到共用目录）。`codex-desktop.sh` 以 `set -eu` 进入该目录，所以之后 Codex 无法启动。本机步骤要删除整个 `~/Desktop`，被 macOS 权限拦下，桌面文件未受影响；之后每次重试都卡在同一处。已在 VPS2 以 agentdesk 属主重建该空目录。
- **修复**：
  - 项目绑定的是个人文件夹（家目录下的直接子目录，或桌面、文稿、下载等）时，只解除绑定，文件全部保留；只删除没有任何提交的空 `.git`。
  - VPS 共用工作区不再整体删除；没有其他项目在用时清空其内容，目录本身保留。只有项目单独绑定的远程目录才整个删除。旧的半途删除计划里记录的共用目录会被忽略，重试可以继续完成。
  - 单聊右键新增「删除…」：原生确认窗口说明范围，先删 VPS 上的会话记录和 CLI 会话文件，再删本机的撤销存档、命令记录和独立工作树。
  - 删除失败改为弹窗显示原因，并写入审计日志。
- **发版**：`v0.3.0` 标签的 Mac 打包失败（未配签名时 `CSC_LINK` 为空字符串，electron-builder 当成路径报 `not a file`），未上传。`release.yml` 改为签名变量为空时先清除，改发 0.3.1。`v0.3.1` 两个平台打包成功，上传失败：GitHub secret `VPS2_UPDATE_PORT` 末尾带换行，ssh 报 `Bad port`。上传步骤改为去掉端口和目标的首尾空白，改发 0.3.2。
- **VPS2**：主控代码无变化，未重启。
- **验证**：`npm test` 528 项，522 通过，6 项环境跳过，0 失败；新增个人文件夹保留与空 `.git` 删除的测试。

## 2026-11-23 16:03 · GitHub 主线 d62b2f6 · Mac 新版部署

- 从 GitHub 获取并快进到主线 `d62b2f6`，包含项目清理、原生会话重连恢复、Mac 手动安装更新及连接重试修复。上一轮 Windows CI 的 SQLite 清理顺序问题已由本次主线修正。
- 重新构建并安装 Apple Silicon 应用，安装与构建的 app.asar 哈希一致。VPS2 与 Mac Bridge 的全部 JS 文件均与主线源码一致，VPS 日更脚本及两个 systemd 单元的哈希也一致，服务 active，原定时器 enabled。
- 按新版部署说明安装本机 `local.agentdesk.cli-update` 任务，每小时检查一次，美东每日 12:00 后更新，首次检查退出码为 0。本次没有强制立即更新四个模型 CLI。
- 本地 526 项测试中 520 通过、6 项环境跳过、0 失败。主线 CI 的 Ubuntu、Windows、macOS 和 Relay 测试全部通过。打包版 zsh/bash 交互、重连及删除项目后的终端和租约清理检查通过。
- 旧应用保存在用户 Applications 下的本次替换备份目录，可用原 `6192109` 构建回退；本机更新任务可用 `node scripts/local-cli-update.js --uninstall` 移除。

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
