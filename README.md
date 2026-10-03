# ✳ ChristmasDust

**A little snow. A lot of Counter-Strike.** A fast, self-hosted browser for Christmas- and winter-themed Counter-Strike 1.6 servers.

A dark winter page opens straight into a server list: country, map, population, confidence, Steam connect and copy command. Filter by country, map, open slots and theme confidence; browser preferences, favorites and personally hidden servers stay in local storage. Optional location ranks approximate distances entirely in the browser. No account or frontend framework. Anonymous thumbs-up/down ratings use a long-lived HttpOnly voter cookie and built-in SQLite.

**Monitor latency is not your ping.** GameDig measures from the backend to the game server. Recommendations use country and optional geographic distance, never a fabricated visitor ping.

## Quick install — Debian / Ubuntu

```sh
curl -fsSL https://raw.githubusercontent.com/llit47/christmasdust/main/install.sh | sudo bash
```

Review downloaded scripts before running as root if preferred. Requires Debian/Ubuntu with systemd, x86_64 or ARM64, and outbound HTTPS/UDP. The installer downloads checksum-verified official Node 24 LTS, creates an unprivileged service, preserves existing configuration and checks HTTP readiness. Default URL: **http://127.0.0.1:3001**. Configure a TLS reverse proxy for public access.

**Automatic discovery uses Steam Web API:** configure `STEAM_API_KEY` in `/etc/christmasdust/christmasdust.env` for default `auto` mode. Without a key, only configured seeds and restored entries are monitored. You can also curate public `IP:PORT` addresses in the `include` array in `/etc/christmasdust/detection.json`. Restart `christmasdust` after configuration changes. No sample or invented servers are shown to players. GeoIP is optional.

```sh
sudo christmasdust update          # migrates legacy detection config; failure rolls back
sudo christmasdust setup-geoip     # optional interactive GeoLite2 City setup
christmasdust version
sudo journalctl -u christmasdust -f
```

See [installation](docs/INSTALL.md) and [operations](docs/OPERATIONS.md).

## Manual installation / development

Use Node.js 24 LTS and an unprivileged account:

```sh
git clone https://github.com/llit47/christmasdust.git
cd christmasdust
npm ci
cp .env.example .env
# Set STEAM_API_KEY for automatic discovery; otherwise configure operator includes.
npm start
```

Open http://127.0.0.1:3001. `npm run dev` watches the server. `npm test` uses Node's runner with injected offline adapters; `npm run check` checks JavaScript syntax and the frontend rendering boundary. `bash -n install.sh scripts/christmasdust` checks shell syntax. CI also runs ShellCheck. Tests bind ephemeral loopback ports and need no external services.

## Operation at a glance

- Discovery: Steam AppID **10**, game directory `cstrike`, eight regional requests plus up to 20 rotating exact-map searches and at most five rotating theme-name searches every **10 minutes**. Already-classifiable candidates receive admission first; unclassified targeted hits share a 128-entry pending pool. Winter-only names are capped at two monitored endpoints per normalized name; successful live confirmation of targeted `winter` identity can qualify on ordinary maps. Compact coverage counters in `/api/health` and `/api/servers` separate discovery, query and visibility losses.
- Monitoring: GameDig **counterstrike16**, every **45 seconds**, eight concurrent queries, five-second attempt timeout.
- Browser: polls the cached snapshot every **30 seconds** and player history separately every **5 minutes**, pausing while hidden.
- Storage: atomic JSON snapshots and separate built-in SQLite ratings/player history; failures preserve last known data with explicit age and degraded status.
- Classification: weighted, explainable Christmas and winter signals from name, tags, optional description and map. `config/christmas-maps.json` distinguishes strong Christmas/New Year maps and probable verified winter maps; strong maps qualify independently and probable maps require seasonal identity. Generic snow alone is insufficient; targeted `name:winter` candidates can become probable only after live name verification. Curated inclusion stays separate. High confidence remains a heuristic.
- Identity-based duplicate grouping: fresh matching A2S metadata and a usable Steam server identity share one public result. GoldSrc identity can come from a bounded `getchallenge steam` probe. The API reports other endpoint IDs and count; similar names alone do not group endpoints, and all endpoints stay monitored.
- Repeated-name visibility: a separate backend heuristic retains one deterministic public representative when at least five eligible distinct IPs share the same normalized name. Only fresh, online, non-curated servers without strong map evidence participate; multiple ports on one IP count once. Case, spacing and punctuation differences are normalized. Suppressed copies do not contribute to public player totals, but stay monitored and persisted so visibility can recover as the cluster shrinks or names/maps diverge. This does not establish a shared server identity.
- Location: optional local GeoLite2 City MMDB, or explicitly trusted Cloudflare country headers; precise browser coordinates are never uploaded.

API: `GET /api/servers`, `GET /api/player-history`, `GET /api/health`, `GET /api/ready`. Optional token-protected `POST /api/admin/refresh` accepts no body and has a one-minute cooldown. No public querying or scan endpoint.

[Architecture](docs/ARCHITECTURE.md) · [Configuration](docs/CONFIGURATION.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## MVP limits

Steam Web API discovery needs an operator-provided API key and can be incomplete or capped. Legacy Master UDP is no longer used by runtime discovery because its hostname is unavailable in production. Some servers do not register with Steam; include them manually. Only routable public IPv4 endpoints are supported. Steam Networking / FakeIP servers need a separate resolution/query path and are intentionally excluded rather than queried with ordinary GameDig UDP. Server country filtering and distance need an optional local GeoLite2 City MMDB; [native setup](docs/INSTALL.md#server-country-data-optional) explains `sudo christmasdust setup-geoip`. Without it, the Country control shows why filtering is unavailable. GeoIP is approximate and supplied separately under its provider's terms. UDP filtering can make healthy game servers appear unreachable. A single monitor cannot measure visitor ping. Native deployment scripts have static checks and isolated transaction/rollback tests; a real systemd installation and rollback exercise should be performed on a disposable supported host before wider rollout.

Available favorites (online, fresh, with open slots and no password) lead every sort mode, keeping the selected ordering within that group. Recommended ranks Christmas classification and relevance first, then the bounded rating score `(up - down) / (up + down + 5)`, followed by country preference, distance, online/availability, player count and endpoint ID. Missing ratings score zero; Players and Proximity ignore ratings. Ratings do not affect filtering or backend selection. `RATINGS_PATH` defaults to `./data/ratings.sqlite` locally; native installs use `/var/lib/christmasdust/ratings.sqlite`, separate from snapshots and release directories. Back up this database separately. Votes remain attached to their endpoint; current duplicate groups count each voter once, using their most recently updated vote (ties use creation time, then endpoint ID). Clearing the cookie loses access to previous votes; anonymous ratings are not proof of unique people. Mutation limits are 20 per voter and 60 per IP per minute, held only in memory.

Each public card shows a compact 24h player sparkline beside the current count. History reuses successful live measurements, keeps real zeroes and leaves unmeasured half hours as gaps. Its scale starts at zero and uses server capacity when known. `STATS_PATH` defaults to `./data/player-stats.sqlite` locally and `/var/lib/christmasdust/player-stats.sqlite` on native installs. Seven days of five-minute endpoint samples survive removal and rediscovery; removed servers are not queried. History never affects filtering, ranking, ratings or current totals.
