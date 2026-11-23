#!/bin/bash
# AgentDesk: daily official update of the model CLIs, then refresh the model catalog.
# Installed 2026-11-21; logs go to the journal (agentdesk-cli-update.service).
# Source of truth: orchestrator/agentdesk-cli-update.sh in the agentdesk repo; install to /usr/local/sbin/agentdesk-cli-update.
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
umask 022

exec 9>/run/agentdesk-cli-update.lock
if ! flock -n 9; then
  echo "agentdesk-cli-update: another run is in progress"
  exit 0
fi

status=0
version_of() { timeout 20 "$1" --version 2>/dev/null | head -1; }
update_one() {
  local name="$1" bin="$2"; shift 2
  local before after rc
  before="$(version_of "$bin")"
  echo "[$name] before: ${before:-unknown}"
  timeout 900 "$bin" "$@"
  rc=$?
  after="$(version_of "$bin")"
  echo "[$name] after: ${after:-unknown} (exit $rc)"
  if [ "$rc" -ne 0 ]; then
    echo "[$name] update failed; the installed version is kept" >&2
    status=1
  fi
}

update_one codex /usr/bin/codex update
update_one claude /usr/bin/claude update
update_one grok /usr/local/bin/grok update
update_one agy /usr/local/bin/agy update

# The Grok updater stages the release under $HOME/.grok/bin; the orchestrator runs /usr/local/bin/grok.
if [ -x /root/.grok/bin/grok ]; then
  staged="$(version_of /root/.grok/bin/grok)"
  current="$(version_of /usr/local/bin/grok)"
  if [ -n "$staged" ] && [ "$staged" != "$current" ]; then
    if install -m 0755 /root/.grok/bin/grok /usr/local/bin/.grok.new && mv -f /usr/local/bin/.grok.new /usr/local/bin/grok; then
      echo "[grok] installed staged update: ${staged} (was ${current:-unknown})"
    else
      rm -f /usr/local/bin/.grok.new
      echo "[grok] could not install the staged update" >&2
      status=1
    fi
  fi
fi
# Keep the vendor download cache bounded (two newest releases).
find /root/.grok/downloads -maxdepth 1 -type f -name "grok-*" -printf "%T@ %p\n" 2>/dev/null | sort -rn | tail -n +3 | cut -d" " -f2- | xargs -r rm -f

# Re-read each CLI catalog through the running orchestrator (same account/environment as tasks).
ADMIN="/opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/admin.js /var/lib/agentdesk-orchestrator/admin.sock"
if out=$(sudo -u agentdesk $ADMIN catalog 2>&1); then
  echo "[catalog] refreshed: $out"
else
  echo "[catalog] refresh failed: $out" >&2
  status=1
fi

exit "$status"
