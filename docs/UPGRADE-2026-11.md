# 本次升级（2026-11-18）：本机 agent 执行清单

给在本机工作的 agent 用。把 VPS2、VPS1、Windows、Mac 升到 `main` 的最新提交。通用命令（登录、更新代码、校验配置、重启、回滚）见 [DEPLOY.md](DEPLOY.md)，这里只写本次要做什么、改哪些配置、怎样确认。

**顺序：VPS2 → VPS1 → Windows → Mac。** 一端确认生效后再动下一端。每一步动手前告诉用户要做什么。

## 本次更新了什么

| 端 | 内容 |
|---|---|
| VPS2 主控 | 新增 `task_activity` 操作（每步的思考、命令、改文件等工作过程）；任务状态带上每步的任务说明；线路状态带上实时分工；改代码改为 Antigravity 首选（Codex、Grok Build 依次降级，难的由组长点名 Codex）；审查改为交叉审查；查资料改为 Antigravity 首选；重连加随机抖动 |
| VPS1 Relay | 按来源地址限制未认证连接；令牌反复错误的地址暂时拒绝 |
| Windows / Mac 应用 | 组长派遣记录与「我的单聊」分开；单聊显示工作过程；群聊的分工进度表与接受、完成、验收总结；状态栏「额度与分工」页；成员按实际分工显示；各 AI 主题色；面板收成三个标签、可拖动宽度；新开机动画；Clawd 黑色长方形眼睛；安装包可内置服务器地址 |

## 补充（同日后续）

- 群聊派活：`adapters.grok`、`adapters.antigravity`、`adapters.claude` 设 `"sandbox": true`，它们在 bubblewrap 沙盒里可以运行命令、跑测试（VPS2 已为 Codex 装好 `bwrap`；确认 `/usr/bin/bwrap` 存在）。
- 单聊：把 `sandbox.js` 一起复制到 `/opt/agentdesk-orchestrator/`；`agent-chat.sh` 发现 `bwrap` 会自动开启沙盒。三家都能联网搜索。
- 将 `orchestrator/vps2.example.json` 中的最新 Opus 配置加入 `adapters.claude.models`，再将 `adapters.claude.defaultModel` 设为同一个模型 ID。当前示例为 `claude-opus-5-5`。默认模型必须在本机配置的 `models` 中存在，否则主控无法启动。
- 群聊任务某一环节失败时不再直接结束：失败交给组长诊断，组长可以把这个环节改派给其他成员、换同一成员的其他模型，或者用新步骤替换它。每个环节最多重新安排 3 次，替换它的新步骤继承这个次数。分工进度表和调度图会同步显示当前成员、模型、重排次数和之前尝试过的成员。只需更新 VPS2 主控代码和桌面端，配置不用改。
- 附件：所有对话（Codex、Claude/Grok/Antigravity 单聊、群聊任务）都能附加任意类型的文件，可选择、拖入或粘贴；文件夹打包成一个 .zip（跳过 `.git`、`node_modules` 等）。每条消息最多 10 个，每个不超过 25 MB。Word、Excel、PowerPoint、OpenDocument 文件和压缩包在 VPS2 上自动生成一份文本副本，供 CLI 读取。群聊附件组长规划时能看到，每个成员执行步骤时也能看到。Claude、Grok、Antigravity 单聊即使 VPS2 没有开沙盒也能读附件：主控为这条消息提供 `agentdesk_attachment_read` 工具，图片按图片返回，文本、代码、Office 文件分页返回；PDF 要提取文字，VPS2 需装 `poppler-utils`（提供 `pdftotext`），没装时开了沙盒的 CLI 仍可直接打开 PDF。需要同时更新 VPS2（`attachments.js`、`extract.js`、`zipfile.js`）和桌面端；只更新桌面端时，群聊附件会被旧主控拒绝。
- 在 VPS2 上运行 `grok --help`、`agy --help`，确认 `--effort` 的写法；Antigravity 若支持，按 OPERATIONS.md 写 `efforts` 和 `effortArgs`。

## 1. VPS2

1. 用 `ad ls` 确认没有 `running`、`applying`、`testing` 的任务；有就等它们结束，或告诉用户。
2. 备份配置：`sudo cp /etc/agentdesk-orchestrator/config.json /etc/agentdesk-orchestrator/config.json.bak-20261118`
3. 按 DEPLOY.md §1 更新代码：`git pull --ff-only` 到 `main`，再执行 `sudo bash orchestrator/install-ubuntu.sh`。确认 `/opt/agentdesk-orchestrator/` 下有 `activity.js`、`sandbox.js`、`attachments.js`、`extract.js`、`zipfile.js`。
   - 确认 `/usr/bin/bwrap` 存在（没有就 `apt-get install -y bubblewrap`，先告诉用户）。
   - 确认 `pdftotext` 存在（PDF 附件提取文字用；没有就 `apt-get install -y poppler-utils`，先告诉用户）。
