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
| SNAPSHOT_PATH | ./data/snapshot.json | Atomic persistent snapshot file |
| DETECTION_PATH | ./config/detection.json | Required classification/include/exclude JSON |
| DISCOVERY_MODE | auto | auto uses Steam if key supplied; steam requires key; seeds disables Steam |
| STEAM_API_KEY | empty | 32-character hexadecimal Steam Web API key; backend only |
| GEOIP_PATH | empty | Optional local GeoLite2 City/Country MMDB; unreadable configured file fails startup |
| TRUSTED_PROXIES | empty | Comma-separated literal IPs/CIDRs trusted for Express forwarded IP handling |
| TRUST_CF_COUNTRY | false | Accept CF-IPCountry only from a trusted immediate peer; requires trusted proxies |
| ADMIN_TOKEN | empty | Disables admin API when empty; otherwise at least 32 non-whitespace characters |

No precise visitor coordinates are accepted by any API. The frontend sends only a snapshot GET.

## Discovery and detection

Get a [Steam Web API key](https://steamcommunity.com/dev/apikey). The public adapter calls `https://api.steampowered.com/IGameServersService/GetServerList/v1/` with `\appid\10\gamedir\cstrike\region\N` for eight broad regions and up to eight additional `\name_match\*term*` filters drawn from the detection configuration. These fixed-origin requests run at concurrency two with a 16 MB limit per response; no key or seed mode means no Steam requests. Only the first eight distinct, safe ASCII terms of 4–32 characters are queried, with strong terms first. The subset and name-only filter cannot find every server, especially map-only themes or names with accents or other scripts. It does not use the publisher-only `ISteamApps/GetServerList` endpoint. Valve may change access policies or omit servers. HTTP failures appear as degraded discovery and never clear existing data. API keys must not be placed in frontend code or access-log URLs.

Detection configuration contains exactly four arrays:

```json
{
  "strong": ["christmas", "xmas", "santa", "noel", "weihnacht", "swieta"],
  "weak": ["winter", "snow", "snowy"],
  "include": ["8.8.8.8:27015"],
  "exclude": []
}
```

The address above illustrates syntax only; it is **not** a game server recommendation. Use actual servers you want to curate. Public literal IPv4 only, explicit port. Private, loopback, link-local, multicast, documentation and shared-address ranges are rejected. Steam Networking / FakeIP servers need a different Steam resolution/query path and are intentionally unsupported; ordinary GameDig UDP queries are not sent to them. No DNS names or arbitrary visitor-supplied endpoints. Exclusion wins. Includes bypass theme detection and are labelled curated. Strong and weak terms are normalized literal substrings, not executable regular expressions. Names, maps and discovery tags can contribute reasons; live name/map evidence updates the classification. Each array supports up to 1000 entries. No regex backtracking risk.

## GeoIP and proxy trust

Use a separately downloaded [MaxMind GeoLite2 City MMDB](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/) for server coordinates and country; Country MMDB supports only country. MaxMind requires an account and license key for downloads. Follow its current EULA, attribution and redistribution terms; no database is bundled. Configure the official `geoipupdate` utility with root-protected credentials and a daily systemd timer. Put the database in `/var/lib/christmasdust/geoip/` (service-readable), set GEOIP_PATH, then restart after database replacement. This app opens the database once per process, and never calls a remote geolocation API.

GeoIP represents an approximate area, often a population center; accuracyRadiusKm is exposed when available. VPNs, hosting registrations and country centroids can mislead. Country detection alone does not infer a visitor city. MaxMind requires timely database updates/deletion under its terms; operators are responsible for the updater and license compliance.

For a direct connection, keep TRUSTED_PROXIES empty. Behind a local proxy, trust only its exact source address/subnet and configure it to replace forwarded headers. TRUST_CF_COUNTRY should be enabled only when your complete proxy chain sanitizes CF-IPCountry and accepts it solely from Cloudflare. Firewall the origin to that trusted path; trusting loopback is insufficient if a public-facing proxy passes spoofed headers through. Cloudflare network lists are not silently fetched or broadly trusted by the app. When country is unknown or location is denied, all browsing remains available.
