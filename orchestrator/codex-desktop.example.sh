#!/bin/sh
set -eu

export HOME=/var/lib/agentdesk-orchestrator/homes/codex
export PATH=/opt/agentdesk-orchestrator:/usr/local/bin:/usr/bin:/bin
cd /var/lib/agentdesk-orchestrator/desktop-workspace
exec /usr/bin/codex app-server
