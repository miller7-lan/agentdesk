# 签名与发布

从 GitHub Actions 手动运行 **Build release artifacts**，或推送纯 `vX.Y.Z` 标签。工作流构建 Windows x64 的 NSIS 和便携版，以及 macOS 的 DMG 和 ZIP，上传 CI 产物；只有标签构建会交给 VPS2 作为客户端更新（见下文「发布」）。普通 main 提交不再构建安装包。

Windows 使用 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD` 保存签名材料。工作流把它们传给 electron-builder 的 `CSC_LINK` 和 `CSC_KEY_PASSWORD`，使用 SHA-256。macOS 对应 `MAC_CSC_LINK` 和 `MAC_CSC_KEY_PASSWORD`，使用 Developer ID Application 证书和 hardened runtime。公证钩子读取 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，本机也可用 `APPLE_KEYCHAIN_PROFILE`。缺少签名凭据时可生成未签名构建。 [electron-builder 签名文档](https://www.electron.build/docs/troubleshooting/) · [Electron 公证文档](https://github.com/electron/notarize)

## 把服务器地址打进安装包

仓库 **Settings → Secrets and variables → Actions** 里新建 secret `AGENTDESK_SERVER_JSON`，内容参照仓库根目录的 `agentdesk-server.example.json`：

- `host`、`port`：VPS2 的 IP 或域名和 SSH 端口。
- `knownHosts`：服务器的 SSH 主机公钥，一行 known_hosts 格式。在 VPS2 上运行 `cat /etc/ssh/ssh_host_ed25519_key.pub`，在前面加上 `IP ` 即可（端口不是 22 时写成 `[IP]:端口 `）。首次启动时用户仍要核对并确认这个指纹。
- `tunnelUser`、`codexUser`：可选，默认 `windows-tunnel`、`codexdev`。

工作流在打包前把它写成 `agentdesk-server.json`，放进安装包。应用以它为准，覆盖每台电脑上 `~/.agentdesk/remote.json` 里的主机和端口；SSH 私钥和其他个人设置仍从本机读取，**私钥永远不进安装包**。换 VPS 时只要改这个 secret，重新运行工作流。

另有可选的 `AGENTDESK_ENROLLMENT_JSON`，内容即 `agentdesk-enrollment.json`。有了它，构建会改用密码登录（见 [登记说明](../orchestrator/ENROLLMENT.md)），需要 VPS2 上已部署登记服务。

注意：本仓库是公开的，任何登录 GitHub 的人都能下载 Actions 构建产物，也就能从安装包里读到服务器地址。连接仍然要求本机私钥或登记密码，地址本身不足以登录；但如果不想公开 IP，把仓库设为私有，或者改在本机构建（把 `agentdesk-server.json` 放在仓库根目录后执行 `npm run dist:bundle`；0.3.0 起默认的 `npm run dist` 不再打包连接配置）。

## 发布

客户端更新（0.3.0 起）见 [AUTO-UPDATE.md](AUTO-UPDATE.md)：只有推送纯 `vX.Y.Z` 标签（与 `package.json` 版本一致）才构建可推送的包，经专用受限 SSH 账户交给 VPS2，VPS2 再经现有控制通道提供给各客户端。更新包一律不含连接配置；内置连接配置的构建（`bundle_connection` 或 `npm run dist:bundle`）只用于手动分发，不会成为更新包。旧的 `update.enabled`、`update.feedUrl` 设置已不再读取。

- 有签名材料时：工作流把它传给 electron-builder，打包后校验签名（Windows `Get-AuthenticodeSignature`，macOS `codesign` 和 `spctl`）；安装包内的 `build-info.json` 记为已签名，客户端才会默认自动检查和下载。
- 没有签名材料时：产出未签名包，客户端只提示「发现新版本」，由用户手动下载；Windows 由用户点击「重启并更新」安装；macOS 未签名包无法由更新器安装，只能手动替换。 [electron-builder 更新文档](https://www.electron.build/docs/features/auto-update/)
