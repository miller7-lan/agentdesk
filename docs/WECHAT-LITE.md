# 微信办公助手（轻便版）

> 2026-11-23 起。取代 [WECHAT_OMC_PLAN.md](WECHAT_OMC_PLAN.md) 的重方案（OpenClaw + 容器 + 多 CLI 组队）。

在**个人微信**里给「办公助手」发 Word / Excel / PPT 和需求，VPS2 上全程处理，成品文件发回微信。不同步到桌面端，不碰 Mac/Windows，不经过主控调度器。

## 1. 怎么用

1. 发需求文字和文件，可以分多条发。消息先**攒进草稿**，不会马上执行。
2. 发「**开始**」：草稿里的全部文字（按顺序编号）和文件一次交给 AI。
3. 完成后收到成品文件和 1～3 句说明；PPT 另附第一页预览图。

| 命令 | 作用 |
|---|---|
| `开始` / `开始 高` | 执行草稿；可顺带指定档位 |
| `/低` `/中` `/高`（可带内容，如 `/高 写方案`） | 选档位；不选由组长判断 |
| `/清空` | 丢掉草稿（文字和文件） |
| `/ls` | 最近 10 个任务 |
| `/进 编号` | 回到老任务：之后的草稿「开始」时在该任务里接着改（同一执行者、同一会话，上一版成品作为输入） |
| `/新` | 退出老任务 |
| `/s 编号` · `/stop 编号` · `/重试 编号` | 详情 · 停止（运行中或排队中）· 失败/额度不够的任务重做 |
| `/help` | 用法 |

**一个任务结束后，再发的内容就是新任务**；要接着改老任务必须 `/进 编号`。

## 2. 三档

| 档位 | 流程 | 执行者 |
|---|---|---|
| 低 | 组长（Claude Opus，只读）规划一次 → 执行者做完 | Antigravity、Grok 里**剩余额度多的**；做的过程中额度用尽/掉登录时换另一个 |
| 中 | 同上 | Codex（GPT） |
| 高 | Opus 直接做（`/高` 跳过规划；自动判成高档时沿用规划会话接着做） | Claude Opus |

组长只规划，不验收、不中途干预。没指定档位时由组长判断。

**额度闸门**：开始规划前和选执行者时读额度（`orchestrator/quotas.js`，与桌面端同源，缓存 60 秒）。看 5 小时窗口，没有的看周额度。**剩余低于 8%**（`wechat.json` 的 `minQuotaPercent`）的 CLI 不用；组长或该档所有执行者都不够时，任务直接以「🪫 额度不够」结束并给出恢复时间，之后发 `/重试 编号`。读不到额度时不拦。

## 3. 架构

```
个人微信「企业微信」入口（微信插件） ⇄ 企业微信服务器
  ├─ 回调 https://<你的域名>:8443/wecom/callback ── Caddy ──▶ 127.0.0.1:9460
  └─ 主动 API qyapi.weixin.qq.com（出口 IP 在「企业可信 IP」）
agentdesk-wechat.service（User=agentdesk）
  wecom.js   回调验签/AES 解密、access_token、发文字/文件/图片、素材上传下载
  router.js  消息 → 动作（草稿、开始、档位、命令），纯函数
  quota.js   额度闸门
  runner.js  规划 + 执行（复用 adapters.runAdapter，bwrap 沙箱）
  store.js   tasks.json、草稿、去重、gc
  service.js HTTP 回调、排队（同时 1 个）、交付
```

- 每个任务一个目录 `/var/lib/agentdesk-orchestrator/wechat/tasks/<id>/`：`in/` 原件、`work/` 草稿、`out/` 交付（新文件会发回）、`.logs/` CLI 日志。目录是空 git 仓库（Codex 只在 git 仓库里干活）。
- CLI 登录与主控共用 `homes/<cli>`。Claude、Grok、Antigravity 在 bwrap 沙箱里运行，看不到状态目录的其它部分和 `/etc/agentdesk-*`；Codex 用自己的 workspace-write 沙箱。
- 办公规范 `/opt/agentdesk-office/GUIDE.md`，提示词要求先读。

## 4. 办公工具链

