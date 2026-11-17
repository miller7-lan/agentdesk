# 主 Agent 调度子 Agent（群聊模式）开源项目调研

> 调研日期：2026-11-16。星数和最近推送时间取自当天的 GitHub 搜索 API；项目特性取自各仓库 README。
> 目标：找到「一个主 agent 统筹、多个子 agent 各干各的活、扬长补短」的项目，类似 Grok Heavy 那种多 agent 协作，并且要有群聊式的交互。评估它们能否接入 AgentDesk，或者值得借鉴哪些设计。

## 1. 结论先行

| 需求 | 最合适的项目 | 理由 |
|---|---|---|
| **群聊模式**：多个 coding agent 在一个「群」里互相 @、有组长 | **ChesterRa/cccc** | 唯一把「群聊」当核心交互的项目：有 foreman（组长）、`@all` / `@peers`、消息回执、手机远程操作、多种 IM 桥接；Codex 与 Claude Code 都能直接接入 |
| **分工协作**：主 agent 把任务派给不同模型的专家 | **alvinunreal/oh-my-opencode-slim**、**Yeachan-Heo/oh-my-claudecode** | 角色清晰（编排 / 侦察 / 顾问 / 实现 / 设计），每个角色单独配模型，并写明了这样配的理由 |
| **Grok Heavy 式**：多个 agent 并行做同一题，再投票或汇总 | **massgen/MassGen** | 并行 + 互评 + 投票收敛，后端可以混用 Claude Code / Codex / Gemini / Grok |
| **最轻量的借鉴**：给子 agent 指定由哪个 CLI 执行 | **shinpr/sub-agents-skills** | 一个 Markdown 文件定义一个子 agent，frontmatter 里的 `run-agent: codex / claude / grok / gemini` 决定由谁执行，设计可以直接照搬 |

**对 AgentDesk 的建议**：不引入重型框架，**参考 cccc 的群聊协议，结合 sub-agents-skills 的角色定义方式**，在 AgentDesk 里自己实现一个「群聊编排层」（见第 5 节）。

## 2. 候选项目一览

星数和推送时间截至 2026-11-16。

### 2.1 面向 coding CLI 的编排器（与 AgentDesk 最相关）

