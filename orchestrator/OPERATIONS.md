# VPS 2 部署和运维

## 安装

在 Ubuntu 上安装 Node.js 24（默认 `/usr/bin/node`，独立安装时通过 `AGENTDESK_NODE_BIN` 指定路径）、Git 和三个供应商的官方 CLI，并把 CLI 可执行文件安装在系统服务可访问的位置。用各供应商的认证方式给专用服务账户配置凭证。样例使用各自的 API Key 文件，也可以删掉该项并使用已登录的独立 CLI home。输入 VPS root 密码时使用本地 SSH 提示。

```sh
sudo bash orchestrator/install-ubuntu.sh
sudoedit /etc/agentdesk-orchestrator/config.json
```

将凭证文件放在 `/etc/agentdesk-orchestrator`，权限为 `root:agentdesk` 和 `0640`。Windows 和 VPS 1 只持有各自的 Relay 设备凭据。Relay 的 CA 文件可以省略以使用系统公信 CA。生产 Relay 地址、端口和设备 ID 使用 VPS 1 的配置。各 CLI 的 home 在 `/var/lib/agentdesk-orchestrator/homes/<provider>`，配置好后用服务账户确认各 CLI 可以非交互启动。服务账户运行受信任的项目，三个 CLI 的 home 和环境变量分别配置，文件权限由同一服务账户管理。

为每个项目准备可从 Windows 权威仓库同步的 bare Git 镜像，设置到 `workspaces.<id>.repository`。更新 Windows 项目后，先让镜像取得该提交。主控会在每个任务开始时读取 Windows 的 HEAD 并检查工作区干净，再使用同一提交生成各 CLI 的独立 worktree。Linux 可计算的补丁暂存在 VPS 2，审核通过后由 Windows Bridge 检查基线和冲突并写回。Windows Runner 用当地项目执行测试。

```sh
sudo systemctl enable --now agentdesk-orchestrator
sudo systemctl status agentdesk-orchestrator
sudo journalctl -u agentdesk-orchestrator -n 30
```

## Windows 连接

1. 将 `windows-bridge.example.json` 复制到 Windows 用户的 `.agentdesk` 目录，填写项目路径、已授权命令、Windows 自有 Relay 令牌和 VPS 2 SSH 配置。命令使用固定的程序与参数数组。若需要执行 Maven 或 Gradle 的批处理文件，可配置固定的 `cmd.exe /d /c` 参数数组。项目设为 `write:true` 才能改文件，启用 `desktop:true` 后再通过 AgentDesk 桌面开关启停本机控制。
2. 给 Windows Bridge 一把独立 SSH 密钥。在 VPS 2 为 `agentdesk` 用户登记其公钥，限制为下面的强制命令。保留独立的现有 Codex App Server 公钥，以继续使用原 AgentDesk 界面。核对 SSH 主机指纹后更新 Windows 的 `known_hosts`。
3. 在 Windows 的 `.agentdesk/remote.json` 加上 `orchestratorBridge`，值是 Bridge 配置的绝对路径，然后重启 AgentDesk。主路和备用路会分别连接，VPS 2 默认选择 SSH。只使用新版 Windows Bridge 时可将旧 SSH MCP 隧道设为 `"remoteForward":""` 和 `"manageSshd":false`。

```text
restrict,command="/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/ssh-gateway.js /var/lib/agentdesk-orchestrator/bridge.sock" ssh-ed25519 <WINDOWS_BRIDGE_PUBLIC_KEY>
```

## macOS 连接

macOS Bridge 与 Windows 可同时保持 SSH 连接。给 Mac 分配独立的 SSH 公钥和私有 socket。例如在 VPS 2 配置 `"sshBridges":["mac"]`，并为项目配置 `"sshBridge":"mac"` 和独立的 Git 镜像。Mac 的公钥强制命令使用 `bridge-mac.sock`。Mac 项目默认选用自己的 SSH 链路。需要备用时，在 VPS 2 的 `relayBridges.mac` 填入另一组 Relay 配对参数。Mac 配置中的 `relay` 保存其对端设备参数。让 VPS 1 为 Mac 单独登记一对设备，使用不同于 Windows 的设备 ID 和令牌。

在本机用 Node.js 24 运行 `orchestrator/mac-bridge.js /absolute/path/to/mac-bridge.json`。SSH 配置提供 `host`、`port`、`user`、`key` 和经校验的 `knownHosts` 绝对路径。`workspaces` 只列出授权的项目和命令。配置 `desktopExecutable` 可接入签入会话中的官方 macOS agent-desktop。文件和命令功能仅依赖 SSH 和项目授权。辅助功能和屏幕录制需要用户在 macOS 设置中分别授予，权限取决于实际运行后台 Bridge 的进程归属。