4. 用 `sudoedit` 改配置，逐项对照 `orchestrator/vps2.example.json`：
   - `routing.implement` 改成 `["antigravity", "codex", "grok"]`，`routing.review` 和 `routing.research` 都改成 `["antigravity", "grok"]`。整个 `routing` 都没有自定义需求的，直接删掉，用代码里的默认值。
   - 给 `adapters.grok` 和 `adapters.antigravity` 加上 `callLimits`（样例：Grok 每 5 小时 60 次、每周 600 次；Antigravity 每 5 小时 300 次、每周 3000 次），额度页才会显示它们的估算用量。数字请用户按套餐确认。
   - `adapters.antigravity.models` 按样例写入 Gemini 4 的三档模型和各自擅长说明，`defaultModel` 设为 Hydrogen；模型 ID 以 `agy models` 的实际输出为准。
   - 删掉 `adapters.gemini`（Gemini CLI 已停用），并从 `routing` 各列表和 `writeProviders` 里去掉 `gemini`。如果这台服务器上的 Gemini CLI 确实还能用，这一项跳过。
   - `writeProviders` 设为 `["codex", "claude", "grok", "antigravity"]`。
   - `quotaBridges` 加上每台电脑 Bridge 的名称（与 `sshBridges` 中的名称一致），桌面端的「额度与分工」页才能读到额度。
   - Antigravity 已经登录并验证过（见下一步）时，删掉 `adapters.antigravity.authRequired`；还没登录就保留。
5. Antigravity 登录（需要用户在浏览器里完成授权，agent 不要代为输入账号密码）：以主控服务账户和它的专用 HOME 运行一次 `agy`，把授权链接交给用户，用户完成后，用 `agy -p --mode plan --output-format stream-json "回答 ok"` 确认返回成功。再用 `agy models` 把真实模型名填进 `adapters.antigravity.models` 和 `defaultModel`。
6. 校验 JSON、重启服务（DEPLOY.md §1「只改配置」）。

**完成标准：**
- `systemctl is-active agentdesk-orchestrator` 输出 `active`，日志里没有 `invalid_routing`、`invalid_write_providers` 等启动错误。
- `ad doctor` 里的分配顺序与上面一致；Antigravity 不再显示需要登录（如果第 5 步做了）。
- 在 VPS2 上执行 `agy -p --mode plan --output-format stream-json "搜索 Node.js 最新 LTS 版本号并给出来源"`，把输出交给用户，确认只读模式下能联网搜索。

## 2. VPS1（Relay）

按 `relay/OPERATIONS.md` 更新 `relay/server.py` 并重启 `agentdesk-relay`。服务单元不用改：新参数 `--pending-per-address` 有默认值 4。

**完成标准：** `systemctl is-active agentdesk-relay` 为 `active`；桌面端切到 Relay 备用线路时能连上。

## 3. Windows

1. 确认仓库 secret `AGENTDESK_SERVER_JSON` 已填好（VPS2 的地址、端口和 SSH 主机公钥，格式见 `agentdesk-server.example.json`）。这一步只能由用户在 GitHub 网页上操作，agent 只核对用户给出的值是不是合法 JSON、主机公钥指纹是否与 VPS2 上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的结果一致。
2. 推送到 `main` 后 Actions 会自动运行 **Build release artifacts**（文档改动除外），下载最近一次构建的 `agentdesk-windows` 产物，用里面的 `AgentDesk-<版本>-setup.exe` 覆盖安装。也可以手动运行该 workflow。
3. 第一次打开时，核对向导显示的指纹与 VPS2 上的一致，然后确认。

**完成标准：**
- 开机动画播完后进入主界面，状态栏显示 SSH 主用在线。
- 点状态栏「额度与分工」，能看到各成员的额度环，页面顶部没有“主控版本较旧”或“没有开放额度读取”的提示。
- 在一个项目的群聊里发一个只读小任务并附一个 .docx，能看到组长方案、分工进度表，以及成员的“已接受任务”；点「单聊 ›」能看到该成员的工作过程；成员能读出 docx 的内容。
- 附件：Codex、Claude、Grok、Antigravity 单聊各测一次——附件按钮选图片并让它描述；拖入 .xlsx 或 .pdf 让它说出内容；拖入一个小文件夹，显示“已打包 N 个文件”且它能列出文件；在输入框粘贴截图，出现附件。
- Claude 单聊选「完全访问」，让它在本机项目目录新建再删除一个测试文件，确认成功。

