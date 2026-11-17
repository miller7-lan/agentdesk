# 方案 v2：微信一对一 → OpenClaw → 容器化云任务（多 CLI 协作）

> 2026-11-16 更新。已确定的条件：
> - VPS 内存 4 GB，另有 2 GB swap。
> - 微信入口**只做一对一单聊**，不做群聊；用 **OpenClaw** 作为消息网关（个人微信 ClawBot 为主，企业微信官方插件为补充）。AgentDesk 端以群聊呈现，见 [GROUP_CHAT_UI.md](GROUP_CHAT_UI.md)。
> - 微信入口只承担**简单云任务**。
> - 每个任务在**独立容器**里运行，并**定期清理**。
> - 任务和 agent 的**状态要能看到**。
> - 接入 **Claude Code（+ oh-my-claudecode）、Codex、Antigravity CLI、Grok Build**；后两者是**订阅制**（登录账号，不用 API Key）。
>
> 背景见 [MULTI_AGENT_RESEARCH.md](MULTI_AGENT_RESEARCH.md)。

## 1. 微信入口：一对一单聊，用 OpenClaw 做消息网关

### 1.1 可选通道

| 通道 | 你在哪聊 | 一对一 | 主动推送（任务完成后通知） | 说明 |
|---|---|---|---|---|
| **OpenClaw + 企业微信官方插件**（WecomTeam/wecom-openclaw-plugin） | 企业微信 App | ✅ | ✅ | 基于智能机器人长连接，**无需公网回调**；支持私聊、流式回复、主动发消息。需注意版本配套：OpenClaw ≥ 2026.3.22 需要插件 ≥ 2026.3.24 |
| **OpenClaw + 微信 ClawBot**（腾讯官方，iLink） | 个人微信 | ✅（只有单聊） | 待验证 | ✅ **你已实际接入过**（个人微信里使用企业微信 / ClawBot）；插件里扫码连接 |
| 自写桥接 + 企业微信「微信客服」 | 个人微信 | ✅ | ⚠️ 可能受回复时限 / 条数限制 | 官方 kf 接口，需要公网 HTTPS 回调，代码要自己写 |

### 1.2 结论

用 **OpenClaw 作为消息网关**，不再自己写微信桥接：

- **主通道：个人微信（ClawBot）。** 你已经在个人微信里接入过，直接作为日常入口，一对一单聊即可满足需求。
- **补充通道：企业微信官方插件。** 支持主动推送、流式回复，不需要公网回调端口。如果验证后发现 ClawBot 不能主动推送「任务完成」通知，就用它来发通知；两个通道共用同一个 task-runner 和同一个 `cloud-tasks` 技能。
- **微信客服方案降为备选**：只有在 OpenClaw 不可用时才自己写。

### 1.3 OpenClaw 在这里只做「收发 + 转交」

OpenClaw 本身是一个完整的 agent，但在这套系统里**只让它当前台**：
- 它通过一个自定义技能 `cloud-tasks` 调用 VPS 上的 `agent-tasks submit / ls / show / stop / sys`，把任务交给 task-runner；**任务本身仍在第 4 节的容器里执行**，不在 OpenClaw 进程里执行。
- `/ls`、`/s 17` 这类固定命令由技能直接处理，不经过模型，省额度，结果也稳定。
- OpenClaw 自己的模型只用来把一句自然语言整理成任务（选执行者、写清指令），挑最便宜的就够了。
- task-runner 在任务状态变化时调用 OpenClaw 的主动发消息接口通知你；OMC 的 hook 事件也可以转发到 OpenClaw 网关（OMC 原生支持），用来推送 `/team` 任务的中间进度。

### 1.4 OpenClaw 的注意事项

- **内存**：OpenClaw 网关常驻，需要计入 4 GB 的内存预算。上线前实测它的常驻内存；如果偏高，就把任务并发从 2 降为 1。
- **安全**：
  - 不给 OpenClaw 开 shell / 文件系统类工具，只启用 `cloud-tasks` 这一个技能。
  - 不安装来路不明的社区技能。
  - 网关只监听本机。
  - 配对时只允许你自己的账号。
- **升级**：OpenClaw 和插件的版本要配套升级，固定版本号，不要自动更新。

## 2. 总体架构

