# 本机桌面权限：macOS 授权流程与 Windows 注意事项

本机桌面工具（`desktop_status`、`desktop_snapshot`、`desktop_screenshot`、点击、输入、窗口操作）由 `agent-desktop` 后端执行。它能否工作，取决于**拉起它的应用**在操作系统里拿到的权限，而不只是把某个 helper 文件勾上。

本文记录 macOS 的实际授权过程与容易踩的坑，并列出 Windows 端可能遇到的问题，供 Windows 更新和验收时逐项核对。部署位置和命令见 [DEPLOY.md](DEPLOY.md)。

## 先记住三条

1. **授权对象是拉起后端的应用。** macOS 把普通子进程的权限判断归到负责进程（通常是 AgentDesk 应用）；实测同一个 helper，由 `/bin/sh` 在 launchd 下运行会按 helper 自身授权判定，由 AgentDesk 拉起时则按 AgentDesk 的授权判定。
2. **以实际链路为准。** 在终端里直接运行 helper 的 `permissions` 可能把结果算到终端头上，不代表单聊/桌面工具的链路。最终看应用内 `desktop_status`。
3. **重新打包后要复查。** 当前 macOS 包是 adhoc 签名，重新构建会改变 CDHash，原有 TCC 记录可能匹配失败，需要重新关闭/开启或重新添加。

## macOS

### 需要的权限

| 权限 | macOS 13–15 中的名称 | macOS 27 中的名称 | 用途 |
|---|---|---|---|
| Accessibility | 辅助功能 | 设备控制和数据访问 | `snapshot`、点击、输入、窗口控制 |
| Screen Recording | 屏幕录制 | 录屏与系统录音 | `screenshot`、会话截图 |
| Automation | 自动化 | 自动化 | 个别 Apple Events 命令首次使用；`automation: unknown` 正常，用到时再允许 |

### 授权对象

以应用安装在 `~/Applications/AgentDesk.app` 为例；装在 `/Applications` 时替换路径。

- AgentDesk 应用包：`~/Applications/AgentDesk.app`
- **应用的真实可执行文件（关键）**：`~/Applications/AgentDesk.app/Contents/MacOS/AgentDesk`
- 应用内置助手（如果系统列表单独列出它）：`~/Applications/AgentDesk.app/Contents/Resources/desktop-backend/agent-desktop-darwin-arm64`
- 独立 Bridge 直接拉起的副本（Bridge 配置没有 `desktopSocket`、而是用 `desktopExecutable` 时）：`~/Library/Application Support/AgentDesk/bridge/runtime/node_modules/agent-desktop/bin/agent-desktop-darwin-arm64`

为什么还要加 `Contents/MacOS/AgentDesk`：本机当前这版是 adhoc 构建（没有提供 `MAC_CSC_LINK` 时 electron-builder 会生成 adhoc 包），`codesign -dv` 显示主可执行文件的标识是 `Electron`，而应用包的 bundle id 是 `local.agentdesk.ui`。只把 `.app` 加进列表时，可能出现「列表里 AgentDesk 已开启，但子进程仍报 denied」——把真实可执行文件也加入列表并开启后，`desktop_status` 才转为 `granted`。正式签名构建（Developer ID）一般按 bundle id 匹配，可能不需要这一条；本地构建和未签名构建建议直接加上。

### 步骤

1. 打开 **系统设置 → 隐私与安全性 → 辅助功能**（macOS 27 为 **设备控制和数据访问**）。
2. 点列表下方的 **+**，添加 `~/Applications/AgentDesk.app`。已有条目但状态可疑时，先关闭再开启。
3. 再点 **+**，按 `Cmd+Shift+G`，输入 `~/Applications/AgentDesk.app/Contents/MacOS/AgentDesk`，添加并开启。
4. 打开 **系统设置 → 隐私与安全性 → 屏幕录制**（macOS 27 为 **录屏与系统录音**）。
5. 这一页有两个列表，各有自己的 **+ / −**：
   - 上面的 **屏幕与系统录音**：窗口/屏幕截图用这个。**必须加到主列表。**
   - 下面的 **仅系统录音**：只影响系统音频，加到那里截图仍然失败。
6. 在主列表里同样添加 `.app`、`Contents/MacOS/AgentDesk`，以及列表单独出现的 `agent-desktop-darwin-arm64`，全部开启。
7. 修改屏幕录制后，按系统提示 **退出并重新打开** AgentDesk。已经运行的后端进程会沿用旧状态，不重启不生效。
8. 如果单聊仍显示 denied：完全退出 AgentDesk（菜单栏也要退出）再打开。Bridge 的 desktop 请求每次新建连接，不需要额外重启 Bridge。

### 验证

- 在单聊里让成员执行一次 `desktop_status`，应看到 `accessibility.state = granted`、`screen_recording.state = granted`。
- 再执行一次窗口 `desktop_screenshot`，成功返回 PNG 即通。
- 开发者在本机核对 helper 本身（用 `/bin/sh` 是为了绕开终端自己的 TCC 归属；最终仍以应用内 `desktop_status` 为准）：

```sh
BIN="$HOME/Applications/AgentDesk.app/Contents/Resources/desktop-backend/agent-desktop-darwin-arm64"
launchctl submit -l agentdesk-permcheck -- /bin/sh -c "'$BIN' permissions > /tmp/agentdesk-permcheck.json 2>&1"
sleep 3
launchctl remove agentdesk-permcheck
cat /tmp/agentdesk-permcheck.json
```

