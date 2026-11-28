# 部署记录

每次部署一条，最新的在最上面。只写版本、做了什么、怎样验证、怎样回滚；不写 IP、令牌和密钥。

## 2026-11-28 16:15（北京时间）· VPS2 CLI 单聊断线即停 + 客户端 0.5.11

- 用户要求：断联应立刻停止处理，重连回到上一次继续（Mac、Windows 都出现过断线后内容丢失）。
- 原因：CLI 跑在 dtach 里，断线后继续运行；会话记录（chats/<provider>-<chat>.json）只在 CLI 退出时写，被杀或重启时丢失，重连开成新对话；重接时 dtach 只重画当前一屏。sshd 对 agentdesk 的 ClientAlive 为 900×3，断线约 45 分钟后才发现。
- `orchestrator/agentdesk-cli.js`：不再用 dtach，CLI 随 SSH 连接结束（SIGHUP）；启动 10 秒后即保存会话（Claude/Grok started，Codex/Antigravity 找到会话 id 即存）；新连接先结束同一单聊仍在运行的旧 CLI（含旧 dtach 会话；按 /proc cmdline+environ 核对是该单聊的进程），等其退出再 `--resume`/`resume` 继续。stdout/stderr 写错误忽略，保证退出时记录写成。
- VPS2：部署该文件（备份 agentdesk-cli.js.bak-20261128-stopdrop）；`/etc/ssh/sshd_config.d/60-agentdesk-bridge.conf` 的 Match User agentdesk 加 ClientAliveInterval 10 / ClientAliveCountMax 3（备份 /root/backups/60-agentdesk-bridge.conf.bak-20261128-alive），`sshd -t` 后 reload；root 等不变（900）。
- 验证：VPS2 上以 agentdesk 在 pty 里跑测试单聊：运行中 10 秒记录 started=true；第二个连接先结束第一个，再 `--resume` 同一会话；强杀终端（等同 sshd 断开）后 CLI 全部退出、记录保留、无残留；测试数据已删。全量测试 0 失败。
- 客户端 0.5.11 只改帮助文字和注释。回滚：恢复两个备份文件并 reload ssh。

## 2026-11-28 14:45（北京时间）· 客户端 0.5.10

- v0.5.9 发布运行 Windows 测试失败（bridge-ssh/chat-link/remote 测试在 win32 上读取 `AGENTDESK_SSH_JUMP`），未上传。win32 跳板也写入该环境变量（不设 ELECTRON_RUN_AS_NODE），ssh-options 旧用例显式 `platform: 'linux'`；本地以模拟 win32 跑相关 4 个测试文件 47/47 通过。内容同 0.5.9。

## 2026-11-28 14:20（北京时间）· 客户端 0.5.9 · Windows 跳板修复

- 现象：`windows`（18133）跳板路线（remote.json `jump`）每 30 秒 `remote_connection retry`，Bridge 不通，`update_download` 30 秒后 `network`；本机残留约 70 个 ssh.exe。VPS1 侧跳板账户每次登录成功，VPS1→VPS2:22 正常，VPS2 sshd 连接停在 `[accepted]`（客户端握手字节从未到达）。
- 原因：Windows 上 ProxyCommand 运行 `AgentDesk.exe`（GUI 子系统）+ `ELECTRON_RUN_AS_NODE` 的 `ssh-jump.js`，读不到 ssh 传来的标准输入；helper 不退出，其子 ssh 一并残留。
- 修复：`orchestrator/ssh-options.js` 在 win32 上 ProxyCommand 直接是 `ssh.exe <jumpArguments> -W host:port`（参数按 Windows 命令行规则加引号；路径含 `"`、`%`、换行拒绝），不再设 ELECTRON_RUN_AS_NODE；Mac/Linux 仍用 helper。
- 验证：用户在该 PC 上手动以系统 ssh.exe `-W` 作 ProxyCommand 走同一跳板，握手完成直到目标账户认证（之前从未到达 VPS2）；`test/ssh-options.test.js` 新增用例；全量测试见提交。
- VPS2 未改动。受影响设备需手动安装 0.5.9（自动更新本身走这条连接）。

## 2026-11-28 11:55（北京时间）· 客户端 0.5.8

- v0.5.7 提交漏了 `vendor/win32-openssh/sftp-server.exe`（`.gitignore` 的 `*.exe`），发布运行已取消、未上传。`.gitignore` 加例外并补上文件，发 0.5.8，内容同 0.5.7。

## 2026-11-28 11:40（北京时间）· 客户端 0.5.7 + VPS2 · CLI 挂载整台电脑

- 用户要求：远程 CLI 控制本机、尽量贴合本地部署体验，能读写本机任意项目（系统拦截除外），其他人的 Windows 也要能用。
- 客户端 `native-cli-ssh.js`：有 sftp-server 时（Windows：安装包 `resources/win32-openssh/sftp-server.exe`，退回 System32\OpenSSH；Mac：`/usr/libexec/sftp-server`）用它以当前用户身份提供整台电脑，`ssh … mount computer <mode>`，一台电脑一个挂载、多个单聊共用；CLI 请求 `pc <项目本机路径 hex>`。没有 sftp-server 时退回只挂项目（0.5.3 方式）。`vendor/win32-openssh/`：PowerShell/Win32-OpenSSH 10.0.0.0p2-Preview `OpenSSH-Win64.zip`（sha256 23f50f34…aba5）中的 sftp-server.exe、libcrypto.dll、LICENSE.txt 原样，`build.win.extraResources` 打进 Windows 包。
- VPS2 `agentdesk-cli.js`：`mount computer` 挂在 `cli-chats/<设备>/pc-files`；`computerPath` 把本机路径映射为沙盒路径（Windows `C:\x` → `/c/x`，Mac 只接受 `/Users/…`、`/Volumes/…`，拒绝 `..`）；挂载不在或连接已断（ENOTCONN）时退回 VPS2 文件夹并提示。`cli-jail.js`：整台电脑绑在 `/pc`，Windows `/a`…`/z` 链接到 `/pc/X:`，Mac `/Users`、`/Volumes` 链接到 `/pc/…`。旧客户端的 `vps`/`local` 请求不变。
- 验证：用户 Windows（DAZZLE-LEGION）上实测 Win32 sftp-server 单独运行：根目录列出 C:、D:，读、写、建目录、改名、删除正常，列 System32 2.2 秒。VPS2 上以临时钥匙、经 `ssh win` 提供 sftp 端到端：0.7 秒挂上，Grok 在 `/pc/C:/Users/18133/Desktop/ICT-dual-track-202611` 启动（真实路径显示为 /pc/C:/…），关闭后卸载；连接已断时退回逻辑修正后通过。测试 649 项通过。临时钥匙和数据已删。

## 2026-11-28 04:20（北京时间）· 客户端 0.5.6

- 0.5.5 Windows 打包测试失败（`test/pc-bridge.test.js` 保护开关测试在 Windows 用 zsh → `invalid_terminal_shell`），未上传。测试改为按平台选 shell；按用户既定选择不移标签，发 0.5.6，内容同 0.5.5。

## 2026-11-28 03:50（北京时间）· 客户端 0.5.5 · 终端「保护」开关

- 用户要在终端上加按钮切换保护。`pc-bridge.js` 增加 `protection`（get/set/profile）与 `protect` 操作，`capabilities` 返回其状态；`main.js` 在 Mac 上提供（`userData/cli-terminal.json` 记住，开时用 `macSandboxProfile`），Windows 为 null 不显示；`terminal-panel.js` / `index.html` 加 `#terminalProtect`，只在 CLI 单聊显示。测试 648 项通过。

## 2026-11-28 03:10（北京时间）· 客户端 0.5.4 + VPS2 · Mac 终端去沙盒、Codex 可执行命令

- 用户 Mac 截图：CLI 让 AI 在共用终端 `brew install yt-dlp` 失败，`sandbox-exec: sandbox_apply: Operation not permitted`（终端在 sandbox-exec 里，Homebrew 再开一层被拒）。用户要求 AI 能在终端用命令、按本机部署体验。`main.js` 的 pc 桥终端 `profile` 改为不套 sandbox-exec（只影响 CLI 单聊的共用终端；旧对话式单聊的终端未改）。代价：该终端里可读到 `~/.agentdesk` 等 AgentDesk 密钥。
- VPS2 `agentdesk-cli.js`：Codex 改为 `--sandbox danger-full-access`（用户同意）；原因是 Codex 自带 bubblewrap 在 CLI 沙盒里无法建用户命名空间，所有命令失败；隔离由 cli-jail 负责（备份 `*.bak-20261128-codex`）。
- 进行中：整台电脑挂载（Windows 打包 Win32-OpenSSH sftp-server，Mac 用系统 sftp-server），等用户 Windows 上线后自动测试。

## 2026-11-28 01:30（北京时间）· 客户端 0.5.3 + VPS2 · CLI 直接改电脑上的项目

- 用户要求 CLI 直接改电脑上的文件。客户端 `native-cli-ssh.js`：项目有本机目录（`resolveRoot`，main.js 按项目配置的 `localRoot`，渲染层传不进路径）时，先开 `ssh agentdesk@vps2 mount <projectId> <write|read>`（无终端），在本机用 `sftp-project-write.js` 只提供该目录的 SFTP；同项目多个单聊共用，断线按 1/2/5/10/20/30 秒重挂，最后一个单聊关闭时断开。CLI 请求多一个词 `local|vps`（旧客户端 6 个词仍可用）。
- VPS2 `agentdesk-cli.js`：`mount` 子命令以 agentdesk 身份用 sshfs（passive、带缓存）挂在固定位置 `cli-chats/<设备>/mounts/<项目>`，新连接替换旧挂载；`local` 时沙盒把它绑成 `/work/<项目名>`（已验证：沙盒启动后才挂上的也能看到，断开后为空、重挂后恢复）。上传改到 `cli-chats/<设备>/uploads/<项目>`，沙盒内 `/uploads`。`project-mount.js` 增加 `directory`（固定挂载点）选项，原调用不变（备份 `*.bak-20261128-fixed`）。
- 验证：VPS2 上用临时钥匙端到端——0.66 秒挂上，VPS2 侧读到「电脑」文件、写入的新文件出现在「电脑」上，关闭后卸载；测试钥匙与数据已删除。测试 647 项通过。
- 未改：Codex 自带的命令沙盒在 CLI 沙盒内无法启动（嵌套用户命名空间被拒），Codex 执行命令会失败；改为由 CLI 沙盒负责隔离的改动被自动审查拦下，待用户确认。
- `ssh-jump.js`：外层 ssh 结束 3 秒后结束内层 ssh（Windows 上残留进程）。

## 2026-11-28 00:10（北京时间）· 客户端 0.5.2 · CLI 单聊深色玻璃质感；ictvps 改走中继；开通 CLI 设备

