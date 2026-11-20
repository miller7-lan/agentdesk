# Windows 单聊原生开发模式测试记录

## 第三阶段验收

Windows 原生单聊通过 VPS2 的官方 CLI 访问私有 SSHFS 项目挂载。真实 Windows 命令通过同一个独立 Worker 执行。模型验收使用临时 C# 工程，不改真实项目。

| 单聊 | VPS2 与 Windows 真机结果 |
| --- | --- |
| Codex | 官方 App Server 成功创建线程，`workspaceWrite` 探针写入真实 Windows 文件。模型轮次遇到刷新令牌冲突，用户确认额度已耗尽，模型发起的编辑、编译和续聊待验收。 |
| Claude | 官方模型使用原生文件工具改源文件，通过 `local_shell` 编译并运行 EXE。断开后能查到原 `runId` 的输出和退出码，恢复同一线程。 |
| Antigravity | 官方模型使用原生文件工具改源文件，通过 `local_shell` 编译并运行 EXE。断开后能查到原 `runId` 的输出和退出码，恢复同一线程。 |
| Grok Build | 真机夹具连接了 native seat 与 Windows Worker。断开后能查到原 `runId` 的输出和退出码，并恢复 AgentDesk 线程。官方 CLI 实测返回 `402 Payment Required`，提示用量耗尽。模型驱动的编辑、编译和供应商上下文续聊待验收。 |

Claude、Antigravity 的 EXE 均核对了 Windows 源文件、PE 文件头、运行输出与退出码。重连测试要求挂载租约推进代际。跨供应商的并发写入仲裁在自动化中验证。当前机器缺少 VPS1 跳板配置，真实备用线路切换与打包版 GUI 验收仍待完成。模型级性能对比尚未采集。

复测命令、安装和回滚流程见 [Windows 原生单聊部署与验收](WINDOWS-NATIVE-CHAT-DEPLOY.md)。

## 第二阶段记录

2026-11-20。开发基线为 `65da1ea`。本记录对应可写项目 SFTP、VPS2 SSHFS 挂载和 Windows 本机命令这三个已实现的组件。产品单聊接入有单独的验收项。

全量回归包含 310 项。Windows 通过 278 项、跳过 32 项。Ubuntu/WSL 通过 304 项、跳过 6 项。两端均无失败。

## 验收结果

| 事项 | 结果 | 范围 |
| --- | --- | --- |
| 项目 SFTP | Windows 实测通过 | 二进制分块读写、追加、截断、同步、文件时间戳、目录创建删除、重命名、临时文件原子替换 |
| 路径约束与冲突 | Windows 实测通过 | 拒绝路径越界、NTFS 备用数据流、junction 和硬链接。已打开文件被外部修改后，下一次写入返回冲突，保留外部内容 |
| VPS2 挂载 | 真机夹具通过 | VPS2 进程从 SSHFS 读取 Windows 文件，替换文件，写入并读回 160 KiB 二进制，创建目录并重命名。Windows 侧直接检查内容和大小 |
| `local_shell` | Windows 实测通过 | PowerShell、CMD、项目工作目录、环境变量、退出码、后台运行、增量日志、停止、重复请求复用同一运行 |
| Shell 与客户端分离 | Windows 实测通过 | 独立进程运行命令。客户端断开并重新连接后通过原 `runId` 读到实际退出结果 |
| 跨模型项目租约 | Windows 组件测试通过 | 模拟 Codex 和 Claude 两个身份。相同项目阻止第二个写者，同时允许只读访问。不同目录可以分别取得租约，设备身份不匹配时拒绝请求 |
| Windows EXE | Windows 实测通过 | 临时 C# 工程由 Windows .NET Framework 编译器构建。随后实际运行生成的 EXE，检查退出码、输出和 PE 文件头 |
| CLI 原生单聊 | 尚未端到端验证 | 当前提交的挂载与 Shell 组件尚未接入 Codex App Server 的会话工作目录或 Claude Code 的沙箱工作目录 |
| 断线后继续 AI 会话 | 尚未端到端验证 | 本机 Shell 的断开和恢复已验证。文件传输中途断开、VPS1 线路切换、原模型会话续跑与未知写入核对还需要实测 |
| 真实项目完整构建 | 尚未端到端验证 | 临时 C# 工程证明 Windows 命令层能构建 EXE。两个模型发起的依赖安装、测试、修复、构建和产物验收还需要验证 |

## 复现

在 Windows 仓库运行以下命令。夹具使用临时目录，完成后清理。

```powershell
node --test test/sftp-project-write.test.js test/windows-local-shell.test.js test/command-runs.test.js
npm test
```

从 Windows 通过已配置的 VPS2 管理连接运行真机挂载夹具。VPS2 需要已有 `sshfs`、`fusermount3` 和 `/dev/fuse`。夹具用 App Server 的流式命令通道承载测试 SFTP 流，使用临时挂载点，不改运行中的主控配置和生产挂载。

```powershell
node scripts/verify-windows-project-mount.cjs
```

成功时输出 `VPS2 SSHFS read, atomic replacement, binary write, mkdir and rename` 和 `Windows disk contents verified`。这项验证通过一条真实 SSH 连接，测试的是文件协议和落盘。正式单聊的接入、权限隔离和会话绑定仍需验收。

## 性能测量

挂载夹具中的文件操作通过原生文件调用和 SSHFS 完成，文件 MCP 调用次数为 0。命令夹具验证了后台任务复用同一运行编号和按游标读取新增日志。尚未使用相同的 Codex 或 Claude 任务采集改造前后耗时、工具次数、成功率、重试和 Token，因此没有提供模型级性能结论。

## 接入与回滚边界

Windows 的写入实现和 VPS2 项目挂载与群聊只读挂载分开。当前生产入口仍运行原有路径。下一阶段需要为设备绑定的 Codex / Claude 会话创建隔离的 VPS2 挂载命名空间，将这两条线路连到新的项目挂载和本机命令组件，并验证断线后先核对旧运行再继续。尤其需要验证其他 VPS2 CLI 进程无法借用该挂载或本机命令权限。

此阶段仅验证开发分支。恢复生产时可继续使用 `65da1ea` 对应的 Windows 安装包及原 VPS2 服务文件。后续启用时，部署顺序和备份位置见 [部署说明](DEPLOY.md)。会话数据、登录凭据和项目文件应保留在原位置。