## 4. Mac

1. 后台 Bridge：在仓库目录 `git pull --ff-only`，再 `launchctl kickstart -k gui/$(id -u)/<Bridge 的 launchd 标签>`（标签用 `launchctl list | grep -i agentdesk` 查）。
2. 应用：`npm ci && npm run dist:mac -- --arm64`，用 `dist/mac-arm64/AgentDesk.app` 替换 `/Applications/AgentDesk.app`；或使用 Actions 产物 `agentdesk-mac`。

**完成标准：** 与 Windows 相同的各项，外加 `launchctl print gui/$(id -u)/<标签>` 显示 `state = running`。

## 补充（2026-11-19）

- **撤销本轮**：单聊里 AI 通过本机文件工具改了文件，这一轮结束后会显示「本轮改动本机 N 个文件 · 撤销本轮」。撤销会恢复原样；本轮新建的文件移到废纸篓/回收站；之后又被改过的文件会跳过，不覆盖。存档在应用数据目录的 `checkpoints/`，保留最近 100 轮。AI 通过「本机命令」改的文件不在存档范围。
- **界面**：头像统一成同尺寸的圆角方底；「你」的头像改为人形标志；侧栏去掉左侧图标栏，「新建单聊 / 新建群聊」改为悬停项目名时出现的小图标；底部外观和深色模式收成图标；群聊不再显示已停用的 Gemini；「清空全部群聊记录」改为垃圾桶图标。正在工作的成员有流动边框，成员完成一步时有光线飞到分工进度表（来自 Lancer Light UI，MIT）；成员的完成总结在验收前标「成员自报 · 待验收」。
- **省 token**（VPS2 的 `chat-server.js` 和桌面端）：单聊的工具服务器名改为每个会话固定，系统提示不再随轮次变化，Claude、Grok 的提示缓存能跨轮命中；Antigravity 只在会话第一轮发送使用说明；读本机文件每次最多 64 KiB，分页继续；本机命令输出超过 8000 字符时保留开头 2000 和结尾 6000。

## 补充（2026-11-19 下午）

- **任务预算**（VPS2）：每个群聊任务最多 24 次成员调用、300 万 token（输入加输出，不算缓存读取），包括规划、重新分配、返工和验收。超出后任务暂停为「待处理」（`budget_exceeded:steps` 或 `budget_exceeded:tokens`），不会失败也不会重派。可在 `config.json` 里加 `"taskBudget": { "steps": 24, "tokens": 3000000 }` 调整，填 0 关闭对应上限。
- **单聊独立工作树**（桌面端）：新建单聊时勾「独立工作树」，这个单聊在项目旁的 `.agentdesk-worktrees/<项目>/<会话>` 里、分支 `agentdesk/<会话>` 上改文件，项目目录不受影响。输入框上方可以查看差异、合回创建时的分支、丢弃。合回要求项目目录干净且仍在原分支；有冲突会自动撤回。本机命令仍在项目目录里运行。
- **会话流程**（桌面端）：单聊输入框旁的「流程」按钮。内置「调研 → 实现 → 自查」「排查 Bug」，可以复制修改或新建（最多 8 步，每步可设思考程度、模型、目标、交付要求）。点阶段只切换设置并载入任务，不自动发送。
- **项目泳道**（桌面端）：群聊右侧「任务 › 泳道」，同一项目的每个群聊、每个单聊各一条泳道。
- **节点特效**：分工进度表和调度图的节点，成员完成时接收光线，到达时圆点填色、外圈亮一下。

- **自己排分工顺序**（VPS2 + 桌面端）：「额度与分工」页里，侦察、改代码、审查、查资料四种活可以用 ‹ › 调整成员顺序，「恢复默认」撤销。顺序保存在本机，随你发出的群聊任务发给主控：自动派活、降级、重新分配都按它走，组长规划时也会参考。只能在主控已为这种活配置的成员之间排序（Claude 不会被排进改代码），不改 VPS2 配置，不影响别人。旧主控会忽略这个顺序。
- **泳道与对话同屏**（桌面端）：群聊右侧面板第一个标签「泳道」（默认打开），Lancer 风格的竖向泳道树，只显示当前这个群聊自己的任务（同项目的其他群聊和单聊不在里面）；对话上方显示进行中任务线的成员链；点泳道节点，对话滚到该任务。

