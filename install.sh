#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
[[ $EUID == 0 ]] || { echo 'Run this installer with sudo bash.' >&2; exit 1; }
[[ -r /etc/os-release ]] || { echo 'Debian/Ubuntu required'; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == debian || ${ID:-} == ubuntu ]] || { echo 'Supported systems: Debian or Ubuntu with systemd.'; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'A running systemd host is required.'; exit 1; }
channel=${CHRISTMASDUST_CHANNEL:-main}
[[ $channel =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$ && $channel != *..* ]] || { echo 'Invalid channel'; exit 1; }
if [[ -L /opt/christmasdust/current ]]; then
  echo 'Existing installation found; preserving configuration and running updater.'
  exec /usr/local/bin/christmasdust update "${CHRISTMASDUST_CHANNEL:-$(cat /etc/christmasdust/channel)}"
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils util-linux
command -v systemctl >/dev/null
id christmasdust >/dev/null 2>&1 || useradd --system --home-dir /var/lib/christmasdust --create-home --shell /usr/sbin/nologin christmasdust
install -d -m 0755 /opt/christmasdust /opt/christmasdust/releases
install -d -o root -g christmasdust -m 0750 /etc/christmasdust
install -d -o christmasdust -g christmasdust -m 0750 /var/lib/christmasdust
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
case $(uname -m) in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo 'Supported architectures: x86_64 and aarch64'; exit 1;; esac
# Install the latest official Node 24 LTS binary; verify against its HTTPS checksum manifest.
curl -fsSL --proto '=https' https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
archive=$(awk -v arch="$arch" '$2 ~ "^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$" {print $2}' "$work/SHASUMS256.txt")
[[ -n $archive && $archive != *$'\n'* ]]
curl -fsSL --proto '=https' "https://nodejs.org/dist/latest-v24.x/$archive" -o "$work/$archive"
(cd "$work" && awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
install -d -m 0755 /opt/christmasdust/node
tar -xJf "$work/$archive" --strip-components=1 -C /opt/christmasdust/node
# Fetch the bootstrap files from one checkout so they are mutually consistent.
git clone --quiet --depth 1 --branch "$channel" -- https://github.com/llit47/christmasdust.git "$work/source"
if [[ ! -e /etc/christmasdust/christmasdust.env ]]; then
  sed -e 's|SNAPSHOT_PATH=.*|SNAPSHOT_PATH=/var/lib/christmasdust/snapshot.json|' -e 's|RATINGS_PATH=.*|RATINGS_PATH=/var/lib/christmasdust/ratings.sqlite|' -e 's|DETECTION_PATH=.*|DETECTION_PATH=/etc/christmasdust/detection.json|' "$work/source/.env.example" > /etc/christmasdust/christmasdust.env
  chown root:christmasdust /etc/christmasdust/christmasdust.env
  chmod 0640 /etc/christmasdust/christmasdust.env
fi
if [[ ! -e /etc/christmasdust/detection.json ]]; then install -o root -g christmasdust -m 0640 "$work/source/config/detection.json" /etc/christmasdust/detection.json; fi
printf '%s\n' "$channel" > /etc/christmasdust/channel
install -m 0644 "$work/source/deploy/christmasdust.service" /etc/systemd/system/christmasdust.service
install -m 0755 "$work/source/scripts/christmasdust" /usr/local/bin/christmasdust
systemctl daemon-reload
systemctl enable christmasdust
/usr/local/bin/christmasdust update "$channel"
cat <<'MESSAGE'
ChristmasDust installed and healthy.
URL: http://127.0.0.1:3001 (default; put a TLS reverse proxy in front for public access)
Service: christmasdust.service
Config: /etc/christmasdust/christmasdust.env
Add STEAM_API_KEY for automatic discovery, or include public IP:port servers in /etc/christmasdust/detection.json.
Optional country data: sudo christmasdust setup-geoip (docs/INSTALL.md).
Commands:
  sudo systemctl restart christmasdust
  sudo journalctl -u christmasdust -f
  sudo christmasdust update
  christmasdust version
MESSAGE
