# Architecture

One Node.js 24 process serves Express and static ES modules. No database or build step.
Steam discovery (10 minutes) collects AppID 10 / cstrike metadata in regional requests. GameDig counterstrike16 queries (45 seconds) target only classified candidates and operator includes. Both jobs serialize through one coordinator; a busy job is skipped, never piled up. Public reads only read memory.

Discovery merges candidates, never replaces the entire cache. Partial regional success remains useful. A failed live query retains previous metadata and increments misses; three consecutive misses mark offline. Online is a last-observed state, not a guarantee. Cached data ages visibly. Non-curated servers expire after seven days without discovery or successful queries; the total candidate count is capped. Includes take precedence over capacity; exclusions win over includes.

Snapshots use a versioned schema, temporary file, fsync, atomic rename and directory fsync. Startup restores the last snapshot before accepting traffic. Memory can continue serving if disk persistence fails, with degraded health. Readiness means initialization completed; freshness is reported separately so an upstream outage does not cause restart loops.

Visitor country comes from a local MMDB lookup or an explicitly trusted proxy's sanitized CF-IPCountry. The API never returns visitor coordinates. The opt-in browser geolocation result remains in memory; Haversine distance is computed locally. Recommendation orders same-country, geographic distance when available, online state, available slots, then population. Distance is approximate and never network ping. GameDig latency is the monitor-to-server query latency.

External adapters (discovery, query, GeoIP), storage and clock are injected for offline tests. The frontend uses text nodes for external metadata and builds Steam links only from validated endpoints.
