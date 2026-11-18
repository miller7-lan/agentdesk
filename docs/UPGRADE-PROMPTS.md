# 交给本机 agent 的升级提示

两段提示，整段复制给对应电脑上的 agent（Claude Code、Codex 都可以）。步骤和确认标准以 [UPGRADE-2026-11.md](UPGRADE-2026-11.md) 和 [DEPLOY.md](DEPLOY.md) 为准，这里只是把它们按电脑拆开。

**顺序：** 先在 Mac 上运行第一段（它负责 VPS2 和 Mac），等它汇报 VPS2 已生效、给出提交号和主机指纹后，再在 Windows 上运行第二段。

## Mac 端（负责 VPS2 和 Mac）

````text
你是在我 Mac 上工作的 agent。任务：先把 AgentDesk 的 VPS2 主控升级到 GitHub 仓库 miller7-lan/agentdesk 的 main 分支最新提交，再升级这台 Mac 上的后台 Bridge 和 AgentDesk 应用，并逐项确认生效。Windows 由另一个 agent 负责，你不用管。

开始前先读仓库里的这三份文档，以文档为准：
- AGENTS.md
- docs/DEPLOY.md（登录、更新代码、校验配置、重启、回滚的具体命令）
- docs/UPGRADE-2026-11.md（这次要改哪些配置、怎样确认）

规则：
1. 顺序是先 VPS2，后 Mac。VPS2 确认生效后再动 Mac。VPS1（Relay）这次不用动，除非它的 relay/server.py 落后于 main。
2. 每一步动手前，用一两句话告诉我要做什么、改哪个文件或哪台机器，等我同意再执行。只读的查看命令不用问。
3. 不要替我输入任何账号密码，也不要替我完成 Google、Antigravity、Grok、Claude 的登录授权。需要登录时把链接或步骤交给我。
4. 真实 IP、私钥、令牌、密码不写进仓库，也不贴在回复里。配置只改各端本机的文件。
5. 改任何配置前先备份（例如 config.json.bak-<日期>）。启动失败就按 DEPLOY.md 回滚，并把日志原文给我。
6. 不要 force push，不要改 GitHub 上的任何东西。

一、VPS2（主控）
1. 用我的管理员 SSH 登录（不是 agentdesk 用户，那个账户不能开 shell）。先查有没有正在执行的任务（DEPLOY.md §1 的 admin.js ls）。有 running、applying、testing 的任务，就等它们结束或问我。
2. 仓库目录执行 git pull --ff-only，然后执行 sudo bash orchestrator/install-ubuntu.sh。
3. 确认 /opt/agentdesk-orchestrator/ 下有这些文件：activity.js、sandbox.js、attachments.js、extract.js、zipfile.js、chat-server.js、agent-chat.sh。
4. 确认 /usr/bin/bwrap 存在（沙盒运行命令需要它）。没有的话先问我，再执行 apt-get install -y bubblewrap。
5. 确认 pdftotext 存在（PDF 附件提取文字需要它）。没有的话先问我，再执行 apt-get install -y poppler-utils。
6. 按 UPGRADE-2026-11.md 第 1 节逐项对照 orchestrator/vps2.example.json，用 sudoedit 改 /etc/agentdesk-orchestrator/config.json：
   - routing：改代码用 antigravity、codex、grok；审查和查资料用 antigravity、grok。没有自定义需求就整个删掉，用代码默认值。
   - writeProviders 设为 ["codex","claude","grok","antigravity"]；删掉 gemini（这台服务器的 Gemini CLI 确实还能用就保留）。
   - adapters.grok、adapters.antigravity、adapters.claude 加 "sandbox": true，并加上 callLimits（数字先用样例值，告诉我让我确认）。
   - adapters.claude.defaultModel 设为最新 Opus，并确认它在 models 里。
   - adapters.antigravity 的模型以 agy models 的实际输出为准。
   - quotaBridges 填上各台电脑 Bridge 的名称，与 sshBridges 里的名称一致（Mac 和 Windows 两台都要有）。
7. 校验 JSON，然后 sudo systemctl restart agentdesk-orchestrator。
8. 在 VPS2 上运行 grok --help 和 agy --help，确认 --effort 的写法，把输出给我看。
9. Antigravity 还没登录的话：以主控服务账户和它的专用 HOME 运行一次 agy，把授权链接给我，等我在浏览器完成。完成后用 agy -p --mode plan --output-format stream-json "回答 ok" 确认，再删掉 adapters.antigravity.authRequired。
确认标准：
- systemctl is-active agentdesk-orchestrator 输出 active；journalctl 最近 50 行没有 invalid_routing、invalid_write_providers 等启动错误。
- doctor 里的分配顺序与上面一致。
- 把 VPS2 当前的 git 提交号和 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 的指纹告诉我，Windows 的 agent 会用它们核对。

