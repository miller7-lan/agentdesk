# AgentDesk 产品化路线图

> 基于 0.2.7（commit `39da1b1`）的代码审阅。目标：从「个人自用的远程 Codex 桌面壳」走到「别人装上就能用、出了问题能排查、权限可信的产品级 Agent 客户端」。

## 阶段进展

本地代码已实现多项目配置、首次运行向导、SSH 指纹确认、滚动日志和审计、脱敏诊断导出、发布构建以及可选更新检查。Docker 分支仍待 VPS2 实机验收。Windows 原生启动、发布证书签名、公证和实际更新源仍需各自的测试环境或凭据。

以下内容保留作为 0.2.7 审阅时的路线图。

## 1. 现状定位

AgentDesk 本身不是 agent，它是 **VPS 上 Codex App Server 的 Windows 桌面前端**，外加两组「本机能力」回注给远端 Codex：

| 模块 | 文件 | 作用 |
|---|---|---|
| 连接层 | `remote.js` | 通过 Windows OpenSSH 拉起 VPS 上的 `codex app-server`（JSON-RPC over stdio），外加可选反向隧道；重试退避、心跳、空闲休眠 |
| 本机桌面 | `desktop.js` | 包装 `agent-desktop` MCP 二进制，作为 dynamicTools 注入线程 |
| 本机文件 | `windows-files.js` | 完全访问模式下的 `windows_file_*` 工具（C:/D:，排除系统目录） |
| 工作区面板 | `workspace.js` | 只读的文件树、Git 改动、diff、本地技能打包上传 |
| 界面 | `src/*.js` | 无框架原生 JS，会话/审批/模型选择/斜杠命令 |

**已经做得好的地方**（保留，别重写）：

- 连接层的健壮性是全项目最成熟的部分：旧连接输出不会污染新请求、超时的写操作不重放、隧道以 `remote forward success` 为就绪信号，并且有 11 个针对性测试。
- SSH 参数收得很紧：`-F none`、`StrictHostKeyChecking=yes`、`IdentitiesOnly`、固定 ed25519、`restrict` 强制命令。
- Electron 基线正确：`contextIsolation`、`sandbox`、无 `nodeIntegration`、有 CSP、禁止导航。
- 构建时校验桌面组件 SHA-256（`scripts/prepare-desktop.js`）。

## 2. 差距总览

| 维度 | 现状 | 产品级要求 | 差距 |
|---|---|---|---|
| 安装与首次配置 | 手写 `remote.json`、手动放私钥、手动配 VPS 强制命令 | 引导式向导，一键生成密钥、校验指纹、检测远端 | 🔴 大 |
| 权限模型 | 三档模式；桌面工具在所有模式下都可用；本机文件工具无逐次审批 | 工具级权限、逐次/会话级审批、可审计 | 🔴 大 |
| 本机编码能力 | 本机只能读文件树；跑命令依赖可选的 SSH MCP 隧道 | 本机 shell、补丁应用、搜索 | 🔴 大 |
| 可配置性 | 工作区路径 `C:\CodexSSH\windows-dev` 写死 | 多项目、多主机、任意目录 | 🟠 中 |
| 可观测性 | 无日志文件；出错只在状态栏一行 | 结构化日志、诊断包导出、崩溃上报（可选） | 🟠 中 |
| 测试与 CI | 仅 `remote.js` 有单测；无 CI、无 lint | 主进程全覆盖单测、渲染层 E2E、Windows CI | 🟠 中 |
| 分发与更新 | 未签名的 portable/nsis；无自动更新 | 代码签名、自动更新、发布渠道 | 🟠 中 |
| 界面完成度 | 示例（mock）数据混在正式界面；自写 Markdown 渲染；文案全部硬编码中文 | 只有真实数据；完整 Markdown/代码高亮；i18n 可选 | 🟡 小-中 |
| 代码结构 | `live.js` 988 行、全局可变状态、无类型 | 模块化 + 类型检查（JSDoc/TS） | 🟡 小-中 |

## 3. 必须先修的具体问题（P0）

这些问题小，但会直接伤害用户信任或数据，应在任何新功能之前处理。

1. **配置写错会被静默覆盖。** `remote.js:24-28` 中 `JSON.parse` 失败也进入 `catch`，随后用默认值覆盖 `remote.json`。用户少打一个逗号，主机名、用户名就全没了。
   → 只在 `ENOENT` 时写默认文件；解析失败时保留原文件，在界面报出行列号。

