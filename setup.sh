#!/usr/bin/env bash
# takeoff VM セットアップ(Ubuntu 22.04)。リポジトリ直下で実行: bash setup.sh
set -euo pipefail
DOMAIN="a1-takeoff.duckdns.org"
APPDIR="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="$(whoami)"

echo "== apt 更新 =="
sudo apt-get update -y

echo "== Node.js 20 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== rclone =="
if ! command -v rclone >/dev/null 2>&1; then
  curl -fsSL https://rclone.org/install.sh | sudo bash
fi
rclone version | head -1

echo "== Caddy(HTTPS自動) =="
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "== Caddyfile =="
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
    reverse_proxy localhost:5050
}
EOF
sudo systemctl restart caddy

echo "== .env =="
if [ ! -f "$APPDIR/.env" ]; then
  cp "$APPDIR/.env.example" "$APPDIR/.env"
  SECRET="$(openssl rand -hex 32)"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" "$APPDIR/.env"
  sed -i "s|^RCLONE_CONF=.*|RCLONE_CONF=/home/$USER_NAME/.config/rclone/rclone.conf|" "$APPDIR/.env"
  echo ">>> $APPDIR/.env を作成しました。ALLOWLIST / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を記入してください。"
else
  echo "(.env は既存。そのまま使用)"
fi

echo "== systemd (takeoff.service) =="
sudo tee /etc/systemd/system/takeoff.service >/dev/null <<EOF
[Unit]
Description=takeoff app
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=$APPDIR
ExecStart=/usr/bin/node $APPDIR/server.js
Restart=always
User=$USER_NAME
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable takeoff

echo ""
echo "== セットアップ完了 =="
echo "次の手順:"
echo "  1) nano $APPDIR/.env  … ALLOWLIST / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を記入"
echo "  2) sudo systemctl restart takeoff   … この時点で https://$DOMAIN にログインできるか確認(現場一覧は空でOK)"
echo "  3) Drive(サービスアカウント)設定 → rclone リモート gdrive を作成 → 再度 restart"
echo "ログ確認: journalctl -u takeoff -f"
