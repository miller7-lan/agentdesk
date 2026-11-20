# Windows 原生单聊部署与验收

本流程适用于在 Windows 应用里通过 VPS2 官方 CLI 开发真实项目。Windows 全访问单聊使用已经配置为可写的 Bridge 项目。项目路径由当前 Windows 配置解析，只有本机项目目录与 Bridge 根目录一致、SSH 主机和端口匹配时才进入原生链路。VPS2 启动器未安装时，现有客户端仍可使用旧链路。

## 已验证的故障与修复

- **Codex 沙箱超时。** 普通 VPS 目录的 App Server 探针不到 1 秒，诊断全访问下的 SSHFS 读写约 8 秒。Bubblewrap 在绑定项目和保护 `.git`、`.agents`、`.codex` 等路径时产生多次远程元数据查询。旧探针超时终止时可能已经写入，所以要核对实际落盘。App Server 从 VPS 本地目录启动，`thread/start` 使用挂载目录，`workspaceWrite` 只显式授权此项目。75 秒预算下实测约 54 秒结束，Windows 文件也通过核验。该时间来自利用 App Server 回传 SFTP 的测试线路，不能推断所有网络下都相同。
- **正式宿主启动死锁。** 宿主转发 SFTP 时同步解析自己的 FUSE 挂载，会阻塞它等待的回复。现在启动器从 VPS 本地目录派生 CLI，挂载路径留给子进程解析。真实 VPS2 已能通过该启动器连接 Codex 与 Claude 的官方线程。
- **Claude 认证。** 现有登录目录属于 `agentdesk`；用 root 运行受限夹具时，沙箱内看不到该用户的凭据。启动器按现有配置目录的属主降权运行 Claude，挂载仅在私有命名空间内按该 UID/GID 提供访问。这个过程没有复制凭据。Claude 已经通过真实 Worker 原生修改 Windows 源码，调用 `local_shell` 构建并运行 EXE。
- **Codex 模型额度。** 官方 App Server 的线程与沙箱已经分别验证。真实模型轮次仍需有效订阅认证和可用额度。现有轮次曾报告刷新令牌已被使用。需要时在实际服务账户下运行 `codex login --device-auth` 并完成网页授权，待额度恢复后再运行模型验收。
- **Claude 断线恢复。** 使用原生启动器与独立 Worker，关掉连接后重新查到了原 `runId` 的输出和退出码。核对 Windows 文件后推进租约代际，并成功恢复同一个 Claude 线程。当前测试机没有配置 VPS1 跳板，真机线路切换仍需在已配置跳板的设备验收。
- **自动化回归。** Windows 284 项通过、32 项跳过，Ubuntu/WSL 308 项通过、8 项跳过，均无失败。包括群聊只读挂载、工作树、补丁和调度回归。

## 部署前验收

在 Windows 的开发分支上连接具备管理命令权限的 VPS2 夹具账户。夹具使用临时项目和私有挂载。Claude 命令包含真实模型调用。Codex 的模型版本在额度可用时运行。

```powershell
node scripts/verify-windows-project-mount.cjs --codex-sandbox
node scripts/verify-windows-native-seat.cjs
node scripts/verify-windows-native-seat.cjs --claude --model --reconnect
node scripts/verify-windows-native-seat.cjs --model
npm test
```

上线前还需用对应分支的安装包打开 AgentDesk，选择已配置的临时项目，分别从 GUI 发起 Codex 和 Claude 的构建请求。核对 Windows 磁盘内容、EXE 标头、退出码、日志、相同项目的第二个写者是否被拒绝，以及关闭并重开窗口后是否仍能查询原 `runId`。VPS1 切换需使用已登记跳板的测试机，验证换线路后继续同一会话。生产配置和真实项目不作为试验对象。

## 更新顺序

确认 VPS2 上有 `sshfs`、`fusermount3`、`bwrap`、`setpriv` 和可用的 `/dev/fuse`。当前实现利用已认证的官方 App Server 管理通道启动私有项目命名空间。它需要现有服务账户的挂载权限。受限权限环境应先验证现有管理通道能运行 `unshare --mount --propagation private true`。不要为此放宽普通 CLI 或项目账户的系统权限。

通过验收后，先更新 VPS2 文件，再覆盖安装同一提交的 Windows NSIS 安装包。以下清单只交付原生单聊的启动器与其直接依赖。现有安装中的其他服务若早于开发基线，先参照 [通用部署说明](DEPLOY.md) 同步依赖。

```bash
git fetch origin feat/windows-native-dev
git switch feat/windows-native-dev
git pull --ff-only

app=/opt/agentdesk-orchestrator
backup=$(sudo mktemp -d /var/backups/agentdesk-native-XXXXXX)
files=(native-channel.js native-project-session-host.js project-mount.js chat-server.js)
for name in "${files[@]}"; do
  "$app/node" --check "orchestrator/$name" || exit 1
  if sudo test -f "$app/$name"; then
    sudo cp -a -- "$app/$name" "$backup/$name" || exit 1
  fi
done
git rev-parse HEAD | sudo tee "$backup/revision" >/dev/null
for name in "${files[@]}"; do
  sudo install -m 0644 "orchestrator/$name" "$app/$name" || exit 1
done
```

保留上一个 Windows 安装包。关闭旧版应用前检查本机后台命令是否仍在运行，避免更新时杀掉 Worker。覆盖安装后沿用原项目和 Bridge 配置。重开应用会重新检查 VPS2 启动器是否存在，并在首次用到原生单聊时启动或连接独立 Worker。保持本机数据目录中的 `windows-native-chat`、VPS2 的单聊历史与登录目录。

## 回滚

从更新时记下的 `backup` 目录恢复同一批文件。备份中不存在的文件仅在确认它由这次安装新增后移除。按原通用部署流程确认活跃任务排空后再处理服务进程。用旧版 Windows NSIS 安装包覆盖安装，保留 Worker 运行记录、SSH 登录配置与项目文件。暂停中的项目须先查询旧命令并核对写入结果。
