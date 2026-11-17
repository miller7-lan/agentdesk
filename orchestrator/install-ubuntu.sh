#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run this installer as root.' >&2; exit 1; fi
node_bin="${AGENTDESK_NODE_BIN:-/usr/bin/node}"
if ! "$node_bin" -e 'require("node:sqlite"); if (+process.versions.node.split(".")[0] < 24) process.exit(1)'; then
  echo 'Install Node.js 24 or newer, then retry with AGENTDESK_NODE_BIN pointing to its executable.' >&2
  exit 1
fi
command -v git >/dev/null
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! id agentdesk >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/agentdesk-orchestrator --shell /bin/sh agentdesk
fi
install -d -m 0755 /opt/agentdesk-orchestrator
ln -sfn "$(realpath -- "$node_bin")" /opt/agentdesk-orchestrator/node
install -d -m 0750 -o root -g agentdesk /etc/agentdesk-orchestrator
install -d -m 0700 -o agentdesk -g agentdesk /var/lib/agentdesk-orchestrator
install -m 0644 "$source_dir"/*.js /opt/agentdesk-orchestrator/
install -m 0644 "$source_dir/agentdesk-orchestrator.service" /etc/systemd/system/
if [[ ! -e /etc/agentdesk-orchestrator/config.json ]]; then
  install -m 0640 -o root -g agentdesk "$source_dir/vps2.example.json" /etc/agentdesk-orchestrator/config.json
fi
systemctl daemon-reload
echo 'Configure CLI binaries, credentials, workspace mirror and Relay before enabling agentdesk-orchestrator.service.'
