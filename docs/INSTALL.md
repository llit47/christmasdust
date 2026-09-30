# Native installation

Supported: Debian 12/13 or Ubuntu 22.04/24.04 with running systemd, x86_64 or ARM64. Root is needed for setup; the web process always runs as `christmasdust`. Outbound HTTPS accesses GitHub, npm, nodejs.org and Steam; outbound UDP reaches public game query ports. Incoming HTTP defaults to loopback port 3001.

Existing installations keep their configured `PORT` during updates; change it in `/etc/christmasdust/christmasdust.env` if moving an older installation to 3001.

The README shows the one-line installer. For review first:

```sh
curl -fsSL https://raw.githubusercontent.com/llit47/christmasdust/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

The environment variable `CHRISTMASDUST_CHANNEL` selects a trusted Git branch or tag; it is the installer's only configuration override. Installation is noninteractive. Existing installations invoke the updater; it preserves the environment file and migrates supported legacy detection files transactionally. A preprovisioned environment file should be root:christmasdust 0640 and use the standard snapshot path for automatic snapshot rollback.

The installer installs OS prerequisites, downloads the latest official Node 24 LTS binary into `/opt/christmasdust/node`, verifies its SHA256 against the official HTTPS manifest, creates the service user, and installs:

| Path | Contents |
| --- | --- |
| /opt/christmasdust/releases/ | Immutable application releases and lockfile-installed dependencies |
| /opt/christmasdust/current | Atomic symlink to active release |
| /opt/christmasdust/node/ | Dedicated Node 24 runtime |
| /etc/christmasdust/christmasdust.env | Protected persistent application environment |
| /etc/christmasdust/detection.json | Protected classification, include/exclude lists |
| /etc/christmasdust/channel | Update branch/tag |
| /var/lib/christmasdust/ | Persistent snapshot |
| /var/lib/christmasdust-geoip/ | Optional root-controlled local GeoLite2 City MMDB |
| /etc/systemd/system/christmasdust.service | Hardened service, enabled on boot |
| /usr/local/bin/christmasdust | Update/version/GeoIP setup command |

Set a Steam key or curated addresses before expecting results. Add `GEOIP_PATH` for server country filtering and approximate distance. Restart after changing config. Readiness checks verify startup and restored storage initialization, not Steam availability or the presence of matching servers.

## Server country data (optional)

After installing or upgrading, obtain a [MaxMind account and license key](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/), then run:

```sh
sudo christmasdust setup-geoip
```

The command asks for AccountID and a hidden LicenseKey. It installs `geoipupdate` if needed, tests the new credentials and City database in temporary root-controlled locations, then prepares `/var/lib/christmasdust-geoip` as root:christmasdust `0750`. Only after validation does it replace `/etc/GeoIP.conf` (root-only `0600`) and the database, atomically update `GEOIP_PATH` without changing other environment settings, restart ChristmasDust, and verify readiness. A failed validation leaves the working config and database intact; a failure before readiness restores them. It is safe to rerun. `/etc/GeoIP.conf` is a system-wide geoipupdate configuration; setup selects the City edition and its ChristmasDust database directory while preserving unrelated settings. Never put the license key in shell history or the app environment file.

When the distro supplies `geoipupdate.timer`, setup enables it and adds a small `geoipupdate.service` post-hook: refreshed database files become root:christmasdust `0640`, then the running app restarts to load the new MMDB. No extra scheduler is installed. If the timer is unavailable, arrange refreshes through the distro service or rerun setup. Running the `geoipupdate` binary directly bypasses the service post-hook. Check `/api/servers`: `meta.serverGeoipConfigured` should be `true`; matched servers with database records should have country and coordinates. Without GeoIP, browsing still works and the Country control explains why filtering is unavailable. Location is approximate; see [MaxMind's update guidance](https://dev.maxmind.com/geoip/updating-databases/).

## Reverse proxy

Use your existing TLS proxy (Caddy example):

```caddyfile
winter.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Direct proxy country lookup needs trustworthy client IP forwarding: set `TRUSTED_PROXIES=127.0.0.1/32` only when this proxy is the sole permitted path and sanitizes X-Forwarded-For. Leave Cloudflare country support off unless you have configured the full trusted chain. Precise geolocation and clipboard APIs generally require HTTPS or localhost. Copy falls back to a selectable command dialog.

## Manual service setup

Install Node 24, create the unprivileged user, install a checkout with `npm ci --omit=dev --ignore-scripts`, make releases root-owned/readable, provision protected configuration and writable state directory as above. Adapt the checked-in service's Node path if needed, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now christmasdust
curl -fsS http://127.0.0.1:3001/api/ready
```

Manual checkout users can run `npm start` directly under an unprivileged account; no root or systemd is required for development. The native updater assumes the installer's directory layout.
