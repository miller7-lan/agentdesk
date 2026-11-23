# 微信办公助手（个人微信 ClawBot / 企业微信智能机器人）

> 2026-11-23 起。取代 [WECHAT_OMC_PLAN.md](WECHAT_OMC_PLAN.md) 的重方案。两种通道，`wechat.json` 的 `channel` 二选一，上层逻辑相同：
>
> - **`ilink`（默认，当前使用）**：个人微信 ClawBot，腾讯 iLink 协议（与腾讯官方 OpenClaw 插件 `@tencent-weixin/openclaw-weixin` 2.4.10 相同的 HTTP 接口，`orchestrator/wechat/ilink.js`）。在个人微信里直接聊。**注意**：iLink 不是正式开放 API，协议可能变更；只用自己的微信号、低频使用。用户 2026-11-23 知情后选择此通道。
> - **`wecom`**：企业微信智能机器人 · API 模式 · 长连接（官方 SDK `@wecom/aibot-node-sdk` 1.0.7，`bot.js`），只能在企业微信 App 里用。

## 0. 个人微信 ClawBot 登录

```sh
# 在 VPS2 上（或从 Mac：ssh -t root@<VPS2> '…'）
sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/wechat/login.js   # 终端出二维码，手机微信扫码确认
systemctl restart agentdesk-wechat
```

凭据存 `/var/lib/agentdesk-orchestrator/wechat/ilink-account.json`（0600），收信游标和各用户最近的 `context_token` 存 `ilink-state.json`。扫码人自动是管理员（白名单）。日志出现 `-14 session expired` 时服务暂停 1 小时；持续出现就重新登录（`login.js --force`）。出站文件上限按 50MB，入站 100MB；文件用 AES-128-ECB 加密后走微信 CDN。

在企业微信里和「AgentDesk」机器人单聊，发 Word / Excel / PPT 和需求，VPS 2 在沙箱里处理，成品文件主动推送回来。不同步到桌面端，不碰 Mac/Windows 和主控调度器，不提供 shell。

## 1. 用法（引导式）

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

- **userid**（`frame.body.from.userid`）= 任务所有者。草稿、任务、文件目录、限流都按 userid 分开；`/看 /进 /停 /重试 /重发` 只能操作自己的任务。
- **chatid** 只在群聊出现。**群里不处理任务和文件**；所有结果用主动推送发到所有者单聊（会话 ID 填 userid），不会发到群里或别人那里。
- **原始帧**只用于 24 小时内的被动回复（透传 `req_id`），不落盘。
- **白名单** `allowUsers`：为空时拒绝所有人。被拒的人收到固定回复，日志打印其 userid 以便登记。当前只登记管理员本人，模型订阅不对外开放。
- **限流**（`limits`）：每人每分钟 30 条消息、同时最多 2 个排队/执行中的任务、24 小时 20 个任务、`/3` 快问快答每小时 30 次。全局同时只执行 1 个任务。
- 微信里**没有** shell、root、本机 Bridge 或主控访问；AI 只在本任务的 bubblewrap 沙箱目录里读写。

## 4. 文件

- **收**：`message.file` / `message.image` → SDK `downloadFile(url, aeskey)` 解密 → 存到该用户的草稿目录。下载链接 5 分钟有效，最大 100MB；消息里没有文件名，取下载响应里的名字（去掉路径）。
- **发**：成品写在任务的 `out/`。交付前校验：docx/pptx/xlsx 必须是完整 zip 且含 `[Content_Types].xml` 和主部件（`word/document.xml` / `ppt/presentation.xml` / `xl/workbook.xml`），坏文件不发并说明。然后 `uploadMedia(buffer, {type:'file', filename})` 拿 `media_id`，`sendMediaMessage(userid, 'file', media_id)` 主动推送。
- **限制**：SDK 分片 512KB × 最多 100 片（约 50MB）；官方文档普通文件 20MB、图片 10MB，本服务按 **20MB** 卡，超出不上传并告知。`media_id` 3 天有效。
- **失败**：每个文件最多试 3 次（2 秒、8 秒退避，断线时等重连最多 2 分钟）；结果记在任务的 `deliveries`。发送失败可以 `/重发编号`，文件仍在 `out/` 里（保留 30 天）。

## 5. 普通微信的能力边界

| 场景 | 状态 |
|---|---|
| 企业微信内部成员，在企业微信 App 里和机器人单聊 | ✅ 官方支持（本方案） |
| 企业微信群里 @机器人 | 官方支持；本服务只回一句「请单聊使用」 |
| 普通微信用户（外部联系人 / 外部群）直接和智能机器人聊 | ❌ 官方文档（101031、101463、100719、101138）只描述企业内单聊和群聊，userid 为企业成员，**没有任何外部联系人、微信插件或互通的说明**。不能假设支持 |
| 成员用个人微信经「微信插件」使用机器人 | ❓ 文档未提及，需实测：管理员在「我的企业 → 微信插件」绑定个人微信后，看个人微信里能否看到并和机器人对话 |

