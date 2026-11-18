# AgentDesk

Electron 桌面端（Windows、macOS）+ VPS2 上的编排主控（Claude 当组长，给 Codex、Grok Build、Antigravity 派活）+ VPS1 上的 TLS Relay 备用线路。

- 测试：`npm test`；改了 `relay/` 再跑 `cd relay && python3 -m unittest discover -s tests`。CI 在 Ubuntu、Windows、macOS 上跑同一套测试。
- **部署或修改 VPS2、Windows 端、Mac 端**（更新代码、改配置、确认生效、回滚）之前，读 `docs/DEPLOY.md`。
- 分工和额度规则在 `orchestrator/routing.js`；Claude 只做规划、诊断、验收，这条由代码强制。
- 真实 IP、私钥、令牌、密码只放在各端配置或 GitHub secret 里，仓库只放 `*.example.json`。
- 用户界面文字和文档用中文。
