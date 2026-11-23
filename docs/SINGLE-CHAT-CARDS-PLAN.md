# 单聊：问答卡、只读规划交接、权限档与「完全访问」开关

适用分支：`feat/directchat-cards-plan`（2026-11-23）。规划原文：r4（主人已批准）。本文记录**实际实现**、**验证**与**评估结论**；没有测过的写明「未实测」。

## 1. 实现了什么

| 功能 | 位置 | 说明 |
|---|---|---|
| 问答卡 | `src/question-card.js`、`src/live.js`、`src/app.js`、`src/styles.css` | `item/tool/requestUserInput` 渲染为问答卡：所有问题一页列出（Codex 式），单选/多选、自己填写、`isSecret` 用密码框、跳过；标题按 AI 区分。未答完会标出，本轮结束时未答的问题显示「已失效」。不是审批卡，没有「本会话不再询问」。答案回到发出请求的连接。 |
| Claude / Grok / Antigravity 提问 | `orchestrator/ask-user.js`、`orchestrator/chat-server.js`、`orchestrator/chat-mcp.js` | 单聊服务器提供 MCP 工具 `agentdesk_ask_user`（仅当客户端在 `initialize` 声明 `capabilities.questionCards`）。调用转成 `item/tool/requestUserInput`，等待 15 分钟，期间本轮计时暂停；MCP 桥、能力套接字和 CLI 的 `MCP_TOOL_TIMEOUT`（Claude、Grok）同步放宽。 |
| 每步询问 / 自动编辑 真实差异 | `src/live.js`、`orchestrator/chat-server.js` | 每步询问：所有写入和命令都询问（Codex：`untrusted`）。自动编辑：本机文件写入和修改直接生效，删除、移动、命令和桌面操作仍询问（单聊服务器 `autoApprove: 'edits'`，仅在 on-request 下生效；Codex：`on-request`）。旧服务器忽略 `autoApprove`，此时自动编辑会逐次询问（安全方向）。 |
| 只读规划 | `src/live.js` | Codex 非原生会话的规划轮带 `collaborationMode: plan`，离开规划的第一轮带一次 `default`；线程是否处于规划由 Codex 在恢复会话时返回，重启后也正确。其它轮次不带这个实验字段。所有 AI 规划轮结束后出现「执行此方案？」卡，切到**上次可写模式**并发出执行轮。 |
| 新会话默认 | `src/access-toggle.js`、`src/app.js`、`src/live.js` | 沿用上次可写模式（`lastWritableMode`），上次停在只读规划也不从规划开始；首次「自动编辑」。只记住人的选择（程序设置的模式，如群聊组长建议的单聊，不改默认）。旧客户端只有 `lastPermissionMode` 时自动迁移。**注意**：Windows/Mac 上新会话只有在第一条消息前选了「完全访问」才走原生座；从「每步询问/自动编辑」开始的会话走 MCP 旧线路，不能在原会话里切到完全访问（开关与选项会禁用并说明，交接卡改用上次的每步询问/自动编辑）。 |
| 「完全访问」开关 | `src/index.html`、`src/app.js`、`src/access-toggle.js` | 与权限下拉同一个状态：开 = 完全访问；关 = 上次的每步询问/自动编辑（`lastSafeWritableMode`），从不回到只读规划；下一轮生效；原生会话禁用。**不加 Shift+Tab**。 |
| 原生座提问转发 | `orchestrator/windows-native-seat.js`、`orchestrator/windows-native-desktop.js`、`main.js` | 原生座只放行本线程、本运行轮的 `item/tool/requestUserInput` 给客户端，其余服务端请求仍拒绝。 |

## 2. 规划中的 spike 结论（步骤 0 / 0b）

登录规则：只用现有 `homes/*` 做只读对话，不复制、不刷新、不改凭据；运行前后只比对凭据文件的大小与修改时间（不读内容）；一旦变化即停止该家实测。

### 2.1 步骤 0（现有路径）

| 项 | 结果 | 依据 | 采用的分支（r4 §11） |
|---|---|---|---|
| Claude 提示工具 + AskUserQuestion | **未实测** | AgentDesk 的 Claude HOME 处于未登录状态，且登录进程正在进行；不能在它旁边跑对话。仅核对了 2.1.330 帮助文本：`--permission-prompts none` 时提问和规划工具不提供给模型，默认 `host` 由 `--permission-prompt-tool` 回答。 | 不通过分支：Claude 用 `agentdesk_ask_user` |
| Claude `--permission-mode plan` | **未实测** | 同上 | 保持 `dontAsk` + 工具闸门 + 提示 |
| Claude ExitPlanMode | **未实测** | 同上 | 不开 ExitPlanMode；交接卡引用最后一条回复 |
| Codex `collaborationMode` | **schema 已核对，未实测对话** | `codex app-server generate-json-schema --experimental`（0.171.0，临时 CODEX_HOME，无账号）：`TurnStartParams.collaborationMode = { mode: 'plan'\|'default', settings: { model (必填), reasoning_effort, developer_instructions } }`；另有 `collaborationMode/list` | 采用（仅非原生；没有已知模型时不发送） |
| Codex `requestUserInput` 字段 | schema 已核对 | `questions[{ id, header, question, isOther, isSecret, options[{label, description}] \| null }]`，回答 `{ answers: { id: { answers: [] } } }`，无多选字段 | 按此实现 |
| Codex 是否接受多余 `cancelled` 字段 | **未实测** | — | 不通过分支：Codex 路径不带 |
| Codex `untrusted` 对补丁逐条审批 | **未实测** | schema 中 `untrusted` 为合法值 | 采用 `untrusted` 作为每步询问（只会更多地询问，方向安全）。这与 r4 表格「未通过则 on-request」不同，原因：两档都用 on-request 时 Codex 下二者完全相同，违背「真实差异」的已确认决定 |
| Grok `--permission-mode plan` | **未实测** | 不跑 Grok 登录态对话（见 2.2） | 保持 `dontAsk` + 工具闸门 |
| Antigravity 非原生 `--mode plan` | **未实测** | Antigravity 实测在 2.2 中途停止 | 非原生保持 `accept-edits` + 工具闸门 |

