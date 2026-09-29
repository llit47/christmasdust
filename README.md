# ✳ ChristmasDust

**A little snow. A lot of Counter-Strike.** A fast, self-hosted browser for Christmas and winter Counter-Strike 1.6 servers.

A dark winter page opens straight into a server list: country, map, population, confidence, Steam connect and copy command. Filter by country, map, open slots and theme confidence; save favorites locally. Optional location ranks approximate distances entirely in the browser. No account, tracking, frontend framework or database.

**Monitor latency is not your ping.** GameDig measures from the backend to the game server. Recommendations use country and optional geographic distance, never a fabricated visitor ping.

## Quick install — Debian / Ubuntu

Once this feature is released on main:

```sh
curl -fsSL https://raw.githubusercontent.com/llit47/christmasdust/main/install.sh | sudo bash
```

For this draft MVP, use the feature branch explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/llit47/christmasdust/feat/initial-mvp/install.sh | sudo env CHRISTMASDUST_CHANNEL=feat/initial-mvp bash
```

Review downloaded scripts before running as root if preferred. Requires Debian/Ubuntu with systemd, x86_64 or ARM64, and outbound HTTPS/UDP. The installer downloads checksum-verified official Node 24 LTS, creates an unprivileged service, preserves existing configuration and checks HTTP readiness. Default URL: **http://127.0.0.1:3000**. Configure a TLS reverse proxy for public access.

**Before servers appear:** add a Steam Web API key to `/etc/christmasdust/christmasdust.env`, or curated public `IP:PORT` addresses to the `include` array in `/etc/christmasdust/detection.json`. Restart `christmasdust`. No sample or invented servers are shown to players. GeoIP is optional.

```sh
sudo christmasdust update          # preserves config/data; health failure rolls back
christmasdust version
sudo journalctl -u christmasdust -f
```

See [installation](docs/INSTALL.md) and [operations](docs/OPERATIONS.md).

## Manual installation / development

Use Node.js 24 LTS and an unprivileged account:

```sh
git clone https://github.com/llit47/christmasdust.git
cd christmasdust
git switch feat/initial-mvp         # until the MVP is released
npm ci
cp .env.example .env
# Set STEAM_API_KEY, or add curated endpoints to config/detection.json.
npm start
```

Open http://127.0.0.1:3000. `npm run dev` watches the server. `npm test` uses Node's runner with injected offline adapters; `npm run check` checks JavaScript syntax and the frontend rendering boundary. `bash -n install.sh scripts/christmasdust` checks shell syntax. CI also runs ShellCheck. Tests bind ephemeral loopback ports and need no external services.

## Operation at a glance

- Discovery: Steam AppID **10**, game directory `cstrike`, eight regional requests every **10 minutes**; results are classified before monitoring.
- Monitoring: GameDig **counterstrike16**, every **45 seconds**, eight concurrent queries, five-second attempt timeout.
- Browser: polls only the cached snapshot every **30 seconds**, pauses while hidden.
- Storage: atomic JSON snapshots; failures preserve last known data with explicit age and degraded status.
- Classification: editable accent-insensitive terms in `config/detection.json`; high confidence, probable winter, curated. High confidence is still a heuristic, not independently verified.
- Location: optional local GeoLite2 City MMDB, or explicitly trusted Cloudflare country headers; precise browser coordinates are never uploaded.

API: `GET /api/servers`, `GET /api/health`, `GET /api/ready`. Optional token-protected `POST /api/admin/refresh` accepts no body and has a one-minute cooldown. No public querying or scan endpoint.

[Architecture](docs/ARCHITECTURE.md) · [Configuration](docs/CONFIGURATION.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## MVP limits

Steam discovery needs an operator-provided API key and can be incomplete or capped. Some servers do not register with Steam; include them manually. IPv4 only. GeoIP is approximate and supplied separately under its provider's terms. UDP filtering can make healthy game servers appear unreachable. A single monitor cannot measure visitor ping. Native deployment scripts have automated static checks; a real systemd installation and rollback exercise should be performed on a disposable supported host before wider rollout.
