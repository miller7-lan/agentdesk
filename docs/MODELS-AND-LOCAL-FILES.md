# 模型选择与本机文件

## 在 AgentDesk 选模型

- Codex 单聊通过 VPS 上的 Codex app-server 读取 GPT 模型列表，模型、推理强度和速度仍由 Codex 提供。
- Claude Code、Grok Build、Antigravity 单聊从 VPS2 的 `adapters.<供应商>.models` 读取候选模型。每个单聊记住各自的选择，发送和生成项目补丁时都传入所选模型。选择「默认」会使用 CLI 的默认模型。
- 群聊点名成员后，模型 ID 输入框会提示该成员的已配置模型。组长自动分派时使用主控已有的分工与模型规则。
- 当前 VPS2 的 Grok 订阅经 `grok models` 确认提供 `grok-4.7`、`grok-4.7-build-fast`、`grok-4.6`、`grok-4.5`。Claude Code 配置 `opus`、`sonnet`、`haiku` 别名，具体版本由 Claude CLI 和账号决定。Antigravity 待登录，登录后用 `agy models` 核对配置中的模型 ID。旧 Gemini CLI 已退出当前部署。

## 给 VPS2 增加模型

编辑 `/etc/agentdesk-orchestrator/config.json` 中对应 adapter，保留原有路径、凭证和模板。例如在 Claude adapter 增加：

```json
{
  "models": {
    "opus": { "strengths": "复杂实现与深度分析", "billing": "subscription" },
    "sonnet": { "strengths": "日常编码与审查", "billing": "subscription" },
    "haiku": { "strengths": "快速查询和简要分析", "billing": "subscription" }
  }
}
```

有实际 API 计费时按 [主控运维说明](../orchestrator/OPERATIONS.md) 填真实价格。修改后按 [部署说明](DEPLOY.md) 校验配置并重启主控，桌面端重新打开单聊即可读取列表。

## 读取与修改本机文件

- 「对话与查看」通过 Bridge 读取已授权目录，不要求 Git 工作区干净。
- 「修改项目文件」使用所选模型生成项目补丁。项目必须绑定到正确的 Bridge 工作区，并有干净的 Git 基线。查看补丁并确认后才写回本机。
- Windows 的非 Codex 单聊可选「修改本机文件」。用「选目录」可在桌面或 C/D 盘允许的位置新建一个文件或文件夹。用「选文件」可读取并替换所选的 UTF-8 文本文件，单个文件和新内容均限 2 KB。文件内容会发给所选 CLI。模型返回建议后，点「查看并确认本机操作」核对路径和内容，再在系统对话框确认。目标变更后需重新选择。此入口不支持批量改动、删除、移动或重命名。

## Mac 同步更新

1. VPS2 与 Mac 应用应使用同一提交。先更新 VPS2，再在 Mac 的 AgentDesk 仓库运行 `git pull --ff-only` 和 `npm ci`。
2. 按 [Mac Bridge 部署](DEPLOY.md#3-mac-端) 重启 launchd 服务。用 Apple Silicon 打包时运行 `npm run dist:mac -- --arm64`，将生成的 AgentDesk.app 覆盖至 Applications。已有项目、SSH 指纹和 Bridge 配置继续使用。
3. 核对 Mac 的 Bridge 配置中工作区根目录、`write: true` 与项目绑定一致。要允许单聊读取桌面，可在对应工作区配置 `readRoots.desktop`，指向真实桌面路径。项目写入仍经补丁确认。
4. 打开成员单聊选择模型，先读一个测试文件，再生成项目补丁并预览。Windows 的项目外变更入口目前仅适用于 C/D 盘，Mac 使用工作区补丁流程。

配置了真实工作区后，侧栏自动移除内置示例项目。右键真实项目并选「删除项目」只移除 AgentDesk 中的项目入口。

模型资料：[Claude Code 模型配置](https://code.claude.com/docs/en/model-config) · [Grok Build 模型设置](https://docs.x.ai/build/settings)。
