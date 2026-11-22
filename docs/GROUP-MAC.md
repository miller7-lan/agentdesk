# 群聊 v7 在 Mac 上（Q6：按平台分开的文档）

代码：`orchestrator/platform-mac.js`（平台部分）、`orchestrator/group-local.js`（Bridge 端操作）。开关见 [GROUP-V2.md](GROUP-V2.md)。

## 本机命令（`localStages`、`credentialSandbox`）

- 读取、审查、诊断、验收步骤用 `local_shell_run` 在**原项目**里运行任意命令，用登录 shell（默认 zsh，也可以选 bash）。
- 打开 `credentialSandbox` 后，命令在 `sandbox-exec` 下运行（M2）：
  - **只**拒绝读写 AgentDesk 自己的目录（`~/.agentdesk`、`~/Library/Application Support/AgentDesk`、Bridge 的状态目录）；
  - 凭据目录（`.ssh`、钥匙串、`.npmrc`、`.aws` 等）和 `.git` 内部**都不挡**，和原生单聊一样：SSH 和 HTTPS 的 `git push`、包管理器、云服务 CLI 都能用。

  这是 2026-11-22 权限统一（提交 `f6d3e96`，见 [ROLLOUT-2026-11-22.md](ROLLOUT-2026-11-22.md)）之后的行为。之前 M2 的做法是“挡凭据目录和 AgentDesk 密钥目录”，已被这次统一取代。代码里 `credentials: true` 的选项仍然保留，但群聊不再使用。
- 已有的白名单命令（`windows_run_command`）在开关打开时也套同样的 sandbox。

## 写代码步骤的本机副本（`localCopy`，O3；M3 为推荐做法）

- 副本放在 `~/Library/Caches/AgentDesk/group-copies/<任务>/<步骤>`，权限 0700。不能放在 Bridge 状态目录下，因为 sandbox 对所有命令都关闭了那个目录，副本里的命令也会被拒绝：
  - 用 `cp -c -R`（APFS 写时复制）建立，不用硬链接或符号链接；
  - 包括 `.git`、`.env` 和 `node_modules` 等被忽略的目录；
  - 建好后核对快照版本，与规划时的项目一致才使用。
- 每次运行命令前，先把副本恢复到快照状态，再应用该步骤当前的改动；命令跑完后，把副本里的改动传回云端工作树（`.env`、密钥类文件留在本机，不传）。
- 副本里的命令在 sandbox 下运行。在 M2 的规则之外，再加 `(deny file-write* (subpath <原项目 Git 根>))`（O3），包括原项目的 `.git`。副本、临时目录和项目以外的位置照常可写（Q2）。
- 原项目只会通过 AgentDesk 的补丁应用发生变化。
- 条件不满足时不建副本，改代码只在云端进行，群聊里会说明原因：
  - 项目超过 2 GB；
  - 剩余空间不足副本大小的 2 倍；
  - 项目根目录不是 Git 仓库根。
- 任务结束时删除副本；Bridge 启动后第一次清理时，会删掉上次留下的副本。
- `sandbox-exec` 已被 Apple 标为不推荐使用。如果将来被移除，命令会直接失败，不会在没有保护的情况下运行。

## 环境修复（`envFix`）

- 补丁应用到原项目的方式与 `git apply` 相同。
- 写入前把受影响文件的原内容保存在 `env-fixes/<任务>/<修复>/`。撤销时会先核对这些文件仍是修复后的样子，不一致就拒绝撤销。
- N2 三类路径（凭据、`.git`、AgentDesk 目录）一律拒绝。

## 未在真机验证

以上行为做过自动测试：一是 Linux 本机，二是 GitHub CI 的 macOS 运行器。后者真实运行了 sandbox-exec：副本里的命令写原项目被拒绝，副本放在 Caches 下可以正常运行。这些是 CI 验证，**不是用户真机验收**。Mac 上需要真机验收的项目：

- 读取 `~/.agentdesk` 被拒绝（Operation not permitted）；`git push` 测试分支成功；
- `git status` 可用；
- HTTPS 推送可用；
- 副本里的命令写原项目被拒绝，写副本和项目以外的位置成功。

客户端（含新版 Bridge）还没有在用户的 Mac 上安装或替换。
