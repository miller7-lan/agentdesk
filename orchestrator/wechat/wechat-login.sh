#!/bin/sh
# 微信 ClawBot 扫码登录的短命令（root 运行）。
#   wechat-login        主 ClawBot（/var/lib/agentdesk-orchestrator/wechat）
#   wechat-login 2      另开的 ClawBot 2（wechat-2，服务 agentdesk-wechat@2）
# 其余参数原样传给 login.js（如 --force）。登录成功后自动重启对应服务。
set -eu
name=""
case "${1:-}" in [0-9a-z]*) name=$1; shift ;; esac
dir=/var/lib/agentdesk-orchestrator/wechat${name:+-$name}
unit=agentdesk-wechat${name:+@$name}
sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/wechat/login.js --dir "$dir" "$@"
if [ -f "$dir/ilink-account.json" ]; then systemctl restart "$unit" && echo "已重启 $unit"; fi