`orchestrator/wechat/install-office.sh`（root，可重复跑）安装：

- LibreOffice（headless，只在转换时启动，单次峰值约 220 MB）、pandoc、Noto CJK 字体；
- `/opt/agentdesk-office/venv`：python-docx、openpyxl、python-pptx、XlsxWriter、pandas、matplotlib、pdfplumber（版本见 `office/requirements.txt`）；
- `/opt/agentdesk-office/bin`：`office-convert`（格式互转）、`office-preview`（渲染 PNG 自查/预览）、`xlsx-recalc`（重算公式并报错误单元格）。

## 5. 部署

```sh
# 1. 工具链
sh orchestrator/wechat/install-office.sh
# 2. 代码
install -d -m 755 /opt/agentdesk-orchestrator/wechat
install -m 644 orchestrator/wechat/*.js /opt/agentdesk-orchestrator/wechat/
# 3. 配置（密钥不进仓库）
install -m 640 -o root -g agentdesk orchestrator/wechat/wechat.example.json /etc/agentdesk-orchestrator/wechat.json   # 然后填写
# 4. 服务
install -m 644 orchestrator/agentdesk-wechat.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now agentdesk-wechat
```

Caddy（`/etc/caddy/Caddyfile`，`<你的域名>:8443` 站点里）：

```
handle /wecom/* {
	reverse_proxy 127.0.0.1:9460
}
handle {
	reverse_proxy 127.0.0.1:9443 { header_up X-Real-IP {remote_host} }
}
```

Caddy 配置了 `admin off`，`systemctl reload caddy` 会失败，改配置后用 `systemctl restart caddy`（8443 上的站点断一两秒）。

`wechat.json` 字段：`corpId`、`agentId`、`secret`、`token`、`encodingAesKey`、`allowUsers`（企业微信 userid 白名单）、`listen`、`minQuotaPercent`（默认 8）、`sendPreview`（默认 true）、`tiers`（覆盖各档的 provider/model，见 `runner.js` 的 `DEFAULTS`）、`retention.days`（默认 30）、`retention.draftDays`（默认 3）。

### 企业微信后台

1. 应用管理 → 自建 → 创建应用，可见范围只选自己；记下 CorpID（我的企业页底部）、AgentId、Secret。
2. 应用详情 → 企业可信 IP：`<VPS2 公网 IP>`。
3. 应用详情 → 接收消息 → 设置 API 接收：URL `https://<你的域名>:8443/wecom/callback`，Token、EncodingAESKey 随机获取；**服务先启动，再点保存**（保存时企业微信发 GET 校验）。
4. 我的企业 → 微信插件：个人微信扫码关注。

第一次部署可以先跑探路服务 `sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/wechat/probe.js`：不调用 AI，验证收发文字/文件和 `/push 秒数` 主动推送；allowUsers 为空时日志会打印你的 userid。

## 6. 保留与清理

每小时 gc：任务目录和记录保留 **30 天**；没「开始」的草稿 3 天后丢弃。消息正文不写日志（只记类型、发送人、长度）。

## 7. 排障

| 现象 | 查 |
|---|---|
| 后台保存 URL 失败 | `journalctl -u agentdesk-wechat` 有无 `url verified`；`curl -I https://<你的域名>:8443/wecom/callback` 应为 400（缺签名）而不是 502 |
| 发消息没反应 | 日志里 `callback rejected`（Token/AESKey 不一致）；`send failed ... 60020`（可信 IP 没配） |
| 🔑 需要重新登录 | 对应 CLI 在 `homes/<cli>` 的登录过期，和主控同一份，按主控文档重新登录 |
| 任务细节 | `/var/lib/agentdesk-orchestrator/wechat/tasks/<id>/.logs/` |

## 8. 待验证（第 0 步）

- [ ] 回调 URL 用 8443 端口能否保存；域名有无备案/主体要求（不行时：443 按 SNI 分流，需与 AgentDesk 协调）
- [ ] 微信插件里能否给应用**发文件**（docx/xlsx/pptx）；不能时的备选：企业微信 App 里发文件、个人微信收结果
- [ ] 应用发的文件在个人微信里能否打开
- [ ] 主动推送（长任务完成通知）与频率限制
