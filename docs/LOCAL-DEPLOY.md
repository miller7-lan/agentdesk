# 本地如何部署（VPS2 服务端 / Mac / Windows）

本文说明怎样把仓库 `main` 上的 AgentDesk（含群聊 v7）部署到三端，以及每一步怎样确认、怎样回滚。通用的改代码与发版流程见 [DEPLOY.md](DEPLOY.md)；群聊 v7 的开关和行为见 [GROUP-V2.md](GROUP-V2.md)、[GROUP-MAC.md](GROUP-MAC.md)、[GROUP-WINDOWS.md](GROUP-WINDOWS.md)。

## 0. 现状（2026-11-22 写本文时，以实际核对为准）

| 端 | 状态 |
|---|---|
| VPS2 主控 | 2026-11-22 17:40 起运行 `main` 上 `531b33f` 的服务端代码（权限统一、Antigravity `execute_url`、群聊 v7），见 [DEPLOY-LOG.md](DEPLOY-LOG.md)。`groupFeatures` 中 14 个开关都已打开 |
| Mac 应用和 Mac 后台 Bridge | **没有更新**，仍是用户原来安装的版本 |
| Windows 应用（Bridge 在应用里） | **没有更新**，仍是用户原来安装的版本 |
| 单聊 directChatV2 | 没有对任何设备打开（VPS2 上没有 `/etc/agentdesk-orchestrator/devices.json`） |

因此，在 Mac/Windows 更新之前：
- 群聊 v7 中**只依赖 VPS2 的能力已经生效**：读取并行与单写令牌、组长链写建议、读取阶段读本机原项目、写代码步骤写项目以外的位置（仅限 v7 之前就能写的范围）。
- **需要新版 Bridge 的能力都不可用**：任意命令、本机副本、Mac sandbox、环境修复、写前备份。工具会返回 `bridge_update_required`，群聊照常继续。
- 新界面（环境修复记录、撤销/还原按钮、平台标注）只在新客户端里出现。

按主人决定（2026-11-22，「vps和软件部署好，本机我来」），VPS2 和安装包由部署方负责，第 2、3 节的本机安装和验收**由主人自己做**。下面第 2、3 节就是让这些能力在你的电脑上生效的步骤。这些步骤**还没有在你的 Mac/Windows 上执行或验证过**；目前只有 GitHub CI 的 macOS/Windows 运行器跑过自动测试。

## 1. 部署顺序

**先 VPS2，再 Mac Bridge，再 Mac 应用 / Windows 应用。** 新客户端调用旧主控不认识的操作会报 `unsupported_operation`；旧客户端调用新主控没有问题（新主控会按旧版 Bridge 安全降级）。每一端都先备份、再替换、再验证。

## 2. Mac

Mac 有两个独立部分：**后台 Bridge**（launchd 运行源码目录里的 `orchestrator/mac-bridge.js`）和 **AgentDesk 应用**。群聊 v7 的本机能力在 Bridge 里，界面在应用里，两者都要更新。

### 2.1 准备

- 确认 VPS2 已经是 `main` 的版本（第 4 节的检查）。
- 记下当前版本，回滚时要用：

```sh
cd "$HOME/AgentDesk-src"          # 后台 Bridge 使用的源码目录，以你的 plist 为准
git rev-parse HEAD > "$HOME/.agentdesk/bridge-previous-commit.txt"
launchctl list | grep -i agentdesk   # 找到 Bridge 的 launchd 标签，下文以 local.agentdesk.bridge 为例
```

- 备份应用：先退出 AgentDesk（菜单栏里也要退出），再执行：

```sh
backup="$HOME/AgentDesk-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup" && cp -R /Applications/AgentDesk.app "$backup/"
cp "$HOME/.agentdesk/mac-bridge.json" "$backup/"
```

### 2.2 更新后台 Bridge

