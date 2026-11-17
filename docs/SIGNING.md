# 签名与发布

从 GitHub Actions 手动运行 **Build release artifacts**。工作流构建 Windows x64 的 NSIS 和便携版，以及 macOS 的 DMG 和 ZIP，上传 CI 产物供后续发布。

Windows 使用 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD` 保存签名材料。工作流把它们传给 electron-builder 的 `CSC_LINK` 和 `CSC_KEY_PASSWORD`，使用 SHA-256。macOS 对应 `MAC_CSC_LINK` 和 `MAC_CSC_KEY_PASSWORD`，使用 Developer ID Application 证书和 hardened runtime。公证钩子读取 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，本机也可用 `APPLE_KEYCHAIN_PROFILE`。缺少签名凭据时可生成未签名构建。 [electron-builder 签名文档](https://www.electron.build/docs/troubleshooting/) · [Electron 公证文档](https://github.com/electron/notarize)

## 把服务器地址打进安装包

仓库 **Settings → Secrets and variables → Actions** 里新建 secret `AGENTDESK_SERVER_JSON`，内容参照仓库根目录的 `agentdesk-server.example.json`：

- `host`、`port`：VPS2 的 IP 或域名和 SSH 端口。
- `knownHosts`：服务器的 SSH 主机公钥，一行 known_hosts 格式。在 VPS2 上运行 `cat /etc/ssh/ssh_host_ed25519_key.pub`，在前面加上 `IP ` 即可（端口不是 22 时写成 `[IP]:端口 `）。首次启动时用户仍要核对并确认这个指纹。
- `tunnelUser`、`codexUser`：可选，默认 `windows-tunnel`、`codexdev`。

工作流在打包前把它写成 `agentdesk-server.json`，放进安装包。应用以它为准，覆盖每台电脑上 `~/.agentdesk/remote.json` 里的主机和端口；SSH 私钥和其他个人设置仍从本机读取，**私钥永远不进安装包**。换 VPS 时只要改这个 secret，重新运行工作流。

另有可选的 `AGENTDESK_ENROLLMENT_JSON`，内容即 `agentdesk-enrollment.json`。有了它，构建会改用密码登录（见 [登记说明](../orchestrator/ENROLLMENT.md)），需要 VPS2 上已部署登记服务。

注意：本仓库是公开的，任何登录 GitHub 的人都能下载 Actions 构建产物，也就能从安装包里读到服务器地址。连接仍然要求本机私钥或登记密码，地址本身不足以登录；但如果不想公开 IP，把仓库设为私有，或者改在本机构建（把 `agentdesk-server.json` 放在仓库根目录后执行 `npm run dist`）。

## 发布

发布时核验签名和公证票据，随后把同一次构建的安装包与更新清单发布到管理员托管的 HTTPS 更新目录。macOS 更新需要 ZIP。可在应用用户数据目录的 `config.json` 中填写 `update.enabled` 和 `update.feedUrl`，重启后从「诊断」检查更新。默认关闭。当前更新器只检查版本，下载与安装由发布流程和用户控制。 [electron-builder 更新文档](https://www.electron.build/docs/features/auto-update/)
