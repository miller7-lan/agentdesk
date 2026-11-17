# AgentDesk 待办清单（2026-11-17）

> 汇总仓库里所有分支、所有规划文档中**还没完成**的事，按依赖顺序排列。勾选框表示完成状态。
> 详细背景：[现状评估](STATUS_REVIEW.md) · [路线图](ROADMAP.md) · [微信与分工方案](WECHAT_OMC_PLAN.md) · [群聊界面设计](GROUP_CHAT_UI.md) · [可点击原型](prototype/group-chat.html)

## 当前进度一览

| 方向 | 状态 |
|---|---|
| 桌面端基础（单个 Codex 对话、本机工具、断线重连） | ✅ `main` 已有 |
| 休眠后恢复会话、折叠重复命令 | 🟡 已写好，在 `fix/resume-active-writer`，未合并 |
| 多 agent 主控、双 VPS 中转、macOS 面板 | 🟡 已写好，在 `codex/agentdesk-dual-vps`，未合并；分工和设计不一致 |
| Claude 当组长 + Antigravity 分担 + 省额度 | ⬜ 只有设计 |
| 资源隔离与定期清理 | ⬜ 只有设计 |
| 群聊界面、头像动画、玻璃主题、开机动画 | 🟡 只有原型 |
| Windows / macOS 双平台适配 | 🟡 macOS 打包和 Bridge 在 dual-vps 分支；界面未统一 |
| 微信入口 | ⬜ 只有设计 |
| 安全底线（5 个 P0） | ⬜ 所有分支上都还在 |
| CI、签名、自动更新、首次运行向导 | ⬜ |

## 0. 合并与底线（先做，1～2 天）

- [ ] 合并 `fix/resume-active-writer` → `main`
- [ ] 把 `codex/agentdesk-dual-vps` 合到新的 `main`，解决 6 个重叠文件：`main.js`、`remote.js`、`src/app.js`、`src/index.html`、`src/live.js`、`src/styles.css`
- [ ] 修 P0-1：`remote.json` 解析失败时不再用默认值覆盖（`remote.js` 的 `loadConfig`）
- [ ] 修 P0-2：只读 / 计划模式下不注册桌面工具（`main.js` 的 `turn/start` 处理）
- [ ] 修 P0-3：拦截新窗口，外部链接改用系统浏览器打开（`setWindowOpenHandler` + `shell.openExternal`）
- [ ] 修 P0-4：桌面工具单次超时只让该请求失败，不再停掉整个后端（`desktop.js`）
- [ ] 修 P0-5：版本号统一从 `package.json` 读取（`desktop.js`、`remote.js`）
- [ ] GitHub Actions：Windows、macOS、Linux 三个平台跑 `node --test`，Linux 跑中转服务的 Python 测试

## 1. 主控按确定的分工工作（约 1 周）

- [ ] 规划步骤改由 Claude 执行（`orchestrator/scheduler.js` 里规划步骤目前固定是 Codex）
- [ ] 新增 Antigravity 适配器（先在 VPS 上确认它的无交互调用参数、登录方式、输出格式）
- [ ] 固定任务流程：Antigravity 侦察 → Claude 规划 → Antigravity 写简报 → Codex 改代码 → 自动测试 → Grok 审查 → Antigravity 汇总 → Claude 验收
- [ ] Claude 只在规划、出问题、验收时被唤醒，拿到的都是摘要
- [ ] 升级规则：测试连续失败 2 次、审查意见冲突时交回 Claude，并记录成一条事件
- [ ] 记录每一步的 token 用量（Codex `--json`、Claude `stream-json`；Grok 和 Antigravity 待确认能否拿到）
- [ ] 同一个 CLI 同一时刻只跑一个步骤（订阅令牌刷新不互相覆盖）
- [ ] 订阅登录：每个 CLI 在服务器上登录一次的流程和掉登录 / 额度用尽的识别
- [ ] 对照实测：10 个真实任务，单独完成 vs 多 agent 流程，比较 Claude / Codex 额度消耗和返工次数

## 2. 资源隔离与清理（2～3 天）

- [ ] 每个步骤限制内存和 CPU（Docker 或 `systemd-run -p MemoryMax=…`，**待你决定**）
- [ ] 定时清理：成功任务的 worktree 和日志保留 3 天，失败的保留 7 天；磁盘剩余低于 15% 时提前清理并提醒

## 3. 界面改版：群聊 + 玻璃主题 + 开机动画（2～3 周）

### 3.1 先让 Windows 能用上主控

- [ ] 把 macOS 的「线路与模型」面板移到 Windows（`src/orchestrator.js` 目前在非 macOS 上直接返回）

### 3.2 群聊界面

- [ ] 左栏改成「项目 → 群聊 / 单聊」
- [ ] 主控的任务事件转成群聊消息：派活卡片（状态原地更新）、审批卡片、过程折叠、系统事件
- [ ] 右侧面板：成员、任务、资源；状态栏：容器、内存、各 CLI 额度
- [ ] 输入框：默认发给组长、`@` 点名（显示成员状态）、群级权限模式
- [ ] 渲染层先拆分 `src/live.js`（约 1000 行），再在上面做群聊视图

### 3.3 头像动画