```sh
cd "$HOME/AgentDesk-src"
git fetch origin
git switch main && git pull --ff-only   # 源码目录原来是 detached 检出时，改用 git switch --detach origin/main
npm ci
node --test test/group-v7.test.js test/group-v7b.test.js   # 可选：本机先跑一遍群聊 v7 测试
launchctl kickstart -k "gui/$(id -u)/local.agentdesk.bridge"
launchctl print "gui/$(id -u)/local.agentdesk.bridge" | grep -E 'state|last exit'   # 应为 state = running
```

`~/.agentdesk/mac-bridge.json` 不需要改。可选项：
- 顶层或工作区里写 `"groupShell": false`，可以在这台电脑上关闭“任意命令”。
- 顶层 `"groupCopies": "<目录>"` 可以改本机副本的位置。缺省为 `~/Library/Caches/AgentDesk/group-copies`。**不要**设在 `~/.agentdesk` 或 `~/Library/Application Support/AgentDesk` 下面，那两个目录会被 sandbox 对所有命令关闭，副本里的命令就会被拒绝。
- 写项目以外的位置，仍然需要 Bridge 配置里的 `readAnyFolder` 和 `writeAnyFolder` 都为 `true`。

### 2.3 更新应用

Apple Silicon（Intel 机器把 `--arm64` 换成 `--x64`）：

```sh
cd "$HOME/AgentDesk-src"
npm run dist:mac -- --arm64 --publish never
# 产物：dist/mac-arm64/AgentDesk.app
```

用产物替换 `/Applications/AgentDesk.app` 后打开。也可以在 GitHub Actions 手动运行 **Build release artifacts**，选 `main` 的同一提交，下载 `agentdesk-mac`。签名与公证见 [SIGNING.md](SIGNING.md)。`~/.agentdesk` 和 `~/Library/Application Support/AgentDesk` 中已有的数据和配置沿用，不要删除。

### 2.4 验证（Mac）

1. 应用里「主控线路」显示在线。
2. 在 VPS2 上确认 VPS2 能看到新版 Bridge（第 4.3 节），回复里应有 `"groupLocal":1` 和 `"platform":"mac"`。
3. 在测试项目里发一个群聊小任务，例如“审查 README 并在本机运行 git status”。审查步骤应能用 `local_shell_run` 在原项目里运行命令；群聊里会出现一行 Mac sandbox 说明。
4. M2 检查（权限统一后）：让审查步骤运行 `ls ~/.agentdesk`，应该被拒绝（sandbox，Operation not permitted）；`git status` 和 `git push` 测试分支应该正常。
5. O3 检查：让写代码的步骤在本机副本里运行命令。命令应在 `~/Library/Caches/AgentDesk/group-copies/<任务>/` 里执行；试图写原项目应该被拒绝。
6. 任务结束后，对应的副本目录会被删除。

### 2.5 回滚（Mac）

```sh
launchctl bootout "gui/$(id -u)/local.agentdesk.bridge" 2>/dev/null || true
cd "$HOME/AgentDesk-src" && git switch --detach "$(cat "$HOME/.agentdesk/bridge-previous-commit.txt")" && npm ci
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.agentdesk.bridge.plist"
```

应用：退出 AgentDesk，把备份目录里的 `AgentDesk.app` 放回 `/Applications`。

另外，可以在 VPS2 上逐项关闭开关（第 4.4 节），不用动 Mac。

## 3. Windows

Windows 的 Bridge 运行在 AgentDesk 应用进程里，所以**重新安装应用**就同时更新了 Bridge。

### 3.1 准备

