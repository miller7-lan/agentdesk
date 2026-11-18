# 故障排查

| 情况 | 检查 |
|---|---|
| 指纹列表为空 | 请管理员核对主机与端口，并把核验过的 ed25519 主机记录写入连接配置指定的 `known_hosts`。重启后向导会重新读取。 |
| 登记过期 | 在应用的连接窗口重新登记，SSH 和 Relay 使用新签发的限时凭据。 |
| 工作区无法读取 | 在「工作区」重新选择 Git 仓库根目录，并检查当前账户的读取权限。 |
| 主控显示 CLI 需要登录 | 请主控管理员在服务器终端运行 `agent-tasks login <cli>`，完成后重新检测。 |
| 额度数据缺失 | 检查主控是否为当前 Bridge 开放额度查询，以及对应 CLI 是否提供额度数据。 |
| 容器指标缺失 | 核对当前服务版本是否提供 `resource_status` 与 Docker 遥测。 |
| 状态栏或 `/status` 显示「VPS1 跳板」 | 当前 SSH 实际经 VPS1 转发到 VPS2；这是正常回退。直连恢复后，新连接会自动改回直连。 |
| 直连失败但没有切到跳板 | 只有传输层或 DNS 故障会回退；主机指纹、认证、配置和端口转发错误会保留直连并直接报错。确认 `jump.mode` 是 `auto`，且 `jump` 的 key/knownHosts 文件存在。 |
| 跳板报 `administratively prohibited` | VPS1 的 `permitopen` 与目标 VPS2 主机/端口不一致；按 `docs/DEPLOY.md` §4 核对，不要放开为任意目标。 |
| 跳板认证或指纹失败后长时间不重试 | 跳板线路上的认证/主机密钥失败会把自动重试拉长到 10 分钟，避免 VPS2 fail2ban 封禁 VPS1 的源 IP。修好配置后点「重新连接」。 |
| 跳板一直不回直连 | `auto` 模式只按 `probeMinutes`（默认 10 分钟）做 TCP + SSH banner 探测；探测成功只影响新连接。检查 `jump.probeMinutes` 和 VPS2 的 22 是否可达。 |
| Windows 打包版跳板报 ProxyCommand 错误 | 确认 `resources\ssh-jump.js` 和 `ssh-options.js` 存在；路径不要含 `"`、换行或 `%`；必要时用 `AGENTDESK_SSH` 指向可用的 `ssh.exe` 复现。 |
| 需要排查连接或构建 | 打开「诊断」，预览并导出 `tar.gz`，其中包含版本、有限的运行状态、应用日志和审计记录。诊断里的 `remote.route` 只显示 `direct`/`jump`/`suspended`。 |

应用日志位于 Electron 用户数据目录的 `logs/agentdesk.log`，最多三份，每份 5 MiB。审计文件按本地日期写为 `logs/audit-YYYYMMDD.jsonl`。
