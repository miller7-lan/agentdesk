# 现状评估与下一步（2026-11-17）

> 结论：**还没有达到产品级。** 多 agent 协作的「骨架」已经在 `codex/agentdesk-dual-vps` 分支上写出来了，而且质量不错；但它和我们确定的设计（Claude 当组长、Antigravity 分担、省额度、容器、微信、群聊界面）还有明显差距，三条分支也还没合到一起。

## 1. 仓库里现在有什么

| 分支 | 内容 | 测试 | 状态 |
|---|---|---|---|
| `main` | AgentDesk 0.2.7：Windows 桌面端，单个 Codex 对话，本机桌面和文件工具 | 11 个，通过 | 基线 |
| `fix/resume-active-writer` | 修复休眠后恢复会话；时间线折叠重复的工具命令 | 11 个，通过 | **未合并** |
| `codex/agentdesk-dual-vps` | 双 VPS 架构：VPS 1 中转（Python）、VPS 2 主控（Node），调度 Codex / Claude Code / Grok Build；macOS 版界面 | Node 17 个 + Python 8 个，全部通过 | **未合并**，与上一条分支有 6 个文件重叠 |
| `claude/sharp-brown-0fzzdv` | 规划文档和群聊界面原型，没有改代码 | — | 文档 |

### `codex/agentdesk-dual-vps` 已经做到的（值得保留）

- 任务写入 SQLite，断线、重启后能恢复；同一个任务 ID 重复提交不会重复执行。
- 每个子步骤有独立的 Git worktree、进程、会话和日志；只有被允许写的步骤能改文件，只读步骤改了文件会被拒绝。
- 补丁先留在 VPS 上，等你审核后再写回本机，写回前核对 Git 基线和冲突。
- 两条线路（SSH 直连 / TLS 中转）可切换，写入和命令有操作记录，断线后能查询结果而不是盲目重试。
- 三个 CLI 的适配器已经写好，包括无交互调用参数、会话恢复、只读限制、日志脱敏、超时和输出上限。

## 2. 和确定的设计相比，差在哪里

| 需求 | 现状 | 差距 |
|---|---|---|
| **Claude 当组长**：规划、派活、把控方向、验收 | 规划步骤固定由 **Codex** 执行（`scheduler.js` 里 `planner.role = 'codex'`）；没有验收步骤，计划执行完直接等人工审核 | 规划改由 Claude；新增「Claude 只看摘要验收」 |
| **Antigravity 分担重活** | 适配器只有 codex / claude / grok | 新增 Antigravity 适配器；侦察、简报、汇总交给它 |
| **省 Claude / Codex 额度** | 不记录 token 用量；没有升级阶梯；只写代码的限制是「只有 Codex 能写」 | 记录每步用量；实现侦察 → 规划 → 简报 → 改代码 → 测试 → 审查 → 验收的流程和升级规则 |
| **容器 + 定期清理** | 直接以服务账户运行 CLI，用 worktree 隔离文件；worktree 和日志要手动清理 | 每步加资源限制（容器或 systemd 沙盒）；加定时清理 |
| **状态可见** | 有任务和步骤状态、事件序号 | 需要接到群聊界面和微信上 |
| **群聊界面** | 只有 macOS 的「线路与模型」对话框（`src/orchestrator.js` 在非 macOS 上直接返回） | Windows 端还没有任何主控界面；群聊界面只有原型 |
| **微信入口** | 无 | OpenClaw + ClawBot + 任务技能 |
| **基础问题（ROADMAP P0）** | 三条代码分支上**都还在**：配置写错会被覆盖、外链会开新窗口、只读模式也能控制桌面、桌面超时会杀掉整个后端、版本号不一致 | 先修 |
| **CI** | 没有 | Windows + Linux 跑 Node 和 Python 测试 |

## 3. 接下来怎么做（按顺序）

### 第 0 步：合并分支、补安全底线（1～2 天）

1. 把 `fix/resume-active-writer` 合进 `main`。
2. 把 `codex/agentdesk-dual-vps` 基于新的 `main` 合并，解决 6 个重叠文件（`main.js`、`remote.js`、`src/app.js`、`src/index.html`、`src/live.js`、`src/styles.css`）的冲突，跑全部测试。
3. 修 ROADMAP 第 3 节的 5 个 P0 问题。
4. 加 GitHub Actions：`node --test` 和中转服务的 Python 测试。

不先合并的话，后面每做一项都要在三条分支上各改一遍，冲突只会越来越多。

### 第 1 步：让主控按确定的分工工作（约 1 周）

1. 规划步骤改由 Claude 执行，计划格式里加上「谁来做、验收标准」。
2. 新增 Antigravity 适配器（先在 VPS 上验证它的无交互调用参数和登录方式）。
3. 把一个任务固定成：Antigravity 侦察 → Claude 规划 → Antigravity 写简报 → Codex 改代码 → 自动测试 → Grok 审查 → Antigravity 汇总 → Claude 验收。
4. Claude 只在规划、出问题、验收时被唤醒，拿到的都是摘要。
5. 测试连续失败 2 次、审查意见冲突时交回 Claude；每次升级记成一条事件。
6. 从 Codex 的 `--json` 和 Claude 的 `stream-json` 输出里记录每步 token 用量，写进任务记录。
7. 同一个 CLI 同一时刻只跑一个步骤，避免订阅令牌刷新互相覆盖。

### 第 2 步：隔离和清理（2～3 天）

1. 每个步骤加内存和 CPU 上限：可以用 Docker，也可以用 `systemd-run --scope -p MemoryMax=1G`，后者更轻。
2. 加定时清理：成功任务的 worktree 和日志保留 3 天，失败的保留 7 天；磁盘剩余低于 15% 时提前清理。

### 第 3 步：Windows 群聊界面（2～3 周）

1. 先把 macOS 的主控面板移到 Windows（提交任务、看状态、应用补丁、切换线路），保证 Windows 能完整使用。
2. 再按 [群聊界面原型](prototype/group-chat.html) 改版：任务事件转成群聊消息，步骤状态驱动头像动画，审批和应用补丁做成卡片。

### 第 4 步：微信入口（3～5 天）

OpenClaw + ClawBot 接个人微信；写一个只调用主控管理接口（提交、查状态、停止）的技能；任务状态变化时主动推送。

### 第 5 步：产品化收尾（持续）

首次运行向导、日志和诊断包导出、代码签名和自动更新、用户文档。见 [ROADMAP.md](ROADMAP.md) 的 M3 / M4。

## 4. 需要你确认

1. **VPS 用几台？** 现在代码是双 VPS（VPS 1 中转、VPS 2 主控），之前的方案按一台 4 GB VPS 设计。4 GB + 2 GB swap 的是哪一台？主控和四个 CLI 都要放在那一台上。
2. **隔离方式**：用 Docker 容器（隔离更彻底、占用略多），还是 systemd 资源限制（更轻、和现有代码改动更小）？
3. **合并分支**：可以由我来合并 `fix/resume-active-writer` 和 `codex/agentdesk-dual-vps`，并把冲突的解决方式写清楚吗？