```
个人微信 ────(ClawBot，主通道)────────┐
企业微信 App ──(官方插件，补充通知)───┴──▶ VPS
                                                    │
        ┌───────────────────────── VPS（4G + 2G swap）─────────────────────┐
        │  OpenClaw 网关 + cloud-tasks 技能：收发消息、白名单、命令解析       │
        │        │                                                          │
        │        ▼                                                          │
        │  task-runner（Node + SQLite）                                     │
        │    队列 / 状态机 / 并发控制 / 超时 / 清理                           │
        │        │ docker run（每个任务一个容器）                            │
        │        ├─▶ [task-17] claude -p …        (agent-claude 镜像)       │
        │        ├─▶ [task-18] codex exec …       (agent-codex 镜像)        │
        │        └─▶ [task-19] agy / grok …       (agent-ag / gk 镜像)      │
        │                                                                   │
        │  status API（127.0.0.1）  ◀── SSH 隧道 ── AgentDesk「云任务」面板  │
        │  codex app-server（现有，AgentDesk 桌面会话用，不受影响）          │
        └───────────────────────────────────────────────────────────────────┘
```

设计原则：
- **微信只负责派发和查看简单任务**。复杂的开发工作仍在 AgentDesk 桌面端完成。
- **一个任务对应一个容器**。容器结束即销毁，工作目录按策略保留，到期清理。
- **状态只有一个来源**：task-runner 的 SQLite 数据库。微信、AgentDesk、命令行三处看到的状态一致。

## 3. 四个 CLI 的分工：Claude 当组长，只做决策

**核心功能**：Claude 负责整体规划、把控主方向、把任务分配给其他 AI。
**额度目标**：总 token 用量允许上涨，但 Claude 和 Codex 的额度要尽量少花。Claude 只做「想清楚、拆清楚、判对错」，读代码、读日志、查资料、写代码、初审这些重活都交给别人。

> 依据：目前没有公开实测证明「多 agent 能省 Claude / Codex 额度」。能确认的只有：按难度分流能在质量基本不变时降低强模型用量（RouteLLM，非编码场景）；多 agent 的总 token 是单 agent 的数倍（Anthropic）。所以必须靠 3.5 节的实测确认真的省了。

### 3.1 各 CLI 的定位

| 代号 | CLI | 无交互调用 | 定位 | 花额度的时机 |
|---|---|---|---|---|
| `cc` | Claude Code + OMC（订阅） | `claude -p` | **组长**：理解需求、整体规划、拆任务、指定由谁做、把控方向、最终验收；疑难问题的最后裁决 | 每个任务的开头（规划）和结尾（验收），以及升级时 |
| `ag` | Antigravity（订阅） | 待验证 | **侦察 + 主力**：读代码、读日志、写侦察报告和简报、总结各工人的结果交给组长 | 大部分重活 |
| `gk` | Grok Build（订阅） | 待验证 | **查资料 + 审查**：实时信息、第二审查人、ag 额度用尽时顶上 | 经常用 |
| `cx` | Codex（订阅） | `codex exec` | **只负责改代码**：按简报动手，不自己探索仓库 | 只在需要改代码时 |

OMC 本身就支持由 Claude 拉起 Codex、Antigravity、Grok 作为工人（`omc team N:codex` 等），正好对应这个结构：Claude 是组长，OMC 负责把活派出去、收回来。

### 3.2 一个任务的流程

```
你 ──▶ Claude 组长：读需求（只读你的话和侦察报告，不读原始代码）
          │ ① 需要了解代码时，先派 ag 侦察
          ▼
       ag 侦察：读代码 / 日志，写侦察报告（≤ 1 页：相关文件、现状、可能的根因）
          │
          ▼
       Claude 规划：写 plan.md（目标、步骤、每步由谁做、验收标准）── 只写一次
          │ ② 按计划派活
          ├──▶ ag 写简报（改哪些文件和行号、改法、要跑的测试）
          ├──▶ cx 按简报改代码 ──▶ task-runner 跑测试（不花模型额度）
          ├──▶ gk 审查 diff
          └──▶ gk 查资料（如需要）
          │ ③ 各步结果由 ag 汇总成一页
          ▼
       Claude 验收：看汇总、测试结果和 diff 摘要，决定通过 / 返工 / 调整方向
```

Claude 在一个普通任务里只被唤醒 2～3 次：规划、（必要时）中途调整方向、验收。

### 3.3 让 Claude 少花额度的具体做法

1. **Claude 看地图，不看实地**：它拿到的是 ag 的侦察报告和汇总，不读原始代码、完整日志和完整测试输出。需要细节时，派人去看再汇报，而不是自己去读。
2. **只在里程碑被唤醒**：工人的每一步进展写入任务账本，只有「侦察完成 / 某步失败 / 审查有阻塞 / 全部完成」这类里程碑才唤醒 Claude，不逐步汇报。
3. **计划写成文件**：`plan.md` 写一次，后续只更新状态，不在对话里反复复述；Claude 的会话按项目定期 `/compact`，不背着很长的历史。
4. **验收看结论**：验收依据是自动测试结果、gk 的审查结论和 diff 摘要（改了哪些文件、各多少行）。只有审查标出阻塞问题时，Claude 才看相关那一段 diff。

