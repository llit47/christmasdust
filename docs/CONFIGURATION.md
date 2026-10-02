# Configuration

Copy `.env.example` to `.env` for local use. Native installation uses `/etc/christmasdust/christmasdust.env`, root-owned and readable only by root and the service group (0640). Restart after changes. Environment values are validated at startup; malformed numbers, modes, keys, proxy networks and detection entries fail fast. Paths resolve relative to the working directory; use absolute production paths. Do not shell-source this file: Node and systemd read it as environment data.

| Variable | Default | Purpose |
| --- | --- | --- |
| NODE_ENV | production in example; development if absent | Express runtime mode: production, development, test |
| HOST | 127.0.0.1 | Literal listen IP; use 0.0.0.0 only with appropriate firewall/proxy setup |
| PORT | 3001 | TCP port, 1–65535; unprivileged ports recommended |
| DISCOVERY_INTERVAL_MS | 600000 | Discovery delay, 60000–86400000 |
| LIVE_INTERVAL_MS | 45000 | Live refresh delay, 10000–3600000 |
| QUERY_CONCURRENCY | 8 | Maximum simultaneous game queries, 1–32 |
| QUERY_TIMEOUT_MS | 5000 | GameDig attempt deadline, 500–30000 |
| DISCOVERY_TIMEOUT_MS | 15000 | Per Steam request deadline, 1000–60000 |
| DISCOVERY_LIMIT | 5000 | Maximum results per Steam request, 1–20000; hitting limit marks partial |
| MAX_SERVERS | 1000 | Automatic candidate capacity, 1–5000; curated includes take priority |
| STALE_AFTER_MS | 180000 | Last successful live refresh becomes stale after this; at least live interval |
| RETENTION_MS | 604800000 | Retain non-curated candidates without discovery/live success, or hidden candidates without a positive theme match, for this duration, 1 hour–30 days |
| STATS_PATH | ./data/player-stats.sqlite | Separate seven-day player history SQLite; native default `/var/lib/christmasdust/player-stats.sqlite`; `:memory:` for tests |
| RATINGS_PATH | ./data/ratings.sqlite | Separate persistent anonymous ratings SQLite |
| SNAPSHOT_PATH | ./data/snapshot.json | Atomic persistent snapshot file |
| DETECTION_PATH | ./config/detection.json | Required classification/include/exclude JSON; native installs require an absolute path |
| DISCOVERY_MODE | auto | auto uses Steam Web API when keyed; steam requires a key; seeds disables discovery; no legacy Master UDP in runtime |
| STEAM_API_KEY | empty | Required for automatic discovery; optional for seeds/restored monitoring in auto mode; 32 hexadecimal characters, backend only |
| GEOIP_PATH | empty | Optional local GeoLite2 City MMDB for server country and coordinates; native example: `/var/lib/christmasdust-geoip/GeoLite2-City.mmdb`; unreadable configured file fails startup |
| TRUSTED_PROXIES | empty | Comma-separated literal IPs/CIDRs trusted for Express forwarded IP handling |
| TRUST_CF_COUNTRY | false | Accept CF-IPCountry only from a trusted immediate peer; requires trusted proxies |
| ADMIN_TOKEN | empty | Disables admin API when empty; otherwise at least 32 non-whitespace characters |

No precise visitor coordinates are accepted by any API. The frontend reads snapshots and player history separately; neither accepts visitor coordinates.

## Discovery and detection

