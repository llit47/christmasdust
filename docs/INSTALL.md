# Native installation

Supported: Debian 12/13 or Ubuntu 22.04/24.04 with running systemd, x86_64 or ARM64. Root is needed for setup; the web process always runs as `christmasdust`. Outbound HTTPS accesses GitHub, npm, nodejs.org and Steam; outbound UDP reaches public game query ports. Incoming HTTP defaults to loopback port 3001.

Existing installations keep their configured `PORT` during updates; change it in `/etc/christmasdust/christmasdust.env` if moving an older installation to 3001.

The README shows the one-line installer. For review first:

```sh
curl -fsSL https://raw.githubusercontent.com/llit47/christmasdust/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

Until this PR is released, replace `main` with `feat/initial-mvp` in the URL and run `sudo env CHRISTMASDUST_CHANNEL=feat/initial-mvp bash install.sh`. The environment variable selects a trusted Git branch or tag; it is the installer's only configuration override. Installation is noninteractive. Existing installations invoke the updater; existing environment/detection files are preserved. A preprovisioned environment file should be root:christmasdust 0640 and use the standard snapshot path for automatic snapshot rollback.

The installer installs OS prerequisites, downloads the latest official Node 24 LTS binary into `/opt/christmasdust/node`, verifies its SHA256 against the official HTTPS manifest, creates the service user, and installs:

| Path | Contents |
| --- | --- |
| /opt/christmasdust/releases/ | Immutable application releases and lockfile-installed dependencies |
| /opt/christmasdust/current | Atomic symlink to active release |
| /opt/christmasdust/node/ | Dedicated Node 24 runtime |
| /etc/christmasdust/christmasdust.env | Protected persistent application environment |
| /etc/christmasdust/detection.json | Protected classification, include/exclude lists |
| /etc/christmasdust/channel | Update branch/tag |
| /var/lib/christmasdust/ | Persistent snapshot and optional local GeoIP |
| /etc/systemd/system/christmasdust.service | Hardened service, enabled on boot |
| /usr/local/bin/christmasdust | Update/version command |

Set a Steam key or curated addresses before expecting results. Add GEOIP_PATH for country and distance support. Restart after changing config. Readiness checks verify startup and restored storage initialization, not Steam availability or the presence of matching servers.

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
