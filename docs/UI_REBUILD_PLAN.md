# 界面重构计划：指挥中心 + 液态玻璃 + 组件化

> 2026-11-18 定稿草案。原型：[prototype/command-center.html](prototype/command-center.html)（模拟数据，可点）。

## 已定的方向

| 项 | 决定 |
|---|---|
| 布局 | **指挥中心**：顶部常驻额度卡片，下面一条派活栏，主区是任务看板（待确认方案 / 执行中 / 待你处理 / 已完成），点任务从右侧拉出详情抽屉 |
| 额度卡片 | **双环 + 详情**：外环 5 小时窗口、内环每周窗口，中间大字是较满的那个；旁边写两个窗口的百分比和重置时间、今日任务次数；底部一条用量条标出软线和硬线；最下一行是它此刻在做什么 |
| 视觉 | **白色液态玻璃，精修**：参考 Apple Liquid Glass 的原则，自己实现，不引入第三方玻璃库 |
| 重构范围 | **界面和前端代码一起重写**：组件化，按页面逐步迁移 |

## 信息结构

```
左侧导航   指挥中心 | 我的单聊 | 工作区 | 诊断 | 外观
指挥中心
  顶栏       项目筛选（全部 / 各项目）· VPS2 线路状态 · Relay 备用
  额度条     每个成员一张双环卡片 · VPS2 资源卡（内存、交换、容器、磁盘）
  派活栏     「待你处理 N」· 输入框 · 项目 · 执行者（由组长分派 / @成员直接改 / @Antigravity 查资料）· 发送
  看板       待确认方案 | 执行中 | 待你处理 | 已完成（已完成只列最近若干项）
  抽屉       概览（组长方案、分工进度、完成总结、验收总结）| 每个成员一页（组长派遣的任务说明 + 工作过程）| 补丁（差异 + 应用到本机）
             底部按钮随状态变：确认方案 / 要求调整、应用到本机 / 打回返工、停止
我的单聊     左边会话列表（按项目），右边对话；工作过程同抽屉里的成员页
```

现在的群聊时间线由“看板 + 抽屉”取代：组长方案、分工进度、接受与完成总结都在抽屉的概览页；组长派遣记录就是抽屉里的成员页。侧栏里的「派遣」会话不再需要。

## 每块界面的数据来源（全部是现有接口）

| 界面 | 主控操作 |
|---|---|
| 额度卡片 | `quota_status`：各成员的 `buckets[].fiveHour/weekly`（`usedPercent`、`resetsAt`）、`level`、`policy.soft/hard`、停用原因 |
| 卡片底部“在做什么” | `project_tasks` 中正在运行的步骤 |
| 今日任务次数 | `project_tasks` 的 `metrics.roleCalls`（按今天过滤） |
| VPS2 资源 | `resource_status` |
| 看板 | `project_tasks`（列 = 任务状态映射：`awaiting_details/awaiting_approval/planning` → 待确认方案，`queued/running/testing/applying/triaging/awaiting_acceptance` → 执行中，`needs_review` → 待你处理，`completed/failed/cancelled` → 已完成） |
| 抽屉概览、成员页 | `status`（含每步 `brief`、`output`、`verdict`）、`task_activity` |
| 补丁页 | `task_diff`，应用用 `apply` |
| 线路 | `routes`、`select_route` |

## 液态玻璃规范

- **只给浮层用玻璃**：左侧导航、顶栏、额度卡片、派活栏、抽屉。任务卡片、对话内容、代码和差异放在实底白卡上，保证阅读。
- **材质**：`backdrop-filter: url(#lens) blur(18px) saturate(180%)`，底色 `rgba(255,255,255,.42)`。`#lens` 是 SVG 滤镜（`feTurbulence` → `feGaussianBlur` → `feDisplacementMap`），让背后的光轻微弯折。Electron 用 Chromium，支持滤镜引用；系统开了“减少透明度”时退回不透明白底。
- **高光**：左上方来光：内阴影亮边 + 左上角径向高光。
- **同心圆角**：外层 22px、内边距 10px、内层 12px；任何嵌套都按“内层 = 外层 − 内边距”算。
- **背景**：三团柔光（青、蓝、暖橙）缓慢漂移，与开机动画同一套颜色；减少动态效果时静止。
- **颜色语义**：正常 青 `#2fb59c`，只接主业 琥珀 `#d08a1c`，已停 红 `#d4485e`，需登录 灰 `#9aa6b6`；品牌渐变 `#2fb59c → #5b7be8` 只用在主按钮和进度。
- **深色模式**：同一套结构，玻璃底色换成 `rgba(28,32,38,.5)`，在第 4 阶段做。

## 组件化方案

- 用 **Preact + htm**：一个约 10 KB 的库文件放进 `src/vendor/`，不需要打包工具，符合现在 `script-src 'self'` 的安全策略。组件就是返回 HTML 模板的函数，状态变了只重绘变化的部分，不再整块 `innerHTML`。
- 目录：`src/ui/`（`app.js` 入口、`store.js` 状态、`api.js` 封装主控操作和轮询、`components/` 各组件、`styles/` 设计变量和玻璃材质）。
- 状态集中在 `store.js`：任务、额度、资源、线路、打开的抽屉；轮询统一在 `api.js`（看板 3 秒、运行中的步骤工作过程 2.5 秒、额度 30 秒）。
- 保留不动：主进程 `main.js`、`preload.js` 和全部主控接口；开机动画、头像动画（`avatars.js`）作为现成模块接入。

## 分阶段迁移（每阶段可用、可测、可回退）

1. **骨架与材质**：引入 Preact + htm、设计变量、玻璃材质、左侧导航、顶栏；旧界面挂在“经典视图”入口下照常可用。
2. **额度条与资源卡**：接 `quota_status`、`resource_status`，替换状态栏里的额度小条。
3. **看板与派活栏**：接 `project_tasks`、`submit`、`start_plan`；卡片显示成员步骤和进度。
4. **抽屉**：概览、成员页（工作过程）、补丁页和全部操作按钮；完成后群聊时间线和「派遣」会话下线。
5. **我的单聊**：迁移现有单聊（Codex 直连和其他成员）到新组件，含工作过程。
6. **收尾**：深色模式、窄窗口（960×600）布局、键盘操作、减少动态效果和减少透明度、删除旧代码。

每阶段都用 Playwright 在 1440×900 和 960×600 截图核对，并保持 `npm test` 和三系统 CI 全绿。

## 待你确认

1. 原型的整体观感（玻璃强度、颜色、密度）是否可以作为基准。
2. 群聊时间线完全由“看板 + 抽屉”取代，可以吗？（取代后不再有按时间滚动的群聊消息流。）
3. 已完成一列默认只显示最近多少项（原型里不限）。
4. 窄窗口下额度条改成两行两列、看板改成两列，可以吗？

## 参考

- Apple WWDC25「Meet Liquid Glass」：https://developer.apple.com/videos/play/wwdc2025/356/
- Liquid Glass 设计原则综述：https://www.createwithswift.com/liquid-glass-redefining-design-through-hierarchy-harmony-and-consistency/
- 开源网页实现（只参考做法，未引入代码）：liquid-glass-react（rdev）、quidlass、liquid-glass-js、archisvaze/liquid-glass；它们普遍基于 kube.io 的「liquid-glass-css-svg」SVG 位移滤镜思路。
