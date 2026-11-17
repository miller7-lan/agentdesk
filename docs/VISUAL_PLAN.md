# 视觉改版实施计划：白色玻璃主题 + 科技感开机动画 + Windows / macOS

> 2026-11-17。效果代码见 [prototype/group-chat.html](prototype/group-chat.html)：打开即播放开机动画，「外观」里可调主题、预览 Windows / macOS 标题栏。
> 本计划基于 `main`（`e46d666`）的实际文件：`main.js`、`src/index.html`、`src/styles.css`、`src/group.css`、`src/avatars.js`。
> 视觉风格参考了 DSH 的 Aqua 玻璃主题插件和 550C 等开机动画插件，**只借鉴效果，代码全部自己写**（Aqua 是 AGPL-3.0）。

## 已确定的要求

| 项目 | 要求 |
|---|---|
| 主题 | 白色为主的玻璃质感，背景带一点流动，**阅读不受影响**；深色保留为可选 |
| 开机动画内容 | **组网 + 粒子字标**：Claude 在中心醒来，数据链路依次连向各 agent，每连通一个 logo 醒来；粒子汇聚成「AgentDesk」字标 |
| 开机动画风格 | **白色蓝图 HUD**：浅色点阵网格、细蓝线、蓝色光晕、等宽字体读数；固定这一套，不随深色主题变化 |
| 时长 / 声音 | 约 5 秒；静音 |
| 播放时机 | 每次启动 App 播放一次；最小化后恢复、从托盘或通知重新打开**不算启动** |
| 跳过 | **双击任意位置**直接进入；Esc / 回车 / 空格也可以；单击不跳过 |
| 平台 | Windows 和 macOS 都要符合各自的系统习惯 |

## 1. 开机动画

### 1.1 画面和时间线（秒）

| 时间 | 画面 |
|---|---|
| 0 ～ 0.6 | 浅色点阵网格淡入，十字基准线出现；一道扫描线从上到下扫过（1.3 秒） |
| 0.25 ～ 1.25 | Claude 周围的 HUD 依次画出：虚线内环、120 刻度环、三段反向旋转的弧、外轨道、雷达扫描扇面 |
| 0.9 | Claude（组长）醒来，开始抛杂耍球；下方显示「Claude · 组长 / ORCHESTRATING」 |
| 1.35 起，每 0.45 一个 | 数据链路从中心射向 Codex → Antigravity → Grok Build → 本机 Bridge；连通后有数据包沿线流动，节点外圈弹出、带旋转括号，logo 醒来；旁边显示「名称 / 职责 · 状态读数」。额度用尽的节点用琥珀色链路和电池提示 |
| 3.05 ～ 3.9 | 约 1600 个粒子从各节点飞出，汇聚成「AgentDesk」字标 |
| 3.95 ～ 4.45 | 实心字标带蓝色光晕淡入，粒子淡出；下方显示「CLAUDE 统筹 · 多 AGENT 协作 // SYSTEM READY 100%」 |
| 4.15 ～ 4.95 | 一道光从左到右扫过字标（只照亮字形） |
| 5.0 | 整体放大、模糊、淡出，主界面从轻微模糊中进入（0.7 秒） |

四角 HUD：左上「AGENTDESK // BOOT SEQUENCE · 版本 · 系统」，右上实时时钟（毫秒）和「VPS2 · 4 GB · DOCKER」，左下滚动启动日志（最多 6 行），右下「双击任意处或按 Esc 进入」。窄屏（< 560 px）隐藏右上和左下 HUD、节点职责和中心标签，缩小头像，副标题只显示进度。

### 1.2 用真实的启动检查驱动

原型里的检查是模拟的。正式版每个节点和每行日志都来自真实状态，动画本身就是一次启动自检：

| 节点 / 日志 | 数据来源（`main` 现有） | 显示 |
|---|---|---|
| link vps2 · ssh | `remote.js` 的 `status` 事件（`codex: 'ready'`） | OK + 握手耗时 |
| orchestrator | 主控线路状态（`orchestrator` 的 `route_status`） | ONLINE / RELAY / OFFLINE |
| docker · containers | 云任务服务的遥测（第 2 阶段提供；没有时这行不显示） | 运行中 / 上限 |
| Claude · Codex · Antigravity · Grok | `orchestrator/quotas.js` 的实时额度和登录状态 | READY / QUOTA 0% · 重置时间 / LOGIN REQUIRED |
| local bridge | 本机桌面开关、Bridge 授权 | AUTHORIZED / DESKTOP OFF |

规则：
- 节点按「检查完成」的顺序点亮，时间线里的 0.45 秒间隔是**最短间隔**，不是固定时长；所有检查在 5 秒内完成时按上表节奏播放。
- 某项检查超过 5 秒没有结果：该节点显示「WAITING」，动画照常结束进入主界面，不卡住启动；结果出来后在状态栏更新。
- VPS 连不上：节点显示红色「OFFLINE」，结束时提示「重试 / 离线进入」，不自动进入。
- 额度用尽、未登录只提示，不阻塞。

### 1.3 「每次启动播放一次」的实现

- 主进程在 `app.whenReady()` 时生成一个 `launchId`，通过 `preload.js` 暴露为 `window.desk.launch = { id, firstShow }`。
- 渲染层在 `sessionStorage` 里记录已播放的 `launchId`。同一次启动内页面重载、窗口最小化 / 恢复、`second-instance` 唤起、点通知重新显示都**不重播**。
- 设置「开机动画：每次启动 / 关闭」，并提供「立即重播」按钮。

### 1.4 首帧不闪