- 确认 VPS2 已经是 `main` 的版本。
- 保留当前正在用的安装包，回滚时用它覆盖安装。
- 备份 `%USERPROFILE%\.agentdesk\` 下的 `remote.json` 和 Bridge 配置。
- 关闭旧版应用前，确认本机没有仍在运行的后台命令（见 [WINDOWS-NATIVE-CHAT-DEPLOY.md](WINDOWS-NATIVE-CHAT-DEPLOY.md)）。

### 3.2 构建或下载安装包

- **GitHub Actions**：手动运行 **Build release artifacts**，选 `main` 的同一提交，下载 `agentdesk-windows` 里的 `AgentDesk-<版本>-setup.exe`。
- **在 Windows 上自己构建**（需要 Node.js 24、Git）：

```powershell
git clone https://github.com/miller7-lan/agentdesk.git
cd agentdesk
git switch main
npm ci
npm test
npm run dist      # 产物在 dist\：便携版和 NSIS 安装版
```

### 3.3 安装

退出 AgentDesk（托盘里也要退出），运行新的安装包覆盖安装，然后打开应用。项目、Bridge 配置和授权都沿用原来的。

### 3.4 验证（Windows）

1. 应用里「主控线路」显示在线。
2. 在 VPS2 上做第 4.3 节的检查，回复里应有 `"groupLocal":1` 和 `"platform":"windows"`。
3. 群聊小任务：审查步骤能用 `local_shell_run`（默认 PowerShell）在原项目里运行命令；群聊里会出现一行 Windows 说明：**没有强制保护凭据目录，副本没有强制隔离（只做改动检测）**。这是已定的决定（M2、O3），不是故障。
4. 写代码的步骤在本机副本（Bridge 状态目录下的 `group-copies`）里运行命令。如果命令改动了原项目，群聊会显示“原项目有改动”的提示。

### 3.5 回滚（Windows）

退出应用，用保留的旧安装包覆盖安装，恢复备份的 `remote.json` 和 Bridge 配置。也可以只在 VPS2 上关闭对应开关。

### 单聊终端的现状

单聊的交互终端（node-pty + xterm.js）由 GitHub Actions 的 **Terminal packaging check** 在真实的 macOS arm64 和 Windows x64 运行器上检查：
- 用真实 node-pty 跑测试；
- 不签名打包；
- 在打包后的应用里，通过 Worker 驱动真实的 zsh/bash 或 PowerShell/CMD，覆盖输出、AI 写入、接管、Ctrl+C、调整大小、应用重连后找回终端；
- 在应用窗口里渲染 xterm。

自提交 `12f7e16` 起，两个平台全部通过，例如 run [44993538368](https://github.com/miller7-lan/agentdesk/actions/runs/44993538368)。该次运行留下的未签名包（`agentdesk-terminal-mac`、`agentdesk-terminal-windows`）只用于检查，不要当作正式安装包。

之前失败的原因和修复：
- **macOS，打包后的检查**：检查脚本本身有语法错误，没测任何东西就退出了（`906431a` 修复）。
- **macOS，bash 中 Ctrl+C 不能停下整行命令**：macOS 自带 bash 3.2，在继承了外层 `SHLVL` 时只停当前命令。现在终端像新开的终端窗口一样，不带 `SHLVL` 启动（`aa30c52`）。
- **Windows，Ctrl+C 之后“没有响应”**：Ctrl+C 其实生效了，但控制台会丢掉 Ctrl+C 被处理之前已经输入的内容。人在新提示符出现后再输入就没有问题；检查也改为这样做（`aa30c52`）。
- **Windows，应用重连后找不回终端**（`native_chat_lease_denied`）：租约按真实路径保存，查找时却按原样比较；遇到 8.3 短路径或链接就找不到。已修复（`e6a3f6b`），这是用户也会遇到的问题。
- **Windows，窗口检查无法启动应用**：检查给应用指定的 `APPDATA` 目录不存在。现在会先创建（`12f7e16`）；如果仍然启动失败，会报告应用的退出情况。

这些都是 **CI 运行器上的验证，不是用户真机验收**。在你的电脑上要等新客户端安装后，按第 2.4 / 3.4 节确认终端能打开、能输入、Ctrl+C 能停下长命令、关掉窗口再打开能找回终端。

## 4. 服务端（VPS2）

需要能 `sudo` 的管理员登录。下面是 2026-11-22 三次部署实际使用的受控做法：只替换 `orchestrator/*.js`，不碰 systemd 单元。现网的 `agentdesk-home-mount.service` 有 drop-in（`10-mount-propagation.conf`），所以**不要**运行会覆盖单元的 `install-ubuntu.sh`，也不需要 `daemon-reload`。

### 4.1 更新

```sh
cd <VPS2 上的源码工作目录> && git fetch origin && git switch main && git pull --ff-only
APP=/opt/agentdesk-orchestrator
AD="sudo -u agentdesk $APP/node $APP/admin.js /var/lib/agentdesk-orchestrator/admin.sock"   # 在 /tmp 下运行
B=/root/backups/agentdesk-deploy-$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)CST
sudo install -d -m 700 "$B"
sudo tar --numeric-owner -C /opt -cpzf "$B/runtime.tgz" agentdesk-orchestrator
sudo tar --numeric-owner -C /etc -cpzf "$B/etc.tgz" agentdesk-orchestrator
for u in agentdesk-orchestrator.service agentdesk-home-mount.service; do
  cmp -s orchestrator/$u /etc/systemd/system/$u && echo "unit same $u" || echo "unit DIFFERS $u (do not overwrite)"
done
(cd /tmp && $AD ls)                                   # 看有没有正在跑的任务
(cd /tmp && $AD maintenance on "deploy main")         # 排空
(cd /tmp && $AD maintenance)                          # 等到 ready=true、running 为空
for f in orchestrator/*.js; do
  cmp -s "$f" "$APP/$(basename "$f")" || sudo install -m 0644 -o root -g root "$f" "$APP/$(basename "$f")"
done
for f in orchestrator/*.js; do cmp -s "$f" "$APP/$(basename "$f")" || echo "MISMATCH $f"; done   # 应无输出
sudo systemctl restart agentdesk-orchestrator         # agentdesk-home-mount 因 PartOf 随之重启
(cd /tmp && $AD maintenance off)
```

维护状态会持久化，**重启后不会自动解除**；忘记执行 `maintenance off`，新任务会一直排队。

### 4.2 配置：群聊开关

`/etc/agentdesk-orchestrator/config.json`（agentdesk:agentdesk 0600）顶层的 `groupFeatures`。没写的开关视为关闭；写错键名，服务会拒绝启动并报 `invalid_group_features:<名称>`。当前现网 14 项都是 `true`：

```json
"groupFeatures": {
  "timeline": true, "snapshotNotice": true, "planFailureAdvice": true, "anyLead": true, "leadChainQuota": true,
  "patchDownload": true, "applyPause": true, "stageGroups": true, "localStages": true, "writeAnywhere": true,
  "localCopy": true, "credentialSandbox": true, "envFix": true, "leadAdvice": true
}
```

改配置前先 `sudo cp -a config.json config.json.bak-<时间>`。改完用生产 Node 以 agentdesk 用户校验，再重启：

```sh
cd /tmp && sudo -u agentdesk /opt/agentdesk-orchestrator/node -e "const c=JSON.parse(require('fs').readFileSync('/etc/agentdesk-orchestrator/config.json','utf8')); require('/opt/agentdesk-orchestrator/group-features.js').groupFeatures(c.groupFeatures); console.log('valid')"
sudo systemctl restart agentdesk-orchestrator
```

### 4.3 验证

```sh
systemctl is-active agentdesk-orchestrator agentdesk-home-mount        # 都是 active
journalctl -u agentdesk-orchestrator --since "-10min" -p warning --no-pager   # 应无条目
cd /tmp && $AD doctor                                                 # ok:true；anyLead:true 时 lead 为 null
```

确认某台电脑的 Bridge 是否支持群聊 v7（Bridge 在线时）。`mac` 和 `windows` 是 VPS2 上的 Bridge 名称，`workspace` 是该 Bridge 配置里的工作区键：

```sh
cd /tmp && sudo -u agentdesk env AGENTDESK_BRIDGE=mac /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/admin.js \
  /var/lib/agentdesk-orchestrator/admin.sock bridge "$(cat /proc/sys/kernel/random/uuid)" command.execute '{"operation":"group_capabilities","workspace":"mac"}'
```

- 新版 Bridge 回复 `{"groupLocal":1,"platform":"mac",...,"backups":true}`。
- 旧版 Bridge 回复错误（如 `command_not_authorized`）。这时 VPS2 会按旧版处理，新能力返回 `bridge_update_required`。
- 离线时回复 `ssh:mac_unavailable` 之类的错误。

### 4.4 回滚

- **只关某一项**：把 `groupFeatures.<名称>` 改为 `false`，然后重启服务。已有的环境修复记录和项目外文件备份仍能撤销或还原。
- **整体回滚**：
  1. 进维护模式；
  2. `sudo mv /opt/agentdesk-orchestrator /opt/agentdesk-orchestrator.failed-$(date +%s)`；
  3. `sudo tar --numeric-owner -xpzf "$B/runtime.tgz" -C /opt`（配置同理用 `etc.tgz`，先备份当前配置）；
  4. 重启服务，验证，退出维护模式。

  现网每次部署的备份和 `ROLLBACK.md` 都在 `/root/backups/agentdesk-deploy-group-v7*-*CST/`。

## 5. 已知限制（部署前请知悉）

- 群聊 v7 的 Bridge 端能力只在 Linux 本机和 GitHub CI 的 macOS/Windows 运行器上测试过，**没有在用户的 Mac/Windows 上验收过**。按第 2.4、3.4 节逐项确认后才算可用。
- 群聊没有交互终端（单聊终端的打包检查在 CI 上已通过，但还没有在真机上验收，见第 3 节“单聊终端的现状”）。补丁**应用前**的本机测试仍在本机临时拷贝里运行；补丁应用后的测试在原项目里运行。
- 改了平台相关源码的环境修复只做标记，不会在云端重跑测试。
- Windows 不做强制隔离或凭据保护，只做检测和标注（M1、M2、O3 的决定）。
- 单聊 directChatV2 需要另外授权，本文不涉及；不要为此写设备密钥文件或 `devices.json`。

## 6. 本机四个 CLI 每日自动更新（Mac / Windows）

VPS2 上由 systemd 定时器负责（见 `orchestrator/OPERATIONS.md`「四个 CLI 每日自动更新」）；你自己的电脑用 `scripts/local-cli-update.js`，只需要电脑上有 Node.js。

- 系统每小时启动它一次，它只在**美东时间每天中午 12:00 之后的第一次启动**时更新（跟随夏令时，和电脑本身的时区无关）；中午时电脑在睡眠或关机，醒来后补上。
- 依次运行 `codex`、`claude`、`grok`、`agy` 各自的官方 `update`；没装的跳过，某个失败就保留原版本、继续下一个。
- 日志 `~/.agentdesk/cli-update.log`（Windows 是 `%USERPROFILE%\.agentdesk\cli-update.log`），记录每个 CLI 更新前后的版本。

安装（在仓库目录里，用平时能直接运行这四个 CLI 的终端执行，这样它们的位置能被找到）：

```sh
node scripts/local-cli-update.js --install     # Mac：launchd 任务 local.agentdesk.cli-update；Windows：计划任务「AgentDesk CLI Update」
node scripts/local-cli-update.js --now         # 立即更新一次，确认能跑通
node scripts/local-cli-update.js --status      # 上次更新时间、今天是否已更新、日志位置
node scripts/local-cli-update.js --uninstall   # 移除定时任务
```

注意：
- 仓库目录移动后要重新 `--install`（任务里记的是脚本的完整路径）。Mac 上新装了 CLI、PATH 变了，也要重新 `--install`。
- Windows 上 CLI 正在被 AgentDesk 或终端使用时，更新可能因为文件被占用而失败，日志会记下，第二天再试。