### 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 列表里 AgentDesk 已开启，单聊仍报「辅助功能未授权」 | adhoc 签名标识（`Electron`）与应用包记录不匹配 | 按上面第 3 步添加 `Contents/MacOS/AgentDesk`，重启应用 |
| 勾选后状态没变化 | 后端进程在授权前已启动并缓存状态 | 完全退出并重开 AgentDesk；必要时结束 `desktop-backend/agent-desktop-darwin-arm64` 进程后再试 |
| 屏幕录制勾了仍截图失败 | 加到了「仅系统录音」，或改完没重启应用 | 移到/加到主列表「屏幕与系统录音」，退出并重开应用 |
| 应用更新后又失效 | adhoc CDHash 变化，旧记录不再匹配 | 按本文重新关闭/开启或重新添加；每次替换应用后都复查 |
| 列表里有多份 AgentDesk / agent-desktop | 旧构建、回滚副本、Bridge runtime 各有一份 | 只保留正在使用的路径，其余可移除，避免看错条目 |
| `automation: unknown` | 正常状态 | 首次用到 Apple Events 时会弹「自动化」授权，允许即可 |
| helper 单独运行 granted，单聊仍 denied | 终端/launchd 与应用的权限归属不同 | 以应用内 `desktop_status` 为准，按上面第 3 步处理 |

### 安全

- 只给当前在用的应用和可执行文件授权；桌面工具不用时可在应用状态栏关闭，或在系统设置里关闭对应开关。
- 权限记录只存在本机 TCC 数据库，不会进仓库；仓库和文档里不要写本机凭据。
- 删除旧应用副本后，对应的 TCC 条目可以手动移除。

## Windows

Windows 没有 macOS 的 TCC 开关，桌面工具失败通常不是「少勾了一个权限」，而是完整性级别、会话隔离或捕获限制。Windows 端更新和验收时按下面清单逐项确认。

### 可能的问题

| 类别 | 可能的问题 | 处理 / 验证 |
|---|---|---|
| UIPI / 提权不一致 | AgentDesk 以普通权限运行，操作「以管理员身份运行」的窗口会被拒绝；反过来，提权后的 AgentDesk 也不能把文件拖给普通权限的 Explorer | AgentDesk 与目标窗口保持相同完整性级别；需要控制管理员窗口时以管理员启动 AgentDesk；普通窗口和管理员窗口各测一次 |
| 会话隔离 | 把 Bridge 或后端注册成 Windows 服务（Session 0）时看不到登录用户桌面，`snapshot` 为空、截图为黑 | 在交互式用户会话运行（托盘或启动项），不要做成服务；核对进程的 SessionId 与登录会话一致 |
| 安全桌面 | UAC 提示、锁屏、Ctrl+Alt+Del 界面无法自动化 | 预期限制；无人值守任务前确认桌面已解锁，不要在这些界面操作 |
| 屏幕捕获 | 最小化窗口、DRM/受保护内容、部分硬件加速窗口截图为黑；多显示器或 DPI 缩放导致坐标偏移 | 先恢复窗口再截图；按 per-monitor DPI aware 换算坐标；多屏各测一次 |
| 焦点 / 前台 | `SetForegroundWindow` 限制会让点击或输入落到别的窗口 | 优先用 UI Automation 语义操作；需要物理输入时先确认目标窗口在前台，并用 `snapshot` 验证焦点 |
| 杀毒 / EDR | Defender、SmartScreen 或企业 EDR 可能拦截未签名的 `agent-desktop-win32-x64.exe`、模拟输入或屏幕捕获 | 给 exe 正式签名；首次运行按 SmartScreen 提示放行；企业环境加白名单；查事件查看器和 EDR 日志 |
| 路径 / 编码 | 安装路径含空格、中文或 `%` 时命令拼接失败（尤其 SSH 跳板的 `ProxyCommand`） | 使用带引号的绝对路径；避免 `%`；在 Windows 端实际运行一次 helper |
| RDP / 远程会话 | 断开 RDP 后会话可能变为 disconnected，截图为黑或失败 | 使用控制台会话或保持 RDP 连接；重新连接后重试 |
| 锁屏 / 休眠 | 会话锁定时无法截图或输入 | 任务前唤醒并解锁；关闭睡眠或使用保持唤醒 |
| 版本差异 | Windows 11 24H2 的 Administrator Protection、UAC 策略和 Defender 版本会影响提权与自动化 | 在目标版本上验收：普通用户、管理员、UAC 开启/关闭各一次 |

### Windows 验证步骤

1. 确认 Bridge 的 `desktopExecutable` 指向实际打包的 `desktop-backend\agent-desktop-win32-x64.exe`；如果配置了 `desktopSocket`/命名管道，确认对应进程在交互式会话中运行。
2. 在交互式用户会话运行 `agent-desktop-win32-x64.exe status`，确认后端能启动；Windows 没有 TCC，`permissions` 的字段可能不适用，以实际 `snapshot`/`screenshot` 为准。
3. 用记事本做一次闭环：`snapshot` → `click` / `type` → `screenshot`。
4. 再对「以管理员身份运行」的窗口重复一次，记录是否需要提权。
5. 断开/重连 RDP、锁屏后再各测一次，把预期失败项写进升级记录。
6. Windows 更新或重新打包后重跑本节，并把结果补到升级清单。

## 更新后复查（两端）

- macOS：替换应用或重新打包后，检查辅助功能和屏幕录制列表里的路径是否仍指向当前应用；重新做一次 `desktop_status` 和窗口截图。
- Windows：更新或重新打包后，检查 `desktopExecutable` 路径、签名/杀软拦截、UIPI 提权和 RDP/锁屏场景。
- 把实际结果（哪一项通过、哪一项受限）记到升级清单或 PR 描述里，方便下一次更新对照。