### 3.4 让 Codex 少花额度

Codex 的额度主要花在探索仓库（搜索、读文件、试错）上，所以：
- 只给它 ag 写好的简报和相关文件路径，按简报改，不做大范围探索；
- 测试、lint、类型检查由 task-runner 直接在容器里跑，失败时只把精简后的报错交回；
- 连续失败 2 次就停下，交回 Claude 重新判断方向，而不是让 Codex 自己反复试错。

### 3.5 路由与升级

- **多步骤的任务一律先交给 Claude 组长**（规划和派活是它的主要职责）。
- **简单的单步任务可以直达**，不经过 Claude，节省额度：「总结 / 读一下 / 分析日志」→ `ag`，「最新 / 查一下 / 搜」→ `gk`。直达开关可以在群设置里关掉；关掉后所有任务都先经过 Claude。
- 显式点名（`@cc` / `@cx` / `@ag` / `@gk`）就交给对应的 CLI，你的点名优先。
- 升级：工人连续失败、ag 和 gk 意见冲突、或者工人判断「方向可能不对」时，交回 Claude 裁决。每次升级都在群聊里显示原因。

### 3.6 额度护栏和实测

- **交接只传摘要**：完整输出写进任务目录，交给 Claude 和 Codex 的只有报告、简报、diff 摘要和精简报错。
- **额度水位联动**：群聊状态栏显示每个 CLI 的剩余额度和重置时间。Claude 本周用量超过阈值（例如 60%）时，直达范围自动扩大、验收改为「测试通过 + gk 无阻塞即自动通过，只把结论报给 Claude」，并在界面上提示。
- **Antigravity / Grok 也有额度**：两者都用尽时任务排队等重置，不自动改用 Claude / Codex 干杂活，除非你手动点名。
- **实测**：task-runner 记录每个任务在每个 CLI 上的 token 用量。上线后拿同一批 10 个真实任务对照：一组由 Claude 或 Codex 单独完成，一组走上面的流程，比较 Claude 和 Codex 的额度消耗、测试通过率、返工次数。省下了额度但返工明显变多，就调整唤醒和升级规则。

## 4. 容器设计

**镜像**：共用一个基础镜像（Debian slim + Node + git + tmux + 常用工具），每个 CLI 一个派生镜像，固定 CLI 版本号，按周重建。

**每个任务容器的启动参数**（4 GB 内存下的取值）：

```
docker run --rm --name task-<id>
  --memory 1g --memory-swap 1.5g --cpus 1 --pids-limit 256
  --read-only --tmpfs /tmp:size=256m
  --cap-drop ALL --security-opt no-new-privileges
  --user 10001:10001
  -v /srv/agent-tasks/<id>/work:/work            # 任务工作目录（唯一可写目录）
  -v /srv/agent-creds/<cli>:/home/agent/<cli 的配置目录>  # 该 CLI 的登录态（见 4.1）
  --network agent-egress                        # 只放行 LLM API 与包管理源
  --stop-timeout 10
  agent-<cli>:<ver> <cli 命令>
```

要点：
- **不挂载 docker.sock**，也**不挂载**宿主机的代码仓库、`~/.ssh`、Codex app-server 的工作区。
- **凭据**：每个 CLI 单独一个目录，只挂给该 CLI 的容器，详见 4.1。
- **并发**：同时最多运行 **2 个**任务容器（2 × 1 GB，加上 codex app-server 和系统开销，不超过 4 GB，swap 只作缓冲）；`/team` 任务独占 2 个名额。超出的任务排队。
- **超时**：默认 15 分钟，`/team` 任务 40 分钟，超时后 `docker stop` 并标记为 `timeout`。
- **产物**：容器内写到 `/work/out/`；结束后由 task-runner 汇总生成摘要。文本直接回复到微信，文件则提供 AgentDesk 的查看入口，或在体积较小时以附件形式回复。

### 4.1 订阅制登录态的处理

四个 CLI 都按订阅账号登录（Codex 本来就在 VPS 上用账号登录）。这和 API Key 有三点不同，需要专门设计：

