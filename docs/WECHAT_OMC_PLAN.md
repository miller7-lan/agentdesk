# 方案：微信入口 + oh-my-claudecode 多 agent 协作

> 2026-11-16。承接 [MULTI_AGENT_RESEARCH.md](MULTI_AGENT_RESEARCH.md)。
> 目标：在微信里给「组长 agent」发任务；组长用 oh-my-claudecode（下称 OMC）调度 Claude / Codex / Gemini 等子 agent 分工完成；结果和需要审批的事项回到微信与 AgentDesk。

## 1. 先说清楚两个硬限制

**限制一：个人微信目前做不了「多个 agent 在微信群里聊」。**

- 腾讯官方的微信 ClawBot 插件（底层是 iLink 协议，2026 年 3 月下旬开始灰度）**只支持单聊**，不支持群聊和微信自动化。要求 iOS 微信 8.0.70 及以上，在「我 → 设置 → 插件」里扫码连接。该信息来自第三方报道，以腾讯官方文档为准。
- cccc 的微信桥同样**仅支持与机器人单聊**：扫码登录，群消息不支持（其 SDK 拿不到稳定的群 ID），只推送最终消息，不推送中间过程。
- 用 wechaty 类非官方协议或 hook 注入可以进群，但有封号风险，并且等于把电脑控制权交给一个非官方程序。**不建议使用。**

所以「群聊」发生在 agent 侧（cccc 的 Group 或 OMC 的 team），**微信只是你和组长之间的一对一遥控器**。如果一定要在 IM 群里看到多个 agent 发言，用**企业微信**：官方支持，cccc 的企业微信桥还支持流式输出。

**限制二：OMC 没有微信，也没有远程触发入口。**

- OMC 的通知能力：会话结束时向 Telegram / Discord / Slack 推送摘要（`omc config-stop-callback …`），以及把 6 类 hook 事件（session-start、stop、ask-user-question、pre/post-tool-use 等）**单向**转发到 OpenClaw 网关。
- OMC 的 README 明确说 `/team`、`/autopilot` 等斜杠命令需要一个**正在运行的 Claude Code 会话**，没有用来远程发起任务的 webhook 或 API。
- `omc team N:codex` 这类终端团队依赖 **tmux**，因此要跑在 Linux / WSL 上，不能在原生 Windows 上运行。

结论：需要一个「中枢」负责收发微信消息，并把消息送进一个常驻的 Claude Code + OMC 会话。最现成的中枢是 **cccc**。

## 2. 推荐架构

```
 微信（单聊 ClawBot/扫码）     企业微信群（可选，需要群聊时用）
            │                            │
            └──────────┬─────────────────┘
                       ▼
        ┌─────────── cccc 守护进程（VPS / Linux）──────────┐
        │  Group「dev」 追加式账本：消息 / 任务 / 产物       │
        │                                                    │
        │  foreman：Claude Code + OMC 插件  ◀── 微信消息默认送达这里
        │     │  /team、omc team 2:codex、/ask codex …       │
        │     ├─ Codex worker（tmux）   实现 / 跑测试          │
        │     ├─ Gemini/Antigravity worker（tmux）  第二意见   │
        │     └─ Claude 子 agent       审查 / 验证            │
        │                                                    │
        │  peer：Codex App Server 会话（AgentDesk 现有链路） │
        └────────────────────────────────────────────────────┘
                       ▲
                       │ SSH（现有链路）
        AgentDesk（Windows）：看群聊、看 diff、审批、本机桌面/文件工具
```

各部分职责：

| 组件 | 职责 | 为什么选它 |
|---|---|---|
| 微信 / 企业微信 | 发任务、收结果、`/status` `/pause` `/resume` | 手机随时可用 |
| cccc | IM 桥接、Group 账本、把消息路由给 foreman、`@角色` 点名 | 现成的微信与企业微信桥；Claude Code 可以通过 MCP + hooks 接入为会话 |
| Claude Code + OMC | 组长：拆任务、开 team、派给不同 CLI、验收 | OMC 的 plan → exec → verify → fix 流水线，加上多 CLI worker |
| Codex / Gemini worker | 按分工干活 | 由 OMC 在 tmux 中拉起，干完即退出 |
| AgentDesk | 桌面端查看、审批、本机 Windows 能力 | 已有的审批 UI 与本机工具，承担微信不适合做的事 |

一条消息的流转：
1. 你在微信发「修一下登录超时的 bug，改完跑测试」。
2. cccc 把这条消息作为 `/send @foreman` 投递给 Claude Code 会话。
3. Claude（装了 OMC）走 team 流水线，例如 `omc team 1:codex` 负责实现，Claude 子 agent 负责审查，必要时用 `/ask antigravity` 拿第二意见。
4. 遇到需要审批的操作（OMC 的 ask-user-question / pre-tool-use 事件），发到 AgentDesk 审批，微信端只收到一条「有待审批」的提醒。
5. 完成后组长在 Group 里回复摘要，cccc 把最终消息推回微信，完整 diff 在 AgentDesk 里看。

## 3. 分工建议（扬长补短）

