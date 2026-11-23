#!/usr/bin/env bash
# One-time setup of the demo on a fresh Ubuntu 24.04 server (run as root).
# Runs Temporal, the quote desk (worker + API, mock model) and the web app behind Caddy on port 80.
set -euo pipefail
APP=/opt/dhruva
REPO=https://github.com/narayananramu/dhruva-quote-desk.git

# Swap, so builds fit in 2 GB of RAM
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq curl git build-essential python3 debian-keyring debian-archive-keyring apt-transport-https gnupg

# Node 22 and pnpm
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
corepack enable
corepack prepare pnpm@latest --activate

# Temporal CLI (dev server)
if ! command -v temporal >/dev/null; then
  curl -sSf https://temporal.download/cli.sh | sh -s -- --dir /usr/local
fi

# Caddy
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

# ngrok
if ! command -v ngrok >/dev/null; then
  curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc > /etc/apt/trusted.gpg.d/ngrok.asc
  echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" > /etc/apt/sources.list.d/ngrok.list
  apt-get update -q && apt-get install -yq ngrok
fi

# App
id dhruva >/dev/null 2>&1 || useradd -r -m -d /var/lib/dhruva -s /usr/sbin/nologin dhruva
if [ -d $APP/.git ]; then git -C $APP pull --ff-only; else git clone $REPO $APP; fi
cd $APP
pnpm install --frozen-lockfile
(cd web && VITE_API_URL=/api pnpm build)
chown -R dhruva:dhruva $APP
mkdir -p /var/lib/dhruva && chown dhruva:dhruva /var/lib/dhruva

cat > /etc/systemd/system/dhruva-temporal.service <<'EOF'
[Unit]
Description=Temporal dev server for the Dhruva demo
After=network.target
[Service]
User=dhruva
ExecStart=/usr/local/temporal server start-dev --headless --ip 127.0.0.1 --db-filename /var/lib/dhruva/temporal.db
Restart=always
[Install]
WantedBy=multi-user.target
EOF
# The installer puts the binary at /usr/local/temporal or /usr/local/bin/temporal
T=$(command -v temporal || echo /usr/local/temporal); sed -i "s#/usr/local/temporal #$T #" /etc/systemd/system/dhruva-temporal.service

cat > /etc/systemd/system/dhruva-app.service <<EOF
[Unit]
Description=Dhruva quote desk (worker + API)
After=dhruva-temporal.service
Requires=dhruva-temporal.service
[Service]
User=dhruva
WorkingDirectory=$APP
Environment=QUOTE_MODEL=mock
Environment=AI_PRICE_MOCK_INR_PER_M=410
Environment=QUOTE_DB=/var/lib/dhruva/quote-agent.db
Environment=PORT=3000
ExecStartPre=/bin/sleep 5
ExecStart=$APP/node_modules/.bin/tsx src/dev.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
:80 {
  handle_path /api/* {
    reverse_proxy 127.0.0.1:3000
  }
  handle {
    root * $APP/web/dist
    try_files {path} /index.html
    file_server
  }
}
EOF

cat > /etc/systemd/system/dhruva-ngrok.service <<'EOF'
[Unit]
Description=ngrok tunnel to the Dhruva demo
After=network-online.target caddy.service
Wants=network-online.target
[Service]
ExecStart=NGROK_BIN http 80 --url NGROK_URL --config /etc/ngrok/ngrok.yml --log stdout
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF

sed -i "s#NGROK_BIN#$(command -v ngrok)#; s#NGROK_URL#${NGROK_URL:?set NGROK_URL to your ngrok domain}#" /etc/systemd/system/dhruva-ngrok.service

# Fresh demo every night at 03:00 IST
cat > /etc/cron.d/dhruva-reset <<'EOF'
CRON_TZ=Asia/Kolkata
0 3 * * * root curl -s -X POST -H 'x-demo-user: professor' http://127.0.0.1:3000/settings/reset >/dev/null
EOF

systemctl daemon-reload
systemctl enable --now dhruva-temporal dhruva-app
systemctl restart caddy
[ -f /etc/ngrok/ngrok.yml ] && systemctl enable --now dhruva-ngrok || echo "Put the ngrok config at /etc/ngrok/ngrok.yml, then: systemctl enable --now dhruva-ngrok"
echo done