For automatic discovery, get a [Steam Web API key](https://steamcommunity.com/dev/apikey). The public adapter calls `https://api.steampowered.com/IGameServersService/GetServerList/v1/` with `\appid\10\gamedir\cstrike\region\N` for eight broad regions and up to 25 targeted filters: up to 20 exact catalog maps rotating round-robin across the full catalog, plus up to five distinct safe ASCII name terms of 4–32 characters from `strong` and `related`. These fixed-origin requests run at concurrency four with a 16 MB limit per response; no key or seed mode means no Steam requests. If configured as weak terms, `winter` and `snow` alternate in one of the five name slots; the other four rotate strong/related terms. Other weak terms are not queried. `snow` remains ordinary weak evidence and gets no live-name promotion. The cursor resets on process restart; every catalog map is queried across successive discovery runs. Result caps and unindexed servers still limit coverage. It does not use the publisher-only `ISteamApps/GetServerList` endpoint. The exact-map filter is supported by Steam's server browser API, but its behavior through this Web API endpoint remains unverified with a live key. Valve may change access policies or omit servers. HTTP failures appear as degraded discovery and never clear existing data. API keys must not be placed in frontend code or access-log URLs.

Legacy Master UDP is isolated from normal discovery: `hl2master.steampowered.com` no longer resolves in production. Its implementation and protocol tests remain for compatibility, but it supplies no runtime coverage or partial-discovery status. No key in `auto` mode means discovery is disabled; configured includes and restored entries still receive live queries. `seeds` behavior is unchanged.

Admission considers already-classifiable relevant metadata first, then unclassified targeted `name:*` / `map:*` candidates, then broad candidates. The global `MAX_SERVERS` limit and shared 128-entry pending bound remain. New unclassified `name:winter` candidates are capped at two endpoints per normalized name across the existing monitor, including previously live-promoted rows. Case, Unicode forms, punctuation and spacing use the same normalization as public same-name suppression. Existing rows are not evicted by this cap; independently classifiable Christmas/XMAS/catalog-map candidates and operator includes bypass it. Deliberately skipped mirrors count as dropped candidates, without marking discovery partial.

A targeted `name:winter` candidate remains hidden until a successful live A2S query confirms a non-negated normalized whole `winter` token in its current name. The monitor then records probable confidence with a `live-verified-winter-name` signal, even on an ordinary/non-catalog map. Discovery metadata and failed queries cannot grant this promotion, and `name:snow` gets no equivalent rule. The classifier's global weak-term thresholds stay unchanged. The signal and last successful query timestamp survive schema-1 snapshots; complete live theme loss hides the server on the first observation and retires it on the second, while incomplete responses/failures preserve last-good data.

Detection configuration is schema version 2. The runtime accepts unversioned legacy files in memory; the native updater migrates them on disk without a prompt:

```json
{
  "version": 2,
  "strong": ["christmas", "xmas", "noel", "weihnacht", "weihnachten", "swieta"],
  "related": ["santa", "jinglebells"],
  "weak": ["winter", "snow", "snowy", "holiday", "ice", "frozen"],
  "include": ["8.8.8.8:27015"],
  "exclude": []
}
```

The address above illustrates syntax only; it is **not** a game server recommendation. Use actual servers you want to curate. Public literal IPv4 only, explicit port. Private, loopback, link-local, multicast, documentation and shared-address ranges are rejected. Steam Networking / FakeIP servers need a different Steam resolution/query path and are intentionally unsupported; ordinary GameDig UDP queries are not sent to them. No DNS names or arbitrary visitor-supplied endpoints. Exclusion wins. Includes bypass theme detection and are labelled curated. Terms match normalized whole tokens or token phrases, not arbitrary substrings or executable regular expressions. Strong Christmas identity and known strong maps qualify independently; verified probable winter maps require positive seasonal identity; generic seasonal discovery metadata alone cannot qualify. Targeted winter identity can qualify through the separate live-verification rule above. The bundled `config/christmas-maps.json` catalog has validated, unique `strong` and `probable` map IDs. Add only verified CS 1.6 maps there and redeploy; native updates replace this bundled catalog but preserve the operator detection file. Legacy term arrays allow 1000 entries; version 2 allows 1003 so every valid legacy array has room for this release's additions. Include/exclude arrays remain limited to 1000. No regex backtracking risk.

An unattended update migrates supported unversioned files to version 2, preserving includes, excludes and custom terms while moving the old built-in `santa` term to `related` and adding this release's new terms. Custom terms are retained before built-in additions; if a future migration reaches its version's term cap, optional defaults are skipped rather than deleting custom terms. Already-versioned files are not rewritten. Unsupported future versions and unknown keys fail validation. The updater restores the exact previous file if deployment fails; operators normally need no manual edit after updating. The map catalog is bundled with each release.

An already-installed updater from before version 2 cannot retroactively perform the new disk migration during its first upgrade. The new application applies version 2 semantics to the untouched legacy file in memory, so the first upgrade works without editing it; the newly installed updater writes version 2 on its next run. This keeps the first upgrade safe for rollback to the old release.

Native updates resolve `DETECTION_PATH` through the staged application config and require an existing regular file owned by root in a root-controlled directory. Candidates and restore files are created beside that file for atomic replacement. The first successful v1-to-v2 migration retains its exact legacy bytes in a root-only `rollback` subdirectory beside the configured file; later updates never overwrite that backup. Fresh v2 installations do not create one.

## GeoIP and proxy trust

Use a separately downloaded [MaxMind GeoLite2 City MMDB](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/) for server coordinates and country; a Country MMDB supplies no coordinates. MaxMind requires an account and license key for downloads. Follow its current EULA, attribution and redistribution terms; no database is bundled. For native installs, `sudo christmasdust setup-geoip` configures geoipupdate, permissions, `GEOIP_PATH`, and the distro timer when available; see [native setup](INSTALL.md#server-country-data-optional). The app opens the database once per process; the timer service hook restarts it after refresh. It never calls a remote geolocation API. Without `GEOIP_PATH`, server country filtering is disabled with an explanation in the UI.

GeoIP represents an approximate area, often a population center; accuracyRadiusKm is exposed when available. VPNs, hosting registrations and country centroids can mislead. Country detection alone does not infer a visitor city. MaxMind requires timely database updates/deletion under its terms; operators are responsible for the updater and license compliance.

For a direct connection, keep TRUSTED_PROXIES empty. Behind a local proxy, trust only its exact source address/subnet and configure it to replace forwarded headers. TRUST_CF_COUNTRY should be enabled only when your complete proxy chain sanitizes CF-IPCountry and accepts it solely from Cloudflare. Firewall the origin to that trusted path; trusting loopback is insufficient if a public-facing proxy passes spoofed headers through. Cloudflare network lists are not silently fetched or broadly trusted by the app. When country is unknown or location is denied, all browsing remains available.

## Discovery catalog additions

The catalog adds three exact Christmas map identifiers, not broad substring rules:

| Catalog entry | Tier | Evidence |
| --- | --- | --- |
| `2000_xmas` | strong | [CSserv CS 1.6 map distribution](https://www.csserv.ru/cs/maps/fy/2000_xmas) identifies the Christmas variant; punctuation in `$2000$_xmas` normalizes to the same catalog key. [Observed CS 1.6 listings](https://www.gs4u.net/ru/cs16/map-2000_xmas/page-1) also use `2000_xmas`. |
| `de_snow2xmas` | strong | [GameBanana CS 1.6 map release](https://gamebanana.com/mods/558358). Its compound `snow2xmas` token needs the exact catalog entry rather than treating all compound snow names as strong. |
| `he_christmas` | strong | [Mapper's SnarkPit listing](https://snarkpit.net/map?game=4) describes the Christmas HE map for Counter-Strike/CS 1.6. |

Repository tests and map-catalog history were also searched: absent `de_xmas`, `de_snow` and `fy_snow` are fixtures, not additional verified catalog candidates. `de_xmas` already has explicit token evidence; generic snow maps remain excluded without corroboration. No arbitrary snow-map list was imported. Catalog additions expand exact targeted searches; high/probable score thresholds, term weights, and probable-map corroboration requirements remain unchanged.
