# VPS 2 部署和运维

## 安装

在 Ubuntu 上安装 Node.js 24（默认 `/usr/bin/node`，独立安装时通过 `AGENTDESK_NODE_BIN` 指定路径）、Git 和要用的各家官方 CLI（Codex、Claude Code 必装；Grok Build、Antigravity 按需；Gemini CLI 已停用），并把 CLI 可执行文件安装在系统服务可访问的位置。样例按订阅登录配置（见下文「订阅登录」）；也可以在 `credentials` 里改用 API Key 文件。输入 VPS root 密码时使用本地 SSH 提示。

```sh
sudo bash orchestrator/install-ubuntu.sh
sudoedit /etc/agentdesk-orchestrator/config.json
```

将凭证文件放在 `/etc/agentdesk-orchestrator`，权限为 `root:agentdesk` 和 `0640`。Windows 和 VPS 1 只持有各自的 Relay 设备凭据。Relay 的 CA 文件可以省略以使用系统公信 CA。生产 Relay 地址、端口和设备 ID 使用 VPS 1 的配置。各 CLI 的 home 在 `/var/lib/agentdesk-orchestrator/homes/<provider>`，配置好后用服务账户确认各 CLI 可以非交互启动。服务账户运行受信任的项目，三个 CLI 的 home 和环境变量分别配置，文件权限由同一服务账户管理。

