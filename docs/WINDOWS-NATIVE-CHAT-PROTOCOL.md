# Windows 原生单聊协议 v1

适用于 Windows 的 Codex 和 Claude 单聊。接口、租约、SFTP、挂载生命周期和 Shell 组件可独立测试。第三阶段已接入桌面入口，启动器与独立 Worker 已通过隔离夹具验证。最新真机结果和正式部署门槛见 [Windows 原生单聊部署与验收](WINDOWS-NATIVE-CHAT-DEPLOY.md)。

## 请求边界

桌面端在已确认 SSH 主机后，将官方线程与 Windows 本机配置中的项目匹配。传输层验证设备、模型供应商、线程、项目和访问模式之后，才为协议处理器提供可信上下文。Windows Worker 的本地控制管道需要本机密钥。工具调用参数不提供密钥、任意目录、用户权限或 VPS2 挂载路径。

| 字段 | 类型 | 来源或含义 |
| --- | --- | --- |
| `protocolVersion` | 整数 | 本版为 1。其他版本返回 `INVALID_REQUEST` |
| `deviceId` | 字符串 | 传输层已认证的 Windows 设备 |
| `provider` | 字符串 | `codex` 或 `claude` |
| `threadId` | 字符串 | 经会话启动器确认的官方会话标识 |
| `projectId` | 字符串 | 本机已绑定项目标识 |
| `projectRoot` | Windows 绝对路径 | 仅在可信上下文中使用。工作区路径由 Bridge 配置解析 |
| `accessMode` | 字符串 | `read` 或 `write`，以可信上下文为准 |
| `leaseId` | 字符串 | Windows Worker 生成的租约标识 |
| `mountId` | UUID | VPS2 生成的挂载实例标识 |
| `mountPath` | VPS2 绝对路径或空值 | 仅在服务器确认挂载就绪后返回 |
| `generation` | 整数 | 租约代际。恢复后增加，旧代际不能写入 |
| `requestId` | 字符串 | 逻辑请求的稳定标识。超时后仍使用原标识查状态 |
| `runId` | UUID | Windows Shell 命令运行标识 |
| `sequence` | 整数 | 事件或命令状态版本 |
| `timestamp` | UTC ISO 8601 | 事件发生时间。命令运行的 `startedAt` 和 `finishedAt` 是 UTC Unix 毫秒 |

```json
{"protocolVersion":1,"requestId":"req-1","operation":"project.acquire","projectId":"example"}
```

回应中的租约 ID 示例用占位符表示。

```json
{"protocolVersion":1,"requestId":"req-1","ok":true,"value":{"leaseId":"<leaseId>","projectId":"example","accessMode":"write","state":"active","generation":1,"createdAt":"2026-11-20T11:00:00.000Z"}}
```

```json
{"protocolVersion":1,"requestId":"build-1","operation":"local_shell.run","leaseId":"<leaseId>","generation":1,"args":{"command":"npm test","shell":"cmd","background":true}}
```

```json
{"protocolVersion":1,"requestId":"build-1","ok":true,"value":{"runId":"<runId>","state":"running","exitCode":null,"stdout":"","stderr":"","stdoutCursor":0,"stderrCursor":0,"sequence":0,"startedAt":1795172400000}}
```

## 生命周期

| 对象 | 逻辑操作 | 状态与约束 |
| --- | --- | --- |
| 租约 | `project.acquire`、`project.status`、`project.suspend`、`project.reconcile`、`project.release` | `active → suspended → reconciling → active / released`。同一或重叠目录仅有一个写者，读者不占用写入权。相同会话重复申请原租约 |
| 挂载 | `project.mount`、`project.mountStatus`、`project.unmount` | `mounting → ready → suspended / unmounting → unmounted`，出错进入 `failed`。VPS2 创建新实例，旧路径失效。只读租约由 SFTP 和 FUSE 两层限制写入 |
| 本机命令 | `local_shell.run`、`local_shell.status`、`local_shell.stop`、`local_shell.list` | `running → completed / failed / timed_out / unknown`，停止进入 `cancelling → cancelled`。协议保留 `queued`，当前 Worker 直接启动。短命令最多等约 15 秒，长命令返回原运行编号 |

每条 SFTP 请求重新核对租约。暂停时关闭流，清理已有文件句柄。正在进行的系统调用可能已经生效。连接中断且存在写入尝试时，后续恢复会要求核对实际内容和命令状态。跨进程外部编辑仍存在检查与写入之间的竞态。当前实现依赖文件身份、大小、时间戳和安全打开来检测冲突，不提供跨多个文件的严格事务。

## 幂等、日志与恢复

