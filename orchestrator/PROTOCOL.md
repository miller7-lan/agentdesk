# AgentDesk 编排与 Windows Bridge 业务协议 v1

传输、TLS、设备认证、回执、UUID 和分块格式按 [VPS 1 Relay v1](../relay/PROTOCOL.md)。备用链路由 Windows Bridge 和 VPS 2 分别连接 VPS 1 的 TCP 22022。VPS 1 转发既有 kind，业务字段由 Bridge 和 Orchestrator 解释。

主用链路由 Windows AgentDesk 用专用 SSH 公钥连接 VPS 2 的 TCP 22。SSH 强制命令将 stdio 接入 Orchestrator 的私有 Unix socket。主路使用相同的 `data` 帧以及任务和消息 ID。SSH 身份替代 Relay 的 hello、设备 ID 与 Relay 回执。接收端在两条链路使用同一去重数据库。

## 提交任务

| kind | body | 方向 |
| --- | --- | --- |
| `task.request` | `{workspace, prompt, command?}` | Bridge → Orchestrator |
| `task.status` | `{operation:"status", after?}` | Bridge → Orchestrator |
| `task.status` | `{operation:"cancel"}` | Bridge → Orchestrator |
| `task.status` | `{operation:"start_plan", workspace, prompt, provider?, model?}` | 群聊 Bridge → Orchestrator |
| `task.status` | `{operation:"plan_reply", revision, reply}` | 群聊 Bridge → Orchestrator |
| `task.status` | `{operation:"plan_approve", revision}` | 群聊 Bridge → Orchestrator |
| `task.status` | `{operation:"operation_status", request_id}` | 双向 |

`task_id` 由提交方生成。相同任务 ID、工作区、提示和命令重提会返回同一任务状态。不同参数返回 `task_id_conflict`。提交响应返回已入队任务。状态响应附带递增序号的事件，调用方以最后收到的 `sequence` 作为下次 `after`。本机管理员决定应用补丁及切换路由。

群聊提交先启动只读规划。状态返回 `plan.rounds`，包含带 `revision` 的提问或方案。状态为 `awaiting_details` 时答复当前轮次，状态为 `awaiting_approval` 时可要求调整或确认当前方案。重发相同答案或确认使用原任务 ID 和轮次。主控持久化批准后才分派执行。旧主控会拒绝新操作。更新主控后，旧的命名 Bridge 提交也会进入规划，新版客户端可回答问题和确认方案。独立的管理端任务仍可用原有入口。

## Windows 操作

下表请求由 Orchestrator 发给 Bridge。除流、操作状态、命令取消和截图分块外，`body` 都包含 `workspace`。项目路径使用相对工作区的正斜线分隔符，根目录以空字符串表示。Bridge 本地配置校验命令、写操作和桌面授权。

| kind | body.operation | 其余字段与结果 |
| --- | --- | --- |
| `file.read` | `list`, `search` | `path`。搜索另带 `query`。返回 `items,truncated` |
| `file.read` | `stat` | `path`。返回 `type,size,version` |
| `file.read` | `read` | `path,offset?,version?`。返回 `data,sha256,offset,size,version` |
| `file.read` | `artifact` | `stream_id,offset?`。返回 `data,sha256,offset,size` |
| `file.write` | `mkdir`, `move`, `delete`, `write` | `path,version`。移动另带 `destination`，写入另带完整的 `stream_id` |
| `file.patch` | `apply` | `base`（Git 提交 ID）、完整的 `stream_id`。只在工作区干净且 HEAD 匹配时应用 |
| `command.execute` | `git_baseline` | 返回 `head,clean` |
| `command.execute` | `run` | `command,permission:"development",timeout_ms`。返回 `code,stdout,stderr` |
| `command.execute` | `cancel` | `request_id` 引用原运行请求 |
| `task.request` | `desktop` | `tool,arguments`。返回 `success,contentItems`。截图条目附 `stream_id,mimeType,size,sha256` |
| `task.status` | `stream_status` | `stream_id`。返回 `stream_id,next_offset,state` |

`version` 是文件内容的 SHA-256。目录版本由当前修改时间派生。新建用 `version:null`，移动要求目标尚不存在。版本不匹配返回 `version_conflict`。读取和上传每块最多 64 KiB（原始字节），每个文件或截图最多 20 MiB。上传按 `stream.open`、`stream.chunk`、`stream.end` 执行。每次等待业务结果再发送下一块。续传时使用原任务 ID、流 ID 和相同内容，从 Bridge 报告的连续偏移继续。分块和整文件都校验 SHA-256，只有完成的流可以发布。项目文件读取用版本绑定各块，截图读取用整文件校验和。

## 响应与恢复

成功用 `result`，`body:{in_reply_to,value}`。失败用 `error`，`body:{in_reply_to,error}`。响应携带原 `task_id` 和独立的 UUIDv7。Relay ACK 表示接收端持久化了消息 ID，业务结果由独立帧返回。接收端在执行前保存消息 ID，收到同 ID 的请求不会重复执行。

写入、桌面动作、补丁和命令断线后，优先通过仍可用的链路发送 `operation_status`。返回 `{state:"finished",kind,outcome}` 时使用原执行结果，`running` 或 `unknown` 时保留原请求 ID 并人工核对。操作记录按 Relay 的 24 小时窗口清理。切换路由不自动重发任何副作用请求。

## 联调方法

从仓库根目录运行 `node --test test/orchestrator.test.js`。测试用本机临时证书启动真实 Python Relay，连接 Node Bridge 和 Orchestrator 端点，验证握手、设备配对、分块文件写入读取和版本冲突。另一个测试使用 Unix socket 和 SSH 强制命令程序验证直连链路的数据流。生产环境还需验证 OpenSSH、公网连通性、Windows 桌面和供应商认证。
