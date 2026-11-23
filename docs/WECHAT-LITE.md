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

## 1. 用法

1. 发需求文字和文件，可以分多条发。消息先**攒进草稿**。
2. 发「**开始**」：草稿里的全部文字（按顺序编号）和文件一次交给 AI。机器人回「收到 #编号」，做完**主动推送**成品文件和说明；PPT 另附第一页预览图。

| 命令 | 作用 |
|---|---|
| `你好` | 打招呼，回用法 |
| `/问 问题` | 快问快答：便宜模型只读回答，不进草稿、不建任务 |
| `开始` / `开始 高` | 执行草稿；可顺带指定档位 |
| `/低` `/中` `/高`（可带内容） | 选档位；不选由组长判断 |
| `/清空` | 丢掉草稿 |
| `/ls` · `/s 编号` | 最近任务 · 详情（含没发出去的文件） |
| `/进 编号` · `/新` | 回到老任务接着改（同执行者同会话）· 退出 |
| `/stop 编号` · `/重试 编号` · `/重发 编号` | 停止 · 失败或额度不够的任务重做 · 再发一次成品文件 |

一个任务结束后，再发的内容就是新任务。

## 2. 三档与额度

| 档位 | 流程 | 执行者 |
|---|---|---|
| 低 | Claude Opus 组长只读规划一次 → 执行者做完 | Antigravity、Grok 里剩余额度多的；途中额度用尽/掉登录换另一个 |
| 中 | 同上 | Codex（GPT） |
| 高 | Opus 直接做 | Claude Opus |

开始前读额度（`orchestrator/quotas.js`，缓存 60 秒）：看 5 小时窗口，没有的看周额度；**剩余低于 8%** 的不用。组长或该档执行者都不够时直接回「🪫 额度不够」和恢复时间。读不到额度时不拦。

## 3. 身份、多人与权限

- **userid**（`frame.body.from.userid`）= 任务所有者。草稿、任务、文件目录、限流都按 userid 分开；`/s /进 /stop /重试 /重发` 只能操作自己的任务。
- **chatid** 只在群聊出现。**群里不处理任务和文件**；所有结果用主动推送发到所有者单聊（会话 ID 填 userid），不会发到群里或别人那里。
- **原始帧**只用于 24 小时内的被动回复（透传 `req_id`），不落盘。
- **白名单** `allowUsers`：为空时拒绝所有人。被拒的人收到固定回复，日志打印其 userid 以便登记。当前只登记管理员本人，模型订阅不对外开放。
- **限流**（`limits`）：每人每分钟 30 条消息、同时最多 2 个排队/执行中的任务、24 小时 20 个任务、`/问` 每小时 30 次。全局同时只执行 1 个任务。
- 微信里**没有** shell、root、本机 Bridge 或主控访问；AI 只在本任务的 bubblewrap 沙箱目录里读写。

## 4. 文件

- **收**：`message.file` / `message.image` → SDK `downloadFile(url, aeskey)` 解密 → 存到该用户的草稿目录。下载链接 5 分钟有效，最大 100MB；消息里没有文件名，取下载响应里的名字（去掉路径）。
- **发**：成品写在任务的 `out/`。交付前校验：docx/pptx/xlsx 必须是完整 zip 且含 `[Content_Types].xml` 和主部件（`word/document.xml` / `ppt/presentation.xml` / `xl/workbook.xml`），坏文件不发并说明。然后 `uploadMedia(buffer, {type:'file', filename})` 拿 `media_id`，`sendMediaMessage(userid, 'file', media_id)` 主动推送。
- **限制**：SDK 分片 512KB × 最多 100 片（约 50MB）；官方文档普通文件 20MB、图片 10MB，本服务按 **20MB** 卡，超出不上传并告知。`media_id` 3 天有效。
- **失败**：每个文件最多试 3 次（2 秒、8 秒退避，断线时等重连最多 2 分钟）；结果记在任务的 `deliveries`。发送失败可以 `/重发 编号`，文件仍在 `out/` 里（保留 30 天）。

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
  router.js   消息 → 动作（草稿、开始、档位、命令），纯函数
  quota.js    额度闸门
  runner.js   规划 + 执行（复用 adapters.runAdapter + bwrap 沙箱）
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
| 文件没收到 | `/s 编号` 看「没发出去」；`journalctl -u agentdesk-wechat | grep delivery`；`/重发 编号` |
| 任务细节 | `/var/lib/agentdesk-orchestrator/wechat/tasks/<id>/.logs/` |

日志只记消息类型、userid 哈希、文件扩展名和大小，不记消息正文。
