# 微信办公助手（个人微信 ClawBot）

> 2026-11-23 起，取代 [WECHAT_OMC_PLAN.md](WECHAT_OMC_PLAN.md) 的重方案。通道是**个人微信 ClawBot**：腾讯 iLink 协议，HTTP 接口与腾讯官方 OpenClaw 插件 `@tencent-weixin/openclaw-weixin` 2.4.10 相同，实现在 `orchestrator/wechat/ilink.js`。ClawBot 只负责收发消息，干活的只有 VPS2 上配置好的 CLI；没有安装 OpenClaw。
>
> **注意**：iLink 不是正式开放 API，协议可能变更；只用自己的微信号、低频使用。用户 2026-11-23 知情后选择此通道。
>
> 曾试过的通道（已删除）：企业微信自建应用 HTTP 回调（需要可信域名）、企业微信智能机器人长连接（2026-11-24 删除：官方只支持企业成员在企业微信 App 里使用，不能在个人微信里聊）。

在个人微信里和 ClawBot 单聊，发 Word / Excel / PPT 和需求，VPS 2 在沙箱里处理，成品文件主动发回来。不同步到桌面端，不碰 Mac/Windows 和主控调度器，不提供 shell。

## 0. 个人微信 ClawBot 登录

```sh
# 在 VPS2 上（或从 Mac：ssh -t root@<VPS2> '…'）
sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/wechat/login.js   # 终端出二维码，手机微信扫码确认
systemctl restart agentdesk-wechat
```

凭据存 `/var/lib/agentdesk-orchestrator/wechat/ilink-account.json`（0600），收信游标和各用户最近的 `context_token` 存 `ilink-state.json`。扫码人自动是管理员（白名单）。日志出现 `-14 session expired` 时服务暂停 1 小时；持续出现就重新登录（`login.js --force`）。出站文件上限按 50MB，入站 100MB；文件用 AES-128-ECB 加密后走微信 CDN。


## 0.5 管理员和普通成员（2026-11-24）

- **管理员**：扫码登录 ClawBot 的人 + `wechat.json` 的 `admins`。发的消息（命令除外）直接交给所选 CLI，**默认接着当前对话**，`/新` 开新对话；`/模型`、`/模型1～4` 在 Claude Opus / GPT（Codex）/ Antigravity / Grok 间切换（换 AI 即开新对话）；`/2` 停止当前回复。
- AI 能做办公文件（`out/` 的新文件发回微信），也能经 MCP 工具（`orchestrator/mcp.js` 的 `remote` 范围，`wechat/remote.js`）操作所选电脑：整机文件增删改查（覆盖前 Bridge 备份、删除进废纸篓）、执行命令（Mac 上凭据目录仍被沙箱挡住）、桌面操作、`remote_save_screenshot` 截屏发回、`remote_fetch_file` 取回文件、`remote_push_file` 把成品放到电脑。截屏等都由 CLI 自己调工具，服务不硬编码。
- 电脑操作走主控 `admin.sock` → 对应 Bridge（`devices.js`）；每轮对话发一次性 capability，只能操作本轮选中的电脑、只能把文件存进本对话目录。
- 2026-11-24 实测：Codex、Grok 能用全部远程工具（截屏发回、改文件、执行命令）；Antigravity 只能用文件增删改查——它的 `homes/antigravity/.gemini/config/mcp_config.json` 有固定 `enabledTools` 白名单（与主控群聊共用），要放开命令/桌面/截屏需在白名单加 `local_shell_run`、`local_desktop`、`remote_*`（会同时影响群聊里 Antigravity 的 local 步骤）。Claude 当时 5 小时额度剩 2%，未实测。
- **设备在线提醒**：每分钟查一次各电脑（`devices`，默认只有 Mac）到主控的 SSH/Relay 通道；上线立即提醒、连续 2 次查不到才算离线，提醒所有管理员；服务启动时有离线的也提醒一次。`/电脑` 查看并 `/电脑2` 切换。电脑要「开机即连」：Bridge 用 LaunchAgent（RunAtLoad + KeepAlive）常驻并用 `desktopExecutable`，不依赖打开 AgentDesk（Mac 端提示词见 `docs/WECHAT-MAC-BRIDGE-PROMPT.md`）。
- **普通成员**：只有办公流程（下面第 1 节）。任务做完后接着发消息 = 继续改上一个任务；`/新` 开新任务。
- **隔离**：每人自己的任务编号（#1 起）和目录 `wechat/users/<userid 哈希>/{tasks/<编号>,pending,ask}`；查询都按本人过滤，AI 的当前目录只是本人的一个任务目录（沙箱看不到别人的）。旧数据启动时自动迁移。

## 1. 用法（普通成员，引导式）