- **组长规划不再直接失败**（VPS2）：组长的回复前后带说明文字或放在代码块里也能解析；格式不对会退回让组长重写一次；还不行或 CLI 出错时，群聊里会说明原因，直接回复就重新规划（连续 3 次以上才算失败）。组长规划时可以读本机项目和授权目录（只读，不能运行命令）。
- **群聊默认在和组长对话**（桌面端）：组长等你回答问题或确认方案时，直接发的消息就是回答，不会新开任务；新任务自动关联这个群聊的上一个任务。失败的任务卡片写明原因，有「让组长重新来」。
- **常驻流线**（桌面端）：成员完成一步后，从完成总结到泳道节点和进度表留一条流动的虚线，有光点沿线传导，点击终点节点后消失；重启后仍在。

## 补充（2026-11-19 晚）

- **组长可读本机任意文件夹（只读）**：VPS2 主控新增只给组长的 `computer` 位置。在桌面端 Bridge 配置顶层加 `"readAnyFolder": true` 并重启 Bridge 后，组长的 `windows_list_locations` 会出现它：家目录、`/Volumes` 挂载卷和临时目录里的文件夹可以列举、搜索、grep 和读取，`path` 用绝对路径（`~` 为家目录）。写入、命令和桌面操作仍只限项目；系统目录、`~/Library`、`.ssh` 等凭据目录、`.git` 和常见凭据文件被拒绝，符号链接解析后再校验。主控只给组长的规划、诊断、验收步骤下发这个位置。需要同时更新 VPS2 和桌面端 Bridge；只更新一端时该位置不可用（安全降级）。Mac 的示例配置和本机配置已打开，Windows 配置见 `orchestrator/windows-bridge.example.json`。
- **成员也能读写本机任意文件夹**（在上一条基础上）：`computer` 位置不再只给组长，所有成员都能读。改文件的步骤（改代码）还可以用 `windows_write_file`、`windows_make_directory`、`windows_move_path`、`windows_delete_path` 在家目录、挂载卷、临时目录里新建、覆盖、建目录、移动、删除（删除进废纸篓/回收站），前提是 Bridge 配置顶层再加 `"writeAnyFolder": true`（示例配置已打开）。覆盖已有文件要带当前版本（主控会自动先查），不会覆盖别人刚改过的内容。同样的拒绝规则对写入生效；项目目录本身仍只通过补丁审核改动，不能借这个位置直接改。需要同时更新 VPS2 和各电脑的 Bridge 并重启 Bridge。
- **Actions 自动构建**：推送到 `main` 会自动构建 `agentdesk-windows` 和 `agentdesk-mac` 产物，不再需要手动运行 workflow。

- **群聊卡住时能看到原因、能自动脱困**（VPS2 + 桌面端）：
  - 成员忙时，并行步骤改派给同类活里空闲的成员（你指定的执行者、组长点名的成员不改派）。
  - 任务卡片显示实时状态：谁在执行、已执行多久、最后一次输出是多久前；排队的步骤在等谁、那个成员正在做哪个任务；等待执行者时每个候选成员为什么不能接（需要登录、冷却到几点、额度不够）。
  - 看门狗（参考 gbdev 的 stall timeout）：运行中的步骤超过 10 分钟没有任何输出，自动停掉并交给组长换成员或换模型重新安排。可在 VPS2 配置里按成员设 `adapters.<成员>.stallTimeoutMs`（毫秒，0 关闭），或全局设 `stallTimeoutMs`。
  - 运行中的步骤旁有「停止这一步」，停掉后同样交给组长重新安排，任务本身继续。
  - 卡住优先换模型：看门狗停掉的步骤先在同一个成员上换它的另一个模型重跑（先默认模型，最多换两次），还卡才交给组长；组长重新安排时也优先换模型。
  - 群聊里能直接停止：每个进行中的任务卡片上有「停止任务」，输入框旁有任务在跑时出现红色停止按钮（停止最新的那个）。

