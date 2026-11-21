# 单聊 v2 客户端 API（协议版本 2）

供 Mac 和 Windows 客户端构建使用（D6）。传输方式不变：每个 provider 一条 SSH 连接，由强制命令拉起 `chat-server.js <provider>`，两端用 JSON-RPC 2.0 通信，每行一个 JSON。v1 的方法（`thread/*`、`turn/*`、`item/*`）全部保留，下面只列 v2 新增或改变的部分。

## 1. 身份与握手

**以服务端为准**：设备身份来自 key 强制命令注入的 `AGENTDESK_DEVICE` 和 `AGENTDESK_PLATFORM`。服务端再拿这两个值去查登记表，看这台设备是否已批准、是否开了 v2。客户端发来的字段只用来比对，不带来任何权限。

### `initialize`
请求：
```json
{ "clientInfo": { "name": "agentdesk", "version": "0.3.0" }, "capabilities": {},
  "device": { "deviceId": "6f0c7a1e-…", "platform": "darwin", "protocolVersion": 2,
              "osVersion": "…", "appVersion": "0.3.0",
              "capabilities": ["attachmentsV2", "statusSubscribe", "localShell", "nativeSeat"] } }
```

| 字段 | 校验 |
|---|---|
| `deviceId` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`；客户端首次运行时生成 UUID，保存在 `~/.agentdesk/device-id` |
| `platform` | 只能是 `darwin` 或 `win32`；其他平台不发 `device` 字段，只走 v1 |
| `protocolVersion` | 整数，不小于 1；当前为 2 |
| `capabilities` | 只用于功能协商，最多 32 项 |

返回：
```json
{ "serverInfo": {…}, "protocolVersion": 2,
  "device": { "deviceId": "…", "platform": "darwin", "state": "approved", "directChatV2": true },
  "features": { "attachmentsV2": true, "status": true, "sessionList": true, "seatLimits": true, "isolatedAntigravity": false } }
```

- **旧 key**（没有设备注入）：返回里没有 `device`，`features.attachmentsV2` 为 false。
- **待登记、已吊销或平台不符的设备**：`initialize` 照常返回 `device.state` 和 `device.error`；之后除了 `status/read` 以外的所有请求都会被拒绝。

### 错误码
| message | code | 何时出现 |
|---|---|---|
| `DEVICE_MISMATCH` | -32001 | hello 里的 deviceId 或 platform 与 key 身份不一致；或强制命令注入的平台与登记表不一致 |
| `DEVICE_NOT_APPROVED` | -32001 | key 带设备身份，但登记表里没有这台设备，或尚未批准 |
| `DEVICE_REVOKED` | -32001 | 设备已被吊销，立即生效 |
| `HELLO_REQUIRED` | -32001 | v2 设备还没成功完成 `initialize` 就发了其他请求 |
| `UPGRADE_REQUIRED` | -32002 | v2 设备没发 `device` 字段，或 `protocolVersion` 太低 |
| `INVALID_DEVICE_HELLO` | -32602 | `device` 字段格式错误 |
| `SESSION_NOT_OWNED` | -32003 | 会话不属于当前设备 |
| `PROJECT_MISMATCH` | -32003 | 这一轮带的 `localRoot` 与会话开启时的项目不一致 |

## 2. 会话

- **`thread/start`**：参数和 v1 相同。v2 只保存 `projectHash = sha256(deviceId + "\0" + localRoot)`，不保存路径。
- **`thread/resume`**：v2 额外返回 `projectHash` 和 `deviceId`，`localRoot` 为空字符串。
- **`thread/list`**：v2 返回本设备的会话：`[{ id, title, projectId, projectHash, createdAt, updatedAt, active }]`。v1 仍返回空数组。
- **`turn/start`**：v2 的变化：
  - 必须带 `localRoot`，hash 不一致时返回 `PROJECT_MISMATCH`；
  - 附件改用 `attachmentIds: [id…]`，只能填本会话里状态为 `received` 或 `attached` 的附件。
- **通知 `turn/queued`**：`{ threadId, turnId, position }` 表示并发已满（全机 6 个、每台设备 4 个），position 是排在第几位；`{ threadId, turnId, reason: "cli_upgrading" }` 表示该 CLI 正在升级。等到可以开始时，服务端照常发出后续事件。

## 3. 附件（D9）

一个附件依次走 begin → chunk → commit；成功只以 commit 的回执为准。

| 方法 | 参数 | 返回 |
|---|---|---|
| `attachment/begin` | `{ threadId, name, size, sha256 }`（单个不超过 25 MB；每个会话最多 30 个未完成或已收到的附件） | 附件视图，`state: "uploading"`，`nextOffset: 0` |
| `attachment/chunk` | `{ threadId, attachmentId, offset, data(base64, 不超过 350000 字符) }` | `{ attachmentId, nextOffset }`；已收到的块会被确认，有缺口时返回 `attachment_offset_mismatch` |
| `attachment/commit` | `{ threadId, attachmentId }` | 附件视图，`state: "received"`、`sha256`、`receivedAt`；大小或 hash 不符时返回 `ATTACHMENT_HASH_MISMATCH`，状态变为 `failed` |
| `attachment/abort` | `{ threadId, attachmentId }` | `{}` |
| `attachment/list` | `{ threadId }` | `{ data: [附件视图] }`，重连后用它续传 |

附件视图：`{ attachmentId, threadId, name, size, sha256, state: uploading|received|attached|failed|expired, nextOffset, receivedAt, expiresAt, error? }`。附件 7 天后过期。属于其他会话或其他设备的附件一律返回 `attachment_not_found`。

**界面规则**：只有当 `state` 为 `received`（或之后的状态）时，才能显示“✓ 已上传（服务器已校验）”。

## 4. 状态（D11、D12）

| 方法或通知 | 说明 |
|---|---|
| `status/read {force?}` | 返回 `{ items }` |
| `status/subscribe {enabled}` | 返回 `{ items, subscribed }`；之后由服务端推送 `status/updated { items }` |

每个 item 的字段：
```json
{ "provider": "claude", "kind": "quota|login|models|version|availability|upgrade",
  "value": {…} | null, "source": "snapshot|claude_usage|codex_app_server|grok_billing|antigravity_usage|call_limits|cli_version|orchestrator|cli_upgrade_spool",
  "observedAt": "ISO|null", "receivedAt": "ISO", "periodMs": 60000,
  "freshness": "fresh|stale|unknown|error", "error": null, "estimated": false, "unofficial": false }
