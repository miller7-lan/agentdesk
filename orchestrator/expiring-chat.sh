#!/bin/sh
set -eu
case "${1:-}" in
    ''|*[!0-9]*) exit 1 ;;
esac
remaining=$(($1 - $(date +%s)))
[ "$remaining" -gt 0 ] || exit 1
exec /usr/bin/timeout --foreground "$remaining" /opt/agentdesk-orchestrator/codex-desktop.sh
