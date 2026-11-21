#!/bin/sh
set -eu

export HOME=/var/lib/agentdesk-orchestrator/homes/codex
export PATH=/opt/agentdesk-orchestrator:/usr/local/bin:/usr/bin:/bin
# D13: a device whose key line injects AGENTDESK_DEVICE and that is switched to direct chat v2 works in its own
# rebuilt folder (direct-chat/<deviceId>/codex-workspace). Every other key keeps the old shared folder, which is
# left exactly as it is. An unapproved or revoked device is refused.
workspace=/var/lib/agentdesk-orchestrator/desktop-workspace
if [ -n "${AGENTDESK_DEVICE:-}" ]; then
  workspace="$(/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/device-registry.js codex-workspace)" || exit 1
fi
cd "$workspace"
# 与群组步骤的 `codex --search exec` 一致：app-server 没有 --search 开关，
# 用同一项配置开启实时联网搜索（只读，不会写文件）。
exec /usr/bin/codex -c 'web_search="live"' app-server