- **群聊派活像单聊一样可看、可指导**（VPS2 + 桌面端）：组长派给成员的每一步，在该成员的派遣单聊里按单聊的样子显示：组长派的任务、思考块、运行命令及输出、改的文件、成员的回复。这个单聊可以发消息给成员指导方向：成员正在做时会停下当前这一轮，在同一个会话里带着你的话继续；还没开始的步骤在开始时一并交给它。你的指导在单聊里显示为「你的指导」，群聊里也会提示；完成总结照常回到群聊。群聊附属的单聊只有成员，没有组长（组长的规划、诊断、验收在群聊里）。

## 补充（2026-11-19 夜）

- **组长模型**：群聊输入框旁新增「组长模型」，可以选任何一个 Claude 模型，每个群聊各记各的；默认用最新的 Opus。组长规划、诊断、验收都会把模型明确传给 CLI，不再落到 CLI 自己登录账号的默认模型（之前可能是 Haiku）。也可以在 VPS2 配置 `adapters.claude.leadModel` 指定默认组长模型。组长给成员挑模型时会按每一步的难度从整张模型表里选，不再固定一种。
- **同一个群聊只改当前任务**：任务还在进行时，在群里直接说话（不带 `/` 或 `@`）会交给组长**修改当前任务的方案**（新操作 `revise_plan`）：已完成的步骤保留，未完成的停下，组长按你的话重新规划剩下的部分，你确认后继续，任务编号不变。只有当前任务已经结束，新消息才开始新任务。
- **泳道加线**：卡片泳道每条泳道左侧有一根竖线，节点圆点在线上（完成实心、运行中脉冲、排队虚线）；成员之间的交接是弯曲连线，正在交接时是流动虚线；还有排队或运行中的步骤时，竖线往下延伸成流动虚线。
- **方案确认方式**：群聊输入框旁新增「方案确认」，每个群聊各记各的。小方案自动（桌面端默认）：不改文件、或 3 步以内的方案直接开始；每次确认：和以前一样；全部自动：组长出方案就执行。改动应用到本机前仍要审核。微信等没带这个设置的入口保持每次确认。
- **派遣单聊**：按「成员 + 具体模型」分开，同一成员同一模型的后续派活复用原来的单聊；只有那个单聊里同时有工作在跑时才另开一个（「Codex GPT 5.5 · 2」）。每个群聊最多保留 10 个，超出时先删已结束、最久没打开的；进行中、等你处理的和正在看的不删（任务本身仍在主控上）。换模型后旧单聊留下说明。排版和普通单聊一致。
- 去掉群聊顶部步骤条和每步「已接受」提示；组长思考程度只列所选组长模型支持的档位。
- **组长优先派新模型**：各成员的模型按代际从新到旧排给组长（版本号越大越新，同一代里完整模型排在 mini、flash、fast 等小模型前面）；组长没指定模型、步骤换给别的成员、卡住换模型时，都先用最新一代的完整模型。配置里较旧的 `defaultModel` 不再当默认用，除非它本身就是最新一代。
- **每种活可以补充成员和具体模型**：额度页「分工与降级顺序」每一行有「+ 补充」，可以加主控已配置的任何成员，以及它的任何具体模型（例如「Codex · GPT-5.4」），用 ‹ › 排顺序、× 去掉。派活、降级、重新分配、卡住换模型都按这个顺序，排在前面的具体模型先用。规划、诊断、验收只能补充 Claude 的模型（第一个就是组长默认用的模型，后面的是卡住时的备选）。顺序存在本机，随群聊任务发给主控（`routeOrder` 现在接受 `成员@模型`）。
- **改方向不丢半成品**：任务进行中在群里说话，组长先逐步判断（新操作 `revise_plan` 后台判断，`approve_addition` 确认新增步骤）：不受影响的继续；需要的补一句指导，在原会话里接着做；方向变了的才停下；需要时新增步骤，按「方案确认」设置决定是否等你确认。组长没法判断时，把你的话作为指导发给正在做的成员。没有成员在做时，仍按原来的方式重新规划剩下的部分。
- 去掉群聊的「执行者」下拉框：要指定成员就在消息开头写 `@Codex …`（输入 @ 会弹出成员列表），只对这一条消息生效。
- 升级 VPS2 后重启主控服务；Windows、Mac 端更新桌面端即可。

## 直接交给本机 agent 的提示

Mac 和 Windows 各一段，见 [UPGRADE-PROMPTS.md](UPGRADE-PROMPTS.md)。先在 Mac 上运行（它负责 VPS2 和 Mac），VPS2 确认生效后再在 Windows 上运行。

## 做完后

把每一端的结果告诉用户：哪些完成、哪些需要用户处理（GitHub secret、Antigravity 授权）、哪些失败及日志里的错误原文。