1. **登录只在 VPS 上做一次，由人工完成。** 对每个 CLI 用 `agent-tasks login <cli>` 起一个临时容器，在里面完成该 CLI 的登录流程；登录态写入 `/srv/agent-creds/<cli>/`（权限 700，属主是容器用户 10001）。
   - 如果某个 CLI 只支持浏览器回调登录、不支持设备码，备选做法是在 Windows 上登录后，经 AgentDesk 的 SSH 把配置目录拷到 VPS。这种做法要先验证令牌是否绑定机器。
   - **微信里不提供登录功能**，避免登录链接或验证码经过微信传递。
2. **令牌会自动刷新并写回文件，所以凭据目录不能只读挂载**；而多个容器同时刷新同一份令牌，可能互相覆盖导致掉登录。因此：
   - **同一个 CLI 同一时刻只运行 1 个容器**（按 CLI 加锁）。全局仍然最多 2 个并发，但两个必须是不同的 CLI。
   - 每次任务开始前备份一次凭据目录（只保留最近 3 份）。掉登录时先尝试回滚，不行再通知你重新登录。
   - 凭据目录不在任务工作目录里，任务产物和日志都不会包含它；gc 永远不清理这个目录。
3. **订阅有用量额度。** 识别各 CLI 的额度用尽和未登录的输出（错误码或关键字，验证阶段逐个收集），任务置为新状态 `quota_limited` 或 `auth_expired`，不重试，并在微信里提示。路由时自动跳过当前额度用尽的 CLI，例如 `gk` 不可用时由 `ag` 顶上，并在结果里注明换了执行者。

**合规提醒**：订阅账号一般只授权本人使用，部分服务条款对自动化或无交互调用、共享账号有限制。这套系统只给你本人通过白名单使用，任务频率低，但上线前仍建议把四家的条款各看一遍，特别是「无交互调用」和「在服务器上使用」两点。

## 5. 状态模型（「看得见」的核心）

任务状态：

```
queued ─▶ starting ─▶ running ─┬─▶ succeeded
   │                           ├─▶ failed
   │                           ├─▶ timeout
   └──────── cancelled ◀───────┘   (用户 /stop)
                       running ─▶ waiting_input ─▶ running   (需要你回答问题时)
               starting/running ─▶ auth_expired | quota_limited   (订阅掉登录 / 额度用尽)
终态 ─(清理后)─▶ archived
```

每个任务记录：id、来源（微信用户 / AgentDesk）、原始指令、执行者（cc/cx/ag/gk）、各子步骤（`/duo`、`/team` 的每个 agent 都有自己的状态行）、容器名、开始和结束时间、耗时、退出码、峰值内存、token 用量（CLI 能输出时记录）、摘要、产物路径。

**三处可以查看状态**：

| 入口 | 内容 |
|---|---|
| 微信 | `/ls`：最近 10 个任务，每行形如「#17 ✅ cx 2m 写备份脚本」；`/s 17`：单个任务详情，含每个 agent 的状态和最后几行输出；`/stop 17`；`/sys`：内存、swap、磁盘、运行中的容器数，以及四个 CLI 的登录与额度状态（✅ 可用 / 🔑 需重新登录 / 🪫 额度用尽） |
| AgentDesk | 新增「云任务」面板：任务列表 + 实时日志（经 SSH 隧道访问 status API），可以停止、重跑、查看产物 |
| 命令行 | `agent-tasks ls / show / logs -f / stop`，排障用 |

状态图标统一使用：⏳ 排队 ▶️ 运行 ❓ 等待回答 ✅ 成功 ❌ 失败 ⌛ 超时 ⏹ 已取消 🔑 需重新登录 🪫 额度用尽。

## 6. 定期清理

由 systemd timer 每小时执行一次 `agent-tasks gc`：

| 对象 | 规则 |
|---|---|
| 运行超时的容器 | 立即停止，标记为 `timeout`（另有每分钟一次的看门狗兜底） |
| 已退出的容器 | `--rm` 自动删除；残留的 `task-*` 容器超过 1 小时强制删除 |
| 任务工作目录 `/srv/agent-tasks/<id>` | 成功的保留 **3 天**，失败的保留 **7 天**（便于排查），之后删除并标记 `archived` |
| 任务数据库记录 | 保留 90 天（只保留元数据和摘要） |
| 容器日志 | Docker `json-file` 驱动，单文件 10 MB、最多 3 个 |
| 悬空镜像和构建缓存 | 每天一次 `docker image prune` / `builder prune`，保留当前使用的版本 |
| 磁盘水位 | 可用空间低于 15% 时提前清理最旧的工作目录，并在微信提醒 |
| 原有的 `.agentdesk-uploads` | 维持现有的 7 天清理规则 |

清理只针对 `task-*` 容器和 `/srv/agent-tasks` 目录，**不碰** Codex app-server 和其他服务。

## 7. 安全边界

