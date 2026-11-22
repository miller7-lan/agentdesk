# 部署记录

每次部署一条，最新的在最上面。只写版本、做了什么、怎样验证、怎样回滚；不写 IP、令牌和密钥。

## 2026-11-22 17:40（北京时间）· VPS2 · 上线 2026-11-22（权限统一）

- **源码**：`main` 上的 `531b33f`，内容是 `f6d3e96` 权限统一、`45045c0` 和 `0fb7f60` 文档，加上本次 Antigravity 的改动。部署前运行树是 `80fbb2d`（群聊 v7 审计版）。
- **做法**：
  - 备份运行树、配置、单元文件和 drop-in；
  - 进维护模式；
  - 用 `install -m 0644` 只替换有变化的 `orchestrator/*.js`，共 11 个：adapters、chat-server、group-features、group-local、permission-prompt（新增）、platform-mac、scheduler、terminal-sessions、windows-native-seat、windows-project-leases、windows；装完逐字节核对一致；
  - 重启 `agentdesk-orchestrator`，然后退出维护模式。

  **没有运行 `install-ubuntu.sh`**：现网的 `agentdesk-home-mount.service` 有 drop-in，单元文件与仓库一致，`agent-chat.sh` 也没变，所以不覆盖单元、不 daemon-reload。
- **配置**：没有改。核对过 [ROLLOUT-2026-11-22.md](ROLLOUT-2026-11-22.md) §2.3 和 [UPDATE-DIRECTION.md](UPDATE-DIRECTION.md) §3 要求的各项：
  - `adapters.{claude,grok,antigravity}.sandbox` 已配置；
  - `groupFeatures` 中 `anyLead`、`localStages`、`localCopy`、`credentialSandbox`、`envFix` 都是 true（14 项全开）；
  - `routing.implement` Codex 排第一；
  - `homeMounts` 为 true，`discoverModels` 为 true；
  - `adapters.claude.models` 已列出。
- **Antigravity（ROLLOUT §5）**：
  - `execute_url` 在原生单聊（`chat-server.js`）和群聊（`adapters.js`）里都从 deny 移到了 allow；
  - 权限说明改为四家同名；
  - 子代理**没有加**：`agy --help`（1.5.14）里没有子代理或浏览器子代理工具的权限名，按文档“不要猜”跳过。
- **验证**：
  - `npm test`：427 项，`# fail 0`（Node 24 和 Node 22）；
  - 部署后服务 active，NRestarts=0；home-mount 为 active；17:40 以来没有 warning 及以上的日志；监听端口与部署前一致；配置 sha256 不变；
  - `ad doctor`：ok，codex、claude、grok、antigravity 均可用，`anyLead: true`；
  - 用已安装的代码和一个替身 CLI 核对：Antigravity 群聊步骤的 `--settings` 里 `execute_url(*)` 在 allow 中；两段权限说明都写明四家；
  - 原生单聊服务（antigravity、claude）用临时状态目录完成 initialize；
  - directChatV2 没有打开（没有 `devices.json`）。
- **没有验证**：ROLLOUT §6 的每台电脑验收（四家单聊问权限、`git push`、`ls ~/.agentdesk` 被拒、子代理、Mac 群聊 `git push`）要在用户的 Mac/Windows 上、装上新客户端后进行，本次没有做。原生单聊里已经打开的会话要关掉重开，才会用新权限。
- **回滚**：VPS2 上 `/root/backups/agentdesk-deploy-rollout-20261122-174040CST/ROLLBACK.md`（恢复运行树 tgz，然后重启）。