| 步骤 | 你发 | 机器人 |
|---|---|---|
| ① 开始 | 需求文字或文件 | 回档位菜单 |
| ② 选档 | 数字 `1` / `2` / `3` | 回错了重发菜单，直到选对 |
| ③ 补充 | 更多文字和 Word/Excel/PPT 文件（可多条） | 第一条回「收到」，之后不逐条回复 |
| ④ 出方案 | `开始` | 「收到 #编号」，组长出方案（约 1～3 分钟），发来 📋 方案和执行预计用时 |
| ⑤ 改方案 | 直接说修改意见（可带文件），可来回多轮 | 组长在同一会话里改，再发 📋 修改后的方案 |
| ⑥ 提交 | `完成` | 「已提交 #编号，执行预计约 N 分钟」；做完主动发文件和说明；明显超时提醒一次 |

- 收集或看方案时回 `1`/`2`/`3` 可以改档位；接着改老任务时不能换档。
- 某一步发了不该发的（比如没选档就发「开始」，没方案就发「完成」），机器人重发当前这一步的提示。
- 提交后马上可以开始下一个任务。

### 命令（「/」后面直接跟数字或词，不要空格）

| 命令 | 作用 |
|---|---|
| `/0` | 显示帮助（这张对应表） |
| `/1` | 查看历史任务（最近 10 个） |
| `/2` | 取消当前这一步（收集、出方案中、看方案都可以），重新开始 |
| `/3问题` | 快问快答，例 `/3今天星期几`：便宜模型只读回答，不建任务 |
| `/进12` | 接着修改 #12 的成品：发修改要求后「开始」，交给原执行 AI，不再出方案 |
| `/看12` | 查看 #12 详情（方案、成品、没发出去的文件） |
| `/停12` | 停止 #12（执行中、排队中或方案阶段） |
| `/重试12` | 重做失败/额度不够的 #12（没出成方案的重新出方案） |
| `/重发12` | 重新发送 #12 的成品文件 |
| `你好` | 打招呼，回帮助 |

## 2. 三档、方案与额度

| 档位 | 执行者 | 粗估用时 |
|---|---|---|
| 1 低 | Antigravity、Grok 里剩余额度多的；途中额度用尽/掉登录换另一个 | 5～15 分钟 |
| 2 中 | Codex（GPT） | 3～10 分钟 |
| 3 高 | Claude Opus（组长也是 Opus 时沿用出方案的会话接着做） | 5～20 分钟 |

- **组长**（默认 Claude Opus，只读）按所选档位出方案：给用户看的方案摘要 + 给执行者的完整简报 + 执行预计分钟数。用户确认前不动手。
- 执行者只按确认后的最新简报一次做完，不验收、不中途干预。
- **时间提醒**：方案和提交时显示预计用时（组长估计，没有就用上表）；执行超过预计 1.5 倍时提醒一次。只求让用户心里有数，不求准。
- **额度**：出方案前查组长，执行前查执行者（`orchestrator/quotas.js`，缓存 60 秒）。看 5 小时窗口，没有的看周额度；**剩余低于 8%** 的不用，都不够时回「🪫 额度不够」和恢复时间，之后 `/重试编号`。读不到额度时不拦。
- 没确认的方案 3 天后自动取消。

## 3. 身份、多人与权限

- **userid**（iLink 消息的 `from_user_id`）= 任务所有者。草稿、任务、文件目录、限流都按 userid 分开；`/看 /进 /停 /重试 /重发` 只能操作自己的任务。
- **群里不处理任务和文件**；所有结果只发到所有者单聊，不会发到群里或别人那里。
- 发消息带上对方最近一条消息的 `context_token`（存在 `ilink-state.json`，重启后仍可主动发）。
- **白名单** `allowUsers`：扫码登录 ClawBot 的人自动在内；其他人收到固定回复，日志打印其 userid 以便登记。当前只有管理员本人，模型订阅不对外开放。
- **限流**（`limits`）：每人每分钟 30 条消息、同时最多 2 个排队/执行中的任务、24 小时 20 个任务、`/3` 快问快答每小时 30 次。全局同时只执行 1 个任务。
- 微信里**没有** shell、root、本机 Bridge 或主控访问；AI 只在本任务的 bubblewrap 沙箱目录里读写。

## 4. 文件

- **收**：文件 / 图片消息里的 CDN 地址下载后 AES-128-ECB 解密，按原文件名（去掉路径）存到该用户的草稿目录；最大 100MB。
- **发**：成品写在任务的 `out/`。交付前校验：docx/pptx/xlsx 必须是完整 zip 且含 `[Content_Types].xml` 和主部件（`word/document.xml` / `ppt/presentation.xml` / `xl/workbook.xml`），坏文件不发并说明。然后 `getuploadurl` → AES 加密上传 CDN → `sendmessage` 发文件消息，只发给任务所有者。
- **限制**：出站单个文件按 50MB 卡（协议没写明，取保守值），超出不上传并告知。
- **失败**：每个文件最多试 3 次（2 秒、8 秒退避，断线时等重连最多 2 分钟）；结果记在任务的 `deliveries`。发送失败可以 `/重发编号`，文件仍在 `out/` 里（保留 30 天）。

