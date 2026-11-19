# 模型选择与本机文件

## 在 AgentDesk 选模型

- Codex 单聊通过 VPS 上的 Codex app-server 读取 GPT 模型列表，模型、推理强度和速度仍由 Codex 提供。
- Claude Code、Grok Build、Antigravity 单聊从 VPS2 的 `adapters.<供应商>.models` 读取候选模型。每个单聊记住各自的选择，发送和生成项目补丁时都传入所选模型。新会话优先选配置里的 `defaultModel`，其次第一个模型；选择「默认模型（CLI）」才使用 CLI 自带的默认模型。
- 配置顶层打开 `"discoverModels": true` 时，主控启动后和每 24 小时会用当前登录账号运行 `codex debug models`、`grok models`、`agy models`，自动刷新模型档案：账号新出现的模型（例如 Gemini 4）会加入，已下架的 Gemini 模型会从运行时候选中移除，失效的默认模型会自动换成一个仍可用的。配置里手写的 `strengths`、`label`、`billing` 和价格会保留，只自动补充没有说明的新模型。CLI 登录变化不需要改配置或重启主控；Claude Code 没有模型列表命令，仍使用配置里的档案。
- 每个模型可配置 `label`（下拉框显示名）、`efforts`（该模型支持的推理强度）和 `defaultEffort`。单聊会按所选模型显示推理强度下拉框，并在 `turn/start` 时传给 CLI：Claude 同时设置 `CLAUDE_CODE_EFFORT_LEVEL` 并传 `--effort`（`low`/`medium`/`high`/`xhigh`/`max`），Grok 用 `--effort`（最高 `xhigh`），Antigravity 的模型 ID 已包含档位（如 `gemini-3.8-flash-medium`），CLI 不接受与 ID 冲突的 `--effort`，因此只在档位与 ID 后缀一致时才传。未配置 `efforts` 的模型不显示该下拉框；模型的 `efforts` 会覆盖角色级设置，模型没有声明时沿用角色级设置。群聊里由组长为每个成员选择模型和推理强度，composer 的「组长思考」只控制组长自己的档位。
- 群聊点名成员后，模型 ID 输入框会提示该成员的已配置模型。组长自动分派时使用主控已有的分工与模型规则。
- 当前 VPS2 的 Grok 订阅经 `grok models` 确认提供 `grok-4.7`、`grok-4.7-build-fast`、`grok-4.6`、`grok-4.5`。Claude Code 使用具体版本 ID `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`、`claude-fable-5-1`。Antigravity 当前账号经 `agy models` 提供 `gemini-3.8-flash-high`、`gemini-3.8-flash-medium`、`gemini-3.8-flash-low`（另有 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`，自动发现只采纳 Gemini 组，因为额度按 Gemini 窗口计算）。Gemini 4 是否出现取决于登录账号和 CLI 版本：换上有权限的账号后，`agy models` 会列出新的 `gemini-4-*`，主控自动加入，不需要再写占位 ID。旧 Gemini CLI 已退出当前部署。

## 给 VPS2 增加模型

Codex、Grok、Antigravity 有 `discoverModels` 自动刷新时，`models` 主要用于手写说明和离线兜底；只有给 Claude Code 增加模型、或想固定/覆盖某个自动发现列表时才需要手工编辑。编辑 `/etc/agentdesk-orchestrator/config.json` 中对应 adapter，保留原有路径、凭证和模板。例如在 Claude adapter 增加：

```json
{
  "defaultModel": "claude-sonnet-5-5",
  "models": {
    "claude-sonnet-5-5": {
      "label": "Sonnet 5.5",
      "strengths": "日常编码与审查",
      "billing": "subscription",
      "efforts": ["low", "medium", "high", "xhigh", "max"],
      "defaultEffort": "medium"
    },
    "claude-opus-5-5": {
      "label": "Opus 5.5",
      "strengths": "复杂实现与深度分析",
      "billing": "subscription",
      "efforts": ["low", "medium", "high", "xhigh", "max"],
      "defaultEffort": "high"
    }
  }
}
```

`efforts` 只填写该 CLI 和模型实际接受的档位，`defaultEffort` 必须出现在 `efforts` 中；校验失败时主控会拒绝启动。Grok 只接受 `low`、`medium`、`high`、`xhigh`。有实际 API 计费时按 [主控运维说明](../orchestrator/OPERATIONS.md) 填真实价格。修改后按 [部署说明](DEPLOY.md) 校验配置并重启主控，桌面端重新打开单聊即可读取列表。

## 读取与修改本机文件

- 「对话与查看」通过 Bridge 读取已授权目录，不要求 Git 工作区干净。
- 组长还可以读取本机任意文件夹：在 Bridge 配置顶层加 `"readAnyFolder": true` 并重启 Bridge，组长的 `windows_list_locations` 会出现只读的 `computer` 位置，可用绝对路径（`~` 为家目录）列目录、搜索、grep 和读文件。该位置不提供写入或命令，并拒绝系统目录、凭据目录、`.git` 和常见凭据文件；其他成员看不到也用不了。VPS2 主控和桌面端 Bridge 都需要本次更新。
- 「修改项目文件」使用所选模型生成项目补丁。项目必须绑定到正确的 Bridge 工作区，并有干净的 Git 基线。查看补丁并确认后才写回本机。
- Windows 的非 Codex 单聊可选「修改本机文件」。用「选目录」可在桌面或 C/D 盘允许的位置新建一个文件或文件夹。用「选文件」可读取并替换所选的 UTF-8 文本文件，单个文件和新内容均限 2 KB。文件内容会发给所选 CLI。模型返回建议后，点「查看并确认本机操作」核对路径和内容，再在系统对话框确认。目标变更后需重新选择。此入口不支持批量改动、删除、移动或重命名。
- 「修改项目文件」被工作区绑定限制拦下时，输入框保留草稿，并提供切换到「对话与查看」或「修改本机文件」的按钮。切换后再发送即可。

## 发送附件

独立 SSH 单聊也支持原文件附件。Windows 和 Mac 使用同一个附件入口，每条最多 3 个，每个不超过 10 MB。支持任意扩展名，解析能力由模型决定。VPS2 有可用的 bubblewrap 时，附件进入本轮的只读目录，轮次结束后清理。独立单聊默认「每步询问」。

在可发言的单聊点击「附件」选择原始文件。非 Codex 单聊每条消息最多 3 个文件，每个不超过 10 MB，选择器不限制扩展名。可先添加说明再发送，也可只发送附件。发送前可以点文件名旁的 × 移除。

Bridge 会把选定文件传到该任务的独立输入目录并校验内容，项目补丁不会包含这些副本。图片、PDF、办公文件、压缩包等能否解析取决于所选 CLI 和模型。非 Codex 单聊添加图片请通过「附件」选择文件。未发送的附件随应用退出清除，本机已发送副本由 Bridge 在约 24 小时后清理，VPS 副本随任务工作目录按主控保留规则清理。Mac 端需同步更新应用、Bridge 和 VPS2。

## Mac 同步更新

1. VPS2 与 Mac 应用应使用同一提交。先更新 VPS2，再在 Mac 的 AgentDesk 仓库运行 `git pull --ff-only` 和 `npm ci`。
2. 按 [Mac Bridge 部署](DEPLOY.md#3-mac-端) 重启 launchd 服务。用 Apple Silicon 打包时运行 `npm run dist:mac -- --arm64`，将生成的 AgentDesk.app 覆盖至 Applications。已有项目、SSH 指纹和 Bridge 配置继续使用。
3. 核对 Mac 的 Bridge 配置中工作区根目录、`write: true` 与项目绑定一致。要允许单聊读取桌面，可在对应工作区配置 `readRoots.desktop`，指向真实桌面路径。项目写入仍经补丁确认。
4. 打开成员单聊选择模型，先读一个测试文件，再生成项目补丁并预览。Windows 的项目外变更入口目前仅适用于 C/D 盘，Mac 使用工作区补丁流程。

配置了真实工作区后，侧栏自动移除内置示例项目。右键真实项目并选「删除项目」只移除 AgentDesk 中的项目入口。

模型资料：[Claude Code 模型配置](https://code.claude.com/docs/en/model-config) · [Grok Build 模型设置](https://docs.x.ai/build/settings)。
