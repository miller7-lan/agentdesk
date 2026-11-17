#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ ${EUID} != 0 || $# != 3 ]]; then
  echo "Usage: sudo bash $0 TLS_FULLCHAIN TLS_KEY DEVICES_JSON" >&2
  exit 2
fi

source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
service_name=agentdesk-relay
config=/etc/agentdesk-relay
code=/opt/agentdesk-relay
cert=$1
key=$2
devices=$3

# Validate the proposed inputs before changing the installation.
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$source_dir" /usr/bin/python3 - "$cert" "$key" "$devices" <<'PY'
import ssl
import sys
from pathlib import Path
from state import load_devices

if sys.version_info < (3, 10):
    sys.exit("Python 3.10 or newer required")
ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(*sys.argv[1:3])
load_devices(Path(sys.argv[3]))
PY

if ! id "$service_name" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$service_name"
fi
install -d -m 0750 -o root -g "$service_name" "$config"
install -d -m 0755 "$code"
install -m 0644 "$source_dir/"{server,protocol,state}.py "$code/"
if [[ ! -e "$config/listen.env" ]]; then
  install -m 0644 "$source_dir/listen.env.example" "$config/listen.env"
fi

stage=$(mktemp -d "$config/.install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
install -m 0640 -o root -g "$service_name" "$cert" "$stage/tls.crt"
install -m 0640 -o root -g "$service_name" "$key" "$stage/tls.key"
install -m 0640 -o root -g "$service_name" "$devices" "$stage/devices.json"
mv -f -- "$stage/"{tls.crt,tls.key,devices.json} "$config/"

install -d -m 0755 "/etc/systemd/journald@$service_name.conf.d"
install -m 0644 "$source_dir/journald.conf" "/etc/systemd/journald@$service_name.conf.d/limits.conf"
install -m 0644 "$source_dir/$service_name.service" "/etc/systemd/system/$service_name.service"
systemctl daemon-reload
systemctl enable "$service_name.service"
systemctl restart "$service_name.service"
systemctl is-active "$service_name.service"