- [ ] 把原型里的绘制代码整理成独立模块（`src/bots.js`）：不工作时显示 logo，工作时醒来；12 种状态和道具；悬停、戳一下、连戳的反应
- [ ] 头像状态由真实任务状态驱动（主控事件 → 成员状态）
- [ ] logo 来自 `@lobehub/icons-static-svg`（MIT），在仓库里放第三方声明；公开发布前确认各家商标使用规范

### 3.4 玻璃主题（参考 DSH Aqua 插件的效果，自己实现）

- [ ] 「玻璃 / 经典」两套皮肤；玻璃皮肤下面板、输入框、卡片都是磨砂玻璃；可选「悬浮卡片」和「贴合」两种布局
- [ ] 可调：模糊度、磨砂度、流体背景色相、背景亮度、自定义壁纸（含壁纸模糊）；设置存在本机
- [ ] 系统原生毛玻璃：
  - Windows 11：`BrowserWindow` 的 `backgroundMaterial: 'acrylic'`（或 `'mica'`），页面背景改为半透明
  - macOS：`vibrancy: 'under-window'`、`visualEffectState: 'active'`
  - Windows 10 或不支持时：退回到页面内绘制的流体背景
- [ ] 性能：流体背景低分辨率绘制、约 15 帧/秒；窗口不在前台、开启「减少动态效果」、开机动画播放期间暂停；提供「关闭动态背景」开关
- [ ] 深浅两套配色都检查对比度（原型里已调过次要文字的颜色）

### 3.5 开机动画（参考 550C 和视频片头类插件的流行做法，自己实现）

- [ ] 首帧直接写在 `index.html` 里，窗口在 `ready-to-show` 之后才显示，避免白屏或闪出旧界面
- [ ] 流程：发光的「AgentDesk」逐字显现 → 逐行显示**真实**的启动检查（VPS 连接、主控、四个 CLI 的登录和额度、本机 Bridge）→ 每个 agent 检查通过时它的 logo 醒来 → 进度条跟随真实进度 → 溶解进主界面
- [ ] 某项检查失败时停在该行并给出处理办法（例如「Grok 额度用尽 · 18:00 重置」只提示不阻塞；VPS 连不上时提供「重试 / 离线进入」）
- [ ] Esc、回车、空格、点击都能跳过；设置里可选「每次 / 每天首次 / 关闭」，并能手动重播
- [ ] 开启「减少动态效果」时只显示静态检查列表，约 1 秒后淡出
- [ ] 可选：自定义片头视频（MP4），播放时静音直到用户点击

### 3.6 Windows / macOS 双平台

| 项目 | Windows | macOS |
|---|---|---|
| 标题栏 | 右侧系统按钮（`titleBarStyle: 'hidden'` + `titleBarOverlay`，按主题改颜色） | 左侧红绿灯（`titleBarStyle: 'hiddenInset'`），品牌标记让出位置 |
| 窗口材质 | Windows 11 acrylic / mica；Windows 10 用页面背景 | vibrancy |
| 字体 | Segoe UI Variable / 微软雅黑；Cascadia Code | 苹方 / SF Pro；SF Mono |
| 快捷键提示 | Ctrl | ⌘ |
| 本机桌面工具 | agent-desktop Windows 版（已有） | agent-desktop macOS 版；需要辅助功能和屏幕录制授权（dual-vps 分支已有 Bridge） |
| 本机文件工具 | C: / D:，排除系统目录（已有） | 用户主目录下授权的项目，排除 `/System`、`~/Library` 等 |
| 打包 | NSIS 安装版 + 便携版 | `.app`；后续加签名和公证（notarize） |
| 系统通知、托盘 | 任务完成 / 待审批通知（已有） | 同样的通知；菜单栏图标可选 |

- [ ] 平台差异集中到一个模块（`platform.js`），界面通过 `data-os` 切换样式
- [ ] 两个平台各做一次完整的手动验收：开机动画、群聊、审批、本机工具、断线重连

## 4. 微信入口（3～5 天）

- [ ] VPS 上安装 OpenClaw（固定版本），通过 ClawBot 接入个人微信；验证能否主动推送
- [ ] 写一个只调用主控管理接口（提交、查状态、停止）的技能；`/ls`、`/s 任务号` 等固定命令不经过模型
- [ ] 任务状态变化时推送到微信；只把结论和待处理事项推送过去
- [ ] 白名单只允许你本人的微信账号；微信发起的任务不能批准高危操作

## 5. 产品化收尾（持续）

- [ ] 首次运行向导：生成密钥、确认主机指纹、检测远端 CLI
- [ ] 日志文件、审计日志、导出诊断包
- [ ] Windows 代码签名、macOS 签名和公证、自动更新
- [ ] 去掉写死的工作区路径 `C:\CodexSSH\windows-dev`，支持多项目
- [ ] 用户文档：安装、权限说明、故障排查

## 待你决定

1. VPS 用一台还是两台？4 GB + 2 GB swap 的是哪一台？
2. 资源隔离用 Docker 还是 systemd 资源限制？
3. 可以由我合并 `fix/resume-active-writer` 和 `codex/agentdesk-dual-vps` 吗？
4. 开机动画默认「每次」还是「每天首次」？
