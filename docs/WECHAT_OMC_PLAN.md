# 方案 v2：个人微信 → 企业微信 → 容器化云任务（多 CLI 协作）

> 2026-11-16 更新。已确定的条件：
> - VPS 内存 4 GB，另有 2 GB swap。
> - 走企业微信官方能力对接个人微信。
> - 微信入口只承担**简单云任务**。
> - 每个任务在**独立容器**里运行，并**定期清理**。
> - 任务和 agent 的**状态要能看到**。
> - 接入 **Claude Code（+ oh-my-claudecode）、Codex、Gemini CLI、Grok CLI**。
>
> 背景见 [MULTI_AGENT_RESEARCH.md](MULTI_AGENT_RESEARCH.md)。

## 1. 微信入口：用「微信客服」，而不是智能机器人

企业微信有两套机器人能力，适用对象不同：

| 能力 | 个人微信能否直接对话 | 特点 |
|---|---|---|
| **微信客服**（kf 接口） | ✅ 个人微信扫码或点链接即可进入会话 | 官方 API：回调通知后用 `kf/sync_msg` 拉取消息，用 `kf/send_msg` 回复。需要公网 HTTPS 回调地址（VPS 上有）。不支持流式输出 |
| 企业微信**智能机器人**（长连接） | ❌ 只面向企业成员的单聊和内部群；第三方资料称外部群无法添加 | 支持流式回复，无需公网 IP；cccc 的企业微信桥接的是这一种 |
| 个人微信 ClawBot | ✅ 但只能单聊，仍在灰度中 | 与企业微信无关 |

**结论**：个人微信入口用**微信客服**，自己写一个小型桥接服务（约 300 行 Node 代码）。如果以后需要在企业微信内部群里看各 agent 的流式输出，再接入智能机器人，可以和微信客服并存。

> ⚠️ 实施前要在官方文档核实微信客服的**回复时限和条数限制**（据我了解，用户发消息后的一段时间内只能主动回复有限几条）。这个限制直接决定了「长任务完成后再通知」能否实现：如果超出时限，就改为由用户发 `/s 任务号` 主动查询，或者用企业微信应用消息兜底通知。

## 2. 总体架构

```
个人微信 ──(微信客服)──▶ 企业微信服务器 ──HTTPS 回调──▶ VPS
                                                    │
        ┌───────────────────────── VPS（4G + 2G swap）─────────────────────┐
        │  wx-bridge（Node）  收发消息、白名单、命令解析                      │
        │        │                                                          │
        │        ▼                                                          │
        │  task-runner（Node + SQLite）                                     │
        │    队列 / 状态机 / 并发控制 / 超时 / 清理                           │
        │        │ docker run（每个任务一个容器）                            │
        │        ├─▶ [task-17] claude -p …        (agent-claude 镜像)       │
        │        ├─▶ [task-18] codex exec …       (agent-codex 镜像)        │
        │        └─▶ [task-19] gemini / grok …    (agent-gemini / grok 镜像)│
        │                                                                   │
        │  status API（127.0.0.1）  ◀── SSH 隧道 ── AgentDesk「云任务」面板  │
        │  codex app-server（现有，AgentDesk 桌面会话用，不受影响）          │
        └───────────────────────────────────────────────────────────────────┘
```

设计原则：
- **微信只负责派发和查看简单任务**。复杂的开发工作仍在 AgentDesk 桌面端完成。
- **一个任务对应一个容器**。容器结束即销毁，工作目录按策略保留，到期清理。
- **状态只有一个来源**：task-runner 的 SQLite 数据库。微信、AgentDesk、命令行三处看到的状态一致。

## 3. 四个 CLI 的分工（扬长补短）

| 代号 | CLI | 无交互调用方式 | 默认用途 |
|---|---|---|---|
| `cc` | Claude Code（可加载 OMC） | `claude -p "<prompt>"` | 默认执行者：代码阅读、审查、需要多步推理的任务；`/team` 用于需要协作的任务 |
| `cx` | Codex CLI | `codex exec "<prompt>"` | 写代码、跑脚本和测试 |
| `gm` | Gemini CLI | `gemini -p "<prompt>"` | 长文档或大仓库的阅读与总结、第二意见 |
| `gk` | Grok CLI | 待确认（见第 9 节） | 实时信息检索、第二意见 |

路由规则（由 task-runner 实现，第一版用简单规则，不调用模型判断）：
- 消息里显式指定了执行者（如 `@cx 写个脚本…`），就交给指定的 CLI。
- 包含「审查 / review」→ `cc`；「总结 / 读一下」+ 长链接或大文件 → `gm`；「最新 / 新闻 / 查一下」→ `gk`；其它情况默认交给 `cc`。
- `/duo <任务>`：一个 CLI 做，另一个厂商的 CLI 审查（例如 `cx` 实现 → `cc` 审查），两步串行执行，不并发，以节省内存。
- `/team <任务>`：在 `cc` 容器内启用 OMC team。只在显式指定时使用，并且独占全部并发额度。

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
  -v /srv/agent-creds/<cli>:/home/agent/.cfg:ro # 该 CLI 的凭据，只读
  --network agent-egress                        # 只放行 LLM API 与包管理源
  --stop-timeout 10
  agent-<cli>:<ver> <cli 命令>
