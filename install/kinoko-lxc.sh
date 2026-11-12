#!/usr/bin/env bash
# Proxmox VE helper: creates a Debian LXC and installs Kinoko in it.
# The repository is private, so run this from a clone on the Proxmox host (as root):
#
#   git clone https://github.com/MrSaucy1/kinoko.git && bash kinoko/install/kinoko-lxc.sh
#
# Everything is asked interactively; any answer can be preset through the
# environment (CTID, CT_HOSTNAME, STORAGE, DISK_GB, CORES, RAM_MB, BRIDGE,
# MEDIA_PATH, GPU=yes|no, KINOKO_PORT, KINOKO_TOKEN).
#
# KINOKO_TOKEN is optional: a GitHub token with read access to the repository,
# so the container can update itself from the admin GUI later.
set -euo pipefail

REPO="${KINOKO_REPO:-https://github.com/MrSaucy1/kinoko.git}"
PORT="${KINOKO_PORT:-8096}"
TOKEN="${KINOKO_TOKEN:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { # ask VAR "question" default
  local var="$1" q="$2" def="$3" ans
  if [ -n "${!var:-}" ]; then return; fi
  read -r -p "$q [$def]: " ans </dev/tty || ans=""
  printf -v "$var" '%s' "${ans:-$def}"
}

command -v pct >/dev/null || fail "Dit script draait op de Proxmox-host (pct niet gevonden)."
[ -f "$SRC/server/package.json" ] || fail "Voer dit script uit vanuit een clone van de Kinoko-repository (zie de README)."
[ "$(id -u)" -eq 0 ] || fail "Voer dit script uit als root."

echo
echo "  Kinoko — installatie op Proxmox"
echo "  --------------------------------"
ask CTID        "Container-ID"                         "$(pvesh get /cluster/nextid)"
ask CT_HOSTNAME "Hostnaam"                             "kinoko"
ask STORAGE     "Opslag voor de container"             "$(pvesm status -content rootdir | awk 'NR==2{print $1}')"
ask DISK_GB     "Schijfgrootte in GB (zonder media)"   "8"
ask CORES       "CPU-cores"                            "2"
ask RAM_MB      "Geheugen in MB"                       "2048"
ask BRIDGE      "Netwerkbridge"                        "vmbr0"
ask MEDIA_PATH  "Map op de host met je films/series (leeg = later zelf koppelen)" ""
if [ -e /dev/dri/renderD128 ]; then ask GPU "Videokaart doorgeven voor hardware-transcoding? (yes/no)" "yes"; else GPU="${GPU:-no}"; fi

pct status "$CTID" >/dev/null 2>&1 && fail "Container $CTID bestaat al."
[ -z "$MEDIA_PATH" ] || [ -d "$MEDIA_PATH" ] || fail "Map bestaat niet op de host: $MEDIA_PATH"

say "Debian-template zoeken…"
pveam update >/dev/null
TEMPLATE="$(pveam available -section system | awk '/debian-1[23]-standard/{print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || fail "Geen Debian-template gevonden."
TPL_STORAGE="$(pvesm status -content vztmpl | awk 'NR==2{print $1}')"
[ -n "$TPL_STORAGE" ] || fail "Geen opslag gevonden die templates kan bewaren."
pveam list "$TPL_STORAGE" | grep -q "$TEMPLATE" || pveam download "$TPL_STORAGE" "$TEMPLATE" >/dev/null

say "Container $CTID aanmaken…"
pct create "$CTID" "$TPL_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" --storage "$STORAGE" --rootfs "$STORAGE:$DISK_GB" \
  --cores "$CORES" --memory "$RAM_MB" --swap 512 \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --features nesting=1 --onboot 1 >/dev/null

CONF="/etc/pve/lxc/$CTID.conf"
# /dev/net/tun so Tailscale can run inside the container.
cat >> "$CONF" <<'TUN'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
TUN

if [ -n "$MEDIA_PATH" ]; then
  say "Mediamap koppelen op /mnt/media (alleen-lezen)…"
  pct set "$CTID" -mp0 "$MEDIA_PATH,mp=/mnt/media,ro=1" >/dev/null
fi

pct start "$CTID"
say "Wachten op netwerk…"
for _ in $(seq 1 30); do pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1' && break; sleep 2; done

if [ "$GPU" = "yes" ]; then
  say "Videokaart doorgeven…"
  # The device must be owned by the container's own "render" group.
  RENDER_GID="$(pct exec "$CTID" -- getent group render | cut -d: -f3 || true)"
  [ -n "$RENDER_GID" ] || { pct exec "$CTID" -- groupadd -r render; RENDER_GID="$(pct exec "$CTID" -- getent group render | cut -d: -f3)"; }
  pct stop "$CTID"
  pct set "$CTID" -dev0 "/dev/dri/renderD128,gid=$RENDER_GID" >/dev/null || echo "  (doorgeven mislukt — vereist Proxmox VE 8.2 of nieuwer; Kinoko werkt dan op software)"
  pct start "$CTID"
  for _ in $(seq 1 30); do pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1' && break; sleep 2; done
fi

say "Kinoko installeren in de container (dit duurt een paar minuten)…"
# Hand the container this checkout (the repo is private, so it cannot simply clone it).
TARBALL="$(mktemp --suffix=.tar.gz)"
tar -czf "$TARBALL" -C "$SRC" --exclude=node_modules --exclude=./data --exclude=./app/build --exclude=./app/.dart_tool .
pct push "$CTID" "$TARBALL" /root/kinoko-src.tar.gz
rm -f "$TARBALL"
pct exec "$CTID" -- bash -c "mkdir -p /root/kinoko-src && tar -xzf /root/kinoko-src.tar.gz -C /root/kinoko-src --no-same-owner && rm /root/kinoko-src.tar.gz"
pct exec "$CTID" -- env KINOKO_REPO="$REPO" KINOKO_PORT="$PORT" KINOKO_TOKEN="$TOKEN" bash /root/kinoko-src/install/install.sh
pct exec "$CTID" -- rm -rf /root/kinoko-src

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
say "Kinoko draait in container $CTID."
echo "    Open:  http://$IP:$PORT"
[ -z "$MEDIA_PATH" ] || echo "    Je media staat in de container onder /mnt/media"
[ -n "$MEDIA_PATH" ] || echo "    Media koppelen:  pct set $CTID -mp0 /pad/op/host,mp=/mnt/media,ro=1"
