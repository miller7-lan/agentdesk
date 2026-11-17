# 签名与发布

从 GitHub Actions 手动运行 **Build release artifacts**。工作流构建 Windows x64 的 NSIS 和便携版，以及 macOS 的 DMG 和 ZIP，上传 CI 产物供后续发布。

Windows 使用 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD` 保存签名材料。工作流把它们传给 electron-builder 的 `CSC_LINK` 和 `CSC_KEY_PASSWORD`，使用 SHA-256。macOS 对应 `MAC_CSC_LINK` 和 `MAC_CSC_KEY_PASSWORD`，使用 Developer ID Application 证书和 hardened runtime。公证钩子读取 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，本机也可用 `APPLE_KEYCHAIN_PROFILE`。缺少签名凭据时可生成未签名构建。 [electron-builder 签名文档](https://www.electron.build/docs/troubleshooting/) · [Electron 公证文档](https://github.com/electron/notarize)

发布时核验签名和公证票据，随后把同一次构建的安装包与更新清单发布到管理员托管的 HTTPS 更新目录。macOS 更新需要 ZIP。可在应用用户数据目录的 `config.json` 中填写 `update.enabled` 和 `update.feedUrl`，重启后从「诊断」检查更新。默认关闭。当前更新器只检查版本，下载与安装由发布流程和用户控制。 [electron-builder 更新文档](https://www.electron.build/docs/features/auto-update/)