```

要点：
- **不挂载 docker.sock**，也**不挂载**宿主机的代码仓库、`~/.ssh`、Codex app-server 的工作区。
- **凭据**：每个 CLI 单独一个只读目录。优先使用 API Key，而不是个人账号的 OAuth 令牌，这样泄露后可以单独吊销，影响面更小。
- **并发**：同时最多运行 **2 个**任务容器（2 × 1 GB，加上 codex app-server 和系统开销，不超过 4 GB，swap 只作缓冲）；`/team` 任务独占 2 个名额。超出的任务排队。
- **超时**：默认 15 分钟，`/team` 任务 40 分钟，超时后 `docker stop` 并标记为 `timeout`。
- **产物**：容器内写到 `/work/out/`；结束后由 task-runner 汇总生成摘要。文本直接回复到微信，文件则提供 AgentDesk 的查看入口，或在体积较小时以附件形式回复。

## 5. 状态模型（「看得见」的核心）

任务状态：

```
queued ─▶ starting ─▶ running ─┬─▶ succeeded
   │                           ├─▶ failed
   │                           ├─▶ timeout
   └──────── cancelled ◀───────┘   (用户 /stop)
                       running ─▶ waiting_input ─▶ running   (需要你回答问题时)
终态 ─(清理后)─▶ archived
```

每个任务记录：id、来源（微信用户 / AgentDesk）、原始指令、执行者（cc/cx/gm/gk）、各子步骤（`/duo`、`/team` 的每个 agent 都有自己的状态行）、容器名、开始和结束时间、耗时、退出码、峰值内存、token 用量（CLI 能输出时记录）、摘要、产物路径。

**三处可以查看状态**：

| 入口 | 内容 |
|---|---|
| 微信 | `/ls`：最近 10 个任务，每行形如「#17 ✅ cx 2m 写备份脚本」；`/s 17`：单个任务详情，含每个 agent 的状态和最后几行输出；`/stop 17`；`/sys`：内存、swap、磁盘、运行中的容器数 |
| AgentDesk | 新增「云任务」面板：任务列表 + 实时日志（经 SSH 隧道访问 status API），可以停止、重跑、查看产物 |
| 命令行 | `agent-tasks ls / show / logs -f / stop`，排障用 |

状态图标统一使用：⏳ 排队 ▶️ 运行 ❓ 等待回答 ✅ 成功 ❌ 失败 ⌛ 超时 ⏹ 已取消。

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
2. 构建基础镜像和 4 个 CLI 镜像，在 VPS 上逐个用无交互方式验证（并确认 Grok CLI 的调用方式）。
3. 配置 gc 定时器与磁盘水位检查。

**阶段 2：微信入口（约 3 天）**
1. 注册企业微信，开通微信客服，配置回调地址（Nginx + HTTPS → wx-bridge）。
2. wx-bridge：验签解密、`sync_msg` 游标、白名单、命令解析（`/ls` `/s` `/stop` `/sys` `/duo` `/team` `@cc/@cx/@gm/@gk`）。
3. 根据核实后的回复时限，实现完成通知或主动查询的降级方案。

**阶段 3：AgentDesk 面板（约 1 周）**
1. status API（只监听 127.0.0.1）+ AgentDesk 的 SSH 本地端口转发。
2. 「云任务」面板：列表、详情、实时日志、停止、重跑、产物预览。

**阶段 4：协作模式（之后）**
- `/duo` 交叉审查；`/team` 接入 OMC（容器内需要 tmux，OMC 的 worker 也在同一个容器里运行）。
- 需要多 agent 群聊时再评估 cccc（其企业微信桥适用于内部群）。

## 9. 待确认

1. **Grok CLI 用哪个**：xAI 官方的 Grok Build，还是社区版 grok-cli？两者的安装方式和无交互调用参数不同，请告诉我你现在用的是哪个。
2. **Gemini 的凭据**：OMC 文档提到 Antigravity 已接替 Gemini CLI，Gemini CLI 保留为企业版或 API Key 方式。容器里建议用 Gemini API Key，请确认你有。
3. **企业微信主体**：可以使用未认证的企业，但部分接口和人数有限制，开通微信客服时需要确认是否可用。
4. 云任务是否需要访问你的 Git 仓库？如果需要，给容器一个**只读的部署密钥**，限定到具体仓库。

## 参考来源

- 企业微信智能机器人官方文档：https://developer.work.weixin.qq.com/document/path/101031
- 企业微信官方 Node SDK：https://cdn.jsdelivr.net/npm/@wecom/aibot-node-sdk@1.0.7/README.md
- 外部群无法添加智能机器人（第三方文章）：https://damodev.csdn.net/6ae1cb7ee5f4ca4eff8cecf5.html
- 个人微信用户经「微信客服」接入（阿里云文档）：https://help.aliyun.com/zh/beebot/intelligent-dialogue-robot-tongyi-version/wechat-customer-service-deployment-guidelines
- 智能机器人长连接与流式回复（第三方整理）：https://damodev.csdn.net/6aef1812e5f4ca4eff8f124b.html
- oh-my-claudecode：https://github.com/Yeachan-Heo/oh-my-claudecode
- cccc：https://github.com/ChesterRa/cccc
