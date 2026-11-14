#!/usr/bin/env bash
set -euo pipefail

# Set this to the absolute path of the Codex CLI already configured for codexdev.
codex_bin=/usr/local/bin/codex
# Set to true after configuring the optional Windows SSH MCP server in Codex.
enable_windows_ssh_mcp=false
if [[ "$enable_windows_ssh_mcp" == true ]]; then
  exec "$codex_bin" \
    -c 'mcp_servers.ssh.enabled=true' \
    -c 'mcp_servers.ssh.default_tools_approval_mode="prompt"' \
    -c 'mcp_servers.ssh.enabled_tools=["ssh_exec"]' \
    app-server
fi
exec "$codex_bin" app-server