| 角色 | 执行者 | 做什么 | 不做什么 |
|---|---|---|---|
| 组长 | Claude Code + OMC | 拆解、派活、汇总、决定是否完成 | 不直接大规模改代码 |
| 实现 | Codex（OMC worker，或 AgentDesk 现有的 Codex 会话） | 写代码、跑测试 | 不做最终验收 |
| 第二意见 | Gemini / Antigravity worker | 方案对比、长上下文阅读 | 不写代码 |
| 审查 | Claude 子 agent（与实现者不同厂商） | 只读审查 diff | 不改代码 |
| 本机操作 | AgentDesk 的桌面与文件工具 | 只在需要操作 Windows 时调用 | 不从微信直接触发 |

原则：**写权限同一时刻只给一个角色**；并行的角色只读，或者各自在独立的 git worktree 里工作。

## 4. 安全边界（必须在上线前做到）

微信账号等于一个能远程改代码、执行命令的入口，所以：

1. **微信只能发任务，不能批准高危操作。** 完全访问、删除文件、本机桌面控制等操作的审批只能在 AgentDesk 里完成（对应 ROADMAP 里的 P0-2 和权限矩阵）。
2. **白名单**：cccc 中只授权你自己的微信账号；如果用企业微信群，限定群成员和 @机器人 的范围。
3. **从微信发起的会话默认不开完全访问**；VPS 上的 Codex 维持 workspace-write 沙盒。
4. **审计**：每条微信指令、派出的子任务、执行的命令都写入 cccc 账本和 AgentDesk 的审计日志，两边可以对照。
5. **熔断**：微信里 `/pause` 立即停止所有 worker；在 AgentDesk 里也要有对应按钮。

## 5. 资源与前置条件

- **VPS 内存是最大障碍。** `workspace.js` 的注释写着 VPS 只有 1 GB 内存。Claude Code + Codex + cccc + 若干 tmux worker 同时运行，1 GB 基本不够，**建议至少 4 GB**。另一种做法是把中枢放到 Windows 的 WSL 里（但这样电脑必须开机，cccc 也写明原生 Windows 的会话接入尚未完成验收）。
- Claude Code 需要 ≥ 2.1.306（cccc 会话接入的要求）；cccc 的 Claude 会话接入功能**标注为实验性**，目前在 Linux / WSL 上测试过。
- 需要在 VPS 上登录 Claude Code、Codex CLI、Gemini/Antigravity CLI 各自的账号。
- 个人微信需要 ClawBot 灰度资格（iOS 8.0.70+）；cccc 的微信桥使用扫码登录。没有资格的话，先用企业微信。

## 6. 实施步骤

**阶段 1：跑通链路（约 3 天，不改 AgentDesk）**
1. 将 VPS 扩容到 ≥ 4 GB，安装 tmux、Claude Code、OMC（`omc setup`）、cccc。
2. `cccc sessions enable --runtime claude`，把 Claude Code 会话接入名为 dev 的 Group，并确认它是 foreman。
3. 在 cccc Web UI 里扫码连接微信，发送 `/status` 验证收发。
4. 从微信发一个只读任务（「审查最近一次提交」），确认 `omc team 1:codex` 能被组长拉起，并且结果回到了微信。

**阶段 2：接入 AgentDesk（约 1-2 周）**
1. AgentDesk 新增「群聊」视图：通过 SSH 隧道读取 cccc 的 Group 账本（或直接嵌入 cccc 的 Web UI，最快）。
2. 审批回流：把 OMC 的 ask-user-question / pre-tool-use 事件路由到 AgentDesk 的审批卡片；微信端只显示提醒。
3. 让 AgentDesk 现有的 Codex App Server 会话作为 Group 的一名 peer，使本机桌面和文件工具可以被组长点名调用（仍需在 AgentDesk 里审批）。

**阶段 3：打磨（持续）**
- 企业微信群模式：组长和各 worker 的发言以不同前缀显示在群里。
- 成本控制：team 并发上限、每日 token 预算，超出时在微信里提醒。
- 角色配置文件化：采用 `.agentdesk/agents/*.md`，见调研文档第 5 节。

## 7. 备选路线

- **OpenClaw 路线**：微信 ClawBot 原生对接 OpenClaw，OMC 也能把事件转发到 OpenClaw 网关。但 OMC 到 OpenClaw 是单向的，从 OpenClaw 反向触发 OMC 的 team 没有现成文档，需要自己写桥接，可行性要先验证。
- **完全自研**：用企业微信官方 API 加上 OMC 的库接口 `createOmcSession()`（基于 Claude Agent SDK）。控制力最强，但 OMC README 说明这只是一个库接口，不能替代插件界面，team 等功能能否完整使用要先验证。

## 8. 待你决定

1. 个人微信单聊够用，还是需要企业微信群（想在群里看到多个 agent 各自发言）？
2. VPS 是否可以扩容到 ≥ 4 GB？不行的话，中枢就放 WSL，电脑需要常开。
3. 除 Claude 和 Codex 外，是否还要接入 Gemini / Antigravity / Grok？

## 参考来源

- oh-my-claudecode README：https://github.com/Yeachan-Heo/oh-my-claudecode
- cccc README 与 IM 桥文档：https://github.com/ChesterRa/cccc 、`docs/guide/im-bridge`
- 微信 ClawBot / iLink（第三方报道，需要以官方文档核实）：https://ai-bot.cn/clawbot/ 、https://allclaw.org/zh/blog/what-is-ilink-zh 、https://tech.ifeng.com/c/8rhMPwE5mJz
