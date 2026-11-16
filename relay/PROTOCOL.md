# AgentDesk Relay v1

Bridge（Windows）和 Orchestrator（VPS 2）分别主动连到 VPS 1 的 TCP 22022。两端使用同一个 TLS 服务地址，各有独立的设备 ID 与令牌。Relay 只把消息交给注册表中与发送方互相配对的设备。

## 编码与握手

- TLS 1.2 或更新版本。客户端校验 CA 和主机名或 IP SAN。使用私有 CA 时，在两端预先分发受信任 CA。Relay 用独立的随机令牌验证每个设备的身份，并用配对注册表授权转发。TLS 在 Relay 终止，部署者可看到传输中的明文。这一版没有端到端加密。
- UTF-8 JSON，每个对象一行，以 LF 结束。帧上限为 196608 字节，含 LF。重复字段、非有限数字及无法解码的 JSON 均为协议错误。
- TLS 就绪后 5 秒内发送 `hello`。令牌使用 32 个随机字节的无填充 Base64url 编码。客户端收到 `welcome` 前不发送其它帧。

```json
{"type":"hello","version":1,"device_id":"windows-bridge","token":"<43 characters>"}
{"type":"welcome","version":1,"device_id":"windows-bridge","role":"bridge","peer_id":"vps2-orchestrator","peer_online":false,"max_frame":196608,"idle_seconds":60}
{"type":"presence","device_id":"vps2-orchestrator","online":true}
{"type":"ping","device_id":"windows-bridge"}
{"type":"pong"}
```

连接空闲 60 秒时关闭。两端每 20 秒发送一次 `ping`，10 秒内未收到 `pong` 则主动关闭并重新连接。网络错误采用 1 秒起步、最高 30 秒的指数退避和随机抖动，收到 `welcome` 后重置。证书或令牌错误应提示配置问题，避免紧密重试。同一设备的新认证连接替换旧连接。客户端将 `welcome.peer_online` 和后续 `presence` 视为当前观察值。

## 消息和回执

数据帧必须含以下六个字段。`device_id` 始终标识已认证的发送方。`task_id` 是任务全过程共用的小写标准 UUID。`message_id` 是每个独立数据帧的小写标准 UUIDv7。多端 UUIDv7 时间最多允许超前 Relay 30 秒，消息有效期从 ID 内嵌的时间起算 24 小时。需要重试同一个数据帧时应保持相同的 ID 和内容。

```json
{"type":"data","device_id":"vps2-orchestrator","task_id":"5544ae92-5344-4406-943c-d3e164b235a7","message_id":"019c579a-56cc-76d3-9275-53a9f119e64d","kind":"file.read","body":{"path":"project/README.md"}}
```

可用 `kind` 包括 `task.request`、`file.read`、`file.write`、`file.patch`、`command.execute`、`result`、`error`、`task.status`、`stream.open`、`stream.chunk` 和 `stream.end`。`body` 必须是对象。除流字段外，业务参数由两端定义。响应帧保留相同 `task_id`、分配自己的 `message_id`，并通过 `body.in_reply_to` 引用请求的 `message_id`。提交代码、访问路径和命令权限由 Bridge 的现有授权规则决定。Orchestrator 管理任务执行和结果。

接收端以自身的 `device_id` 发送 `ack`，其 `task_id`、`message_id` 引用收到的消息。发送端发送相同结构的 `status` 来查询自己的数据帧。

```json
{"type":"ack","device_id":"windows-bridge","task_id":"5544ae92-5344-4406-943c-d3e164b235a7","message_id":"019c579a-56cc-76d3-9275-53a9f119e64d"}
{"type":"receipt","task_id":"5544ae92-5344-4406-943c-d3e164b235a7","message_id":"019c579a-56cc-76d3-9275-53a9f119e64d","state":"acknowledged"}
```

| 状态 | 客户端处理 |
| --- | --- |
| `pending` | Relay 已保存回执并尝试转发。该状态包括送达结果未知的情况。保留原 ID，等待 ACK 或查询接收端任务记录。 |
| `acknowledged` | 接收端确认已接收。执行结果从单独的 `result`、`error` 或 `task.status` 帧获取。 |
| `peer_offline` | Relay 当时未找到对端，消息没有登记。对端上线后可用原帧重试。 |
| `unknown` | 当前配对没有对应回执。原数据库完整且 ID 仍有效时，发送方可用原帧补发。在恢复丢失的数据库后，先核对执行状态。 |
| `receipt_capacity` | Relay 已达到回执上限，未登记当前帧。暂停新消息，延长重试间隔。 |
| `id_conflict` | 同一 ID 的内容或关联不同。停止重试并检查 ID 或序列化。 |
| `expired_id`、`future_id` | 核对系统时间和原操作状态。过期的写操作需要人工或业务侧确认后再处理。 |

`protocol_error` 带 `code` 并终止连接。客户端应记录错误码，避免在同样配置下重复发送无效帧。

### 断线与副作用

Relay 在尝试投递前持久化回执。同一数据库中、有效期内的同 ID 帧至多转发一次；连接或进程在写 socket 前后中断，结果可能保持 `pending`。Relay 不保存正文，也不会重放该帧。客户端收到的回执可能重复，收到 `acknowledged` 后忽略同 ID 的 `pending`。

接收端应在发 ACK 前持久记录已接收 ID，按 ID 去重，并持久记录任务及执行结果。对写入、补丁和命令，恢复时查询原 ID 的状态；无从确定副作用的请求进入待核对状态，禁止自动换新 ID 重跑。文件发布可用临时文件和原子替换。通用命令的外部副作用需要业务确认。这套规则同时覆盖 ACK 丢失、Relay 重启、客户端重启与数据库恢复。

## 文件流

- `stream.open` 的 `body` 含 `stream_id`（UUID）和 `size`（总字节数）。可附业务元数据。一个逻辑流的所有帧使用同一 `task_id` 和 `stream_id`。
- `stream.chunk` 的 `body` 恰好含 `stream_id`、`offset`（从零开始的字节偏移）、`data`（标准 Base64）和 `sha256`（原始分块的十六进制 SHA-256）。Relay 验证每块摘要及原始大小，单块为 1–98304 字节。
- `stream.end` 的 `body` 含 `stream_id`、`size` 和完整内容的 `sha256`。接收端按偏移写入临时文件，验证连续性、总大小和整文件摘要后再发布。空文件可直接发送 open 和 end。
- 建议发送端保持小窗口，例如最多四块待 ACK。接收方可用 `task.status` 返回 `body.stream_id`、`body.next_offset` 和 `body.state`，用于重连后从已持久化的连续偏移恢复。对未确认块，先查询偏移再为缺失数据创建新帧；接收方按流及偏移校验和去重。同一个流的最终发布只能执行一次。
- Relay 不拼装文件，不保留流正文。慢对端的 socket 写入等待上限为 5 秒，超时关闭该连接。每连接的入口限额为持续 120 帧/秒和 4 MiB/秒，突发上限为 240 帧和 1 MiB，超限断开。

## 旧版适配

现有 `remote.js` 使用 SSH stdio 和 Codex JSON-RPC。Relay 帧是独立的外层协议，JSON-RPC 内容可原样放在 `body.rpc`。Bridge 和 Orchestrator 应在各自适配器内维护 RPC ID 与 Relay 的 `task_id`、`message_id` 映射，并复用原有文件、桌面权限检查和 Codex 调用。旧客户端不能只改主机或端口就连入 Relay。