朋友要用的官方做法：**把朋友加入你的企业成为成员**（下载企业微信 App，或经微信插件，未认证企业有人数上限），再加进 `allowUsers`。若最终需要不加入企业的普通微信用户使用，官方通道是「微信客服」，但它需要 HTTP 回调和可信域名，与当前不备案、不用回调的条件冲突，暂不做。**不使用任何非官方个人微信协议。**

## 6. 架构

```
企业微信 App（单聊） ⇄ 企业微信服务器 ⇄ wss://openws.work.weixin.qq.com（长连接，VPS2 主动连出）
agentdesk-wechat.service（User=agentdesk）
  bot.js      SDK 封装：帧 → 统一消息；被动回复 / 主动推送；上传下载
  router.js   按阶段把消息解析成动作（选档、收集、出方案、改方案、命令），纯函数
  quota.js    额度闸门
  runner.js   planTask 出方案/改方案 + executeTask 执行（复用 adapters.runAdapter + bwrap 沙箱）
  deliver.js  成品校验、重试发送、发送记录
  store.js    tasks.json、草稿、去重、gc
  service.js  白名单、限流、排队、交付
```

- **一个机器人只能有一条长连接**，新连接会踢掉旧的（服务会记录 `disconnected_event`）。不要在别处用同一个 Bot ID 跑测试脚本。
- SDK 自动心跳（30 秒）和断线指数退避重连（`maxReconnectAttempts: -1`）；连续 5 次认证失败时进程退出，systemd 60 秒后重启。
- 任务目录 `/var/lib/agentdesk-orchestrator/wechat/tasks/<id>/{in,work,out,.logs}`，是空 git 仓库（Codex 需要）。

## 7. 部署

```sh
# 工具链（一次）
sh orchestrator/wechat/install-office.sh
# 代码和 SDK
install -d -m 755 /opt/agentdesk-orchestrator/wechat
install -m 644 orchestrator/wechat/*.js orchestrator/wechat/package*.json /opt/agentdesk-orchestrator/wechat/
(cd /opt/agentdesk-orchestrator/wechat && npm ci --omit=dev --ignore-scripts)
# 凭据（不进仓库）
install -m 640 -o root -g agentdesk orchestrator/wechat/wechat.env.example /etc/agentdesk-orchestrator/wechat.env   # 填 WECOM_BOT_ID / WECOM_BOT_SECRET
install -m 640 -o root -g agentdesk orchestrator/wechat/wechat.example.json /etc/agentdesk-orchestrator/wechat.json  # allowUsers 等
# 服务
install -m 644 orchestrator/agentdesk-wechat.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now agentdesk-wechat
journalctl -u agentdesk-wechat -f      # 应看到 wecom authenticated
```

改 `wechat.json` 或 `wechat.env` 后 `systemctl restart agentdesk-wechat`。

`wechat.json` 字段：`allowUsers`、`minQuotaPercent`（8）、`limits`、`sendPreview`（true）、`tiers`（覆盖各档 provider/model，见 `runner.js` 的 `DEFAULTS`）、`ask`（`/问` 用的模型）、`retention.days`（30）、`retention.draftDays`（3）、`deliveryRetry`。

## 8. 办公工具链

`install-office.sh`（root，可重复跑）：LibreOffice headless（单次转换峰值约 220 MB）、pandoc、Noto CJK 字体；`/opt/agentdesk-office/venv`（python-docx、openpyxl、python-pptx、XlsxWriter、pandas、matplotlib、pdfplumber）；`/opt/agentdesk-office/bin` 的 `office-convert`、`office-preview`、`xlsx-recalc`；执行规范 `/opt/agentdesk-office/GUIDE.md`。

## 9. 排障

| 现象 | 查 |
|---|---|
| 日志 `853000 invalid bot_id or secret` | `wechat.env` 的 Bot ID / Secret；后台重置过 Secret 要同步 |
| 日志 `disconnected_event` / 反复被踢 | 有别的程序用同一个 Bot ID 连着 |
| 发消息回「只对已登记的成员开放」 | 日志里 `denied user` 那行的 userid 加进 `allowUsers`，重启 |
| 🔑 需要重新登录 | 对应 CLI 在 `homes/<cli>` 的登录过期，与主控同一份 |
| 文件没收到 | `/看编号` 看「没发出去」；`journalctl -u agentdesk-wechat | grep delivery`；`/重发编号` |
| 任务细节 | `/var/lib/agentdesk-orchestrator/wechat/tasks/<id>/.logs/` |

日志只记消息类型、userid 哈希、文件扩展名和大小，不记消息正文。