1. 相同会话、相同 `requestId` 和相同指纹复用原 `runId`。指纹涵盖 Shell、脚本、当前目录和环境覆盖。不同指纹返回 `COMMAND_CONFLICT`。
2. 日志游标以保留的 UTF-8 文本编码的字节计数计算。多字节字符中间的游标无效。缓冲区丢弃旧日志时返回 `stdoutTruncated` 或 `stderrTruncated`，保留同一命令的运行编号和结果摘要。
3. 网络断开时关闭写入流并挂起租约。先用 `project.status`、`local_shell.status` 或 `local_shell.list` 查询。状态查询不会启动命令，重复停止不会创建新任务。
4. 已结束的命令使用真实退出码。Worker 重启时如果结果无法确定，报告 `unknown`。应用必须人工核对未确认文件或旧进程后再授权回收。仍确定在运行的命令必须先停止或等它完成。
5. 恢复成功后使用新的 `generation` 和挂载实例。旧句柄已被关闭。正式接入时，官方线程仍需使用原 `threadId` 恢复。已确认完成的工具调用无需重发。

## 错误和事件

```json
{"protocolVersion":1,"requestId":"build-1","ok":false,"error":{"code":"COMMAND_CONFLICT","message":"该请求编号已用于不同命令。","retryable":false,"requestId":"build-1"}}
```

错误码包括 `INVALID_REQUEST`、`AUTH_DENIED`、`PROJECT_NOT_FOUND`、`LEASE_BUSY`、`LEASE_EXPIRED`、`LEASE_SUSPENDED`、`MOUNT_UNAVAILABLE`、`MOUNT_DISCONNECTED`、`FILE_CONFLICT`、`WRITE_OUTCOME_UNKNOWN`、`COMMAND_CONFLICT`、`COMMAND_STATUS_UNKNOWN`、`BRIDGE_DISCONNECTED`、`RECONCILE_REQUIRED`、`TIMEOUT` 和 `UNSUPPORTED_OPERATION`。`retryable` 表示核对状态后可重试，调用方不可据此盲目重跑。`details` 预留给非敏感诊断。协议处理器过滤底层堆栈和绝对路径。

事件名为 `project.leaseChanged`、`project.mountChanged`、`local_shell.output`、`local_shell.stateChanged` 和 `project.reconcileRequired`。事件格式携带 `protocolVersion`、`deviceId`、`threadId`、`projectId`、`sequence`、`timestamp` 和 `value`。接收端按实体和序号去重，重连时查状态以补齐丢失的事件。事件封装已有实现，生产 UI 转发与重连去重仍需接入。

## 测试与部署边界

```powershell
node --test test/windows-native-protocol.test.js test/windows-local-shell.test.js test/sftp-project-write.test.js
node scripts/verify-windows-project-mount.cjs
node scripts/verify-windows-project-mount.cjs --codex-sandbox
node scripts/verify-windows-project-mount.cjs --codex
node scripts/verify-windows-project-mount.cjs --claude
```

后四条使用 Windows 和 VPS2 真机夹具。夹具占用临时项目和隔离挂载命名空间，验证外部进程看不到项目文件。`--codex` 和 `--claude` 还需要 VPS2 上的对应订阅登录。这些命令无须修改运行中的主控、用户项目或 SSH 登录配置。

2026-11-20 第二阶段验证结果，保留作故障基线：

- Windows 全量测试 282 项通过、32 项跳过，Ubuntu/WSL 全量测试 306 项通过、8 项跳过，两端均无失败。覆盖了重叠写入租约、旧 SFTP 连接失效、人工核对、UTF-8 日志游标和群聊原有行为。
- VPS2 私有命名空间中的 SSHFS 实测通过。命名空间外看不到夹具文件。Windows 实际收到文件替换和二进制写入。
- 官方 Codex App Server 在挂载路径创建了夹具线程。模型轮次因刷新令牌已被使用而失败。独立的 `workspace-write` 文件探针超时，还没有证明官方沙箱能稳定写入该挂载。
- Claude 夹具启动了挂载工作目录和隔离沙箱。Claude Code 返回未登录，未完成模型原生读写和 `local_shell` 调用。
- Windows Shell 组件实测构建并运行了临时 EXE。两个官方模型均未完成发起构建、核对产物和断线后续跑的验收。

生产启用前仍需通过安装包 GUI 验收、Codex 真实模型构建和备用线路切换测试。依照 [原生单聊部署说明](WINDOWS-NATIVE-CHAT-DEPLOY.md) 备份 VPS2 服务文件，再在测试设备更新 Windows 安装包和 Worker。回滚恢复原服务文件和安装包，保留用户工作区、认证和会话数据。