## 5. 谁能用

- ClawBot 绑定在扫码的那个微信号上，扫码人就是管理员。
- 其他微信用户能否和同一个 ClawBot 对话尚未实测；能的话，把日志里 `denied user` 的 userid 加进 `allowUsers` 即可，任务和文件按人隔离。
- 不使用任何第三方个人微信协议或模拟登录。

## 6. 架构

```
个人微信（ClawBot 单聊） ⇄ ilinkai.weixin.qq.com（长轮询，VPS2 主动连出）+ 微信 CDN（文件，AES-128-ECB）
agentdesk-wechat.service（User=agentdesk）
  ilink.js    iLink 通道：长轮询收消息、发文字/文件/图片、CDN 上传下载、-14 会话失效暂停
  login.js    终端二维码扫码登录
  router.js   按阶段把消息解析成动作（选档、收集、出方案、改方案、命令），纯函数
  quota.js    额度闸门
  runner.js   planTask 出方案/改方案 + executeTask 执行（复用 adapters.runAdapter + bwrap 沙箱）
  deliver.js  成品校验、重试发送、发送记录
  store.js    tasks.json、草稿、去重、gc
  service.js  白名单、限流、排队、交付
```

- 长轮询每次最多约 35 秒；网络错误 2 秒后重试，连续 3 次失败改为 30 秒；`-14` 会话失效暂停 1 小时。
- 还没扫码登录时服务空转等待，不会反复重启。
- 任务目录 `/var/lib/agentdesk-orchestrator/wechat/tasks/<id>/{in,work,out,.logs}`，是空 git 仓库（Codex 需要）。

## 7. 部署

```sh
# 工具链（一次）
sh orchestrator/wechat/install-office.sh
# 代码和依赖（qrcode-terminal）
install -d -m 755 /opt/agentdesk-orchestrator/wechat
install -m 644 orchestrator/wechat/*.js orchestrator/wechat/package*.json /opt/agentdesk-orchestrator/wechat/
(cd /opt/agentdesk-orchestrator/wechat && npm ci --omit=dev --ignore-scripts)
# 配置
install -m 640 -o root -g agentdesk orchestrator/wechat/wechat.example.json /etc/agentdesk-orchestrator/wechat.json  # allowUsers 等
# 服务
install -m 644 orchestrator/agentdesk-wechat.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now agentdesk-wechat
# 扫码登录（见第 0 节），然后
journalctl -u agentdesk-wechat -f      # 应看到 ilink connected
```

改 `wechat.json` 后 `systemctl restart agentdesk-wechat`。

`wechat.json` 字段：`allowUsers`、`minQuotaPercent`（8）、`limits`、`sendPreview`（true）、`tiers`（覆盖各档 provider/model，见 `runner.js` 的 `DEFAULTS`）、`ask`（`/3` 快问快答用的模型）、`retention.days`（30）、`retention.draftDays`（3）、`deliveryRetry`。

## 8. 办公工具链

`install-office.sh`（root，可重复跑）：LibreOffice headless（单次转换峰值约 220 MB）、pandoc、Noto CJK 字体；`/opt/agentdesk-office/venv`（python-docx、openpyxl、python-pptx、XlsxWriter、pandas、matplotlib、pdfplumber）；`/opt/agentdesk-office/bin` 的 `office-convert`、`office-preview`、`xlsx-recalc`；执行规范 `/opt/agentdesk-office/GUIDE.md`。

## 9. 排障

| 现象 | 查 |
|---|---|
| 日志 `ClawBot 尚未登录` | 按第 0 节扫码，然后重启服务 |
| 日志 `-14 session expired` 反复出现 | `login.js --force` 重新扫码 |
| 日志 `ilink getupdates failed` | VPS2 到 ilinkai.weixin.qq.com 的网络 |
| 发消息回「只对已登记的成员开放」 | 日志里 `denied user` 那行的 userid 加进 `allowUsers`，重启 |
| 🔑 需要重新登录 | 对应 CLI 在 `homes/<cli>` 的登录过期，与主控同一份 |
| 文件没收到 | `/看编号` 看「没发出去」；`journalctl -u agentdesk-wechat | grep delivery`；`/重发编号` |
| 任务细节 | `/var/lib/agentdesk-orchestrator/wechat/tasks/<id>/.logs/` |

日志只记消息类型、userid 哈希、文件扩展名和大小，不记消息正文。