二、Mac
1. 后台 Bridge：在 Mac 上的仓库目录执行 git pull --ff-only。用 launchctl list | grep -i agentdesk 找到标签，再执行 launchctl kickstart -k gui/$(id -u)/<标签>。
2. 应用：执行 npm ci && npm run dist:mac -- --arm64，用 dist/mac-arm64/AgentDesk.app 替换 /Applications/AgentDesk.app（替换前问我）。也可以用 Actions 产物 agentdesk-mac。下载 Electron 失败时按 DEPLOY.md 设置国内镜像。
3. 重启 AgentDesk。
确认标准（让我在界面上操作，你告诉我看哪里）：
- launchctl print gui/$(id -u)/<标签> 显示 state = running。
- 开机动画后进入主界面，状态栏显示 SSH 主用在线。
- 点状态栏「额度与分工」，能看到各成员额度环，顶部没有「主控版本较旧」或「没有开放额度读取」的提示。
- 群聊里发一个只读小任务，附一个 .docx 文件：能看到组长方案、分工进度表、成员「已接受任务」；点「单聊 ›」能看到工作过程；成员能读出 docx 的内容。
- 开一个 Claude 单聊，模式选「完全访问」，项目选好本机目录，让它在本机目录里新建一个测试文件再删掉，确认成功。之前失败是因为 Claude 的工具授权规则不被识别，这次的新代码已修复。
- 附件测试，Codex、Claude、Grok、Antigravity 单聊各做一次：
  - 用附件按钮选一张图片，让它描述图片；
  - 拖入一个 .xlsx 或 .pdf，让它说出里面的内容；
  - 从访达拖入一个小文件夹，确认显示「已打包 N 个文件」，它能列出文件夹里的文件；
  - 在输入框粘贴一张截图（Cmd+Shift+Ctrl+4 截到剪贴板），确认出现附件。

三、做完后给我一份汇报：
- VPS2 和 Mac 各自完成了什么、确认标准是否都通过；VPS2 的 git 提交号和主机指纹。
- 附件测试：列一张表，行是 Codex、Claude、Grok、Antigravity、群聊，列是图片、xlsx 或 pdf、文件夹、粘贴，每格写通过或失败原因。
- 需要我处理的事项：Antigravity 授权、callLimits 数字确认等。
- 失败项：附上日志或报错原文，并说明是否已回滚。
````

## Windows 端（VPS2 确认生效后再运行）

````text
你是在我 Windows 电脑上工作的 agent。任务：把这台电脑上的 AgentDesk 应用升级到 GitHub 仓库 miller7-lan/agentdesk 的 main 分支最新提交，并逐项确认生效。VPS2 主控和 Mac 由另一个 agent 负责，你不要修改 VPS2。

开始前先读仓库里的这三份文档，以文档为准（本机没有仓库就先 git clone，只读，不提交）：
- AGENTS.md
- docs/DEPLOY.md（第 2 节 Windows 端）
- docs/UPGRADE-2026-11.md（第 3 节 Windows）

规则：
1. 每一步动手前，用一两句话告诉我要做什么，等我同意再执行。只读的查看命令不用问。
2. 不要替我输入任何账号密码，也不要替我完成任何登录授权。
3. 真实 IP、私钥、令牌、密码不写进仓库，也不贴在回复里。
4. 不要修改 VPS2 上的任何东西，也不要改 GitHub 上的任何东西。GitHub secret 只能由我在网页上填，你只核对格式。
5. 改本机配置前先备份。出问题时把报错原文给我。

一、先确认 VPS2 已经升级
- 问我 Mac 那边 agent 汇报的 VPS2 提交号，和 GitHub 上 main 的最新提交对比。
- 如果 VPS2 还没升级，就停下来告诉我，不要继续。新版应用连旧主控时，群聊附件和额度页会出错。

二、安装新版应用
1. 让我确认 GitHub 仓库 secret AGENTDESK_SERVER_JSON 已填好。你只核对我给的值：是合法 JSON，有 host、port、knownHosts 三项，knownHosts 的主机公钥指纹与 Mac agent 汇报的 VPS2 指纹一致。
2. 让我在 GitHub Actions 手动运行「Build release artifacts」。下载 agentdesk-windows 产物，用里面的 AgentDesk-<版本>-setup.exe 覆盖安装（安装前问我；先关掉正在运行的 AgentDesk）。
3. 第一次打开时，核对向导显示的主机指纹与 VPS2 一致，再让我确认。
4. 如果这台电脑还运行着 Windows 端的后台 Bridge（DEPLOY.md 第 2 节有说明），按文档把它更新到同一提交并重启。

三、确认标准（让我在界面上操作，你告诉我看哪里）
- 开机动画后进入主界面，状态栏显示 SSH 主用在线。
- 点状态栏「额度与分工」，能看到各成员额度环，顶部没有「主控版本较旧」或「没有开放额度读取」的提示。
- 群聊里发一个只读小任务，附一个 .docx 文件：能看到组长方案、分工进度表、成员「已接受任务」；点「单聊 ›」能看到工作过程；成员能读出 docx 的内容。
- 开一个 Claude 单聊，模式选「完全访问」，项目选好本机目录，让它在本机目录里新建一个测试文件再删掉，确认成功。
- 附件测试，Codex、Claude、Grok、Antigravity 单聊各做一次：
  - 用附件按钮选一张图片，让它描述图片；
  - 拖入一个 .xlsx 或 .pdf，让它说出里面的内容；
  - 从资源管理器拖入一个小文件夹，确认显示「已打包 N 个文件」，它能列出文件夹里的文件；
  - 在输入框粘贴一张截图（Win+Shift+S 截到剪贴板），确认出现附件。

四、做完后给我一份汇报：
- 完成了什么、确认标准是否都通过、安装的版本号。
- 附件测试：列一张表，行是 Codex、Claude、Grok、Antigravity、群聊，列是图片、xlsx 或 pdf、文件夹、粘贴，每格写通过或失败原因。
- 需要我处理的事项：GitHub secret、Actions 构建等。
- 失败项：附上界面提示或报错原文。
````
