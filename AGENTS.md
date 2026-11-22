# AgentDesk

Electron 桌面端（Windows、macOS）+ VPS2 上的编排主控（任意组员都可当组长，给其他成员派活）+ VPS1 上的 TLS Relay 备用线路；直连 VPS2 出现传输故障时，桌面端、单聊和 Bridge 还可经 VPS1 的受限 SSH 跳板自动回退（见 `docs/DEPLOY.md` §4）。

- 测试：`npm test`；改了 `relay/` 再跑 `cd relay && python3 -m unittest discover -s tests`。CI 在 Ubuntu、Windows、macOS 上跑同一套测试。
- **部署或修改 VPS2、Windows 端、Mac 端**（更新代码、改配置、确认生效、回滚）之前，读 `docs/DEPLOY.md`。
- **把各端升级到最新版本**：按 `docs/UPGRADE-2026-11.md` 逐项执行；交给本机 agent 的现成提示在 `docs/UPGRADE-PROMPTS.md`（Mac 负责 VPS2 和 Mac，Windows 只负责 Windows）。
- **2026-11-22 上线（权限统一、Mac 原生单聊）**：VPS2、Mac、Windows 各自要做的事和 Antigravity 待改项见 `docs/ROLLOUT-2026-11-22.md`。
- 当前定下的方向、未验收项和下一步见 `docs/UPDATE-DIRECTION.md`；改群聊行为前先读。
- 分工和额度规则在 `orchestrator/routing.js`；组长可以是任意组员、任意模型（`groupFeatures.anyLead: true`，VPS2 已开），Claude 也可以干组员的活；关掉这个开关才回到「Claude 只做规划、诊断、验收」。
- 真实 IP、私钥、令牌、密码只放在各端配置或 GitHub secret 里，仓库只放 `*.example.json`。
- 用户界面文字和文档用中文。
- 单聊 v2（设备登记、每设备 SQLite、文件锁、附件回执、状态、升级、窄启动器）：`docs/DIRECT-CHAT-V2.md`；客户端接口 `docs/DIRECT-CHAT-V2-API.md`。`ad device approve/revoke` 只改登记表，SSH key 行由管理员手动写。
