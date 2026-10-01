# ✳ ChristmasDust

**A little snow. A lot of Counter-Strike.** A fast, self-hosted browser for Christmas- and winter-themed Counter-Strike 1.6 servers.

A dark winter page opens straight into a server list: country, map, population, confidence, Steam connect and copy command. Filter by country, map, open slots and theme confidence; browser preferences, favorites and personally hidden servers stay in local storage. Optional location ranks approximate distances entirely in the browser. No account or frontend framework. Anonymous thumbs-up/down ratings use a long-lived HttpOnly voter cookie and built-in SQLite.

**Monitor latency is not your ping.** GameDig measures from the backend to the game server. Recommendations use country and optional geographic distance, never a fabricated visitor ping.

## Quick install — Debian / Ubuntu

```sh
curl -fsSL https://raw.githubusercontent.com/llit47/christmasdust/main/install.sh | sudo bash
```

Review downloaded scripts before running as root if preferred. Requires Debian/Ubuntu with systemd, x86_64 or ARM64, and outbound HTTPS/UDP. The installer downloads checksum-verified official Node 24 LTS, creates an unprivileged service, preserves existing configuration and checks HTTP readiness. Default URL: **http://127.0.0.1:3001**. Configure a TLS reverse proxy for public access.

**Discovery starts automatically:** default `auto` mode uses Valve master UDP without `STEAM_API_KEY`. An optional Web API key in `/etc/christmasdust/christmasdust.env` improves discovery coverage. You can also curate public `IP:PORT` addresses in the `include` array in `/etc/christmasdust/detection.json`. Restart `christmasdust` after configuration changes. No sample or invented servers are shown to players. GeoIP is optional.

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
# auto mode uses master UDP; optional STEAM_API_KEY adds Web API coverage.
npm start
```

Open http://127.0.0.1:3001. `npm run dev` watches the server. `npm test` uses Node's runner with injected offline adapters; `npm run check` checks JavaScript syntax and the frontend rendering boundary. `bash -n install.sh scripts/christmasdust` checks shell syntax. CI also runs ShellCheck. Tests bind ephemeral loopback ports and need no external services.

## Operation at a glance

- Discovery: Steam AppID **10**, game directory `cstrike`, eight regional requests plus up to 20 rotating exact-map searches and five safe theme-name searches every **10 minutes**, plus bounded secondary Valve master UDP discovery. Master-only endpoints remain hidden pending live verification.
- Monitoring: GameDig **counterstrike16**, every **45 seconds**, eight concurrent queries, five-second attempt timeout.
- Browser: polls only the cached snapshot every **30 seconds**, pauses while hidden.
- Storage: atomic JSON snapshots; failures preserve last known data with explicit age and degraded status.
- Classification: weighted, explainable Christmas and winter signals from name, tags, optional description and map. `config/christmas-maps.json` distinguishes strong Christmas/New Year maps and probable verified winter maps; either catalog tier qualifies independently, while generic snow alone is insufficient. Curated inclusion stays separate. High confidence remains a heuristic.
- Identity-based duplicate grouping: fresh matching A2S metadata and a usable Steam server identity share one public result. GoldSrc identity can come from a bounded `getchallenge steam` probe. The API reports other endpoint IDs and count; similar names alone do not group endpoints, and all endpoints stay monitored.
- Repeated-name visibility: a separate backend heuristic retains one deterministic public representative when at least five eligible distinct IPs share the same normalized name. Only fresh, online, non-curated servers without strong map evidence participate; multiple ports on one IP count once. Case, spacing and punctuation differences are normalized. Suppressed copies do not contribute to public player totals, but stay monitored and persisted so visibility can recover as the cluster shrinks or names/maps diverge. This does not establish a shared server identity.
- Location: optional local GeoLite2 City MMDB, or explicitly trusted Cloudflare country headers; precise browser coordinates are never uploaded.

API: `GET /api/servers`, `GET /api/health`, `GET /api/ready`. Optional token-protected `POST /api/admin/refresh` accepts no body and has a one-minute cooldown. No public querying or scan endpoint.

[Architecture](docs/ARCHITECTURE.md) · [Configuration](docs/CONFIGURATION.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## MVP limits

Steam Web API discovery needs an operator-provided API key; bounded secondary Valve master UDP discovery also runs without a key. Both sources can be incomplete or capped. Some servers do not register with Steam; include them manually. Only routable public IPv4 endpoints are supported. Steam Networking / FakeIP servers need a separate resolution/query path and are intentionally excluded rather than queried with ordinary GameDig UDP. Server country filtering and distance need an optional local GeoLite2 City MMDB; [native setup](docs/INSTALL.md#server-country-data-optional) explains `sudo christmasdust setup-geoip`. Without it, the Country control shows why filtering is unavailable. GeoIP is approximate and supplied separately under its provider's terms. UDP filtering can make healthy game servers appear unreachable. A single monitor cannot measure visitor ping. Native deployment scripts have static checks and isolated transaction/rollback tests; a real systemd installation and rollback exercise should be performed on a disposable supported host before wider rollout.

Ratings are informational and never affect selection or ranking. `RATINGS_PATH` defaults to `./data/ratings.sqlite` locally; native installs use `/var/lib/christmasdust/ratings.sqlite`, separate from snapshots and release directories. Back up this database separately. Votes remain attached to their endpoint; current duplicate groups count each voter once, using their most recently updated vote (ties use creation time, then endpoint ID). Clearing the cookie loses access to previous votes; anonymous ratings are not proof of unique people. Mutation limits are 20 per voter and 60 per IP per minute, held only in memory.
