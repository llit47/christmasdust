# Operations

```sh
sudo systemctl status christmasdust
sudo journalctl -u christmasdust -f
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/ready
christmasdust version
sudo christmasdust update
sudo christmasdust update v0.1.0    # once that tag exists
```

`/api/health` returns version, readiness, last successful discovery/live timestamps (Unix milliseconds), snapshot age, in-progress job and degraded/partial flags. `/api/ready` is 200 after initialization, 503 otherwise. Dependency outages do not make the process unready; alert separately on stale age, discoveryPartial, livePartial or persistenceError. Discovery-disabled mode is explicit. Server statuses: unknown, online, uncertain (one/two misses), offline (three or more). Offline means the monitor could not query the server; it is not proof the server stopped. Each server also has per-observation staleness and stability.

Cadences are delays after completed cycles, not real-time deadlines. Slow cycles lengthen refresh time. Busy jobs are skipped; no overlapping global query workloads. Default queries can take minutes with a full candidate cap; reduce the cap or increase concurrency carefully. Last successful live timestamp means at least one server succeeded (or no candidates); per-server timestamps are the authority for individual freshness. No global success flag claims every server is fresh.

## Update and rollback

Updater takes a lock, clones the configured branch/tag into a separate staging directory, runs `npm ci --omit=dev --ignore-scripts`, tests, static checks and config/GeoIP validation as the service user. It makes the finished release root-owned and readable, stops the old service, copies the standard snapshot for rollback, atomically switches `current`, starts the service and polls HTTP readiness for up to 30 attempts. On failure after the switch, it restores the previous symlink and saved snapshot, restarts and reports recovery health. Config and data are never replaced by a new checkout. Previous release directories are retained; only the temporary staging directory is removed.

The standard snapshot path is `/var/lib/christmasdust/snapshot.json`. Custom snapshot locations require your own backups; update rollback backs up only the standard path. There are no schema migrations in 0.1.0; future migrations must remain rollback-compatible. Upstream Steam failure deliberately does not fail an application update. First install has no previous release to restore; inspect the journal and retry after correcting configuration/network access.

The updater refreshes the management command only after successful health. It does not silently replace the systemd unit or Node runtime on regular application updates. Review future unit/runtime changes explicitly. Keep Node 24 security patches current using checksum-verified official binaries and restart; runtime upgrades should be staged separately. Release tags are supported by the same command; changing the channel is persisted only after a successful update.

For manual application rollback, stop the service, atomically replace `/opt/christmasdust/current` with a symlink to the desired retained release, then start and check readiness. Confirm snapshot schema compatibility first. Retained releases consume disk; remove old inactive releases only after confirming they are neither the current target nor a needed rollback point. Back up `/etc/christmasdust` and `/var/lib/christmasdust` with access controls. Restore with correct ownership and restart.

## Troubleshooting

- Empty list: no matches, no Steam key/seeds, invalid key, upstream filtering or firewall. See health and journal. Edit includes for missing servers; do not publish unverified fixtures.
- Servers unreachable: outbound UDP may be blocked, query port differs or remote rate limiting applies. Monitor latency is not player latency.
- Stale after restart: the previous snapshot is intentionally served immediately while refresh runs.
- Disk warning: check free space and service ownership of state directory. Memory still serves last observations but restart durability is compromised.
- Country unknown: configure a current local MMDB or a properly trusted Cloudflare chain. Never trust headers from the open Internet.
- Geolocation denied: normal operation; country filtering and every connection action remain available.
- Changed classification config: restart. Includes/excludes are loaded at startup.

The admin refresh endpoint is optional. Set a generated high-entropy ADMIN_TOKEN in the protected environment, restart, then send a bodyless POST with `Authorization: Bearer <token>` over HTTPS. It schedules discovery followed by live queries, returns 202, 409 when busy or 429 during cooldown. Never put the token in query strings or browser code.

## Release validation still required

Automated tests use injected network adapters; live Steam access requires a real operator key. Before public launch, verify Steam results and UDP access on the deployment host, install/update/fail-health rollback on a disposable Debian/Ubuntu VM, configure TLS, and inspect desktop/mobile behavior with real server populations. No live-network tests belong in CI.