1. **白名单**：只有已登记的微信客服用户（你自己的 external_userid）发来的消息会被执行，其他人的消息只收到固定回复。
2. **微信任务的权限上限**：只能在容器内操作，不能访问 Windows 本机的桌面或文件工具，不能访问 AgentDesk 的工作区，不能执行 SSH。需要这些能力时提示「请到 AgentDesk 处理」。
3. **出网限制**：容器网络只放行各家 LLM API 和包管理源，防止数据被带出到任意地址。
4. **配额**：每日任务数和 token 预算设上限，超出后暂停并通知你。
5. **审计**：每条微信指令和容器的完整日志都保存到清理期限为止。

## 8. 实施步骤

**阶段 1：任务执行核心（约 4-5 天）**
1. 编写 task-runner：SQLite 表结构、状态机、Docker 调度、并发限制、超时看门狗、`agent-tasks` 命令行。
2. 构建基础镜像和 4 个 CLI 镜像。对每个 CLI 逐项验证：①能否在无图形界面的服务器上登录（设备码或拷贝配置目录）；②无交互调用的命令和参数；③登录态保存在哪个目录、令牌是否会刷新写回；④额度用尽和掉登录时的输出特征。Antigravity CLI 和 Grok Build 是这一步的重点。
3. 实现 `agent-tasks login <cli>` 和按 CLI 加锁的调度。
4. 配置 gc 定时器与磁盘水位检查。

**阶段 2：微信入口（约 2-3 天）**
1. 在 VPS 上安装 OpenClaw（固定版本），按你之前的方式接入个人微信（ClawBot 扫码）；验证 ClawBot 能否主动推送消息。实测 OpenClaw 的常驻内存。
   - 如果不能主动推送：在企业微信后台创建智能机器人（选长连接，拿到 Bot ID 和 Secret），用 `openclaw channels add` 加企业微信通道，专门用于发通知。
2. 编写 `cloud-tasks` 技能：命令解析（`/ls` `/s` `/stop` `/sys` `/duo` `/team` `@cc/@cx/@ag/@gk`），固定命令不经过模型；关闭 OpenClaw 的其它工具。
3. task-runner 状态变化 → 调用 OpenClaw 主动推送；配置 OMC 的 OpenClaw 事件转发。

**阶段 3：AgentDesk 面板（约 1 周）**
1. status API（只监听 127.0.0.1）+ AgentDesk 的 SSH 本地端口转发。
2. 「云任务」面板：列表、详情、实时日志、停止、重跑、产物预览。

**阶段 4：协作模式（之后）**
- `/duo` 交叉审查；`/team` 接入 OMC（容器内需要 tmux，OMC 的 worker 也在同一个容器里运行）。

## 9. 待确认

1. ~~Grok 用哪个 CLI~~ → 已确定使用 Grok Build（订阅）。
2. ~~Gemini 的凭据~~ → 已确定使用 Antigravity CLI（订阅），不用 Gemini API Key。
3. ~~主通道在哪里聊~~ → 个人微信（你已接入过 ClawBot）。剩下要验证的是：ClawBot 能否**主动推送**任务完成通知；如果不能，再加企业微信通道来发通知。
4. 云任务是否需要访问你的 Git 仓库？如果需要，给容器一个**只读的部署密钥**，限定到具体仓库。

## 参考来源

- 企业微信智能机器人官方文档：https://developer.work.weixin.qq.com/document/path/101031
- 企业微信团队的 OpenClaw 插件（镜像）：https://cnb.cool/takenotes/github.com/WecomTeam/wecom-openclaw-plugin
- 阿里云：OpenClaw 接入企业微信：https://help.aliyun.com/en/simple-application-server/use-cases/openclaw-enterprise-wechat-integration
- OpenClaw 接入企业微信教程（第三方）：https://damodev.csdn.net/6a6446ca10ee7a33f29249af.html
- 企业微信官方 Node SDK：https://cdn.jsdelivr.net/npm/@wecom/aibot-node-sdk@1.0.7/README.md
- 外部群无法添加智能机器人（第三方文章）：https://damodev.csdn.net/6ae1cb7ee5f4ca4eff8cecf5.html
- 个人微信用户经「微信客服」接入（阿里云文档）：https://help.aliyun.com/zh/beebot/intelligent-dialogue-robot-tongyi-version/wechat-customer-service-deployment-guidelines
- 智能机器人长连接与流式回复（第三方整理）：https://damodev.csdn.net/6aef1812e5f4ca4eff8f124b.html
- oh-my-claudecode：https://github.com/Yeachan-Heo/oh-my-claudecode
- cccc：https://github.com/ChesterRa/cccc
