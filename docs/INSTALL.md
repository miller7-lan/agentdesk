# 安装 AgentDesk

给新电脑安装并接入现有 VPS 时，请从 [GitHub Releases](https://github.com/miller7-lan/agentdesk/releases) 下载通用迁移包，按[新电脑接入指南](MIGRATION.md)配置。

- Windows x64 使用 `AgentDesk-<版本>-setup.exe` 安装，或启动 `AgentDesk-<版本>-portable.exe`。
- macOS 将发布包中的 `AgentDesk.app` 拖到「应用程序」。开发构建在 `dist/mac-arm64/AgentDesk.app` 或对应 Intel 输出目录。

首次启动时，核对管理员提供的 SSH ed25519 指纹。安装包内带有服务器配置时（见 [签名与发布](SIGNING.md)），以安装包为准；否则读取 `~/.agentdesk/mac-remote.json`（macOS）或 `~/.agentdesk/remote.json`（Windows）。包含登记配置的构建使用单独的 AgentDesk 登记密码。完成向导后，从「工作区」添加本机 Git 仓库或填写云端目录。主控工作区标识由主控管理员分配。

项目、外观和向导进度保存在 Electron 用户数据目录的 `config.json`。旧连接配置仍用于 SSH 的主机、账户和密钥。应用可显示诊断报告和导出经过脱敏的压缩包。

本地构建需要 Node.js 24 与 npm。运行 `npm ci` 后，在 macOS 用 `npm run dist:mac -- --publish never`，在 Windows 用 `npm run dist -- --publish never`。正式分发见 [签名与发布](SIGNING.md)。