2. **桌面控制不受权限模式约束。** `main.js:239-243` 中只要桌面开关打开，任何模式（包括「只读/计划」）的 turn 都注册 `desktop_*`，模型可以在只读模式下点鼠标、敲键盘、截屏。
   → 桌面工具至少要求「自动/完全访问」或单独的逐次审批；计划模式一律不注册。

3. **Markdown 链接会开出新的 Electron 窗口。** `src/live.js:27` 生成 `target="_blank"`，但主进程没有 `setWindowOpenHandler`，模型输出里的任意 URL 会在一个新的 BrowserWindow 里加载。
   → `win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`，http(s) 链接改用 `shell.openExternal`，并做协议白名单。

4. **一次桌面操作超时会杀掉整个后端。** `desktop.js:74` 超时调用 `this.stop()`，同一时刻其它进行中的桌面调用全部失败，下次还要重新初始化。
   → 超时只 reject 该请求；连续 N 次超时才重启后端。

5. **版本号散落。** `desktop.js:45` 上报 `0.2.5`，`remote.js:206` 写死 `0.2.7`，`package.json` 是 `0.2.7`。
   → 统一从 `app.getVersion()` / `package.json` 读取。

6. **示例数据出现在正式界面。** `src/app.js:6-8` 在真实模式下仍然把 mock 项目加上「（示例）」展示。
   → 真实模式不加载 `data.js`；mock 只用于 `AGENTDESK_OFFLINE` / 截图。

## 4. 分阶段路线

### M1 · 0.3「可信的基线」（约 2 周）

目标：不加新能力，先让现有能力安全、可排查、可回归。

- [ ] 完成第 3 节全部 P0。
- [ ] **权限矩阵**：在一个地方声明「模式 × 工具族 → 允许/审批/禁止」，`main.js` 按表注册 dynamicTools、按表拦截调用，替代现在分散的 `desktopThreads` / `fullAccessThreads` / `fileTurns` 三个集合。
- [ ] **本机工具审批**：`windows_file_write/move/trash` 和 `desktop_*` 的副作用调用走与远端命令一致的审批卡片（支持「本会话内允许」）。
- [ ] **审计日志**：所有本机工具调用（工具名、参数摘要、结果、所属 thread/turn）写入 `%APPDATA%\AgentDesk\logs\audit-YYYYMMDD.jsonl`，界面可查看。
- [ ] **运行日志**：主进程用轻量 logger 按级别写文件并轮转；ssh stderr 摘要、RPC 错误进入日志。状态栏「导出诊断包」（日志 + 脱敏配置 + 版本信息）。
- [ ] **测试补齐**：`windows-files.js`（路径白名单、保留名、符号链接、偏移读取）、`desktop.js`（工具过滤、参数校验、超时）、`main.js` 中的路由逻辑抽成纯函数后测试。
- [ ] **CI**：GitHub Actions `windows-latest` 跑 `npm test` + `npm run dist`（不发布），加 ESLint。

**验收**：配置写错不丢数据；只读模式下无法触发任何本机副作用；任意一次故障都能从诊断包定位。

### M2 · 0.4「好用的 Agent 客户端」（约 3-4 周）

目标：补上与一线 CLI/桌面 agent 相比最明显的能力缺口。

- [ ] **去掉写死的工作区**：`workspace.js:10` 与 `src/live.js:7` 的 `C:\CodexSSH\windows-dev` 改为配置项；支持多个项目（每个项目 = 本机目录 + 远端 cwd + 主机），侧边栏的项目列表接真实数据。
- [ ] **本机命令执行**（核心缺口）：新增 `windows_shell_exec` 动态工具（PowerShell/cmd，cwd 限定在项目目录，超时、输出截断、可中断），默认需要审批。这样不必再依赖 SSH 反向隧道 + VPS 上的 SSH MCP 才能在 Windows 上跑构建和测试，配置链路能少一半。
- [ ] **本机补丁与搜索**：`windows_file_apply_patch`（统一 diff，失败时给出冲突上下文）、`windows_file_search`（ripgrep 风格，限制结果数）。
- [ ] **会话体验**：
  - 历史会话搜索、重命名、归档、删除；
  - 渲染层改用成熟 Markdown 库 + 代码高亮（表格、嵌套列表、任务列表），替换 `md()` 手写实现；
  - diff 面板支持按 hunk 接受/撤销（调用本机 git）；
  - token/上下文用量常驻显示，接近上限时提示 `/compact`。