Codex 在 Ubuntu 上需要可用的 `bubblewrap` 才能用 `workspace-write` 写入 worktree。Ubuntu 24.04 若启用了 AppArmor 的用户命名空间限制，安装发行版的 `apparmor-profiles`，按 [Codex 沙盒文档](https://learn.chatgpt.com/docs/sandboxing) 载入 `bwrap-userns-restrict`，再用实际服务账户验证 `bwrap --unshare-user --ro-bind / / /bin/true`。

为每个项目准备可从 Windows 权威仓库同步的 bare Git 镜像，设置到 `workspaces.<id>.repository`。更新 Windows 项目后，先让镜像取得该提交。主控会在每个任务开始时读取 Windows 的 HEAD 并检查工作区干净，再使用同一提交生成各 CLI 的独立 worktree。Linux 可计算的补丁暂存在 VPS 2，审核通过后由 Windows Bridge 检查基线和冲突并写回。Windows Runner 用当地项目执行测试。

```sh
sudo systemctl enable --now agentdesk-orchestrator
sudo systemctl status agentdesk-orchestrator
sudo journalctl -u agentdesk-orchestrator -n 30
```

## 订阅登录、任务分配和 Antigravity

### 订阅登录

样例配置按订阅登录写，不放 API Key。每个 CLI 用自己的 home（`/var/lib/agentdesk-orchestrator/homes/<cli>`），以服务账户各登录一次：

```sh
sudo -u agentdesk env HOME=/var/lib/agentdesk-orchestrator/homes/claude /usr/local/bin/claude      # 按 CLI 自己的登录流程完成
sudo -u agentdesk env HOME=/var/lib/agentdesk-orchestrator/homes/antigravity /usr/local/bin/agy
```

登录后用 `ad doctor` 确认每个 CLI 都能启动并读到版本。任务执行中如果某个 CLI 报告掉登录或额度用尽，主控会暂时停用它（额度 30 分钟、登录 6 小时），把步骤交给下一个候选；`ad doctor` 会列出当前被停用的 CLI 和原因。

### 按能力分配任务

规划者（默认 Claude）给每一步标一种能力，主控按 `routing` 里的顺序挑第一个可用的 CLI：

| 能力 | 含义 | 默认候选顺序 |
|---|---|---|
| `plan` | 规划和拆分任务 | claude → codex |
| `triage` | 出问题时诊断：重试、返工还是放弃 | claude |
| `scout` | 读代码、日志、文档并写简报 | antigravity → grok（→ gemini） |
| `implement` | 改代码（唯一可以写文件的能力） | antigravity → codex → grok |
| `review` | 审查改动（交叉审查：改代码的成员不审自己的改动，除非没有别人可用） | antigravity → grok（→ gemini） |
| `research` | 查资料（联网搜索） | antigravity → grok（→ gemini） |
| `accept` | 按摘要验收 | claude |

默认（`groupFeatures.anyLead: true`）任意成员都可以做 `plan` / `triage` / `accept`，Claude 也可以承担其他能力，候选顺序照上表和 `routing`。关掉 `anyLead` 时 Claude 只做 `plan` / `triage` / `accept`，配置无法让它承担其他能力。括号里的 Gemini 只在配置了 Gemini CLI 时作为最后的后备：Google 已于 2026 年 6 月停用 Gemini CLI 并由 Antigravity CLI 取代，样例配置不再包含它。

在 `config.json` 的 `routing` 里改顺序即可调整，未配置的 CLI 会被跳过。Gemini 只能读，不能放进 `implement`。

### 按额度让位

订阅制下有限的是额度，不是 token。主控每 2 分钟读一次各 CLI 的额度（取 5 小时窗口和每周窗口里用得更多的那个百分比），按 `quotaPolicy` 决定谁还能接活：

| CLI | 用量超过 `soft` 后 | 用量超过 `hard` 后 | 默认 |
|---|---|---|---|
| Claude | 只做规划和验收 | 不再派活 | 60% / 95% |
| Codex | 只做改代码 | 不再派活 | 70% / 95% |
| 其他 | — | 不再派活 | 95% |

`keepFor` 列出超过 `soft` 后仍然保留的能力。读不到额度的 CLI 视为可用，额度真正用尽时会从它的报错里识别出来并改派。规划时，各 CLI 的已用百分比也会交给 Claude，让它把读代码、查资料、审查交给额度多的 AI。

每个任务结束时记录它消耗的额度：开始和结束时各读一次，差值写在任务的 `quota` 里，例如 `{"claude":{"fiveHour":3,"weekly":1}}`。这个差值包含同一账号在这段时间里的其他使用（比如你自己在电脑上用 Claude），窗口中途重置时该项不记录。token 用量仍记在 `usage` 里，只作参考。

### 用模板接入 Antigravity

已在 Linux `agy 1.5.10` 核验样例中的参数：`--mode plan` 用于只读，`--mode accept-edits` 用于生成补丁，`--output-format stream-json` 的最终 `result` 提供回复、会话 ID、用量与错误。样例不指定虚构的 `default` 模型；打开 `discoverModels` 后，主控会用当前账号的 `agy models` 自动刷新 `models` 和失效的 `defaultModel`，登录新账号后无需改配置。

官方安装入口为 `https://antigravity.google/cli/install.sh`。安装后，以主控服务账户和专用 HOME 启动一次 `agy` 完成 Google 登录。旧 Gemini OAuth 文件不等于已登录 Antigravity；应实际验证 `agy -p` 返回成功。远程 SSH 登录会提供浏览器授权 URL 和粘贴授权码的入口。参考 [官方认证说明](https://antigravity.google/docs/install?tab=cli) 和 [无交互模式](https://antigravity.google/docs/cli/headless/)。登录资料只保留在 VPS，不进入 Git 仓库。

如果暂不登录，在 `adapters.antigravity` 设置 `"authRequired": true`：诊断显示需要登录，自动分配跳过此 CLI。完成登录并验证后删除该标记或设为 `false`，重启主控恢复分配。此标记不删除任何登录资料，也不关闭其他 CLI。

Antigravity 没有内置适配器，用 `adapters.antigravity.template` 描述它的命令行。**先在 VPS2 上确认参数**，再填配置：

1. 用服务账户运行 `agy --help`，确认：无交互执行一次提示的参数、只读和可写的参数、指定模型的参数、恢复会话的参数、能否输出 JSON。
2. 按结果填写模板：

| 字段 | 含义 |
|---|---|
| `args` | 每次都带的参数；`{prompt}` 是提示内容，`{session}` 是会话 ID |
| `prompt` | `arg`（提示放在参数里，`args` 必须包含 `{prompt}`）或 `stdin`（默认） |
| `readonlyArgs` / `writeArgs` | 只读步骤 / 可写步骤额外带的参数 |
| `modelArgs` | 指定模型时带的参数，`{model}` 是模型 ID |
| `resumeArgs` | 恢复会话时带的参数，`{session}` 是会话 ID |
| `output` | `plain`（整段文本就是回复，默认）或 `jsonl`（每行一个 JSON） |
| `outputField` / `sessionField` / `usageField` / `errorField` | `jsonl` 时回复、会话 ID、token 用量与错误所在的字段，可以用点号写嵌套字段，例如 `result.response`；错误参与额度与登录失效识别 |
| `session` | `none`（默认）、`generate`（主控生成 ID 填进 `{session}`）或 `field`（从输出读取） |

3. 用 `ad submit project '只读：总结 README' ` 加 `ad status` 验证一次；步骤里应出现 `antigravity` 并有输出。Antigravity 如果有地方能读到额度，可以像 Claude 一样写成快照文件（`quotaFile`）。

### 单聊通道（Claude / Grok / Antigravity）

本机命令的工作目录绑定到发起它的项目或独立工作树。单聊在命令卡和终端面板显示本机输出及退出状态，命令卡可单独停止进程；停止整轮会同时请求停止本机命令。群聊成员的步骤记录显示其本机命令，补丁应用后的验证命令显示于「本机测试」。SSH 或 Relay 中断后通过原运行 ID 查询记录。查进度或切换线路时复用原请求。桌面应用重启时，通过本机记录恢复近期命令状态；缺少退出记录的运行显示为「结果待确认」。界面与模型结果均保留有长度上限的输出。

单聊查找本机文件时可用 `*_file_glob` 按通配符找文件、`*_file_grep` 按字面文本搜索并显示行号和上下文。`*_file_edit` 只替换匹配的 UTF-8 文本，默认要求原文只出现一次，可用批量读文件得到的版本防止覆盖外部改动。单聊定点编辑可以通过该轮的文件检查点撤销。群聊可用 `windows_glob_files` 和 `windows_grep_context` 搜索、`windows_edit_file` 精确编辑已授权的项目外文件。群聊项目内的改动经过任务工作区和补丁审阅。

三家都和 Codex 一样能联网搜索、读网页。装有 bubblewrap（`/usr/bin/bwrap`，Codex 的沙盒也要用它）时，`agent-chat.sh` 让 CLI 在沙盒里运行，并开放它自己的 shell 和读写工具：只作用于这个会话在 VPS 上的工作目录（只读轮次连它也只读），看不到其他会话、其他 CLI 的登录、任务数据库和主控配置。用户电脑上的文件仍只能通过 `agentdesk_file_*` 工具，写操作需要批准；用户授权过的本机命令通过 `agentdesk_command_list` / `agentdesk_command_run` 运行，同样需要批准。命令只来自 Bridge 配置里该项目工作区的 `commands` 和 `agentCommands`（Windows 读 `remote.json` 的 `orchestratorBridge`；Mac 在 `mac-remote.json` 写 `agentCommandsFile` 指向 Mac Bridge 的配置），按固定的程序和参数直接执行、不经过 shell，在项目目录运行，5 分钟超时。Codex 单聊也提供这两个工具。只读轮次可以列出授权命令，每步询问模式会展示实际工作目录及参数供确认，完全访问模式按项目授权运行。设 `AGENTDESK_CHAT_SANDBOX=off` 可关闭沙盒，此时 shell 和自带文件工具也一并关闭。

群聊派活同理：在 `adapters.<cli>.sandbox` 设为 `true`（样例已为 Grok、Antigravity、Claude 打开），这些 CLI 改代码时可以运行命令、跑测试，范围限于该步骤的工作副本（只读步骤只读），看不到其他任务、其他 CLI 的登录和 `/etc/agentdesk-*`。Codex 用它自带的沙盒，不受此项影响。


单聊与调度器是两条独立进程，部署或更新单聊文件不需要重启 orchestrator。生产变更前先备份 `authorized_keys`。

1. 复制文件到 `/opt/agentdesk-orchestrator/`：`chat-server.js`、`chat-mcp.js`、`transport.js`、`sandbox.js`、`agent-chat.sh`。两个 JS 用 `node --check` 校验；`agent-chat.sh` 设为 `0755`、`root:root`，只允许 sshd 通过强制命令调用。
2. 在 Mac 上为三家各生成一把专用 ed25519 密钥（目录 `0700`、私钥 `0600`）：

   ```sh
   mkdir -p ~/.agentdesk/keys && chmod 700 ~/.agentdesk/keys
   for agent in claude grok antigravity; do
     ssh-keygen -t ed25519 -N '' -C "agentdesk-chat-$agent" -f ~/.agentdesk/keys/${agent}_ed25519
   done
   ```

3. 把公钥追加到 sshd 使用的 `authorized_keys`（本项目的部署文件为 `/etc/ssh/agentdesk-authorized-keys`），每行绑定一个 provider：

   ```text
   restrict,command="/opt/agentdesk-orchestrator/agent-chat.sh claude" ssh-ed25519 AAAA... agentdesk-chat-claude
   restrict,command="/opt/agentdesk-orchestrator/agent-chat.sh grok" ssh-ed25519 AAAA... agentdesk-chat-grok
   restrict,command="/opt/agentdesk-orchestrator/agent-chat.sh antigravity" ssh-ed25519 AAAA... agentdesk-chat-antigravity
   ```

4. 准备服务账户目录，属主为 `agentdesk:agentdesk`、权限 `0700`：`homes/claude`、`homes/grok-chat`、`homes/antigravity`、`chat-workspace`。Claude 和 Antigravity 复用任务模式的 home，登录一次即可；Grok 的 `homes/grok-chat/.grok/auth.json` 由 chat-server 每轮从任务模式 `homes/grok/.grok/auth.json` 按 mtime 复制。
5. Antigravity 需要先用服务账户完成 `agy` 登录（见上文）。未登录时单聊会返回明确的认证错误，不会影响其它三家。
6. 在 Mac 的 `~/.agentdesk/mac-remote.json` 确认 `claudeKey`、`grokKey`、`antigravityKey` 指向第 2 步的私钥；默认就是上面的路径。
7. 校验并验证：`sshd -t`；从 Mac 用三把密钥各连一次，确认只能握手、不能执行任意命令；再在 AgentDesk 里新建单聊发一条消息。sshd 每次连接会重新读取 `authorized_keys`，不需要重启；单聊服务也不依赖 orchestrator。

### 多人同时使用（2～3 人）

每个人的电脑通过密码登记（见 [ENROLLMENT.md](ENROLLMENT.md)）或静态配置各有一个 Bridge 和自己的工作区，任务互不可见；同一项目可以让多个工作区指向同一个 Git 镜像（`repository`）。

- **并行**：主控同时跑 `maxConcurrentTasks` 个任务（默认 2，最多 8）。空出的位置先给当前正在跑的任务最少的那个人，再按提交先后，避免一个人的一长串任务挡住其他人。
- **每个 CLI 同一时间只跑一个进程**：所有人共用 VPS2 上同一个订阅登录，同时跑两个会互相覆盖令牌刷新。轮到的步骤如果它的 CLI 正忙，会等待并记录「等待 xxx 空闲」。确认某个 CLI 支持并发后，可以在 `cliConcurrency` 里调高，例如 `{"grok": 2}`。
- **额度是共享的**：三个人用的是同一份订阅额度。`ad ls` 按人（`owner`）列出每个任务消耗的额度，便于看谁用得多。
- **互不阻塞**：应用补丁只检查自己的任务；切换线路只在这台电脑自己的任务运行时被拒绝。
- **内存预算（4 GB + 2 GB swap）**：每个在线的人有一个聊天用的 Codex App Server 进程，任务步骤另算。3 人同时在线时建议保持 `maxConcurrentTasks: 2`；如果 `free -m` 显示开始频繁用 swap，先降到 1。

### agent 在你电脑上能做什么

agent 在 VPS2 的代码副本里改代码。通过本机 Bridge，它还能看你电脑上的项目（包括不在 Git 里的本地配置、日志）：

| 工具 | 作用 | 谁能用 |
|---|---|---|
| 列目录、看文件信息、按文件名搜索、分块读取 | 只读 | 所有步骤 |
| `windows_grep_files` 按内容搜索 | 只读；跳过 `.git`、`node_modules`、二进制文件和 1 MB 以上的文件 | 所有步骤 |
| `windows_list_commands` / `windows_run_command` 运行命令 | 在你**真实的项目目录**里运行，看到的是你当前的代码，不包含 agent 的改动；用来复现问题、查看本机环境 | 只有侦察和改代码的步骤 |

能运行哪些命令由你决定：Bridge 配置里每个工作区的 `agentCommands` 列出 `commands` 中允许 agent 调用的名字，默认是空的，即 agent 不能运行任何命令。只放无副作用或副作用可接受的命令，例如 `git-status`、测试命令；不要放部署、发布、删除类命令。agent 的改动在你点「应用补丁」之后才进入本机，并由任务的测试命令验证。

### 定期清理

主控每小时清理一次已结束任务留下的文件：各步骤的代码副本和补丁、CLI 日志、镜像里的 worktree 登记和 `agentdesk/<任务>/…` 分支。任务记录本身保留，历史、额度统计不受影响。

| 设置（`config.json` 的 `retention`） | 默认 | 含义 |
|---|---|---|
| `completedDays` | 3 | 完成或取消的任务文件（worktree、补丁、CLI 日志）保留几天 |
| `failedDays` | 7 | 失败的任务文件保留几天（方便排查） |
| `historyDays` | 60 | 任务记录和事件、单聊线程元数据、无主 worktree/日志保留几天；超期删除并回收数据库空间 |
| `uploadDays` | 7 | 工作区 `.agentdesk-uploads` 里的附件副本保留几天 |
| `minFreePercent` | 15 | 磁盘剩余低于这个百分比时，提前清理最早结束的任务，直到高出 5 个百分点 |

任务文件在 `completedDays`/`failedDays` 后先清掉；任务记录和事件再保留到 `historyDays`（默认 60 天），到期后从 SQLite 删除并执行一次 `VACUUM`。单聊线程元数据在单聊服务启动和应用每次重连时按同一个 60 天窗口清理。项目文件、`.agentdesk-skills`、登录凭据和配置永远不在清理范围。

等你审核补丁的任务永远不会被自动清理，因为应用补丁需要它；`ad doctor` 会显示有几个这样的任务。正在运行的任务也不会被清理。

系统日志由 `agentdesk-journal-retention.timer` 每天执行一次 `journalctl --vacuum-time=60d`，只保留最近 60 天的 journald 日志。

### 四个 CLI 每日自动更新

`agentdesk-cli-update.timer` 每天美东时间中午 12:00（`America/New_York`，自动跟随夏令时；错过的话开机后补跑）以 root 依次运行 Codex、Claude Code、Grok、Antigravity（`agy`）各自的官方 `update`，记录更新前后的 `--version`，然后通过主控的 admin socket 重新读取模型目录（`catalog`）。某个 CLI 更新失败时保留已安装版本、继续更新下一个，整次运行以非零退出码结束。Grok 的更新器把新版放在 `/root/.grok/bin`，脚本会把它装到主控实际调用的 `/usr/local/bin/grok`，下载缓存只留最新两份。它和客户端发起的 `cli-upgrade.js run-pending` 共用 `/run/agentdesk-cli-update.lock`，不会同时运行。

文件：`orchestrator/agentdesk-cli-update.sh`（装到 `/usr/local/sbin/agentdesk-cli-update`）、`agentdesk-cli-update.service`、`agentdesk-cli-update.timer`。

```sh
install -m 0755 orchestrator/agentdesk-cli-update.sh /usr/local/sbin/agentdesk-cli-update
install -m 0644 orchestrator/agentdesk-cli-update.service orchestrator/agentdesk-cli-update.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now agentdesk-cli-update.timer

systemctl list-timers agentdesk-cli-update.timer      # 下次运行时间
systemctl start agentdesk-cli-update.service          # 立即更新一次
journalctl -u agentdesk-cli-update.service -n 80      # 看结果（每个 CLI 的 before/after 和模型目录变化）
```

### 管理命令补充

```sh
ad ls          # 最近 50 个任务：谁提交的、状态、用到的 CLI、消耗的额度
ad doctor      # 各 CLI 是否安装、版本、当前额度、被停用的 CLI 和原因、分配顺序和额度阈值、上次清理结果和磁盘剩余
ad gc          # 立即清理一次，返回清理了哪些任务、释放了多少空间、磁盘剩余
```

## Windows 连接

### 群聊派活，单聊干活

**模型与思考程度。** 群聊的组长固定是 Claude 的最新 Opus（`adapters.claude.defaultModel` 设为 `opus`，Claude Code 总是把它解析成最新的 Opus），用户只在群聊输入栏选组长的思考程度（低 / 中 / 高 / 超高 / 最高，默认高）。派给每个成员的具体模型和思考程度由组长在方案里决定（步骤里的 `model` 和 `effort`），用户在群聊里不改。只有在各成员的单聊里，用户才自己选模型和思考程度，和 Codex 一样。各家的思考程度：Codex 用 `-c model_reasoning_effort`（极低到超高）；Claude Code 用环境变量 `CLAUDE_CODE_EFFORT_LEVEL`（低到最高；它的 `--effort` 参数在部分版本里不生效）；Grok Build 用 `--effort`（低到超高，随模型而定）；Antigravity 的 `agy` 目前没有对应的命令行参数（只有交互里的 `/effort`），所以不传，确认支持后可在 `adapters.antigravity.template` 写 `efforts` 和 `effortArgs`（如 `["--effort", "{effort}"]`）。

**一个项目可以有多个群聊。** 侧栏「＋ 新建群聊」再建一个，任务只出现在发出它的那个群聊里。鼠标移到群聊上点 × 删除：会先提示，并把这个群聊的派遣记录一起删除；只删本机的显示，主控上的任务和正在执行的任务不受影响。

群聊是组长派活和看进度的地方：每项任务显示组长的方案、一张分工进度表（成员、能力、模型、状态、一句话成果），以及从各成员单聊转发来的两类消息——“已接受任务”和完成总结；组长验收后再发一条验收总结。最近 4 项任务完整显示，更早且已结束的折叠成一行，点开可展开。

每个成员的具体工作在它的「派遣」记录里（侧栏群聊下方，每个项目每个成员一个）：组长派给它的任务说明、实时状态和完整工作过程——思考、运行的命令及输出、计划、改了哪些文件、调用的工具和搜索、回复；改了文件的步骤可以在这里查看补丁并确认写回本机。派遣记录只读，和你自己开的单聊（侧栏「我的单聊」）分开：要追加要求，回群聊 @成员，或点「新建单聊」。你自己的单聊同样显示每个任务的工作过程。别人的任务只在群聊里显示进度。

工作过程来自 VPS 上每个步骤的 CLI 日志（`task_activity` 操作，只对任务提交人开放）：Codex、Claude 按各自的事件格式解析；Antigravity 等按模板配置的 CLI 尽量取事件里的文字；Grok 的纯文本输出按原文显示。

组长自动分工时，改代码按 Antigravity → Codex → Grok Build 的顺序降级，永不派给 Claude；困难、跨模块或高风险的改动由组长直接点名 Codex。审查交给与改代码不同的成员。Gemini 在群聊分工里只读。

Antigravity 使用 Google AI Ultra 20x 订阅。当前账号的 `agy models` 提供 `gemini-3.8-flash-low`、`gemini-3.8-flash-medium`、`gemini-3.8-flash-high`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`；Gemini 4 是否出现取决于登录账号和 CLI 版本。配置打开 `"discoverModels": true` 后，主控启动时和每 24 小时按各 CLI 的当前登录刷新模型档案：新增的 Gemini 模型自动加入，下架的自动移除，手写说明保留；不再需要为换账号或新模型改配置。自动发现只采纳 Antigravity 的 Gemini 组，因为路由额度按 Gemini 窗口计算；其 Claude/GPT 模型如需使用要手工加入并另行核对额度分组。档位已写在模型 ID 里，CLI 不接受与 ID 冲突的 `--effort`，所以 Antigravity 模板不要配置 `efforts`/`effortArgs`。组长按 `adapters.antigravity.models` 里写的擅长说明为每一步选模型。手工新增模型前先用 `agy models` 核对真实 ID；不要写占位名，否则 CLI 会报 `invalid model selection`。

### 各 AI 单聊修改

> 本机当前版本同时提供「本机文件单聊」（见上文「单聊通道（Claude / Grok / Antigravity）」）：桌面「新建单聊」和成员面板的单聊入口会优先创建 `agent` 会话，由 `chat-server` 流式执行，`agentdesk_file_*` 工具直接读写本机，改动即时生效。本节的 `edit` 任务补丁流程仍用于群聊 `/edit`、成员的「派遣」记录和旧版 `provider` 会话；两条通道互不影响。

`writeProviders` 显式列出允许生成本机项目补丁的执行者，例如 `["codex","claude","grok","antigravity"]`。它只启用指定成员的直接修改任务，不改变群聊默认的 Claude 组长与能力分工。未安装、未登录或额度用尽的执行者不会因此变为可用。

群聊任务式单聊的计划模式仍只读；其他模式使用 `edit` 任务在 VPS 独立 worktree 生成改动，用户先查看差异，再确认应用到授权本机项目。群聊可使用 `/edit @Grok 任务内容`（也支持 Claude、Antigravity 等），直接指定修改者。直接修改不额外唤醒 Claude 验收，由提交人在现有补丁确认流程中审核。补丁写回仍检查本机 Git 基线、冲突与工作区授权。

Antigravity 仍须先核实实际 CLI 的模板参数与登录状态。

1. 将 `windows-bridge.example.json` 复制到 Windows 用户的 `.agentdesk` 目录，填写项目路径、已授权命令、Windows 自有 Relay 令牌和 VPS 2 SSH 配置。命令使用固定的程序与参数数组。若需要执行 Maven 或 Gradle 的批处理文件，可配置固定的 `cmd.exe /d /c` 参数数组。项目设为 `write:true` 才能改文件，启用 `desktop:true` 后再通过 AgentDesk 桌面开关启停本机控制。
2. 给 Windows Bridge 一把独立 SSH 密钥。在 VPS 2 为 `agentdesk` 用户登记其公钥，限制为下面的强制命令。保留独立的现有 Codex App Server 公钥，以继续使用原 AgentDesk 界面。核对 SSH 主机指纹后更新 Windows 的 `known_hosts`。
3. 在 Windows 的 `.agentdesk/remote.json` 加上 `orchestratorBridge`，值是 Bridge 配置的绝对路径，然后重启 AgentDesk。主路和备用路会分别连接，VPS 2 默认选择 SSH。只使用新版 Windows Bridge 时可将旧 SSH MCP 隧道设为 `"remoteForward":""` 和 `"manageSshd":false`。

Windows Bridge 的 `controlSocket` 使用本机命名管道（样例为 `\\.\pipe\agentdesk-windows-control`），`controlWorkspace` 指定主控已登记的工作区 ID。桌面应用使用该管道发送群聊和成员请求；未配置 Bridge 的 Windows 客户端不开放主控入口。各台电脑使用独立 SSH 公钥和私有工作区。在应用「工作区」里为项目填写相同的主控工作区 ID，并选择已有提交、工作区干净的本机 Git 仓库。

Windows Bridge 也可在 `ssh.jump` 配置 VPS 1 SSH 跳板（见下文）；跳板代码随应用打包，VPS 2 不需要改动。

```text
restrict,command="/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/ssh-gateway.js /var/lib/agentdesk-orchestrator/bridge.sock" ssh-ed25519 <WINDOWS_BRIDGE_PUBLIC_KEY>
```

## 只读挂载本机用户目录（群聊直接读）

群聊里组长和成员读本机文件，走 SSH 原生只读挂载，不再逐个调用 `windows_*` 读工具：

- 本机 Bridge（Mac、Windows 相同）在第二条 SSH 会话上运行一个只读 SFTP 服务（`orchestrator/sftp-readonly.js`，Node 实现，不依赖系统 `sftp-server`）。它只提供用户目录，拒绝一切写入、删除、改名和改属性；`..` 和指向用户目录外的符号链接一律拒绝；`~/.ssh`、钥匙串、浏览器资料、云服务和各 CLI 的登录、Bridge 自己的状态目录和 SSH 密钥都不列出也读不到。过滤在本机完成，VPS2 上任何进程都看不到这些文件。
- VPS2 由单独的 `agentdesk-home-mount.service`（`home-mount.js`）用 `sshfs -o passive,ro` 挂到 `/var/lib/agentdesk-orchestrator/mounts/<bridge>`（未命名的 Bridge 是 `default`）。单独成服务是因为挂载要用 setuid 的 `fusermount3`，主控服务设置了 `NoNewPrivileges`。
- 权限按职责：规划、诊断、验收（组长）读挂载，并保留只读 MCP 去读用户目录以外的地方；侦察、查资料、审查读挂载，挂载断开时才回退到 MCP；改代码读挂载，改动仍在 VPS2 副本里做、以补丁审核回传，用户目录以外的文件仍用带版本校验的写工具。哪个成员、哪个模型接这一步都一样。
- 挂载断开（电脑离线、Bridge 重启）时自动回退到 MCP 读工具，任务不受影响。

启用：

1. VPS2：`apt-get install -y sshfs`；配置加 `"homeMounts": true`；`systemctl enable --now agentdesk-home-mount`，再重启主控。
2. 每把 Bridge 公钥的强制命令在原 socket 后面再加挂载 socket（只有客户端请求的命令恰好是 `agentdesk-mount` 时才会用它）：

```text
restrict,command="/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/ssh-gateway.js /var/lib/agentdesk-orchestrator/bridge-mac.sock /var/lib/agentdesk-orchestrator/bridge-mac-mount.sock" ssh-ed25519 <MAC_BRIDGE_PUBLIC_KEY>
```

3. 本机 Bridge 配置加 `"mountHome": true`，重启 Bridge（Windows 是重启 AgentDesk）。
4. 确认：`route_status` 返回 `homeMount: true`；在 VPS2 上以 agentdesk 用户 `ls /var/lib/agentdesk-orchestrator/mounts/mac` 能看到用户目录、看不到 `.ssh`。如果 `findmnt` 能看到挂载而主控的 `homeMount` 一直是 false，说明挂载没有传进主控服务的命名空间，把主控服务重启一次再看；仍不行就把情况报回来。

## macOS 连接

macOS Bridge 与 Windows 可同时保持 SSH 连接。给 Mac 分配独立的 SSH 公钥和私有 socket。例如在 VPS 2 配置 `"sshBridges":["mac"]`，并为项目配置 `"sshBridge":"mac"` 和独立的 Git 镜像。Mac 的公钥强制命令使用 `bridge-mac.sock`。Mac 项目默认选用自己的 SSH 链路。需要备用时，在 VPS 2 的 `relayBridges.mac` 填入另一组 Relay 配对参数。Mac 配置中的 `relay` 保存其对端设备参数。让 VPS 1 为 Mac 单独登记一对设备，使用不同于 Windows 的设备 ID 和令牌。

在本机用 Node.js 24 运行 `orchestrator/mac-bridge.js /absolute/path/to/mac-bridge.json`。SSH 配置提供 `host`、`port`、`user`、`key` 和经校验的 `knownHosts` 绝对路径。`workspaces` 只列出授权的项目和命令。配置 `desktopExecutable` 可接入签入会话中的官方 macOS agent-desktop。文件和命令功能仅依赖 SSH 和项目授权。辅助功能和屏幕录制需要用户在 macOS 设置中分别授予，权限取决于实际运行后台 Bridge 的进程归属。

使用 launchd 时，将进程放在已登录用户的 `gui/<uid>` 会话中，`ProgramArguments` 使用 Node、脚本和配置的绝对路径。管理命令上传和下载时可设置 `AGENTDESK_BRIDGE=mac`，从而让无工作区字段的流消息走 Mac。用 `AGENTDESK_BRIDGE=mac` 执行 `route relay` 或 `route ssh` 只切换 Mac 的链路。Mac 的文件删除移至 Bridge 状态目录内的 `trash`。

### VPS 1 SSH 跳板

桌面端、单聊和 Bridge 的直连 VPS 2 出现传输层/DNS 故障时，可在客户端自动改经 VPS 1 的受限 SSH 账号转发到 VPS2:22。外层 SSH 仍由客户端端到端认证并校验 VPS 2 指纹，VPS 1 只转发 TCP；它不替代 22022 的应用层 Relay，也不改 VPS 2 的编排器或 sshd。VPS 1 需要专用 `agentdesk-jump` 用户和 `restrict,port-forwarding,permitopen="<VPS2>:22"` 的授权行。客户端在桌面配置顶层或 Bridge 的 `ssh.jump` 下配置 `host/port/user/key/knownHosts`；`mode` 为 `auto`（默认）、`direct`（强制直连）或 `jump`（强制跳板）。跳板密钥/known_hosts 必须与目标 VPS 2 的分开。安装步骤、验证和回滚见 [docs/DEPLOY.md](../docs/DEPLOY.md) §4。

### Mac 应用

Apple Silicon 上先运行 `npm ci`，再运行 `npm run dist:mac -- --arm64`。构建产物位于 `dist/mac-arm64/AgentDesk.app`。安装后用 `~/.agentdesk/mac-remote.json` 配置单独的 Codex App Server SSH 公钥和 VPS 工作区。后台 Bridge 的 `controlSocket` 指向其私有状态目录中的 `control.sock`，`controlWorkspace` 指定对应的 Mac 项目。配置 `desktopSocket` 指向同目录的 `desktop.sock` 时，运行中的 Mac 应用提供桌面操作，后台 Bridge 继续处理连接、文件和命令。

在应用底部打开「线路与模型」，为 Mac 主控任务选择 SSH 主用或 VPS 1 Relay 备用。主路断开时，可以通过在线的备用链路切换。群聊中组长先只读规划并提问，用户确认当前方案后才执行。可以由组长分派，或预选 Codex、Claude Code、Grok Build 或 Gemini，并填入该 CLI 接受的模型 ID。模型 ID 留空时使用其默认模型。普通 Codex 聊天使用自己的 SSH 会话和模型选择器。

Gemini 负责只读分析和审查。要在 VPS 2 启用它，请参照 `vps2.example.json` 的可选 `adapters.gemini`，设置 Gemini CLI 路径和付费 Gemini API 密钥文件。未启用时可省略该配置项。

## 任务与切换

组长从各 `adapters.<provider>.models` 读取能力和计费信息。示例配置的标准 API 文本单价只用于演示，部署时请保留账户实际可用的模型，并按账户计费方式配置。API 模型填写 `inputUsdPerMillion` 和 `outputUsdPerMillion`，订阅模型使用 `billing: "subscription"`，价格未知时使用 `billing: "unknown"`。可用 `defaultModel` 指定模型 ID；未配置时可由组长在已登记模型中挑选，或保留 CLI 默认模型。

单个步骤的 CLI 总时限由顶层 `cliTimeoutMs` 控制（毫秒，默认 2700000，即 45 分钟）。CLI 自己的 print 时限会自动提前 5%（最多 60 秒）结束，留出保存会话和续跑的时间；也可以用 `printTimeoutMs` 单独指定，但不会超过总时限。卡住的步骤仍由看门狗先处理：`adapters.<cli>.stallTimeoutMs` 或 `stallTimeoutMs` 控制多久没有输出就停掉，默认 10 分钟。

- 单价来源见 [OpenAI GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)、[Claude 计费](https://platform.claude.com/docs/en/about-claude/pricing)、[Grok API 计费](https://docs.x.ai/developers/pricing) 和 [Gemini Developer API 计费](https://ai.google.dev/gemini-api/docs/pricing)。

管理端可获取各执行者的额度数据。

```sh
node orchestrator/admin.js /var/lib/agentdesk-orchestrator/admin.sock quotas
```

主控实时读取 Grok Build 和 Antigravity 的真实额度：Grok 用 CLI 自己保存的登录（`<CLI 的 HOME>/.grok/auth.json`）查询 `cli-chat-proxy.grok.com` 的 billing 接口，只读不写、不刷新令牌，令牌过期时等 CLI 下次运行自动续上；Antigravity 运行 `agy -p /usage --output-format json`，不会触发模型调用，路由只看 Gemini 那一组的 5 小时和每周窗口。CLI 报额度用尽时，若报错里写了重置时间（如 “Resets in 4h54m26s”），主控按这个时间暂停该 CLI，不再固定 30 分钟。

读不到真实额度时，Grok Build、Antigravity 等不报告额度的 CLI，可在 `adapters.<cli>.callLimits` 填写每个窗口大约能调用多少次（例如 `{"fiveHour": 300, "weekly": 3000}`）。主控记录每次调用（保留 7 天），用“已调用次数 ÷ 上限”估算 5 小时和每周窗口的用量，路由的软线、硬线照常生效，「额度与分工」页的卡片标注“估算”。上限按你的套餐和实际体验填写，样例数字只是起点：某个 CLI 在估算没到上限时就报额度用尽，说明上限填高了，调低即可。

Codex 默认从主控执行账户的 App Server 实时读取，按供应商返回的额度 ID 保存独立或共享额度。其他执行者可用 `adapters.<provider>.quotaFile` 接入经核实的快照，文件格式如下。时间戳以 UTC ISO 8601 字符串或 Unix 秒表示，分别对应 `observedAt` 和 `resetsAt`。

```json
{
  "observedAt": "2026-11-17T09:00:00Z",
  "buckets": [
    { "id": "shared", "fiveHour": { "usedPercent": 25, "resetsAt": 1794919532 }, "weekly": null }
  ]
}
```

只有供应商确认额度适用范围时才填 `modelIds`。缺失的窗口使用 `null`，读取失败或账户未提供数据时返回 `unavailable`。

Claude Code 订阅账户的额度快照默认由无头轮次里的 `rate_limit_event` 自动刷新：单聊和调度任务每跑一轮都会把 `unifiedWindows` 的 5 小时、7 天用量写入 `adapters.claude.quotaFile`，不需要状态的命令行。也可以在状态行命令中运行 `node /opt/agentdesk-orchestrator/quotas.js claude-statusline <quotaFile>`，把标准输入的同一组数据存入快照。账户没有相应字段时保留上次快照，已重置的窗口会从读取结果中剔除。[Claude Code 状态行参考](https://code.claude.com/docs/en/statusline)

要让特定本地 AgentDesk 实时查看 VPS 2 CLI 的额度，把对应桥接名称加入 `quotaBridges`。成员面板打开时从 VPS 2 查询，最多每 30 秒一次。查询默认包含额度快照（Claude 的快照每轮都会刷新）；管理调用在请求体带 `liveOnly: true` 时跳过快照、只读实时来源。额度正文不会写入调度数据库。其他桥接默认无权读取这些账户用量。

```sh
ad() { sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/admin.js /var/lib/agentdesk-orchestrator/admin.sock "$@"; }
ad catalog   # 立即按各 CLI 的当前登录刷新模型档案（登录新账号后无需重启）
ad submit project '修复并审核项目中的问题' python-test
ad status "$TASK_ID"
ad apply "$TASK_ID"
ad cancel "$TASK_ID"
ad maintenance                      # 查看维护/排空状态：running、queued、ready
ad maintenance on "deploy 2026-11"  # 停止领取新任务；正在执行的步骤跑完后 ready=true
ad maintenance off                  # 部署并确认服务正常后恢复领取任务
```

维护状态保存在数据库的 `settings` 桶里，重启后仍有效；排空期间只影响尚未开始的任务，不会终止正在执行的 CLI，也不会把运行中的步骤重新排队。

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

### 群聊模式

- `/chat` 和 `/broadcast` 在独立工作树中只读运行。广播按当前登录和额度分派，每次最多五个子任务，Claude 保留给组长职责。
- `/duo` 需要至少两个已配置的非 Claude 审查者。审查保留独立执行者，完毕后交 Claude 验收。
- `/team` 占两槽并独占调度，单次连续运行限时 40 分钟，沿用组长规划和人工确认。Docker 运行器与配置同时可用时，批准后的 Codex 写步骤可通过 `docker.teamCommand` 调用容器内的 OMC 启动器。配置使用容器内绝对可执行路径或「路径与参数」数组。启动器从标准输入读取任务，向标准输出返回简报，并遵守已批准的执行范围与 CLI 分工。缺少 Docker 运行器或启动器配置时使用普通多步骤计划。
- `/compact` 生成项目简报，包含任务计数、最近任务状态与标签，供下一次规划和诊断使用。
- `/review` 读取当前工作树相对 HEAD 的快照。给出任务编号时取提交者自己的任务补丁。快照上限 24 KiB。
- 主控通过 `route_status` 提供当前 Bridge 可访问的项目。可在 Bridge 配置中指定 `controlProject`，项目成员资格和工作区绑定由主控校验。
