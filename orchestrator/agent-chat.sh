#!/bin/sh
# SSH 强制命令：只接受 claude / grok / antigravity，启动对应 provider 的单聊服务。
set -eu

[ "$#" -eq 1 ] || { echo "agent-chat: expected exactly one provider" >&2; exit 2; }
provider="$1"
case "$provider" in
  claude|grok|antigravity) ;;
  *) echo "agent-chat: provider must be claude, grok or antigravity" >&2; exit 2 ;;
esac

umask 077
STATE_DIR="${AGENTDESK_CHAT_STATE:-/var/lib/agentdesk-orchestrator}"
case "$provider" in
  grok) HOME="$STATE_DIR/homes/grok-chat" ;;
  *) HOME="$STATE_DIR/homes/$provider" ;;
esac
export HOME
export PATH="/opt/agentdesk-orchestrator:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$HOME" "$STATE_DIR/chat-workspace"
cd "$STATE_DIR/chat-workspace"

NODE="${AGENTDESK_CHAT_NODE:-/opt/agentdesk-orchestrator/node}"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
[ -n "$NODE" ] || { echo "agent-chat: node not found" >&2; exit 1; }

exec "$NODE" /opt/agentdesk-orchestrator/chat-server.js "$provider"