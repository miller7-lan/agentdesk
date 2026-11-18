# Agent HUD 机器人引擎（第三方代码）

来源：[jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open)，提交 `557615f`（2026-11-18），Apache License 2.0，许可证全文见同目录 [LICENSE](LICENSE)。

## 这里有什么

| 文件 | 内容 |
|---|---|
| `agent-hud-bots.js` | `src/packages/hud/src/bots/` 下的程序化机器人引擎（`bot-*.ts`、`mark-painter.ts` 等），用 esbuild 原样打包成浏览器脚本（IIFE，全局名 `AgentHudBots`） |
| `entry.ts` | AgentDesk 写的包装层，**不是**上游代码：用普通 DOM 挂载取代上游的 React `BotMark` 组件，并从 `artwork.js` 读取 logo |
| `artwork.js` | 上游 `src/packages/hud/src/assets/` 里的 `chatgpt.png`、`grok.png`、`antigravity.png`、`claude.png`，未改动，转成 data URL 内嵌（在 `file://` 页面里，直接加载的图片画到画布后不能读回像素，而引擎要读像素来生成机器人） |

## 对上游的改动

- 没有改动引擎源码；只新增了包装层 `entry.ts`。
- 上游按品牌给 logo 着色的规则（OpenAI 绿 `#10a37f`，Grok 跟随前景色）在 `entry.ts` 里重新写了一遍，因为上游的 `agent-artwork.ts` 依赖打包器的资源地址。

## 没有拿的

- **Clawd 的精灵图**（上游 `clawd-sprites.json`）：它是 Anthropic 的美术作品，版权归 Anthropic PBC 所有，上游明确说明不在其许可范围内。我们从不加载它，打包结果里也不包含它。组长 Clawd 继续使用 `src/avatars.js` 里 AgentDesk 自己的绘制。
- 各家 logo 是其所有者的商标，仅用于标示对应的 AI。

## 哪些成员用这个引擎

`src/avatars.js` 的 `HUD` 表：Codex（OpenAI 造型）、Grok Build、Antigravity、Claude Code（Claude 造型）。组长 Clawd、本机、Gemini 和“你”仍由 `src/avatars.js` 自己绘制。

## 重新打包

```sh
git clone https://github.com/jazzenchen/agent-hud-open && (cd agent-hud-open && git checkout 557615f)
npm i esbuild@0.24.0
# 把 entry.ts 里的 "agent-hud-open/src/..." 改成克隆目录的实际路径
npx esbuild entry.ts --bundle --format=iife --global-name=AgentHudBots --target=chrome120 --legal-comments=inline --outfile=agent-hud-bots.js
```

打包后确认没有包含精灵图数据：`grep -c clawd-sprites agent-hud-bots.js` 应输出 `0`。