- `src/index.html` 的 `<body>` 第一个子元素就是开机动画容器，内联最少的样式（白色背景 `#f5f8fc`），保证页面第一帧就是开机画面。
- `BrowserWindow` 已经是 `show: false` + `ready-to-show` 后显示；把 `backgroundColor` 在开机动画期间设为 `#f5f8fc`，避免窗口先闪一下深色。
- 开机动画播放期间暂停其他动画（头像、流动背景），避免和启动时的界面初始化抢 GPU。

### 1.5 代码结构

| 文件 | 内容 |
|---|---|
| `src/boot.js`（新） | 从原型移植的 `runBoot` / `endBoot` / `bootLayout` / `wordPoints`；对外暴露 `window.AgentDeskBoot = { start(feed), end() }`；`feed` 是检查结果的事件源 |
| `src/boot.css`（新） | 原型中 `.boot*` 的样式 |
| `src/avatars.js`（已有） | 节点头像直接用 `AgentDeskAvatars.html(id, { state, size })`；成员 ID 用 `main` 的命名：`lead`、`codex`、`antigravity`、`grok`、`local` |
| `src/live.js` / `src/orchestrator.js`（已有） | 把连接、主控、额度事件转发给 `feed` |
| `preload.js`、`main.js`（已有） | `launchId`；开机期间的窗口背景色 |

## 2. 白色玻璃主题

### 2.1 外观

- 默认浅色。面板、卡片是白色磨砂玻璃；背景是缓慢流动的浅色渐变（5 团大色块缓慢漂移，低分辨率绘制再放大）。
- 「悬浮卡片」布局：侧栏、对话区、右侧面板之间留 10 px 间隙，圆角 14 px；也可选「贴合」。
- 品牌名是带 135° 渐变描边和光晕的胶囊；时间线上下边缘 16 px 渐隐。
- 可调：模糊（0～40 px）、磨砂（50～95%）、色相、背景亮度、自定义壁纸（含壁纸模糊）；可切回经典皮肤。

### 2.2 阅读优先（硬性要求）

- 对话区不透明度**不低于 90%**，输入框 96%；「磨砂」滑块下限 50%，调到最低也不影响阅读。
- 正文 `#24282e`、次要文字 `#4f5864`、更弱的文字 `#6f7884`，都在白底上检查过对比度。
- 流动背景只在面板间隙和边缘隐约可见；开启「减少动态效果」时背景静止。

### 2.3 系统原生毛玻璃

| 平台 | 做法 |
|---|---|
| Windows 11 | `BrowserWindow` 加 `backgroundMaterial: 'acrylic'`，页面背景改为半透明，让系统负责模糊桌面 |
| macOS | `vibrancy: 'under-window'`、`visualEffectState: 'active'` |
| Windows 10 或材质不可用 | 退回页面里绘制的流动背景 |

### 2.4 代码结构

| 文件 | 内容 |
|---|---|
| `src/aqua.css`（新） | 原型中 `:root[data-skin="aqua"]` 的全部规则和玻璃变量；只在 `data-skin="aqua"` 时生效，经典皮肤不受影响 |
| `src/fluid.js`（新） | 流动背景：约 15 帧/秒，窗口失焦、隐藏、减少动态效果、开机动画期间暂停 |
| `src/styles.css`（已有） | 新增玻璃相关的颜色变量（深浅两套） |
| 设置面板 | 「外观」卡片：皮肤、布局、模糊、磨砂、色相、亮度、壁纸、开机动画 |

## 3. Windows / macOS

| 项目 | Windows | macOS |
|---|---|---|
| 标题栏 | `titleBarStyle: 'hidden'` + `titleBarOverlay`（已有），按钮颜色跟随浅色主题 | `hiddenInset`（已有），左侧给红绿灯留 78 px |
| 窗口材质 | acrylic（Windows 11）；Windows 10 用页面背景 | vibrancy |
| 字体 | Segoe UI Variable / 微软雅黑；Cascadia Code | -apple-system / 苹方；SF Mono |
| 快捷键提示 | Ctrl | ⌘ |
| 开机动画左上角 | `WINDOWS` | `MACOS` |

平台差异集中在一处：页面根元素加 `data-os="win|mac"`，样式按它切换，不在各处写 `if (mac)`。

## 4. 验收标准

- [ ] 冷启动第一帧就是白色开机画面，没有深色或空白闪烁
- [ ] 开机动画约 5 秒，各节点状态和真实检查一致；VPS 断开时给出「重试 / 离线进入」
- [ ] 双击、Esc、回车、空格都能立即进入；单击不跳过
- [ ] 最小化后恢复、托盘或通知唤起、第二次启动唤起已有窗口：都不重播
- [ ] 「减少动态效果」开启时：开机只显示约 1 秒静态画面；背景和头像不动
- [ ] 白色主题下，任意滑块组合都能清楚阅读对话
- [ ] Windows 11、Windows 10、macOS 各验收一遍：标题栏、毛玻璃、字体、快捷键提示
- [ ] 1440×900 和最小窗口 960×600 下开机动画不重叠、不出界

## 5. 顺序与工作量

| 步骤 | 内容 | 估计 |
|---|---|---|
| 1 | `src/boot.js` / `boot.css` 移植，`launchId`，首帧不闪，模拟数据先跑通 | 1.5 天 |
| 2 | 接入真实检查（连接、主控、额度、本机），失败处理 | 1 天 |
| 3 | `src/aqua.css` + `src/fluid.js`，设置面板 | 2 天 |
| 4 | 系统毛玻璃（acrylic / vibrancy）和双平台样式 | 1 天 |
| 5 | 三个平台验收、性能检查 | 1 天 |