使用 launchd 时，将进程放在已登录用户的 `gui/<uid>` 会话中，`ProgramArguments` 使用 Node、脚本和配置的绝对路径。管理命令上传和下载时可设置 `AGENTDESK_BRIDGE=mac`，从而让无工作区字段的流消息走 Mac。用 `AGENTDESK_BRIDGE=mac` 执行 `route relay` 或 `route ssh` 只切换 Mac 的链路。Mac 的文件删除移至 Bridge 状态目录内的 `trash`。

### Mac 应用

Apple Silicon 上先运行 `npm ci`，再运行 `npm run dist:mac -- --arm64`。构建产物位于 `dist/mac-arm64/AgentDesk.app`。安装后用 `~/.agentdesk/mac-remote.json` 配置单独的 Codex App Server SSH 公钥和 VPS 工作区。后台 Bridge 的 `controlSocket` 指向其私有状态目录中的 `control.sock`，`controlWorkspace` 指定对应的 Mac 项目。配置 `desktopSocket` 指向同目录的 `desktop.sock` 时，运行中的 Mac 应用提供桌面操作，后台 Bridge 继续处理连接、文件和命令。

在应用底部打开「线路与模型」，为 Mac 主控任务选择 SSH 主用或 VPS 1 Relay 备用。主路断开时，可以通过在线的备用链路切换。任务可以使用自动协作，也可以指定 Codex、Claude Code 或 Grok Build，并填入该 CLI 接受的模型 ID。模型 ID 留空时使用其默认模型。普通 Codex 聊天使用自己的 SSH 会话和模型选择器。

## 任务与切换

```sh
ad() { sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/admin.js /var/lib/agentdesk-orchestrator/admin.sock "$@"; }
ad submit project '修复并审核项目中的问题' python-test
ad status "$TASK_ID"
ad apply "$TASK_ID"
ad cancel "$TASK_ID"
```

`apply` 只接受状态为 `needs_review`、原因是 `patches_ready` 的任务。它会应用已审核的补丁，并在提供测试命令时运行测试。查看补丁时使用 `/var/lib/agentdesk-orchestrator/worktrees/<task-id>/<step-id>.patch`。子 Agent 的保留工件应在确认无需恢复后清理。

主路断开时，等当前任务进入可核对状态，然后执行 `ad route relay`。有未确认的命令或写入时执行 `ad reconcile "$TASK_ID"`。备用继续使用同一个 Windows Bridge 的操作数据库。主路恢复后执行 `ad route ssh`。运维命令也支持按原 ID 查询 Bridge、下载截图和传输文件。

```sh
ad bridge "$TASK_ID" task.status '{"operation":"operation_status","request_id":"<ORIGINAL_REQUEST_ID>"}'
ad bridge "$TASK_ID" task.request '{"operation":"desktop","workspace":"project","tool":"desktop_screenshot","arguments":{}}'
ad download "$TASK_ID" ./screen.png '{"operation":"artifact","stream_id":"<SCREENSHOT_STREAM_ID>","sha256":"<SCREENSHOT_SHA256>"}'
ad download "$TASK_ID" ./readme.txt '{"operation":"read","workspace":"project","path":"README.md"}'
ad upload "$TASK_ID" ./new-file.txt
```

上传返回的流 ID 可用 `file.write` 发布。重试传输时执行 `ad upload "$TASK_ID" ./new-file.txt "$STREAM_ID"`，保留原文件内容和流 ID。对待核对的操作保留原 ID，避免重复跑开发命令或写入。

## 资源和验收

默认同一时间执行一个任务，每种 CLI 最多一个并发实例。任务的依赖允许时三个 CLI 可以同时运行。Windows 按工作区限制写入和开发命令并发。systemd 对 VPS 2 设置 3 GiB 内存硬上限和 128 个进程或线程上限。单次 CLI 尝试日志限额 4 MiB。Relay 操作回执和 Windows 临时流在 24 小时后清理。定期检查 SQLite、工件和历史日志的磁盘占用。

```sh
npm test
python3 -m unittest discover -s relay/tests -q
systemctl show agentdesk-orchestrator -p MemoryCurrent -p MemoryPeak -p NRestarts -p TasksCurrent
```

本地测试用模拟 CLI、实际 Python Relay 和临时 Git 工作区。部署后用真实 CLI 各跑一个独立任务，再提交包含独立实现、审核和研究步骤的任务，确认三个 CLI 同时在线、返回结果且内存留有余量。分别在主路、备用路验证鼠标、键盘、截图、文件和 Runner。断开主路，核对原请求后手动切换。端到端验收需 Windows 用户会话、VPS 1 Relay 设备注册和三个有效模型账户。

可以从服务账户运行三个 CLI 的并发连通性检查。它使用临时 Git 工作区，通过三个实际供应商账号发起轻量请求，报告各 CLI 的结果和当前 cgroup 的峰值内存。为避免与正式任务叠加资源，运行前请先让主控队列空闲。

```sh
sudo systemd-run --wait --pipe --uid=agentdesk --gid=agentdesk \
  -p MemoryHigh=2500M -p MemoryMax=3G -p TasksMax=128 \
  /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/smoke.js /etc/agentdesk-orchestrator/config.json
```