- 客户端：`.native-cli` 固定深色变量 + 半透明背景 `backdrop-filter: blur(22px) saturate(150%)`，xterm `allowTransparency` 与透明背景；状态栏、工具栏、提示卡片同风格。只改 CLI 单聊区域，其他界面和群聊不变。未在真机截图验证，靠用户更新后反馈。
- VPS2：`agentdesk-cli-keys.js add` 开通 `mac`（公钥与 Mac 上 userData 副本一致）和 `windows`（18133，DAZZLE-LEGION，经 `ssh win` 读取）。
- 用户 Windows（18133）`ssh ictvps` 超时：直连 VPS2:22 成功两三次后被中间设备重置（约 28 秒，VPS2 记为 preauth `Connection reset/closed`，未被 fail2ban 封）；`ictvps-relay`（REALITY 中继）正常。已把 `~/.ssh/config` 中 `ictvps` 改为走中继（127.0.0.1:10022，HostKeyAlias 192.238.238.236），原直连改名 `ictvps-direct`，备份 `config.bak-20261127-relay`。中继 4 次中 1 次失败；该电脑上未发现中继的开机自启任务。

## 2026-11-27（北京时间，晚）· 客户端 0.5.1 · 发布 0.5.0 的内容

- 0.5.0 第二次发布运行中 Windows 打包测试失败（`test/cli-jail.test.js` 在 Windows 调用 `process.getuid`），未上传。修复：沙盒测试只在 Linux 运行、`writeIdentity` 兜底；按用户选择不再移动 `v0.5.0` 标签，版本升为 0.5.1 发布，内容与 0.5.0 相同。

## 2026-11-27 22:30（北京时间）· 客户端 0.5.0 + VPS2 · 原生 CLI 单聊改走纯 SSH

- **起因**：经载体转发的原生 CLI 仍慢（Grok/Codex/Antigravity 启动扫描挂载的项目、按键与 SFTP 同道）。用户要求照「自己在终端 ssh 到 VPS2 用 CLI」的方式做，只适配界面；登录不能用 root；多人使用需隔离；群聊不受影响。
- **VPS2 改动**：
  - `60-agentdesk-bridge.conf`（Match User agentdesk）`PermitTTY no → yes`，备份 `*.bak-20261127-cli`，`sshd -t` 通过后 reload。该账号 20 把钥匙全部带 `restrict`（默认无 pty），只有新加的 `restrict,pty` CLI 钥匙能开终端；`DisableForwarding yes` 不变。
  - 新增 `agentdesk-cli.js`（强制命令，以 agentdesk 身份）：`cli <provider> <chatId> <projectId> <nameHex> <mode>` 在 bwrap 沙盒里于 `cli-chats/<设备>/work/<项目>`（显示为 `/work/<项目名>`）启动官方 CLI，按设备的私有历史（cli-history 绑定；Codex 共用 homes/codex，按目录区分），每个单聊记住自己的会话（Claude/Grok 预设 id，Codex/agy 首次运行后识别）；用 dtach（新装 `dtach 0.9`）保活，断线后再连接回同一会话（`-r winch -E -z`）；`upload`、`stop` 两个子命令。
  - 新增 `agentdesk-cli-keys.js`（root 管理）：`add/remove/list` 设备的 CLI 钥匙（写入前备份 authorized keys）。
  - `native-tui.js` 一并部署（共用工具函数）。
- **客户端改动**：`orchestrator/native-cli-ssh.js`（node-pty 运行 `ssh -tt agentdesk@vps2 cli …`，与其他 VPS2 连接共用直连/VPS1 跳板路线记录，255 断线按 1/2/5/10/20/30 秒自动重连，`Permission denied (publickey)` 显示「未开通」并可复制公钥，公钥副本在 userData/cli_ed25519.pub）；`main.js` 的 `tui:call` 改用它；`src/native-cli.js` 去掉权限切换与提示栏，加工具栏（附件/模型/额度/帮助）；新增 `src/native-cli-help.js`；新建单聊默认原生 CLI（群聊页发起的仍是对话界面）；额度刷新改为 60 秒；`project-mount.js` 增加可选缓存（默认关闭，群聊不变）。
- **验证**：全部测试通过（新增 `test/native-cli-ssh.test.js` 4 项）；VPS2 上以真实 sshd + 测试钥匙端到端：0.97 秒看到 Grok 官方界面、上传、调整大小、结束；dtach 断线后会话仍在、重连接回并重绘、`stop` 后进程清空。测试钥匙、会话和数据已清除。
- **发布暂停**：v0.5.0 的发布运行在打包阶段被取消（用户要求），VPS2 未收到 0.5.0；之后的改动并入 0.5.0 重新发布（需移动标签，已征得用户同意）。
- **沙盒加固（同日稍后，用户要求「客户端不能改动也不能查看 VPS」、注意并发与多人隐私）**：
  - 新增 `cli-jail.js`：原生 CLI 不再用群聊的沙盒（整机只读可见），改为从空白开始：只放 `/usr`（`/usr/local` 只留 grok、agy）、Node 运行时、`/etc` 中程序必需的文件；`passwd/group/hosts/hostname/resolv.conf` 为沙盒单独生成；`/root`、`/home`、`/srv`、`/var/lib`、`/var/log`、AgentDesk 代码与数据一律不可见；独立 PID/IPC/UTS/用户/网络命名空间。
  - 每台设备每个 CLI 一个独立家目录 `cli-chats/<设备>/home/<provider>`；共享登录只把令牌文件本身绑入（Claude `.credentials.json`、Codex `auth.json`、agy 令牌，Grok 每次复制 `auth.json`），设置首次复制一次，历史不共享（`.claude.json` 去掉他人项目列表）。
  - 网络：沙盒用独立网络命名空间，经 `slirp4netns` 上网（新装 `slirp4netns`、`passt`；passt 因 AppArmor 限制未使用）。`/usr/local/lib/agentdesk/slirp4netns` 为 setgid `agentdesk-cli` 的副本（新建系统组 `agentdesk-cli`，agentdesk 加入）；`/etc/agentdesk-cli-net.nft` 由 `agentdesk-cli-net.service` 加载，拒绝该组访问本机地址与内网（仅放行本机 DNS）。群聊等其他进程不受影响。新增 `cli-net.py`（通过 NS_GET_USERNS 接入 bwrap 的网络命名空间）。
  - 并发：对话记录改为每个单聊一个文件 `chats/<provider>-<chat>.json`；上传以 O_EXCL 占名；新家目录初始化加锁。
  - 验证：沙盒内看不到 `/root`、`/srv`、AgentDesk 数据、`/etc/ssh`、日志、shadow；`/usr` 只读；外网可达、本机回环与公网地址上的 3001/9443/7681/888 均被拒；四个 CLI 均能启动，Claude/Codex 登录有效；4 个并发首次打开一致；5 个并发同名上传各自成功；跨设备不可见。测试 643 项通过。
  - 已知：共享登录意味着任何开通的设备在 CLI 里都能读到该登录令牌（CLI 运行需要它）；Codex 刷新令牌轮换时，多处同时刷新有小概率使登录失效。
- **pc 命令（回到用户电脑）**：不使用 sshd 端口转发（sshd 配置不再改动）。VPS2：`agentdesk-cli.js pcbridge`（同一把设备 CLI 钥匙、无终端）在 `cli-chats/<设备>/pc/bridge.sock` 监听（位置由服务端决定，同设备新连接替换旧的），沙盒内只读挂到 `/run/agentdesk/pc`，`cli-pc.py` 挂为 `/usr/local/bin/pc`；`AGENTDESK_CHAT` 标明是哪个单聊。客户端：`orchestrator/pc-bridge.js`（主进程里的 TerminalSessions，每单聊一个主终端，最多 4 个；命令从临时文件运行，OSC 633 标记取退出码；AI 颜色行由 shell 自己打印，人工输入颜色用 PSReadLine/zle 设置，不往终端流里插字以免 ConPTY 错位；接管先 SIGINT；`pc --ask` 设为接管并等交还）；`terminal:call` 中 `cli:` 线程走它；面板与 CLI 工具栏「终端」按钮；帮助页说明。
  - 验证：VPS2 沙盒内 `pc` → 桥 → 模拟电脑往返、退出码；bridge 目录在沙盒内只读；客户端用真实 bash 测运行/目录延续/退出码/接管中断/AI 输入被拒/请求接管与交还/不同单聊分开/颜色行。Windows PowerShell 路径只做了脚本生成的单元测试，未在真机运行。
- **回滚**：`agentdesk-cli-keys.js remove <设备>` 关闭某台电脑；恢复 sshd 配置备份并 reload；客户端发更高版本。

## 2026-11-27 21:00（北京时间）· 客户端 0.4.20 · 载体写入合并，修复原生 CLI 打字卡顿

- **起因**：用户反馈原生 CLI 打字半天才出来，直接 ssh 很快。原因是 `native-tui-client.js` 和 `windows-native-seat.js` 把每个 NativeChannel 帧各发一次 `command/exec/write` 并串行等待回复：每帧一个来回，SFTP（CLI 扫描项目时成千上万个小请求）和按键排在同一条队里。
- **改动**：新增 `orchestrator/carrier-writer.js`：同时最多一个写请求在途，期间到达的数据合并进下一次（单次最多 1 MB，积压超过 8 MB 断开）。两处载体都改用它。
- **VPS2**：无改动。
- **验证**：全部测试通过（新增 `test/carrier-writer.test.js` 2 项：在途时到达的 9 次按键合并为 1 次写入、大块拆分、积压上限）。
- **回滚**：发更高版本撤回。

## 2026-11-27 20:10（北京时间）· 客户端 0.4.19 · 原生 CLI 在新建单聊时选择

- **起因**：用户希望选单聊 AI 时同时选「原生 CLI / 默认对话」，CLI 单聊直接显示官方 TUI。
- **改动**：`src/provider-direct.js` 选择框加「界面」单选（记在 `newChatSurface`）；`src/app.js` `startDirect` 的 `surface: 'cli'` 交给 `AgentDeskNativeCli.create`，侧栏显示「CLI」标记；`src/native-cli.js` 去掉输入框按钮，CLI 单聊（`surface: 'cli'`，列表存 `agentdesk.cliChats`）打开即显示并自动启动 TUI（每次运行一次，用户结束的不自动重启）；删除走 `tui forget`。`windows-native-desktop.js` 的 TUI 键加上单聊 id（每个 CLI 单聊独立会话键与 VPS2 私有历史）。
- **VPS2**：无改动。
- **验证**：全部测试通过；打包后的界面冒烟测试由 CI 在 Windows/Mac 上跑。
- **回滚**：发更高版本撤回。

## 2026-11-27 12:10（北京时间）· 客户端 0.4.18 · CLI/终端按键不再触发应用快捷键

- **起因**：xterm.js 默认不阻止按键冒泡，原生 CLI 和终端面板里的 Ctrl+B/J/K/N/Shift+L 会同时触发 `src/app.js` 的全局快捷键。
- **改动**：`src/native-cli.js`、`src/terminal-panel.js` 在终端容器上拦住 keydown 冒泡（Ctrl+Tab 除外）。
- **VPS2**：无改动（0.4.17 已含 host 在 SIGTERM/SIGHUP 时正常清理）。
- **验证**：全部测试通过。
- **回滚**：发更高版本撤回。

## 2026-11-27 11:30（北京时间）· 客户端 0.4.17 + VPS2 · 原生 CLI 单聊

