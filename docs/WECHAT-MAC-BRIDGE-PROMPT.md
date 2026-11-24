# 交给 Mac 本机 agent 的提示词：Bridge 开机即连（不依赖打开 AgentDesk）

> 用途：微信管理员助理要随时远程操作这台 Mac（截屏、文件增删改查、执行命令）。Bridge 必须在 Mac 开机登录后自动常驻连上 VPS2，而不是等打开 AgentDesk App 才连。把下面整段发给 Mac 上的 Claude Code / Codex 执行。

```
请在这台 Mac 上检查并配置 AgentDesk Bridge「开机即连」，只改下面列出的东西，每步做完告诉我结果，改配置前先备份原文件（加 .bak-日期 后缀）。

1. 找到 Bridge 的 LaunchAgent：ls ~/Library/LaunchAgents | grep -i agentdesk（可能是 local.agentdesk.mac-bridge 或 local.agentdesk.bridge）。
   - 用 plutil -p 看 plist：必须有 RunAtLoad=true、KeepAlive=true，ProgramArguments 是「node 绝对路径 + orchestrator/mac-bridge.js + ~/.agentdesk/mac-bridge.json」。
   - node 路径和 mac-bridge.js 路径必须真实存在；不要指向 AgentDesk.app 里会随升级变化的临时路径。缺什么就按仓库 docs/MAC-DEPLOY.md「设置开机后自动启动」补上。
2. 看 ~/.agentdesk/mac-bridge.json（不要把里面的 token、私钥打印出来）：
   - 如果用的是 "desktopSocket"（由 AgentDesk App 提供，App 不开就不能截屏/操作桌面），改为 "desktopExecutable"，
     指向 ~/Library/Application Support/AgentDesk/bridge/runtime/node_modules/agent-desktop/bin/agent-desktop-darwin-arm64（先确认文件存在且可执行；不存在就告诉我，别乱改）。
   - 确认顶层 "readAnyFolder": true、"writeAnyFolder": true，mac 工作区 "desktop": true（微信管理员要整机文件读写和桌面操作）。
   - relay.host 必须是 195.72.187.23（旧 IP 166.1.218.21 已经停用）。
3. 系统设置 → 隐私与安全性：给上面的 agent-desktop-darwin-arm64（以及 LaunchAgent 用的 node）打开「屏幕录制」和「辅助功能」。需要我手动点的，列出来让我点。
4. 防止睡眠断线：pmset -g 看一下；建议接电源时不睡眠（sudo pmset -c sleep 0，显示器可以睡），需要 sudo 的命令列给我，我自己执行。
5. 让它开机后无需打开 App 也在线：如果希望重启后不登录也连上，告诉我需要开启「自动登录」（LaunchAgent 只在用户登录后运行，截屏也需要登录会话）。
6. 重启 Bridge：launchctl kickstart -k gui/$(id -u)/<标签>，然后 tail ~/.agentdesk/mac-bridge*.log 看到连上 VPS2（ssh 或 relay 连接成功）、"macOS desktop permissions: granted granted"。
7. 退出 AgentDesk App 后等 1 分钟，再确认 Bridge 进程仍在（pgrep -fl mac-bridge.js）。完成后告诉我，我会在微信里发 /电脑 和让助理截屏验证。
```
