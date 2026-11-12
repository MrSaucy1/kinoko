#!/usr/bin/env bash
# Installs Kinoko on Debian 12/13 or Ubuntu 22.04+ (container, VM or bare metal).
#
# The repository is private, so run this from a clone:
#
#   git clone https://github.com/MrSaucy1/kinoko.git && sudo bash kinoko/install/install.sh
#
# Environment:
#   KINOKO_REPO    git URL, only used when not run from a clone
#   KINOKO_TOKEN   optional GitHub token (read access) so "Kinoko bijwerken" in
#                  the admin GUI can pull updates from the private repository
#   KINOKO_PORT    port to listen on (default: 8096)
set -euo pipefail

REPO="${KINOKO_REPO:-https://github.com/MrSaucy1/kinoko.git}"
PORT="${KINOKO_PORT:-8096}"
TOKEN="${KINOKO_TOKEN:-}"
DIR=/opt/kinoko
DATA=/var/lib/kinoko
# The checkout this script lives in, if any.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
[ -f "$SRC/server/package.json" ] || SRC=""

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Voer dit script uit als root."; exit 1; }
command -v apt-get >/dev/null || { echo "Dit script ondersteunt alleen Debian en Ubuntu."; exit 1; }

say "Pakketten installeren (ffmpeg, git, videodrivers)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git ffmpeg sudo gnupg >/dev/null
# Hardware transcoding drivers; harmless when there is no GPU. Names differ per release.
for pkg in vainfo intel-media-va-driver-non-free intel-media-va-driver mesa-va-drivers; do
  apt-get install -y -qq "$pkg" >/dev/null 2>&1 || true
done

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Node.js 22 installeren…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

say "Gebruiker en mappen aanmaken…"
id kinoko >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin kinoko
for grp in video render; do getent group "$grp" >/dev/null && usermod -aG "$grp" kinoko; done
mkdir -p "$DATA"
chown -R kinoko:kinoko "$DATA"

if [ -n "$SRC" ] && [ "$SRC" != "$DIR" ]; then
  say "Kinoko kopiëren vanuit $SRC…"
  mkdir -p "$DIR"
  # Replace the code, keep nothing stale; user data lives in $DATA, not here.
  find "$DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$SRC/." "$DIR/"
  rm -rf "$DIR/server/node_modules" "$DIR/data"
elif [ -d "$DIR/.git" ]; then
  say "Bestaande installatie bijwerken…"
  chown -R kinoko:kinoko "$DIR"
  sudo -u kinoko git -C "$DIR" pull --ff-only
else
  say "Kinoko ophalen van $REPO…"
  if [ -n "$TOKEN" ]; then git clone --depth 1 "${REPO/https:\/\//https://x-access-token:$TOKEN@}" "$DIR"; else git clone --depth 1 "$REPO" "$DIR"; fi
fi
chown -R kinoko:kinoko "$DIR"
chmod 750 "$DIR"
if [ -n "$TOKEN" ] && [ -d "$DIR/.git" ]; then
  # Stored in the checkout's git config, readable by the kinoko user only.
  sudo -u kinoko git -C "$DIR" remote set-url origin "${REPO/https:\/\//https://x-access-token:$TOKEN@}"
  chmod 600 "$DIR/.git/config"
fi

say "Afhankelijkheden installeren…"
(cd "$DIR/server" && sudo -u kinoko npm ci --omit=dev --no-audit --no-fund >/dev/null)

say "Beheerhulp en service instellen…"
install -m 755 "$DIR/install/kinoko-helper" /usr/local/bin/kinoko-helper
cat > /etc/sudoers.d/kinoko <<SUDO
# The Kinoko server may run its root helper, and nothing else.
kinoko ALL=(root) NOPASSWD: /usr/local/bin/kinoko-helper
SUDO
chmod 440 /etc/sudoers.d/kinoko
visudo -cf /etc/sudoers.d/kinoko >/dev/null

cat > /etc/systemd/system/kinoko.service <<UNIT
[Unit]
Description=Kinoko media server
After=network-online.target
Wants=network-online.target

[Service]
User=kinoko
Group=kinoko
WorkingDirectory=$DIR/server
Environment=KINOKO_DATA=$DATA
Environment=KINOKO_PORT=$PORT
Environment=NODE_ENV=production
ExecStart=$(command -v node) src/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now kinoko >/dev/null
systemctl restart kinoko

ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
say "Klaar. Open Kinoko in je browser om de installatie af te ronden:"
echo "    http://${ip:-<ip-adres>}:$PORT"
echo
echo "    Status:    systemctl status kinoko"
echo "    Logboek:   journalctl -u kinoko -f"
if [ -n "$TOKEN" ]; then echo "    Bijwerken: via Beheer → Overzicht → Kinoko bijwerken"
else echo "    Bijwerken: git pull in je clone en dit script opnieuw uitvoeren (of installeer met KINOKO_TOKEN voor de knop in Beheer)"; fi
