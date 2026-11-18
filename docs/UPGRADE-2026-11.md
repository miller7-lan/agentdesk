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
- `adapters.claude.defaultModel` 设为 `"opus"`（组长用最新 Opus）。
- 在 VPS2 上运行 `grok --help`、`agy --help`，确认 `--effort` 的写法；Antigravity 若支持，按 OPERATIONS.md 写 `efforts` 和 `effortArgs`。

## 1. VPS2

1. 用 `ad ls` 确认没有 `running`、`applying`、`testing` 的任务；有就等它们结束，或告诉用户。
2. 备份配置：`sudo cp /etc/agentdesk-orchestrator/config.json /etc/agentdesk-orchestrator/config.json.bak-20261118`
3. 按 DEPLOY.md §1 更新代码：`git pull --ff-only` 到 `main`，再执行 `sudo bash orchestrator/install-ubuntu.sh`。确认 `/opt/agentdesk-orchestrator/activity.js` 已存在。
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
2. 在 GitHub Actions 手动运行 **Build release artifacts**，下载 `agentdesk-windows` 产物，用里面的 `AgentDesk-<版本>-setup.exe` 覆盖安装。
3. 第一次打开时，核对向导显示的指纹与 VPS2 上的一致，然后确认。

**完成标准：**
- 开机动画播完后进入主界面，状态栏显示 SSH 主用在线。
- 点状态栏「额度与分工」，能看到各成员的额度环，页面顶部没有“主控版本较旧”或“没有开放额度读取”的提示。
- 在一个项目的群聊里发一个只读小任务，能看到组长方案、分工进度表，以及成员的“已接受任务”；点「单聊 ›」能看到该成员的工作过程。

## 4. Mac

1. 后台 Bridge：在仓库目录 `git pull --ff-only`，再 `launchctl kickstart -k gui/$(id -u)/<Bridge 的 launchd 标签>`（标签用 `launchctl list | grep -i agentdesk` 查）。
2. 应用：`npm ci && npm run dist:mac -- --arm64`，用 `dist/mac-arm64/AgentDesk.app` 替换 `/Applications/AgentDesk.app`；或使用 Actions 产物 `agentdesk-mac`。

**完成标准：** 与 Windows 相同的三项，外加 `launchctl print gui/$(id -u)/<标签>` 显示 `state = running`。

## 做完后

把每一端的结果告诉用户：哪些完成、哪些需要用户处理（GitHub secret、Antigravity 授权）、哪些失败及日志里的错误原文。