- [ ] **大文件与附件**：上传改为分块并显示进度；超过阈值的文件夹先打包。
- [ ] **重构渲染层**：把 `live.js` 拆为 `rpc-client` / `session-store` / `views/*`，状态集中管理；用 JSDoc + `tsc --checkJs` 做类型检查（不必迁 TS）。

**验收**：不配置 SSH 隧道也能完成「改代码 → 本机跑测试 → 看 diff → 提交」的完整闭环。

### M3 · 0.5「别人也能装」（约 3 周）

目标：让第二个用户在 15 分钟内从零跑起来。

- [ ] **首次运行向导**：输入主机 → 生成 ed25519 密钥对 → 展示需要粘贴到 VPS `authorized_keys` 的一整行（含 `restrict,command=`）→ 首次连接时展示主机指纹让用户确认并写入专用 `known_hosts` → 检测远端 `codex` 版本与登录状态。
- [ ] **远端一键安装脚本**：`config/` 下的模板升级为可执行的 `install-vps.sh`（创建非 root 用户、安装启动脚本、可选 sshd drop-in，执行前 `sshd -t`）。
- [ ] **Codex 协议兼容层**：启动时读取 `initialize` 返回的版本，与已测试版本范围比对；不兼容时明确提示而不是在某个 RPC 上莫名失败。为用到的每个 RPC 方法建立契约测试（录制真实响应做 fixture）。
- [ ] **代码签名 + 自动更新**：electron-builder 配置签名证书（或至少 Azure Trusted Signing）；`electron-updater` + GitHub Releases，区分 stable / beta 渠道。
- [ ] **设置界面**：图形化编辑 `remote.json` 中的全部字段，含校验。
- [ ] 用户文档：安装、权限说明（截屏和文件内容会发往 VPS 这一点需要醒目提示）、故障排查。

**验收**：新用户只看文档和向导、不读源码即可完成配置；升级不需要重新下载安装包。

### M4 · 1.0「产品」（持续）

- 多主机 / 多 Codex 账户切换；可选直连本机 `codex app-server`（无 VPS 模式），扩大适用人群。
- 插件化的本机工具：把桌面、文件、shell 统一为本机 MCP server 注册表，用户可添加自己的本机 MCP。
- 离线可用：断线期间保留草稿、排队发送；会话本地缓存，重连后增量同步。
- 可选的匿名崩溃上报（默认关闭，明确告知）。
- i18n：文案抽离，至少提供中/英两套。
- 性能：长会话虚拟滚动、文件树懒加载（当前上限 3000 项、深度 8）。

## 5. 需要先拍板的方向性问题

1. **是否继续只做 Codex 前端？** 当前所有 agent 能力都来自远端 Codex。如果目标是「自己的 CLI agent」，需要决定是否抽象出一层 `AgentBackend` 接口，日后接入其它 app-server 或自研 agent loop。建议：M2 重构渲染层时就把 RPC 调用收敛到一个客户端模块，留出接口，但不提前实现第二个后端。
2. **VPS 是否必须？** 引入本机 shell 后，「VPS 跑模型推理客户端、Windows 跑工具」的意义主要剩下：VPS 网络环境、常驻、资源隔离。若这些不是硬需求，「本机直连模式」会显著降低上手门槛，值得放到 M3 评估。
3. **完全访问的边界。** 现在完全访问 = 远端无沙盒 + 本机 C:/D: 读写。产品化后建议拆成「远端权限」和「本机权限」两个独立开关，避免用户为了让远端跑命令被迫放开本机文件。
4. **是否需要真正的 CLI 形态？** 如果「cli agent」指终端界面，`remote.js` 已经与 Electron 解耦（只依赖 Node），可以较低成本做一个 `agentdesk-cli`，复用连接层和本机工具，作为 M4 的候选项。

## 6. 建议的近期执行顺序

1. P0-1 配置覆盖、P0-3 外链窗口（各几行代码，风险最高）
2. P0-2 桌面权限 → 顺势落地权限矩阵
3. 日志 + 诊断包
4. 测试补齐 + Windows CI
5. 去掉写死工作区 → 本机 shell 工具（M2 的核心）