```

客户端规则：
- `value` 为 null 时显示“未知”，**不显示 0%**；
- 显示“来源 · x 秒前”；
- `unofficial` 为 true 时标注“非官方接口”；
- `estimated` 为 true 时标注“估算”。

主控（经 Bridge 控制 socket，`main.js` 白名单）：`status_snapshot` 返回 `{ items, observedAt }`，包含额度、可用性和升级状态；只有 `quotaBridges` 里的 Bridge 和 admin 可以调用。

## 5. CLI 升级（Q5）

主控操作（经 Bridge）：
- `cli_upgrade { provider }`：provider 为 `codex|claude|grok|antigravity`。只有已批准的设备可以调用，设备按 Bridge 名称在登记表的 `bridges` 中查找。返回 `{ requestId, state: "queued", merged, runnerInstalled }`。
- `cli_upgrade_status`：返回 `{ requests: [{ requestId, provider, state: queued|started|succeeded|rolledBack|failed, events, fromVersion, toVersion }], upgrading: [provider], runnerInstalled }`。

只能升级到 latest；指定版本时返回 `cli_version_selection_unsupported`。触发前客户端必须在本机让用户二次确认。`runnerInstalled: false` 表示 root 执行器尚未安装（门禁 G3），请求只会排队。

## 6. 原生 seat 与本机 Worker

`agentdesk-seat` 控制帧：`{ protocolVersion: 1, state: "queued", position }` 表示在排队，排队期间不会因挂载超时而断开。客户端会把它转成通知 `agentdesk/seatQueued { threadId, position }`。

模型可用的本机工具（只在完全访问的写入轮次提供）：
- `local_shell`（已有）。
- `terminal { action: open|write|read|resize|signal|close|list, terminalId?, data?, cursor?, shell?, cols?, rows?, signal? }`：只有 Worker 的 `capabilities.pty` 为 true 时才提供（需要 node-pty，门禁 G2）。
- `file_lock_acquire { paths: [项目内相对路径] }`：等待最多 120 秒；锁在空闲 30 秒或本轮结束时释放。

Worker 操作（主进程到 Worker，需要 Worker 密钥）：

| 操作 | 说明 |
|---|---|
| `capabilities` | `{ pty, locks, checkpoints, sharedWrite }` |
| `endTurn` | 释放本会话的锁 |
| `lockFiles` | 加锁 |
| `lockStatus` | 查看锁状态 |
| `terminal` | 模型调用终端 |
| `terminalRead`、`terminalTakeover`、`terminalInput` | 用户在界面上查看、接管和输入；接管期间模型写入返回 `terminal_taken_over` |
| `checkpoint`、`checkpoints`、`restoreCheckpoint` | D8 检查点；有其他会话持锁时回退被拒绝 |

Worker 事件：`{ event: "lock", value: { type: waiting|acquired|released|timeout|staleWriteRejected|bypassed, sequence, timestamp, owner, label, path, … } }` 和 `{ event: "terminal", value: { type: opened|output|exited|takenOver|handedBack|closed, terminalId, … } }`。按 `sequence` 去重。

客户端通知：`agentdesk/fallback { reason, at }` 表示新的完全访问会话已回退到 MCP 工具（D14），界面必须提示用户。

## 7. 登记信息（给管理员用）

IPC `device:info` 返回 `{ deviceId, platform, keys: [{ channel, publicKey, fingerprint }], supported }`，只读取 `.pub` 公钥。用户把这些信息交给管理员执行 `ad device approve`。

## 8. 版本规则

- 服务端新增的字段一律可选，旧客户端照常工作。
- 客户端遇到不认识的字段和通知直接忽略。
- 不兼容的改动必须提高 `protocolVersion`，服务端以 `UPGRADE_REQUIRED` 拒绝过旧的客户端。
