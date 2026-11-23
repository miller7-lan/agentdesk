#!/bin/sh
# 安装微信办公助手的办公工具链（root 执行，可重复跑）。
#   apt：LibreOffice（headless 转换/重算/预览）、pandoc、Noto CJK 字体
#   /opt/agentdesk-office/venv：固定版本的 Python 办公库
#   /opt/agentdesk-office/bin：office-convert / office-preview / xlsx-recalc
#   /opt/agentdesk-office/GUIDE.md：给执行者的办公规范
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=/opt/agentdesk-office

apt-get install -y --no-install-recommends \
  libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
  pandoc fonts-noto-cjk python3-venv poppler-utils

install -d -m 755 "$root" "$root/bin"
[ -x "$root/venv/bin/python3" ] || python3 -m venv "$root/venv"
"$root/venv/bin/pip" install --quiet --disable-pip-version-check -r "$here/office/requirements.txt"
install -m 755 "$here"/office/bin/* "$root/bin/"
install -m 644 "$here/office/GUIDE.md" "$root/GUIDE.md"
chown -R root:root "$root"
echo "office toolchain ready at $root"