### 2.2 步骤 0b：Grok / Antigravity 改走 ACP 评估

入口：`grok acp`、`agy acp`（两者都是 stdio ACP 服务器）。

| 检查项 | Antigravity (`agy acp` 1.5.14) | Grok (`grok acp`) |
|---|---|---|
| G1 只读 bwrap 中启动 | 空 HOME 下在只读 bwrap 中 `initialize` 成功；带登录态的沙盒运行未完成（见 G5） | **未实测**：无登录态时连 `initialize` 都拒绝（"Not signed in"） |
| G2 接收 `mcpServers` | **通过**：stdio MCP 服务器被接入，模型调用了其中的工具 | 未实测 |
| G3 提问往返 | **部分**：`ask_question` 以结构化 `tool_call` 事件出现（`questions[{question, options[], is_multi_select}]`），**没有向宿主发可回写的请求**，本轮随即 `end_turn`；用户答案作为下一条消息发送后，模型正确引用了答案 | 未实测 |
| G4 `session/load` 跨进程恢复 | **通过**：新进程 `session/load` 后续答，上下文保留（约 11 秒） | 未实测 |
| G5 凭据元数据不变 | **未通过（不确定）**：第三次运行启动的同一秒（07:07:19），`antigravity-oauth-token` 的大小和修改时间发生变化；该次运行本身因沙盒启动失败立即退出，无法排除是现网或本次启动触发的续期。按规则停止 Antigravity 登录态实测。之后在没有任何测试运行时，该文件于 08:04 再次被现网续期，说明现网会自行续期，07:07 的变化很可能不是测试造成，但无法证实 | 未实测：`grok-chat` 的令牌比 `homes/grok` 旧约 7 小时，用它跑对话很可能触发续期，可能波及现网 Grok 登录，因此不做 |
| G6 工具白名单可施加 | 未实测（`agy acp` 没有 `--settings`；权限通过 `session/request_permission` 由宿主决定，MCP 工具调用时确实发来了 allow/deny 请求） | 未实测 |
| S1 plan 模式 | `session/new` 返回模式 `default`/`accept-edits`/`plan`；`set_mode` 未实测 | 未实测 |

**选家结论（按 r4 §3.6.2 规则）**：两家都没有满足 G1–G6 全部硬门槛 → **本期不接入 ACP（步骤 4b 跳过）**，Grok 与 Antigravity 使用 `agentdesk_ask_user`。这是 r4 已批准范围内的既定回退。

完成评估还需要：一个与现网隔离的 Grok 与 Antigravity 测试账号（或主人确认允许在评估中续期令牌）。届时重测 G1、G3（Grok）、G5、G6、S1。若 Antigravity 通过，其提问应按「结构化提问事件 + 下一条消息作答」接入，而不是等待宿主请求。

## 3. 验证

- `node --test test/*.test.js`：503 项，497 通过，0 失败，6 跳过（既有的 Windows 专属与真实 bash 测试）。
- 新增测试：`test/ask-user.test.js`、`test/question-card.test.js`、`test/access-toggle.test.js`、`test/native-seat-questions.test.js`，以及 `test/chat-server.test.js` 中的问答往返（三家）、跳过、旧客户端不提供工具、自动编辑。
- 界面：在 VPS2 上用临时 Electron 45（隔离目录，私有库目录，不装系统包）加载真实 `src/index.html`，用替身 `window.desk` 驱动 26 项检查，全部通过（含通过真实「新建单聊」路径创建会话、群聊式程序改模式不被记住、重绘保留未提交选择、服务端撤回问题、旧线路会话锁定完全访问）：问答卡渲染与三题一页、未答标出且不发送、按题作答、折叠摘要、Codex 标题与密码框、Codex 跳过、开关与下拉同步、从规划打开再关闭回到每步询问、新会话不从规划开始、原生会话限制、规划轮只读、交接卡与执行轮、自动编辑带 `autoApprove`、Codex 规划协作模式与退出、无渲染错误。
- **未实测**：任何真实 CLI 的端到端提问（Claude、Grok、Antigravity、Codex 均没有在真实模型上走完问答卡）；Windows / Mac 原生座的真实转发（只有假桥测试）；Codex `collaborationMode` 在真实 app-server 上的效果。

## 4. 已知限制

- 问答卡的问题文字会随会话保存；`isSecret` 的答案不保存（摘要显示 ••••）；未提交的选择只在内存中保留（重绘不丢，重启后丢）。
- 问题超时（15 分钟）、CLI 放弃等待（MCP 连接关闭或 `notifications/cancelled`）时，服务端发 `agentdesk/requestExpired`，卡片显示已失效，本轮计时立即恢复。
- 原生 Codex 会话不发 `collaborationMode`，因此原生 Codex 的规划轮不会触发 `request_user_input`；原生座的提问转发主要服务原生 Claude/Grok/Antigravity。
- Antigravity 不支持 `MCP_TOOL_TIMEOUT`（未发现对应设置），它自己的 MCP 工具超时可能短于 15 分钟，届时提问会提前失效（未实测）。
- Grok 二进制中有 `MCP_TOOL_TIMEOUT` 字样，但单位与是否生效**未实测**；Claude 的 `MCP_TOOL_TIMEOUT`（毫秒）同样没有在真实对话中验证。
- 「执行此方案？」卡只在本次打开期间出现，重开会话不会再弹。
