#!/bin/sh
set -eu

export HOME=/var/lib/agentdesk-orchestrator/homes/codex
export PATH=/opt/agentdesk-orchestrator:/usr/local/bin:/usr/bin:/bin
cd /var/lib/agentdesk-orchestrator/desktop-workspace
# 与群组步骤的 `codex --search exec` 一致：app-server 没有 --search 开关，
# 用同一项配置开启实时联网搜索（只读，不会写文件）。
exec /usr/bin/codex -c 'web_search="live"' app-server