| 仓库 | ⭐ | 最近推送 | 许可证 | 形态 | 一句话 |
|---|---|---|---|---|---|
| [ChesterRa/cccc](https://github.com/ChesterRa/cccc) | 1.3k | 2026-11-16 | Apache-2.0 | Rust 守护进程 + Web UI / TUI / IM 桥接 | 「像群聊一样协调你的 coding agents」 |
| [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 40.9k | 2026-11-16 | MIT | Claude Code 插件 | 以团队为核心的多 agent 编排，可以拉起 Codex / Gemini / Grok 等 CLI 作为 worker |
| [alvinunreal/oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) | 10.2k | 2026-11-16 | MIT | OpenCode 插件 | 精简的多 agent 套件，可以混用任意模型，自动委派 |
| [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)（原 oh-my-opencode） | 70.9k | 2026-11-16 | **SUL-1.0（非 OSI）** | 基于自家 pi 分支 senpi | 任务拆成 agent 图，每部分用合适的模型并行执行 |
| [ruvnet/ruflo](https://github.com/ruvnet/ruflo)（原 claude-flow） | 81.9k | 2026-11-16 | MIT | MCP server + 插件 | Queen 领导的蜂群拓扑，主要服务 Claude Code，也支持 Codex |
| [massgen/MassGen](https://github.com/massgen/MassGen) | 1.2k | 2026-06-12 | Apache-2.0 | Python TUI | 多 agent 并行、互评、投票收敛 |
| [shinpr/sub-agents-skills](https://github.com/shinpr/sub-agents-skills) | 101 | 2026-10-22 | MIT | Agent Skill | 跨 CLI 的子 agent 路由 |
| [josstei/maestro-orchestrate](https://github.com/josstei/maestro-orchestrate) | 490 | 2026-11-02 | — | 插件 | Gemini CLI / Claude Code / Codex / Qwen Code 下的 39 个专家并行子 agent |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8.8k | 2026-11-13 | — | TUI | 同时管理多个终端 agent（各自独立工作，不协作） |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28.7k | 2026-11-15 | — | 看板 Web UI | 用看板派任务给 Claude Code / Codex 等，人是调度者 |
| [Doriandarko/make-it-heavy](https://github.com/Doriandarko/make-it-heavy) | 1.1k | 2025-07-16 | MIT（10 万用户以上须署名） | Python 脚本 | 模拟 Grok Heavy：4 个 agent 并行研究，再汇总 |
| [BeehiveInnovations/pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server)（原 zen-mcp） | 11.8k | **2025-12-15** | — | MCP server | 让 Claude Code / Codex 咨询其它模型。已近一年没有推送 |

### 2.2 通用多 agent 框架（若要自研编排层）

| 仓库 | ⭐ | 最近推送 | 备注 |
|---|---|---|---|
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | 14.7k | 2026-11-16 | AutoGen 的官方继任者，支持 Python / .NET |
| [microsoft/autogen](https://github.com/microsoft/autogen) | 61.9k | 2026-11-12 | **README 已声明归档、不再维护**，新项目不要用 |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 61.0k | 2026-11-16 | 角色扮演式 crew，概念最直观 |
| [agno-agi/agno](https://github.com/agno-agi/agno) | 43.2k | 2026-11-16 | 支持 Team 模式 |
| [agentscope-ai/agentscope](https://github.com/agentscope-ai/agentscope) | 36.1k | 2026-11-16 | Leader–worker 的 Agent Team；按回合路由模型；自带飞书 / Discord 通道 |
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | 30.7k | 2026-11-16 | handoff 机制，轻量 |
| [camel-ai/camel](https://github.com/camel-ai/camel) | 18.0k | 2026-11-16 | 角色扮演 / workforce |
| [OpenBMB/ChatDev](https://github.com/OpenBMB/ChatDev) | 34.8k | 2026-11-06 | 「虚拟软件公司」，偏研究 |
| [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 71.3k | **2026-01-21** | 推送已放缓 |
| [langchain-ai/langgraph-supervisor-py](https://github.com/langchain-ai/langgraph-supervisor-py) | 1.7k | 2026-07-15 | **已归档** |

## 3. 重点项目拆解

### 3.1 cccc：真正的「群聊」

- **架构**：本地单一守护进程负责写入每个 Group 的追加式账本（消息、事件、任务、共享上下文）。Web UI、TUI、CLI、MCP 工具和 IM 桥接都经过它。
- **角色**：第一个加入 Group 的 agent 自动成为 **foreman（组长）** 负责统筹，后加入的是 peers。可以用 `@foreman`、`@peers`、`@all` 指定接收者。
- **三种消息语义**：Send（立即送达）、Send + Reply（跟踪回复）、Mail（进入对方收件箱，不打断当前工作）。把「打断」和「不打断」区分开，这是群聊式协作的关键设计。
- **接入方式**：Claude Code、Codex CLI、OpenCode、Pi 可以作为已有会话接入；另外还能运行 Grok Build、Cursor、Kimi Code、Cline、Amp 等。README 的支持列表里没有 Gemini CLI。
- **远程**：Web UI 可以在手机上用（Admin Token + HTTPS）；IM 桥接支持 Telegram、Slack、Discord、飞书、钉钉、企业微信、微信（仅私聊），可以在聊天里查看状态、暂停或恢复。
- **安装**：Windows 有 PowerShell 安装脚本，也可以 `pip install cccc-pair`，或用 Docker。
- **风险**：星数少（1.3k），属于小团队项目；它自带 Web UI，与 AgentDesk 的界面有重叠。

### 3.2 oh-my-opencode-slim：「扬长补短」写得最清楚

各角色的分工、推荐模型和理由（摘自其 README）：

| 角色 | 职责 | 选模型的原则 |
|---|---|---|
| Orchestrator | 规划、派活、汇总、验收 | 指令遵循和判断力，比吞吐量重要 |
| Explorer | 代码库侦察、外部资料 | 便宜、快，不需要顶级推理 |
| Oracle | 架构决策、疑难调试、代码审查 | 强推理、高推理强度 |
| Fixer | 按计划实现有边界的改动 | 稳定高效地写代码 |
| Designer | UI/UX 实现 | 前端与视觉判断力 |
| Observer（可选） | 读截图 / PDF | 多模态，替不支持多模态的编排者看图 |
| Council（按需） | 多模型共识 | 用不同厂商的模型拿到不同视角；贵，不自动触发 |

委派方式：编排者把专家作为后台任务派出，汇总结果后再继续；也可以手动 `@agent 任务`。支持把每个 agent 开在独立的终端分屏里，方便观察。

### 3.3 oh-my-claudecode：Claude 做组长，其它 CLI 当工人

- `omc team N:codex`、`omc team N:gemini` 等命令会在 tmux 分屏中拉起对应 CLI 作为 worker（也支持 antigravity、grok、cursor）。
- 流水线分为 plan → prd → exec → verify，失败时进入 fix 循环；最终由组长审批。
- 「三模型顾问」：Claude 汇总 `/ask codex` 和 `/ask antigravity` 的结果。
- 4.4.0 起不再用 MCP 包装其它模型，改为直接调用对方 CLI。这个演进方向值得注意：**直接驱动对方的完整 CLI，比把对方包成工具更能发挥对方的长处**。

### 3.4 MassGen / make-it-heavy：Grok Heavy 式「并行再收敛」

- MassGen：每个 agent 都完整解答整道题，可以使用不同的前沿模型；agent 之间互相观察、批评、改进，答案稳定后投票选出最终结果。后端支持 Claude / Claude Code / Gemini / Grok / OpenAI / Codex 和本地模型。仍处于早期阶段，作者提示架构可能会有破坏性变更。
- make-it-heavy：先由编排者生成 4 个不同角度的子问题，4 个 agent 并行回答，最后由一个综合 agent 汇总。代码很少，适合用来理解这种模式，不适合直接用。
- 这类方案适合**难题求解 / 方案评审**，不适合日常改代码，因为多个 agent 同时改同一份代码会冲突，成本也会翻几倍。

### 3.5 sub-agents-skills：最小可借鉴单元

```markdown
---
run-agent: codex        # 由哪个 CLI 执行：codex / claude / grok / gemini / glm / kimi
model: ...
effort: high
permission: read-only   # read-only / safe-edit / yolo
---
## Task
审查当前分支的改动……
## Done When
输出按严重程度排序的问题列表
```

每个子 agent 是一个文件，权限级别写在定义里。这种格式和 AgentDesk 现有的「技能」上传机制很接近，可以直接沿用。

## 4. 需要警惕的点

- **ruflo（原 claude-flow）**：星数很高，但 README 里有不少无法核实的数字（路由「89% 准确率」、对比 LangGraph / AutoGen 的基准结果放在外部 gist 里），agent 数量前后写法不一致，扩展不在沙盒中运行，还夹带商业推广。不建议作为依赖。
- **oh-my-openagent**：许可证是 SUL-1.0，不是 OSI 认可的开源协议；而且已经从 OpenCode 迁到作者自己的 pi 分支上。集成或借鉴代码之前要先读许可条款。
- **AutoGen、langgraph-supervisor**：已归档，不要选。
- **pal-mcp-server**：近一年没有推送。
- **成本**：并行多 agent 会让 token 消耗成倍增长。cccc 用 Mail 语义避免打断，oh-my-opencode-slim 不自动触发 Council，都是在控制成本，自研时也要有同样的开关。

## 5. 对 AgentDesk 的落地建议

AgentDesk 已经具备的基础：与 Codex App Server 之间的 JSON-RPC、多个 thread 并存、审批流、本机工具注入。缺的是「多个 agent 之间的消息路由」和「每个角色绑定不同后端」。

### 方案 A：直接集成 cccc（最快，约 1-2 周）

- 在 VPS 上运行 cccc 守护进程，把 Codex 作为一名成员接入；AgentDesk 新增一个「群聊」标签页，作为 cccc 的客户端（或者直接内嵌它的 Web UI）。
- 优点：群聊、IM 桥接、手机远程都是现成的。
- 缺点：界面和状态管理有两套；依赖一个小团队维护的项目。

### 方案 B：自研轻量编排层（推荐，约 3-4 周，可以和 ROADMAP 的 M2 合并）

1. **角色定义**：沿用 sub-agents-skills 的格式，在 `.agentdesk/agents/*.md` 里声明角色、后端（`codex@vps` / `claude-code@local` / `gemini@local` …）、模型、推理强度、权限级别。
2. **后端适配层**：先实现 `CodexAppServerBackend`（已有）；再用 stdio 驱动本机 Claude Code 或 Gemini CLI 的 headless 模式（具体协议实现前需要核实各 CLI 当前版本的接口）。对应 ROADMAP 第 5 节提到的 `AgentBackend` 接口。
3. **群聊账本**：每个「群」是一个追加式 JSONL 文件，记录消息、任务、产物路径。消息分 Send / Mail 两种语义（借鉴 cccc），支持 `@角色`。
4. **组长 agent**：由一个强推理模型担任 foreman，只负责拆任务、派活、验收，不直接改代码；实现由 Fixer 角色负责，审查交给**另一个厂商的模型**（交叉审查最能发现单一模型的盲点）。
5. **冲突控制**：同一时刻只允许一个角色持有写权限；并行的角色只读，或者各自在独立的 git worktree 里工作。
6. **界面**：在会话侧栏增加群聊视图，每条消息标注是哪个角色、用的哪个模型；审批卡片沿用现有组件。
7. **成本开关**：Heavy / Council 模式默认关闭，按需触发，并在界面上预估 token 用量。

### 推荐的默认分工（起步配置）

| 角色 | 建议后端 | 职责 |
|---|---|---|
| Foreman | 强推理模型 | 拆解、派活、汇总、决定何时结束 |
| Explorer | 便宜快速的模型 | 读代码、查资料、给出文件定位 |
| Fixer | Codex（VPS，现有链路） | 按计划改代码、跑测试 |
| Reviewer | 与 Fixer 不同厂商的模型 | 只读审查 diff，给出阻塞 / 非阻塞意见 |
| Operator | 本机桌面工具 | 只在需要操作 Windows 界面时才调用，单独审批 |

## 6. 待确认

- 「gork bot 的群聊模式」，本文按 **Grok Heavy 的多 agent 协作 + 群聊式交互**理解。如果指的是另一个具体产品（例如某个聊天机器人的群聊功能），请提供链接，以便补充对比。
- 准备接入哪些后端（Claude Code、Gemini、Grok、国产模型？），决定了方案 B 第 2 步先做哪个适配器。
- 是否需要 IM 群（飞书 / 微信 / Telegram）作为群聊入口。如果需要，方案 A 的性价比明显更高。