- **起因**：用户要一个「纯血」CLI 单聊：官方 TUI 原样显示，经反向通道直接操作本机，并和 AgentDesk 的功能结合；Windows 和 Mac 都要支持。
- **改动（VPS2，新增，不影响现有单聊）**：`orchestrator/native-tui-host.js`（由 root codex app-server 的 command/exec 载体启动，在私有挂载命名空间里运行：SFTP 挂载项目、提供 agentdesk MCP 套接字、上传目录）、`native-tui-launch.js`（以 CLI 的服务账户在伪终端里准备私有历史和 MCP 配置，再在 bwrap 里运行官方 CLI；项目绑定为 `/work/<项目名>`，Codex 为 `/work/<会话键前 8 位>/<项目名>`，上传只读绑定为 `/uploads`）、`native-tui.js`（各 CLI 的交互式参数、提示、续聊判断）、`pty-run.py`（伪终端：fd0 按键、fd1 画面、fd3 尺寸）。`native-channel.js` 增加可选的帧类型集合（t 终端、m 工具中继、u 上传），默认集合不变；`chat-mcp.js` 给 local_shell/terminal 15 分钟超时。
- **改动（客户端）**：`orchestrator/native-tui-client.js`（一条载体复用 SFTP、终端、工具中继、上传）、`windows-native-desktop.js` 的 `tui()`（每个 CLI + 项目一个会话，独立的会话键和本机租约，记录在 `tui.json`；工具：local_shell、有 node-pty 时 terminal、Windows 管理员 PowerShell；只读模式不提供工具）、`main.js` 的 `tui:call` / `tui:event`、`src/native-cli.js` + 样式（输入框旁「原生 CLI」按钮、状态栏、可修改/只读规划、上传、重新连接续聊、后台保活与回放；按键按 Windows Terminal / Terminal.app 习惯）。
- **权限**：全部按官方模式：Claude/Grok/Antigravity 用默认权限模式（只读规划用 plan），Codex 用 `--sandbox workspace-write|read-only` 和自己的默认批准策略；AgentDesk 不预先放行任何工具，包括连到本机的 agentdesk 工具。续聊：Claude/Grok/agy 在本会话的私有历史里有内容时用 `--continue`，Codex 按 rollout 的 cwd 找到会话 id 用 `resume <id>`；继续失败 10 秒内退出就改为新对话。
- **VPS2**：上述 4 个新文件放到 `/opt/agentdesk-orchestrator/`，`native-channel.js`、`chat-mcp.js` 覆盖前备份为 `*.bak-20261127-tui`。不需要重启服务。
- **验证**：全部测试通过（新增 `test/native-tui.test.js` 8 项）；在 VPS2 上用真实客户端模块 + 真实 host 端到端跑通 Claude Code、Codex、Grok、agy 的官方 TUI（启动约 0.2 秒、项目挂载为 /work/<名>、上传、调整尺寸、结束后无残留挂载和临时目录），agentdesk MCP 工具经中继到达「本机」并返回，未提供的工具和错误能力码被拒。
- **回滚**：删除 VPS2 上 4 个新文件即关闭该功能（客户端会提示 VPS2 没有原生 CLI 服务）；客户端发更高版本撤回。

## 2026-11-26 16:10（北京时间）· 客户端 0.4.16 · 单聊发送后输入框立刻清空

- **起因**：Windows 单聊（Codex）连到 VPS2 的 SSH 被中途重置（`client_loop: send disconnect: Connection reset`），之后再发消息时，消息已经出现在对话里，输入框却还留着原文。原因是输入框只在 `turn/start` 成功后才清空，等连接、恢复会话、发送失败的整个过程中文字都还在。
- **改动**：`src/live.js` 在等待连接前就清空输入框；这一轮没能开始（连接失败、会话恢复失败、发送失败、完全访问被拒）时把原文放回输入框；期间切到了别的会话，就放进原会话的草稿，不会写进别人的输入框。插话（steer）不变。
- **VPS2**：无改动。
- **验证**：全部测试通过（`test/stuck-interactions.test.js` 新增 1 项）。
- **回滚**：发更高版本撤回。

## 2026-11-26 11:09（北京时间）· 客户端 0.4.15 · 重发 0.4.14

- **起因**：v0.4.14 的 Windows 打包测试失败：`test/local-commands.test.js` 断言命令列表只有项目配置的命令，而 Windows 上现在还会列出内置诊断命令。
- **改动**：该测试只比对非内置命令。功能同 0.4.14。
- **VPS2**：无新改动（0.4.14 的单聊服务改动已生效）。
- **回滚**：发更高版本撤回。

## 2026-11-26 11:04（北京时间）· 客户端 0.4.14 + VPS2 单聊服务 · Windows 管理员 PowerShell、内置诊断命令

- **改动（客户端）**：新增 `admin-shell.js` 和工具 `agentdesk_admin_shell`（仅 Windows）：先弹 AgentDesk 确认（显示原因和第一条命令），再用 `Start-Process -Verb RunAs` 触发 UAC；提权的 PowerShell 助手通过随机命名管道连回 AgentDesk，先用 `GetNamedPipeServerProcessId` 核对管道属于本 AgentDesk 进程，再发送随机令牌；之后每次调用执行一段脚本并返回退出码、stdout、stderr（各最后 16000 字，CLIXML 错误转纯文本），单条最长 10 分钟。会话按对话区分，10 分钟无调用或 60 分钟后自动结束，写审计日志 `admin_shell`。普通单聊（ask）之后每条命令逐条确认；原生完全访问单聊（经 `windows-native-seat.js` 的 adminShell 钩子）同意一次即可；只读轮次拒绝。`local-commands.js` 在 Windows 上新增 11 条内置只读诊断命令（`sys-overview` 等），工作区 `"builtinCommands": false` 可关闭，同名时以用户配置为准。
- **改动（VPS2）**：`chat-server.js` 放行 `agentdesk_admin_shell`（不再出审批卡，由客户端确认；超时 14 分钟；只读轮次拒绝；系统提示加一条用法），`chat-mcp.js` 相应放宽该工具超时。两个文件直接替换（单聊服务每个连接单独启动，新连接生效，不用重启主控）。
- **18133 电脑**：`~/.agentdesk/windows-bridge.json` 增加 git-log、git-diff-stat、git-branch、git-fetch、docker-ps、docker-stats、gpu-status、tunnel-status，备份 `windows-bridge.json.bak-20261126-commands`。
- **验证**：全部测试通过（新增 `test/admin-shell.test.js` 9 项、`test/builtin-commands.test.js` 3 项）。在 18133 上用真实 PowerShell 助手（不经 UAC）验证管道、属主校验、令牌、中文输出、退出码、超时与结束；11 条内置命令和 8 条新增命令逐条实跑通过。UAC 实弹待用户在电脑前试。
- **回滚**：客户端发更高版本撤回；VPS2 恢复 `/opt/agentdesk-orchestrator/chat-server.js.bak-20261126-admin` 与 `chat-mcp.js.bak-20261126-admin`；18133 恢复上述 Bridge 配置备份。

## 2026-11-26 10:22（北京时间）· 客户端 0.4.13 · 重发 0.4.12

- **起因**：v0.4.12 的 Windows 打包在测试阶段失败（`cleanup.test.js`、`history-retention.test.js` 断言文件权限 0600，Windows 上恒为 0666；来自 main 上的清理加固提交，与 0.4.12 改动无关），没有上传。
- **改动**：这两处权限断言在 Windows 上跳过。客户端功能同 0.4.12。
- **VPS2**：无改动。
- **验证**：本机全部测试通过；以发布运行的 Windows 测试为准。
- **回滚**：发更高版本撤回。

## 2026-11-26 10:16（北京时间）· 客户端 0.4.12 · Windows 桌面控制能按名字启动 PowerShell

- **起因**：GPT 在 Windows（18133）上调 `desktop_launch({app:"powershell.exe"})` 返回 `APP_NOT_FOUND`，命令没送到电脑。agent-desktop 只认直接在 `System32` 或 Windows 目录下的裸名，`powershell.exe` 在 `System32\WindowsPowerShell\v1.0\`，`pwsh` 在 `Program Files\PowerShell\7\`。
- **改动**：`desktop.js` 新增 `resolveLaunchApp`：Windows 上 `desktop_launch` 的 `app` 是裸程序名时，按 System32、Windows 目录、Windows PowerShell、PowerShell 7、PATH 的顺序找 `.exe`，找到就换成绝对路径再交给后端；找不到（例如应用显示名）或已是路径时原样传。不增加权限（本来就能传绝对路径）。Mac 不变。
- **VPS2**：无改动。
- **验证**：全部测试通过（`test/desktop.test.js` 新增 2 项）。Windows 实机待升级后让 GPT 再试 `desktop_launch powershell.exe`。
- **回滚**：发更高版本撤回。

## 2026-11-25 18:54（北京时间）· VPS2 主控 · 清理加固（5555e68）

- **改动**：`cleanup.js` 改为先原子移入 `.cleanup-trash/<批次>/`、`trashDays` 后再删；路径防逃逸（realpath、符号链接、跨文件系统拒绝），只清已结束、未运行、未被引用的任务；每步写 `cleanup-audit.jsonl`；`.cleanup.lock` 防并发；数据库无任务记录时不清无主目录（`orphanGuard: no_task_records`）。`scheduler.js` 删历史记录前先导出 `cleanup-archive/`。`admin.js` 新增 `ad gc --dry-run`。
- **部署方式**：维护模式排空（无运行任务）→ 安装 → 重启主控 → 手动启动 `agentdesk-home-mount` → 关闭维护模式。安装源是 5555e68 的 `orchestrator/` 暂存副本，但 `mcp.js` 保留线上版本（含 feat/wechat-admin 的微信远程工具，main 上还没有）。`install-ubuntu.sh` 需带 `AGENTDESK_NODE_BIN=/opt/agentdesk-node24/bin/node`（系统 `/usr/bin/node` 不到 24，否则脚本直接退出）。旧版整目录备份为 `/opt/agentdesk-orchestrator.bak-20261125-deploy-cleanup`。
- **验证**：`npm test` 612 通过、0 失败；服务 `active`，启动无报错；`ad gc --dry-run` 计划为空、`orphanGuard: no_task_records`；首轮正式清理（10:54Z）`ok: true`，无删除、无错误，`ad doctor` 的 `cleanup` 已显示该结果；`worktrees/` 下 31 个无主目录仍在（留待人工处理）。`missingRepositories` 报 mac/lenovo/win3 三个镜像仓库不存在（只报告，不处理）。
- **回滚**：`sudo cp -a /opt/agentdesk-orchestrator.bak-20261125-deploy-cleanup/*.js /opt/agentdesk-orchestrator/`，重启主控并手动启动 `agentdesk-home-mount`。

## 2026-11-24 19:50（北京时间）· 客户端 0.4.11 · Windows 后台常驻 Bridge

- **改动**：新增 `background.js`；Windows 打包版在配置了主控 Bridge（`remote.json` 的 `orchestratorBridge`）时，把自己登记为开机启动（`HKCU\…\Run`，参数 `--background`）。后台启动不开窗口、只连主控并显示托盘图标；关掉窗口不退出（留在托盘、首次弹提示），托盘「退出」才真正退出并断开。再次打开 AgentDesk 会在同一进程里打开窗口。Bridge 没起来时照常开窗口。`config.json` 的 `"bridgeAtLogin": false` 可关闭开机启动。Mac 不受影响（仍是 LaunchAgent 独立 Bridge）。
- **VPS2**：无改动。
- **验证**：全部测试通过（新增 `test/background.test.js` 4 项）。Windows 实机（联想）待升级后核对：重启电脑不打开 AgentDesk，微信 `/设备` 显示联想在线。
- **回滚**：发更高版本撤回；单台电脑可在 `config.json` 设 `"bridgeAtLogin": false` 后重开 AgentDesk 取消开机启动。

## 2026-11-24 17:15（北京时间）· VPS1 / VPS2 · 第三台 Windows（win3）预配置

- **VPS2**：`config.json` 的 `workspaces`、`sshBridges`、`quotaBridges`、`relayBridges`、`projects` 加 `win3`（Git 镜像 `repos/win3.git` 由主控首次使用时自动建）；新增 `relay-win3.token`；重启主控和 `agentdesk-home-mount`，`bridge-win3.sock`、`bridge-win3-mount.sock` 已建立。改前备份 `config.json.bak-20261124-win3`。
- **VPS1**：Relay 注册表新增 `win3-bridge` ↔ `vps2-orchestrator-win3`，主控一端已上线。
- **Caddy（临时）**：:8443 加一条随机路径，只提供 0.4.10 Windows 安装包下载给新电脑（备份 `Caddyfile.bak-20261124-win3dl`），重启 Caddy 约 1 秒。装好后删掉。
- **钥匙（17:31）**：win3 的 codex/claude/grok/antigravity/bridge 五把公钥已写入 `/etc/ssh/agentdesk-authorized-keys`（单聊设备标签 `win3`，Bridge 限定 `ssh-gateway.js bridge-win3.sock bridge-win3-mount.sock`），改前备份 `/root/backups/agentdesk-authorized-keys.bak-20261124-173101-win3`。待 win3 真机验证单聊和群聊。
- **回滚**：恢复 `config.json.bak-20261124-win3` 并重启两个服务；VPS1 删掉这两条配对；恢复 Caddyfile 备份并重启 Caddy。

## 2026-11-24 16:30（北京时间）· 客户端 0.4.10 · 原生单聊支持本机技能；Mac 自签名

- **起因 1**：Mac 原生单聊里 `$college-lab-report` 不生效。原生单聊的 Codex 在 VPS2 沙箱里只看得到自己的 CODEX_HOME；客户端的本机技能上传仍走普通会话的路（远程工作区 `.agentdesk-skills` + 直连 Codex 的 `skills/extraRoots/set`），原生会话的 Codex 看不到，原生会话也不放行登记技能目录。模型只好自己用 local_shell 去 Mac 上找 SKILL.md。
- **改动 1**：`windows-native-seat.js` 新增 `installSkill`：经该会话的 Codex 用 `fs/writeFile` 写到 `CODEX_HOME/agentdesk-skills/<技能>`（CODEX_HOME 由 `skills/list` 的系统技能路径推出），`skills/extraRoots/set` 登记后 `forceReload` 确认识别；路径校验、单文件 ≤2 MB。`skills:upload` 带上 threadId，原生会话走 seat；`live.js` 改为会话建好后再上传技能（首条消息也能用）。普通会话不变。
- **起因 2**：原生单聊 `screencapture -l` 报 `could not create image from window`。Mac 版是临时签名（无 `_CodeSignature`），macOS 屏幕录制授权按版本失效。
- **改动 2**：没有 Developer ID 时用自签名证书签名（secret `MAC_SELF_SIGN_P12` / `MAC_SELF_SIGN_PASSWORD`，原件在 VPS2 root 目录，不入库）：`release.yml` 导入临时钥匙串，`build/notarize.js` afterSign 签名（不开 hardened runtime），CI 校验指定要求钉在这张证书上（certificate root/leaf），并对签名后的 App 跑终端和界面冒烟测试。更新上仍是未签名构建（`signed:false`，手动替换）。
- **VPS2**：无改动（skill 写入 `/root/.codex/agentdesk-skills`，由客户端经原生会话的 Codex 完成）。
- **验证**：`npm test` 通过（新增 `test/native-seat-skills.test.js`）；在 VPS2 用 Codex 0.171 实测 skills/list → fs/writeFile → extraRoots/set → 重新加载可识别；分支上手动跑发布流程（不上传）验证 Mac 签名和签名后启动。
- **用户步骤**：Mac 装上后在「屏幕与系统录音」里删掉 AgentDesk 再添加（最后一次）。
- **回滚**：客户端回到 0.4.9（授权会回到按版本失效）。

## 2026-11-24 13:30（北京时间）· 客户端 0.4.9 · Windows Bridge 目录原地切换

- **起因**：检查 Windows 是否有 0.4.8 的问题：Windows 的 `remote.json` 由接入脚本写入 `orchestratorBridge`（`~/.agentdesk/<设备>-bridge.json`，用户可写），不会「找不到 Bridge」。但 0.4.7 在 Windows 切换 root 时 `stopBridge()` 后立即 `startOrchestratorBridge()`：`stop` 是异步的（控制管道 `close` 回调后才关 `bridge.sqlite`），立即重启可能与旧实例冲突导致新 Bridge 起不来；且会结束正在运行的 Bridge 命令。
- **改动**：Windows 不重启 Bridge，写文件后直接改 `localBridgeSettings.workspaces[ws].root`（`WindowsOperations` 持有同一对象、每次请求现读 root）。Mac 仍 `launchctl kickstart`。
- **VPS2**：无改动。
- **验证**：`npm test` 通过。Windows 端日志读不到，需用户装好后试单聊/群聊。
- **回滚**：客户端回到 0.4.8。

## 2026-11-24 13:15（北京时间）· 客户端 0.4.8 · Mac 找不到 Bridge 配置文件

- **起因**：Mac 装上 0.4.7 后，「hi」（文件夹 `~/大学学习/华为ict`）完全访问单聊报「这台电脑没有可用的主控 Bridge 配置」；`mac-bridge.json` 未被改动、审计日志没有 `bridge_root`。`commandsFile()` 只认 `mac-remote.json` 的 `agentCommandsFile` / `orchestratorBridge`，这台 Mac 都没写 → `macBridgeSettings()` 为 null，`syncBridgeRoots` 无文件可改，本机命令列表也为空。0.4.5 之前的「Bridge 写入授权与本机目录不匹配」很可能也是这个原因。
- **改动**：Mac 上两者都没写时，回退到 `<userData>/bridge/mac-bridge.json`（launchd `local.agentdesk.mac-bridge` 实际使用的文件，存在才用）。
- **VPS2**：无改动。
- **验证**：`npm test` 通过；装上后看 Mac 审计日志 `bridge_root` ok、`mac-bridge.json` 的 `workspaces.mac.root` 变为项目文件夹。
- **回滚**：客户端回到 0.4.7；Bridge 配置用 `mac-bridge.json.bak-root-*` 恢复。

## 2026-11-24 13:10（北京时间）· 客户端 0.4.7（0.4.6 打包失败未发布）· Bridge 目录跟随项目；禁止个人文件夹作项目；删除防重复

- **起因**：Mac「hi」项目（文件夹为桌面）自动连上主控 `mac` 后，完全访问单聊报「该项目的 Bridge 写入授权与本机目录不匹配」；群聊任务 `d60f32a5` 的快照来自 `~/AgentDeskWorkspace`（`mountProject: AgentDeskWorkspace`），不是项目文件夹。Bridge 配置（Mac 为 launchd 的 `mac-bridge.json`，Windows 为进程内 Bridge）里工作区 `root` 是装机时写死的，客户端从未随项目更新（此前记录里「Bridge 根目录跟随当前项目」的说法不成立：`activateProject` 只改本机 workspace 服务）。
- **改动**：新增 `bridge-root.js`：项目绑定主控工作区时把该工作区的 Bridge `root` 改为项目文件夹（只改 root，保留 write/commands 等，先备份 `*.bak-root-<时间>`，原子写入，保持权限），然后 Windows 重启进程内 Bridge、Mac `launchctl kickstart -k local.agentdesk.mac-bridge`；在项目增改/选择后和启动时执行。个人文件夹（桌面、文稿、下载等）和不存在的目录不切换并提示。`refusedRoot` 新增个人顶层文件夹。单聊不匹配错误分三种说明（无 Bridge / 主机不一致 / 目录不一致）。项目菜单删除：进行中提示并忽略重复点击（Mac 审计日志里 9 次 `already_deleting`）。
- **VPS2**：无改动（`mountFor` 每个任务向 Bridge 现问 `mount_info`，会跟随新 root）。
- **验证**：`npm test` 通过；新增 `test/bridge-root.test.js`、扩展 `windows-native-desktop.test.js`。
- **0.4.6**：标签已推送，但 Mac/Windows 打包时新测试失败（macOS 临时目录 `/var`→`/private/var` 使「桌面」判断未识别；Windows 无 0600 权限位），未上传。0.4.7 改为两边都用真实路径比较用户目录，测试在 Windows 跳过权限位检查。
- **回滚**：客户端回到 0.4.5；Bridge 配置用 `mac-bridge.json.bak-root-*` 恢复并重启 Bridge。

## 2026-11-24 12:40（北京时间）· VPS2 配置 + 客户端 0.4.5 · 去掉本地示例，新建项目必须连主控

- **起因**：0.4.4 后 Mac 新建「hi」仍是本地示例，提示「主控没有给这台电脑分配工作区」。VPS2 `/etc/agentdesk-orchestrator/config.json` 一直没有 `projects` 段，`route_status` 给每台设备回 `projects: []`，客户端没有空闲工作区可选。另外客户端真实模式仍加载 billing-service / web-dashboard / infra-scripts 演示项目和会话。
- **VPS2（12:17）**：`config.json` 加 `projects`：`mac`、`windows`、`lenovo` 各一个（`members` 和 `workspaces` 都只含本设备）。备份 `config.json.bak-20261124-projects`；重启主控，重新启动 `agentdesk-home-mount`。以后新接入设备也要补一条。
- **客户端 0.4.5**：真实模式不再加载内置演示数据（项目、会话、改动、文件树、终端）；新建项目对话框去掉「本地示例」，没有空闲工作区时不能创建并说明原因；读到空闲工作区后，未连主控的旧项目自动连接（不弹确认，清掉示例记录，保留文件夹和单聊）。工作区全被占用时示例提示条仍会显示原因。
- **验证**：`npm test` 通过。
- **回滚**：VPS2 配置用备份文件覆盖后重启主控；客户端回到 0.4.4。

## 2026-11-24 11:42（北京时间）· VPS2 · 群聊步骤与微信助手隔离 CLI 对话记录；Antigravity 整目录独立

- **改动**（`42b54be`）：
  - `adapters.js` 新增 `history` 参数：群聊步骤按发起设备（`history: 'group-<bridge>'`，scheduler 传入）各用一份 CLI 对话记录（`cli-history/adapter-group-<bridge>/<provider>`）；未传的调用方（微信助手）用 `adapter-default`。它们都看不到单聊记录，彼此也看不到。
  - `project-delete.js` 删除群聊项目时一并清理该设备那份记录。
  - `cli-history.js`：Antigravity 改为整个 `.gemini/antigravity-cli` 目录按实例独立（首次只复制 bin、builtin、设置等，不复制任何历史），只把登录令牌 `antigravity-oauth-token`（原地写入）挂回共用的那份。原因：上一版按单个文件挂载 `conversation_summaries.db`，它的 WAL 日志（`-wal/-shm`）仍在共用目录里，两台设备同时使用时可能互相套用日志、损坏数据库。上一版部署后没有任何设备用过（`cli-history` 为空），无实际影响。11:30 已先单独替换 `cli-history.js` 并经 `agent-chat.sh` 端到端验证（WAL 落在设备目录、摘要缓存可写、续聊正常）。
  - 带上了微信分支已在现网的 `adapters.js` 一行（`mcp.scopeArg`），避免覆盖。
- **VPS2**：备份到 `/root/backups/agentdesk-deploy-group-isolation-20261124-114150CST/`（含 `ROLLBACK.sh`）；维护模式排空（无运行任务）→ 替换 `adapters.js`、`scheduler.js`、`project-delete.js`、`cli-history.js`（逐字节一致）→ 重启主控（旧进程停止超时被 KILL，新进程正常，NRestarts=0）→ 重新启动 `agentdesk-home-mount`（随主控停掉）→ `doctor` 全部 ok → 退出维护模式。**没有重启 `agentdesk-wechat`**（另一会话在开发），它下次重启后才用新的 `adapters.js`。
- **验证**：`npm test` 590 项通过；新增真实 bwrap 测试：设备 A 的群聊步骤只列出自己的会话、登录可用、共用目录和设备 B 的记录不可读、新会话写入 A 的目录。
- **Codex 未做**：Codex 自带沙盒支持 `permissions.<档>.filesystem` 禁读（`codex sandbox` 实测有效，可写目录用 `:workspace_roots`），但命令行 `--sandbox` 会覆盖权限档，单聊「完全访问」不进沙盒；需改 Codex 启动方式并处理 git 工作树和家目录挂载，单独做。
- **回滚**：`sh /root/backups/agentdesk-deploy-group-isolation-20261124-114150CST/ROLLBACK.sh`。

## 2026-11-24 11:45（北京时间）· 客户端 0.4.4 · Mac + Windows 推送更新

- **起因**：Mac「hi」、Lenovo「群聊Projects」的群聊里组长和 AI 回复都是「示例：……」：新建项目对话框「主控项目」默认「本地示例」，建出的项目没有 `serverProject`，客户端按示例运行（`isExample`），任务从未发到 VPS2（主控数据库里没有这些任务）。
- **改动**：新建项目默认选中这台电脑空闲的主控工作区，「本地示例（不连主控，AI 不会真的工作）」放最后；工作区被占用时说明被哪个项目占用。示例项目群聊顶部加提示条和「连接到主控」（`connectProject` → `projects.js bindWorkspace` 更新 `orchestratorWorkspace`，保留文件夹，清除示例记录）。一个工作区仍只连一个项目：Bridge 的工作区根目录跟随当前项目（`activateProject`），多个项目共用会取错快照，本次不放开。
- **VPS2**：没有改动。
- **验证**：`npm test` 全部通过；新增源码测试；`node --check` 通过。**没有**在真机上看过界面，需主人更新后确认。
- **回滚**：VPS2 `withdrawn.json` 加入 `0.4.4`。

## 2026-11-24 11:20（北京时间）· VPS2 · 单聊按设备隔离 CLI 对话记录

- **起因**：Lenovo 的 Antigravity 单聊用 shell 读到了共用 CLI 目录 `homes/antigravity/.gemini/antigravity-cli/brain/` 里微信助手那段对话的记录（Mac 桌面测试文件），并当成自己的经历回答。三家单聊、群聊、微信助手共用 `homes/<provider>`，沙盒把整个目录可写放入，任何会话都能读其他所有会话。
- **改动**（`200e9ca`）：新增 `orchestrator/cli-history.js`；`chat-server.js` 在沙盒里把对话记录相关的目录/文件换成本实例自己的副本（`STATE_DIR/cli-history/<instance>/…`，一台设备一份；原生会话一会话一份），登录凭据仍共用。Antigravity：`brain`、`conversations`、`annotations`、`implicit`、`log`、`presence`、`scratch`、`cache`、`crashes` 和 `conversation_summaries.db`、`jetbox_summaries_proto.pb`、`history.jsonl`；Claude：`.claude/{projects,sessions,session-env,shell-snapshots,todos,file-history,plans,paste-cache,debug}`、`.cache/claude-cli-nodejs`；Grok：`.grok/{sessions,logs,memtrace}`。旧对话第一次续聊时只把这一个对话从共用目录复制过来；删除单聊时一并删除本实例里的 Antigravity 记录。
- **已知**：`jetbox_summaries_proto.pb` 由 agy 用改名覆盖写入，被挂载的文件拒绝改名（EBUSY），agy 只在本设备日志里报错，对话不受影响。
- **VPS2**：备份 `chat-server.js` 到 `/root/backups/agentdesk-deploy-cli-history-20261124-111648CST/`（含 `ROLLBACK.sh`）；`install -m 0644` 部署 `chat-server.js`、`cli-history.js`，逐字节核对一致。chat-server 每次单聊连接单独启动，**没有重启主控**；已连着的单聊要「重新连接」后生效。
- **验证**：`npm test` 586 项通过；VPS2 上用真实 agy 直接跑和经 `agent-chat.sh` 端到端各跑一次（临时设备 `isotest`）：新对话只写入设备目录，共用目录不变；shell 列 `brain` 只看到自己的 1 个对话（改前 70 多个）；续聊记得上一句；删除单聊后设备目录里的记录清空。测试数据已删除。
- **仍未隔离**：群聊步骤与微信助手之间仍共用 `homes/<provider>`（它们已读不到各设备单聊）；Codex 走另一套机制，未改。
- **回滚**：`sh /root/backups/agentdesk-deploy-cli-history-20261124-111648CST/ROLLBACK.sh`。

## 2026-11-24 10:45（北京时间）· 客户端 0.4.3 · Mac + Windows 推送更新

- **版本**：0.4.3（上一版 0.4.2）。本机文件夹不存在的项目可以直接删除：`project-deletion.js` 新增 `folderMissing`，文件夹不存在时按「保留文件夹」处理（跳过重叠、顶层目录、工作树等本机检查，不删任何本机文件），确认后再核对一次文件夹仍不存在，否则停止。确认框加一行「本机文件夹已不存在」。
- **起因**：Lenovo 上「群聊Projects」（`D:\agentdesk\群聊Projects`，已不存在）删除失败 4 次：「视频」项目绑定 `D:\agentdesk`，重叠检查只比路径，误判重叠。
- **Antigravity 新建会话失败排查**：客户端 `windows-native-chat/threads.json`、`leases.json` 均为空，VPS2 上该设备三家单聊线程表为空，删除墓碑只有已删项目 `c414483b…`；今天 VPS2 没有新建原生座位。结论：不是旧会话没清干净，与文件夹不存在有关，删掉或重新选择文件夹后复测。
- **VPS2**：没有改动。
- **验证**：`npm test` 全部通过；新增 2 项删除测试（父文件夹被其他项目绑定时可删、确认后文件夹重新出现则停止）。
- **回滚**：VPS2 `withdrawn.json` 加入 `0.4.3`。

## 2026-11-24 10:30（北京时间）· 客户端 0.4.2 · Mac + Windows 推送更新

- **版本**：0.4.2（上一版 0.4.1）。包含 11-23 已合入 main 的修复（本机文件夹不存在时提示并可重新选择；磁盘根下文件夹的项目可删除；删除失败记录原因类别），加上本次两项 Windows 反馈：
  - 项目「···」菜单 / 右键新增「更改本机文件夹…」（只改绑定，不移动文件；仅本机项目显示），复用 0.4.2 的 `relink`；
  - 「需要加只读权限」提示的 icacls 命令改成 PowerShell 写法 `${env:USERNAME}`，路径加引号（原来写的是 cmd 的 `%USERNAME%`，在 PowerShell 里照抄会出错）。
- **起因**：Lenovo（Windows）0.4.1 上项目文件夹 `D:\agentdesk\群聊Projects` 不存在，右侧显示 ENOENT + icacls 提示，删除项目 4 次失败（审计日志 `project_change remove failed`）。
- **VPS2**：没有改动。顺带把昨天 15:49 随主控重启停掉、没有自动起来的 `agentdesk-home-mount` 重新启动（只读挂载，读截图和 Lenovo 日志用）。
- **验证**：`npm test` 全部通过；新增测试覆盖 icacls 写法和菜单项。发布运行、VPS2 收包结果见本次汇报。
- **未验证**：Lenovo 上 Antigravity「新建会话失败：client_loop: send disconnect: Connection reset / native_bridge_disconnected」原因未查明（服务端日志无记录，时间上与文件夹不存在同时出现），待 0.4.2 重新选择文件夹后复测。
- **回滚**：在 VPS2 `withdrawn.json` 加入 `0.4.2`。

## 2026-11-24 02:40（北京时间）· VPS2 · 微信办公助手删除企业微信通道，只保留个人微信 ClawBot

- **改动**：删除企业微信智能机器人通道（`bot.js`、`wechat.env.example`、`@wecom/aibot-node-sdk` 依赖、对应测试；文件校验测试移到 `test/wechat-deliver.test.js`）；`service.js` 只用 ClawBot；unit 去掉 `EnvironmentFile`。文档改为只描述 ClawBot。
- **VPS2**：删除 `/etc/agentdesk-orchestrator/wechat.env`（企业微信 Bot ID / Secret）和 `wechat.json` 的旧备份；`wechat.json` 去掉 `channel` 和企业微信 userid；`/opt/agentdesk-orchestrator/wechat/` 重新部署（`node_modules` 只剩 `qrcode-terminal`）；重启 `agentdesk-wechat`，日志 `ilink connected`，白名单 1 人（扫码人）。企业微信后台的 AgentDesk 机器人需管理员自行删除或停用。
- **验证**：微信相关测试 39 项全部通过。
- **回滚**：git 回到 df4dd89 重新部署；企业微信机器人需在后台重新获取 Secret。

## 2026-11-24 02:30（北京时间）· VPS2 · 微信办公助手改为个人微信 ClawBot + 引导式流程，合并到 main

- **通道**：新增 `ilink.js`（个人微信 ClawBot，腾讯 iLink 协议，对齐官方插件 2.4.10）并设为默认；`login.js` 终端扫码登录，扫码人自动为管理员。企业微信智能机器人通道（`bot.js`）保留，`wechat.json` 的 `channel` 切换。用户已扫码，服务已连上。
- **流程**：引导式——需求/文件 → 回 1/2/3 选档（回错重提示）→ 收集 →「开始」组长出方案（附预计用时）→ 改方案可多轮 →「完成」执行交付；执行超出预计 1.5 倍提醒一次。命令统一为「/」紧跟数字或词：`/0` 帮助、`/1` 历史、`/2` 取消、`/3问题`、`/进12`、`/看12`、`/停12`、`/重试12`、`/重发12`。
- **VPS2**：替换 `/opt/agentdesk-orchestrator/wechat/*.js`，`npm ci` 增加 `qrcode-terminal`；unit 的 `EnvironmentFile` 改为可选；`wechat.json` 设 `channel: "ilink"`，保留临时 `tiers.planner = codex`（Claude 登录过期）。重启 `agentdesk-wechat`；主控未动。
- **验证**：`npm test` 590 项，583 通过，7 跳过，0 失败（微信相关 45 项，含假 iLink 服务的收发与 AES 往返）。
- **回滚**：`wechat.json` 改 `channel: "wecom"` 并重启，或按上一条整体回滚。

## 2026-11-24 01:40（北京时间）· VPS2 · 微信办公助手（企业微信智能机器人长连接）预部署

- **改动**：新增独立服务 `agentdesk-wechat`（分支 `feat/wechat-lite`，`orchestrator/wechat/`）。通道为企业微信智能机器人 API 模式长连接，官方 SDK `@wecom/aibot-node-sdk` 1.0.7；取代当天早些时候的自建应用 HTTP 回调方案（`wecom.js`、`probe.js` 已删除）。草稿 +「开始」、三档执行、额度闸门（剩余低于 8% 不开工）、白名单与限流、按 userid 隔离、docx/pptx/xlsx 校验后上传并主动推送给任务所有者、失败重试与 `/重发`。
- **VPS2**：
  - 办公工具链：apt 装 LibreOffice（writer/calc/impress）、pandoc、fonts-noto-cjk；`/opt/agentdesk-office/{venv,bin,GUIDE.md}`（`install-office.sh`）。
  - 代码：`/opt/agentdesk-orchestrator/wechat/`（含 `node_modules`，`npm ci --omit=dev --ignore-scripts`）。
  - 配置：`/etc/agentdesk-orchestrator/wechat.env`（Bot ID / Secret，root:agentdesk 0640，**尚未填写**）、`wechat.json`（`allowUsers` 为空）。
  - systemd：`/etc/systemd/system/agentdesk-wechat.service` 已安装，**未启用、未启动**。
  - Caddy：早些时候为 HTTP 回调加的 `/wecom/*` 路由已撤回，恢复原配置（备份 `Caddyfile.bak-20261123-161719-wecom`），重启 Caddy 两次，各断约 1 秒。
  - 主控 `agentdesk-orchestrator`、enrollment：未改动、未重启。
- **验证**：`npm test` 581 项，574 通过，7 跳过，0 失败（微信相关 36 项）。用假凭据启动服务：VPS2 能连上长连接，官方返回 853000 认证失败，日志与重连行为正确。真实 CLI 端到端：低档（组长临时换 Codex，因 Claude 登录过期）把 40 行销售明细做成带公式、柱状图、排名的 xlsx，约 8.6 分钟。
- **待办**：填写机器人凭据后启用服务并做手机端实测；Claude 在 `homes/claude` 的登录已过期（11-22），需管理员重新登录（主控群聊和单聊同样受影响）。
- **回滚**：`systemctl disable --now agentdesk-wechat`，删除 `/etc/systemd/system/agentdesk-wechat.service`、`/opt/agentdesk-orchestrator/wechat/`、`/etc/agentdesk-orchestrator/wechat.{env,json}`；工具链可保留或 `apt remove` 并删除 `/opt/agentdesk-office`。

## 2026-11-23 23:10（北京时间）· 客户端 0.4.1 · 更新下载先走 VPS1、失败退回 VPS2

- **改动**：Windows Bridge 处理 `client_update` / `client_update_read` 时先走 Relay（VPS1），Relay 不在线或读取出错时同一请求改走直连 SSH（VPS2），并在 1 分钟内跳过 Relay；线路状态每 5 秒查一次，不再每块都查；单块超时 10 秒改 30 秒；客户端并发读取 4 块改 8 块。
- **背景**：Lenovo 0.3.10 → 0.4.0 下载约 28–70 KB/s，Mac 29 秒完成；每块读取前多一次线路查询，往返翻倍。
- **测试目的**：Lenovo 已在 22:53 自动安装 0.4.0（`update_install installed`），这是第一次验证 Windows 自动检查、自动后台下载。0.4.0 → 0.4.1 仍按 0.4.0 的方式（直连）下载。
- **VPS2**：无改动（主控按 `relay:<名字>` 识别设备，原本就接受经 Relay 的更新读取）。
- **验证**：`npm test` 543 项，536 通过，7 项跳过，0 失败。

## 2026-11-23 22:45（北京时间）· VPS2 · 单聊沙箱偶发「bwrap: Can't bind mount /oldroot/」、Antigravity 全部模型

- **问题**：Antigravity / Claude / Grok 单聊偶发「本轮失败：bwrap: Can't bind mount /oldroot/ on /newroot/ … remount "/newroot/srv/claude-shared/.claude.json": No such file or directory」，6 小时内 17 次。`/srv/claude-shared/.claude.json` 是 `/root/.claude.json` 的单文件 bind；root 的 Claude Code 每次替换该文件后挂载指向已删除的文件，AppArmor 拒绝 bwrap 重新挂载它（"deleted entry"），整个沙箱起不来。
- **修复**：`sandbox.js` 不再整体 `--ro-bind / /`，改为逐个只读挂载根目录下的文件夹、重建 bin/lib 等符号链接，跳过 `/srv`（没有 CLI 需要），最后把新根设为只读。在 VPS2 上人为制造 `/srv` 下的失效单文件挂载复现：旧沙箱报同样错误，新沙箱正常，`/usr` 与根目录仍只读。
- **Antigravity**：单聊服务的 agy 登录换成能用 Gemini 4 的账号（旧凭据备份 `/root/backups/agy-chat-token.bak-20261123`）；`chat-server.js` / `model-catalog.js` 部署，单聊菜单列出 agy 全部 23 个模型（主控派活目录仍只用 Gemini）。
- **VPS2**：替换 `/opt/agentdesk-orchestrator/{sandbox.js,chat-server.js,model-catalog.js}`，旧文件备份在 `/root/backups/orchestrator-20261123-sandbox-agy/`。单聊服务按连接启动，新连接即用新代码；**主控（群聊）需重启 `agentdesk-orchestrator` 才用新沙箱，尚未重启**。
- **验证**：`npm test` 542 项，535 通过，7 项跳过，0 失败。
- **回滚**：把备份的三个文件拷回 `/opt/agentdesk-orchestrator/`。

## 2026-11-23 22:20（北京时间）· 客户端 0.4.0 · 更新日志、自动下载更新、刷新模型、额度离线显示

- **更新日志**：新增 `CHANGELOG.md`，每版一节；发版时取出这一节作为更新说明随包上传，「更新」对话框显示「X.Y.Z 更新内容」，更新后显示「本版更新内容」。没有这一节的版本，release.yml 在 meta 步骤就停止。
- **自动下载**：未签名的 Windows / Mac 构建也自动检查（启动 30 秒、每 24 小时、网络恢复、服务器通知）并后台下载；安装规则不变（Windows 点「重启并更新」，Mac 手动替换）。0.3.x → 0.4.0 仍需手动点一次下载。
- **刷新模型**：输入框模型选择旁新增刷新按钮，重新读取当前单聊的模型列表。
- **Antigravity 单聊模型**：`chat-server.js` 的 model/list 改为列出 agy 的全部模型（主控派活目录仍只用 Gemini）。**VPS2 尚未部署这两个文件**，待主人确认。
- **删除项目**：与其他项目共用远程目录时，只删属于本项目的会话，不再报「多个项目共用这个远程目录」。
- **额度离线**：主控连不上时额度窗口只显示「离线」（去掉示例数据）；快照来源的额度显示离线；Codex 断开时状态栏显示「用量 离线」。
- **VPS2**：无改动。
- **验证**：`npm test` 541 项，534 通过，7 项跳过，0 失败。未在真机上点验。

## 2026-11-23 21:10（北京时间）· VPS1 / VPS2 · 第二台 Windows（Lenovo）接入群聊主控

- **背景**：有两台 Windows。原来那台（工作区 `windows`）今天没连 VPS2；Lenovo（`lenovo_actjm6t3`）只登记了单聊钥匙，没有 Bridge，也就没有群聊主控。
- **VPS2**：新建空仓库 `repos/lenovo.git`；`config.json` 的 `sshBridges`、`quotaBridges` 加 `lenovo`，`workspaces` 加 `lenovo`，`relayBridges` 加 `lenovo`；新增 `relay-lenovo.token`；重启主控和 `agentdesk-home-mount`，`bridge-lenovo.sock`、`bridge-lenovo-mount.sock` 已建立。改前备份 `config.json.bak-20261123-lenovo`。
- **VPS1**：Relay 注册表新增 `lenovo-bridge` ↔ `vps2-orchestrator-lenovo`，主控一端已上线。
- **待办**：Lenovo 运行配置脚本生成 Bridge 钥匙，把公钥发回后，在 `/etc/ssh/agentdesk-authorized-keys` 加一行（限定 `ssh-gateway.js bridge-lenovo.sock bridge-lenovo-mount.sock`）。
- **回滚**：恢复 `config.json.bak-20261123-lenovo` 并重启两个服务；VPS1 删掉这两条配对。

## 2026-11-23 21:01（北京时间）· VPS1 / VPS2 · Windows 接入备用线路（Relay）主控

- **问题**：Windows 只有 SSH 主线路，Relay 上没有它的配对，VPS2 的 `relayBridges` 里也只有 mac，所以 Windows 没有备用线路的主控。另外发现 Mac Bridge 的 `relay.host` 还是 VPS1 的旧 IP，Mac 一端从未连上 Relay（要在 Mac 上改，见对话记录）。
- **VPS1**：Relay 注册表新增永久配对 `windows-bridge` ↔ `vps2-orchestrator-windows`（只写令牌摘要）。改前备份在 VPS1 `/root/relay-devices.json.bak-20261123-*`。
- **VPS2**：新增 `/etc/agentdesk-orchestrator/relay-windows.token`（root:agentdesk 0640），`config.json` 的 `relayBridges` 加 `windows`，重启主控。改前备份 `config.json.bak-20261123-win-relay`。Relay 日志确认 `vps2-orchestrator-windows` 已上线。
- **Windows**：待在本机运行配置脚本（写 Bridge 令牌、CA，并在 Bridge 配置加 `relay`），重启应用后 Relay 日志应出现 `connected device=windows-bridge`。
- **回滚**：VPS2 恢复 `config.json.bak-20261123-win-relay` 并重启主控；VPS1 从注册表删掉这两条（或恢复备份），服务 2 秒内自动生效。

## 2026-11-23 21:10（北京时间）· 客户端 0.3.10 · 0.3.9 重发、清理残留的原生单聊记录

- **0.3.9 未发出**：Windows 打包前的测试失败。新加的测试比较临时目录路径时没有统一 Windows 的 8.3 短路径（`RUNNER~1`）；功能代码无问题。测试改用 `realpathSync.native` 后以 0.3.10 重发，内容包含 0.3.9 的全部改动（见下条）。标签 v0.3.9 保留。
- **Mac 报错「载入历史失败：该单聊属于另一个已授权的本机项目」「删除失败：找不到本机项目目录」**：Mac 的 `native-chat/threads.json` 里有 16 条原生单聊记录，属于已不在配置里的旧项目（`~/Desktop`）。「ict」用的是共用的云端目录，所以这些旧 Codex 会话被列到了它下面；打开时记录指向别的项目，删除时又找不到那个项目。
- **修复**：配置正常载入后，启动时清掉所属项目已不存在的原生单聊记录和租约（配置读不出或为空时不清）；删除单聊或项目时，所属项目不存在的记录直接移除本机记录，不再报错。审计事件 `native_orphan_prune`。
- **VPS2**：无改动。
- **验证**：`npm test` 534 项，527 通过，7 项跳过，0 失败。

## 2026-11-23 21:00（北京时间）· 客户端 0.3.9 · 新建项目先建本机 Git 仓库、附件上传进度条

- **新建项目**：「新建项目」对话框里多了「本机文件夹」，可先点「选择…」；没选的话点「创建」时会弹出选择框，取消则不创建。所选文件夹按原有规则处理 Git：普通文件夹 `git init`，空文件夹另建 `.gitignore` 并做首个提交，已在仓库里的沿用父仓库。主控项目绑定照旧保留，群聊不受影响；绑定的文件夹只是工作目录，群聊和单聊读取其他位置文件的权限不变。
- **群聊里的单聊**：以前建的、还没登记的群聊项目，第一次开单聊时也先选本机文件夹并初始化 Git（以前只登记成云端项目，单聊因缺本机目录无法开始），主控绑定保留。
- **附件上传进度条**：Claude / Grok / Antigravity 单聊（含群聊里开的）的附件按服务器已收字节填充进度条；Codex 单聊附件一个文件一次请求，显示「第几个/共几个」和流动进度条。另外所有进行中的上传都显示在右下角浮动的上传面板里，面板放在最上层（有弹窗时放进弹窗里，和提示条同一规则），在群聊界面或打开弹窗时也看得到。群聊附件随消息发送，本次未改。
- **VPS2**：无改动。
- **验证**：`npm test` 532 项，525 通过，7 项跳过，0 失败。未在真机上点验。

## 2026-11-23 20:00 后（北京时间）· 客户端 0.3.8 · 删除时跳过未加载的会话

- **问题**：Mac 上删除项目「ai」报「删除项目没有完成：thread not loaded: 01a20661-…」。删除前会向 VPS2 的 Codex 查每个原生单聊的工作目录；这个会话在 Codex 那边未加载，回的是 `thread not loaded`，只有 `not found` 被当作可跳过，删除整体中止。
- **修复**：`thread not loaded` 与 `not found` 同样视为会话已不存在（项目删除的预览和远程步骤、单聊删除）。原生会话一侧另外放行「Codex 尚无可恢复的历史记录」。
- **VPS2**：主控代码无改动。同日把 autumnmoon.top / claude.autumnmoon.top 的 HTTPS 从宝塔 nginx 443 迁到 Caddy 8443，443 交还 AgentDesk 密码登录服务（见服务器备份 `/root/backups/site-443-to-8443-*`，内含 ROLLBACK.sh）。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败。

## 2026-11-23 20:50（北京时间）· 客户端 0.3.7 · 缩放快捷键

- **问题**：Windows 上 Ctrl+`-` 能缩小，Ctrl+`=` 不能放大。Electron 默认菜单的放大键是 Ctrl+Plus，在 Windows 键盘上需要 Shift。
- **修复**：主进程统一处理缩放键：Ctrl（macOS 为 ⌘）加 `=`/`+` 放大、`-` 缩小、`0` 恢复，主键盘和小键盘都可用，每次半档，限制在 -3～4 级。未在真实 Windows 上验证。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败。

## 2026-11-23 20:30（北京时间）· 客户端 0.3.6 · 推送更新下载提速与重试

- **问题**：Mac 0.3.2 → 0.3.4 推送下载很慢，14 秒和 44 秒后失败。安装包约 122 MB，按 128 KiB 一块经 SSH 控制通道逐块读取（约 930 次往返，经 VPS1 跳板），任一块超时整个下载失败、不重试。
- **修复**：本机下载源同时保持 4 块读取，按顺序输出；单块读取在线路类错误时重试，最多 5 次、间隔递增；明确拒绝（版本已不提供、文件已变化等）不重试。新增重试与拒绝的测试。只对已装 0.3.6 及以后的客户端生效；更早的版本需手动安装一次。
- **Windows**：Windows Bridge 当天没有连接 VPS2；`agentdesk-enrollment`（密码登录）自 11-18 起因 443 被宝塔 nginx 占用而无法启动，未处理，待主人决定。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，521 通过，7 项跳过，1 项失败为 VPS2 环境偶发（沙盒挂载时 `/srv/claude-shared/.claude.json` 正被定时服务替换），单独重跑通过。

## 2026-11-23 20:10（北京时间）· 客户端 0.3.5 · 群聊项目可以删除

- **问题**：群聊里建的项目（没有绑定本机目录，如 ICT、ict、is）不在「删除项目」范围内，右键和「···」都没有删除；只能逐个删群聊，且 VPS 上的群聊任务不会删除。
- **修复**：这类项目的项目行也有「···」和右键「删除项目…」。先向 VPS2 预览任务数量，原生确认窗口说明范围，确认后删除 VPS2 上该项目的群聊任务（日志、工作树、CLI 会话、项目分支），再清本机补丁、群聊、派遣记录和单聊会话。`project_delete` 由主进程发出时保留该项目自己的工作区，不再被当前项目的工作区覆盖。
- **发布**：0.3.4 已推送（Mac、Windows），本版用于第二次推送更新测试。0.3.3 上传时 GitHub 到 VPS2 连接超时未上传，已由 0.3.4 取代。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败。

## 2026-11-23 19:30（北京时间）· 客户端 0.3.4 · 桌面无访问权限时也能删除项目

- **问题**：Mac 0.3.2 上删除项目「ai」（绑定 `~/Desktop`）两次失败，均未连接 VPS2。AgentDesk 没有 macOS「桌面文件夹」访问权限，0.3.2 新增的「桌面 `.git` 是否为空仓库」检查读取桌面时被拒绝，直接报错。
- **修复**：个人文件夹无法读取时视为保留：不碰文件夹和 `.git`，只解除绑定并清理 AgentDesk 数据和 VPS 工作区。新增测试以无权读取的目录验证（root 环境跳过，CI 执行）。
- **VPS2**：无改动。
- **验证**：`npm test` 529 项，522 通过，7 项跳过，0 失败；以非 root 用户单独运行删除测试 12 项全部通过。

## 2026-11-23 19:00（北京时间）· 客户端 0.3.3 · 推送更新测试版

- **用途**：验证 Mac 从 0.3.2 经 VPS2 推送更新到 0.3.3。0.2.9 → 0.3.2 的推送下载在 Mac 上 0.1 秒内失败，VPS2 未收到读取请求；审计日志过滤了 `error` 字段，原因未知，主人随后手动安装了 0.3.2。
- **改动**：
  - 审计日志保留 `error`（错误类别）、`version`、`agent`；下载失败另记错误码，下次失败可直接定位。
  - 侧栏项目行悬停显示「···」，点开即「删除项目…」，不再只靠右键；菜单里的删除项与其他项用分隔线隔开。
  - 提示条加层级，弹窗打开时显示在弹窗内，不再被挡住（例如附件超过 25 MB 的失败提示）；长提示停留时间按长度延长，最多 6 秒。
- **VPS2**：无改动。
- **验证**：`npm test` 528 项，522 通过，6 项环境跳过，0 失败。

## 2026-11-23 16:30（北京时间）· 客户端 0.3.2 · 修复项目和单聊删除

- **事故**：03:14（UTC）Mac 上删除项目「ai」时，VPS 步骤把共用的 Codex 工作目录 `/var/lib/agentdesk-orchestrator/desktop-workspace` 整个删除（项目没有单独的远程目录，代码回落到共用目录）。`codex-desktop.sh` 以 `set -eu` 进入该目录，所以之后 Codex 无法启动。本机步骤要删除整个 `~/Desktop`，被 macOS 权限拦下，桌面文件未受影响；之后每次重试都卡在同一处。已在 VPS2 以 agentdesk 属主重建该空目录。
- **修复**：
  - 项目绑定的是个人文件夹（家目录下的直接子目录，或桌面、文稿、下载等）时，只解除绑定，文件全部保留；只删除没有任何提交的空 `.git`。
  - VPS 共用工作区不再整体删除；没有其他项目在用时清空其内容，目录本身保留。只有项目单独绑定的远程目录才整个删除。旧的半途删除计划里记录的共用目录会被忽略，重试可以继续完成。
  - 单聊右键新增「删除…」：原生确认窗口说明范围，先删 VPS 上的会话记录和 CLI 会话文件，再删本机的撤销存档、命令记录和独立工作树。
  - 删除失败改为弹窗显示原因，并写入审计日志。
- **发版**：`v0.3.0` 标签的 Mac 打包失败（未配签名时 `CSC_LINK` 为空字符串，electron-builder 当成路径报 `not a file`），未上传。`release.yml` 改为签名变量为空时先清除，改发 0.3.1。`v0.3.1` 两个平台打包成功，上传失败：GitHub secret `VPS2_UPDATE_PORT` 末尾带换行，ssh 报 `Bad port`。上传步骤改为去掉端口和目标的首尾空白，改发 0.3.2。
- **VPS2**：主控代码无变化，未重启。
- **验证**：`npm test` 528 项，522 通过，6 项环境跳过，0 失败；新增个人文件夹保留与空 `.git` 删除的测试。

## 2026-11-23 16:03 · GitHub 主线 d62b2f6 · Mac 新版部署

- 从 GitHub 获取并快进到主线 `d62b2f6`，包含项目清理、原生会话重连恢复、Mac 手动安装更新及连接重试修复。上一轮 Windows CI 的 SQLite 清理顺序问题已由本次主线修正。
- 重新构建并安装 Apple Silicon 应用，安装与构建的 app.asar 哈希一致。VPS2 与 Mac Bridge 的全部 JS 文件均与主线源码一致，VPS 日更脚本及两个 systemd 单元的哈希也一致，服务 active，原定时器 enabled。
- 按新版部署说明安装本机 `local.agentdesk.cli-update` 任务，每小时检查一次，美东每日 12:00 后更新，首次检查退出码为 0。本次没有强制立即更新四个模型 CLI。
- 本地 526 项测试中 520 通过、6 项环境跳过、0 失败。主线 CI 的 Ubuntu、Windows、macOS 和 Relay 测试全部通过。打包版 zsh/bash 交互、重连及删除项目后的终端和租约清理检查通过。
- 旧应用保存在用户 Applications 下的本次替换备份目录，可用原 `6192109` 构建回退；本机更新任务可用 `node scripts/local-cli-update.js --uninstall` 移除。

## 2026-11-23 11:02（北京时间）· 项目删除联动清理

- 删除项目改为检查两端数据范围、显示原生确认窗口，再清理本机目录和 `.git`、关联工作树、会话、附件、命令与终端、撤销存档，以及 VPS 的任务、日志、上传与 CLI 会话数据。GitHub 仓库按用户选择保留。共享 Git 缓存清理本项目的工作树与分支，独占的托管副本整库删除。
- 清理计划先持久化，任一步失败保留项目入口并支持重试。设备和服务端保留删除标记，防止旧会话与群聊缓存重新出现。远程目录共享、授权目录变化、单聊仍在执行及未确认的本机写入会显示具体错误。删除确认窗口列明实际目录和记录数量。
- VPS2 在维护模式排空后更新相关运行文件，服务重启并确认控制 socket 就绪后退出维护。最终增量更新的回退文件在 `/root/backups/agentdesk-project-delete-20261123-030146`，此前整批更新备份在 `/root/backups/agentdesk-project-delete-20261123-024527`。配置、登录凭据与 systemd 单元沿用既有设置。
- Mac 后台 Bridge 同步完整 JS 运行文件，Apple Silicon 应用重新打包安装，安装与测试构建的 app.asar 哈希一致。核对旧 Worker 没有子进程与未结束命令后退休，后续由新版按需启动。
- 自动测试共 519 项，513 通过、6 项环境跳过、0 失败。新测试覆盖真实 Git 和关联工作树清理、共享项目隔离、取消、失败重试、分页、会话索引和模型记录清理，以及真实 Bridge 控制通道的两端删除流程。
- 打包版验证 zsh/bash 输出、接管、中断、调整大小、重连和项目删除后的终端及租约清理。真实窗口使用独立配置和临时项目核对两端删除范围，取消后文件、`.git` 和注册记录均存在。现网 Bridge 的预览接口通过。Codex 的真实 CLI 在全新临时配置中完成初始化、列表查询和不存在会话的删除，未调用模型。
- 本次实际删除仅针对测试数据。Windows 安装由对应设备后续更新应用，跨平台逻辑由 CI 验证。

## 2026-11-23 10:00（北京时间）· Mac 新版合并、部署与实测

- 合入主线 `ba56ac9`，合并提交 `8320835`。解决 `main.js` 的更新状态检查冲突，保留此前 Grok 直连回复修复和右侧浅色终端。
- VPS2 运行目录的 80 个 `orchestrator/*.js` 与本次源码逐字节对应，服务 active、NRestarts=0，维护关闭且无运行中任务。本次更新部署 Mac 后台 Bridge 和 Apple Silicon 应用，Bridge 为 running，安装包与测试构建的 app.asar 哈希一致。
- 自动测试共 505 项，499 通过、6 项环境跳过、0 失败。打包版真实 zsh/bash 输出、AI 输入、人工接管、Ctrl+C、调整大小和重连恢复通过。
- 打包版真实界面完成 Grok 问答卡渲染、未回答提交阻止、选择提交及模型继续回复，Codex 的只读规划提问也完成同样往返。完全访问开关与下拉同步，右侧终端为浅色，更新弹窗经 Mac Bridge 查询成功，无页面异常。
- 真实群聊控制通道提交 Codex 只读对话并收到预期回复，任务 completed。该检查覆盖成员对话调度，不包含多成员改文件、补丁应用及验收全流程。
- 首次界面测试在项目初始化完成前选会话，实际落在 Codex，工具请求未成功。纠正测试等待条件并校验实际成员后，两家提问往返通过。
- 修正打包界面自测的配置隔离，启动和失败诊断均显式指定临时 user-data-dir，避免 macOS 忽略 HOME 而写入用户配置。清理本次生成的 CI 测试项目并恢复原项目选择。
- Claude 登录验证按用户要求延后。本次没有重测 Antigravity 真实对话。生产更新存储暂无版本，下载、差分更新和安装流程本次仅由自动测试覆盖。
- 回退可从原 `bf276db` 重新构建。替换应用时保留旧应用备份及设备配置、聊天数据。

## 2026-11-23 09:20（北京时间）· VPS2 · 客户端更新服务上线（main `837e328`）

- **源码**：`main` 上的 `837e328`（单聊问答卡合并，包含 `feat/safe-differential-updates-20261122` 的客户端更新服务端）。部署前的运行树是 06:22 那次部署的结果：`a4f24cc` 的服务端文件，已经有 `client-updates.js`、`client-update-intake.js`、`update-manifest.js`、`worker-idle.js` 以及 `client_update`、`client_update_read`、`open_tasks`，但没有存储、上传账户和强制命令。那次部署没有写进本日志；部署前核对过，运行树与它的 `runtime-after.sha256` 完全一致。
- **代码**：
  - 进维护模式，确认 `running=[]`、`queued=0`、`ready=true`，并且没有 CLI 子进程；
  - 用 `install -m 0644` 替换 5 个文件：`ask-user.js`（新增）、`chat-mcp.js`、`chat-server.js`、`windows-native-desktop.js`、`windows-native-seat.js`；逐个 `node --check`，装完 `cmp` 一致，以 agentdesk 用户试加载；
  - 09:21:04 重启 `agentdesk-orchestrator`，09:21:21 退出维护。

  现在主控用到的全部文件与 `837e328` 的 `orchestrator/` 一致。**没有运行 `install-ubuntu.sh`**，也没有改 systemd 单元、drop-in、`config.json`、nginx 或防火墙。
- **发布通道**（布局见 [AUTO-UPDATE.md](AUTO-UPDATE.md) §6）：
  - 存储 `/var/lib/agentdesk-client-updates`，加上状态目录里的符号链接 `client-updates`；
  - 系统用户 `agentdesk-update`；
  - `sshd_config.d/56-agentdesk-update.conf`（只追加 AllowUsers 和这个用户的限制）；
  - `/etc/ssh/agentdesk-update-authorized-keys`（`restrict` + 强制命令）；
  - CI 钥匙放在 root 专用目录。

  `sshd -t` 通过；`sshd -T` 显示除 AllowUsers 多了一项外，全局设置与部署前逐项一致。**sshd 还没有 reload**（本次会话的权限设置不允许执行），所以上传账户还没生效，需要主人执行 `systemctl reload ssh`。
- **验证**：
  - `npm test`（`node --test`）：505 项，499 通过，0 失败，6 跳过；
  - 部署后服务 active，NRestarts=0，没有 warning 及以上的日志，监听端口与部署前一致；
  - `doctor`：codex、claude、grok、antigravity 均 ok，`anyLead=true`，`blocked={}`；
  - 任务状态计数与部署前一致。
- **验收**（隔离目录 `/var/tmp/adcu-accept-20261123`，测试版本 0.9.x，生产存储里没有任何版本）：
  - 接收：真实强制命令程序以 `agentdesk-update` 运行，拒绝 14 种非法上传，不留残留；`receive()`（GitHub 复核用替身）通过 14 项，包括版本只增不改、并发锁，以及上传账户改不了撤回和灰度文件；真实 GitHub API 复核拒绝了「标签与提交不符」「run 不是这个标签触发的」「标签不存在」三种情况；
  - 分发：以 agentdesk 运行，配合客户端真实的回环适配器，25 项全部通过，包括 25 MB 安装包按 128 KiB 分块下载且 sha512 一致、Range 差分拼装、撤回、按设备灰度和暂停、文件被改动后拒绝提供；
  - 现网：经运行中主控的 admin socket，9 项全部通过；
  - 旧客户端兼容：claude、grok、antigravity 三家单聊服务，12 项全部通过。
- **顺带修复**（客户端，下个正式版本生效）：`update-transport.js` 在下载时每次等待背压都会加一个 `close` 监听且不移除，大文件会触发 `MaxListenersExceededWarning`。已修复并加回归测试。
- **没有验证**：
  - 经真实 SSH 的上传（要等 reload）；
  - GitHub Actions 到 VPS2 的实际上传（要等 secret 和第一个正式标签）；
  - GitHub runner 能否连到 VPS2 的 22 端口（本次会话无权读取防火墙规则）；
  - 真实 electron-updater 的 blockmap 差分；
  - 真实电脑上的下载和安装；
  - Mac Bridge 白名单。
- **回滚**：VPS2 上 `/root/backups/agentdesk-clientupdate-deploy-20261123-092044CST/rollback.sh code|channel|all`。`code` 恢复 5 个文件并重启，`channel` 拆除上传通道。

## 2026-11-22 · Mac 本机 · 合并新版并部署验收

- **源码**：主线 `bd24c0e` 合入 `codex/terminal-workspace-panel`，运行代码提交 `5daced7`；保留右侧“检查工作区 → 终端”及跟随主题的浅色配色。
- **部署**：重新构建 Apple Silicon 的 0.2.9 应用，替换本机用户 Applications 中的 AgentDesk；同步后台 Bridge 的 `orchestrator/*.js`，重启后状态为 running。保留连接配置、项目与聊天数据。按用户此前要求删除替换下来的旧应用副本。
- **验证**：
  - Node 测试共 436 项：430 通过、6 项条件跳过、0 失败。
  - 打包应用真实 zsh/bash：输出、AI 写入、接管、Ctrl+C、调整大小、重连恢复均通过。
  - 隔离测试配置下的打包窗口：xterm 渲染、添加附件成功提示、群聊项目登记后添加附件、未处理失败提示均通过。该检查调用窗口及主进程接口，不调用模型。
  - 包内 153 个源码文件与工作树逐字节一致；已安装应用与构建产物的 app.asar 哈希一致；后台 Bridge 的全部 JS 文件匹配源码。
  - 已安装应用实际窗口确认 Codex SSH 已连接，右侧浅色终端页签正常。
- **VPS2**：只读检查，未修改或重启。主控及 home-mount 为 active；chat-server、permission-prompt、windows-native-seat 与本次源码哈希相同；部署前无 running/applying/testing 任务。
- **未覆盖**：四家真实模型问权限、子代理、群聊端到端任务及真实 git push 验收；单聊 v2 未在本次启用。
- **回退**：可从此前 `db3c273` 构建上一版本；安装时保留现有设备配置和聊天数据。

## 2026-11-22 18:00 后（北京时间）· 客户端 · 添加附件的成功提示

- **问题**：「添加附件成功的提示在本机部署上没看到」。在 Claude/Grok/Antigravity 单聊、原生（provider-direct）单聊、群聊里，选择、拖入、粘贴附件成功后都没有任何提示，只有出错和打包文件夹时才有。在 v1 服务端上（没有上传回执，directChatV2 未开）就完全看不到反馈。
- **修复**（只改客户端：`src/attach-notice.js` 新增，并修改 `live.js`、`provider-direct.js`、`orchestrator.js`、`index.html`）：
  - 添加成功就提示，例如“已添加 N 个附件（先存在本机，发送消息时一起上传）”；群聊是“发送任务时一起交给组长和成员”；服务端确认会立即上传时（v2）提示“正在上传”；
  - 服务端回执到达时提示“附件已上传，服务器已校验”；
  - 消息或任务发送成功后提示“N 个附件已随消息发送 / 随任务提交”。
- **VPS2**：没有改动，也没有重新部署（服务端不需要变化）。
- **验证**：单元测试，加上打包后应用窗口里的检查（CI 的 Terminal packaging check）。主人本机装上新的安装包后才能看到。

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
- **主人决定**（原文「1按最新的来，2没有其他解决办法算了，3vps和软件部署好，本机我来」）：Mac 群聊命令只挡 AgentDesk 密钥目录；Antigravity 子代理跳过；VPS2 和安装包到此部署好，本机安装和验收由主人做。
- **没有验证**：ROLLOUT §6 的每台电脑验收（四家单聊问权限、`git push`、`ls ~/.agentdesk` 被拒、子代理、Mac 群聊 `git push`）要在用户的 Mac/Windows 上、装上新客户端后进行，本次没有做。原生单聊里已经打开的会话要关掉重开，才会用新权限。
- **回滚**：VPS2 上 `/root/backups/agentdesk-deploy-rollout-20261122-174040CST/ROLLBACK.md`（恢复运行树 tgz，然后重启）。
