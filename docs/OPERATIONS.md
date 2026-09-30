# Operations

```sh
sudo systemctl status christmasdust
sudo journalctl -u christmasdust -f
curl -fsS http://127.0.0.1:3001/api/health
curl -fsS http://127.0.0.1:3001/api/ready
christmasdust version
sudo christmasdust update
sudo christmasdust update v0.1.0    # once that tag exists
```

`/api/health` returns version, readiness, last successful discovery/live timestamps (Unix milliseconds), snapshot age, in-progress job and degraded/partial flags. `/api/ready` is 200 after initialization, 503 otherwise. Dependency outages do not make the process unready; alert separately on stale age, discoveryPartial, livePartial or persistenceError. Discovery-disabled mode is explicit. Server statuses: unknown, online, uncertain (one/two misses), offline (three or more). Offline means the monitor could not query the server; it is not proof the server stopped. Each server also has per-observation staleness and stability.

Cadences are delays after completed cycles, not real-time deadlines. Slow cycles lengthen refresh time. Busy jobs are skipped; no overlapping global query workloads. Default queries can take minutes with a full candidate cap; reduce the cap or increase concurrency carefully. Last successful live timestamp means at least one server succeeded (or no candidates); per-server timestamps are the authority for individual freshness. No global success flag claims every server is fresh.

## Update and rollback

Updater takes a lock, clones the configured branch/tag into a separate staging directory, runs `npm ci --omit=dev --ignore-scripts`, tests and static checks. The staged release migrates legacy detection JSON into a separate candidate and validates that candidate plus environment/GeoIP before touching the live service. The updater keeps an exact backup and preserves file ownership/mode. It flushes the completed release, durably switches `current`, then flushes the migrated config file and its directory. The new application can read either legacy or v2 config, so a power loss between those steps leaves a compatible state. It starts the service and checks HTTP readiness and the expected Git revision for up to 30 attempts. Failure before those checks pass restores and flushes the exact old detection file and snapshot before switching the old release pointer back. Current-version detection files are left untouched; custom terms and include/exclude lists survive migration. Previous release directories are retained; temporary files are removed.

Readiness plus matching revision is the deployment commit point. Later failure to refresh the management command or save the channel is reported with a nonzero update status, but the healthy new release stays active. Do not manually edit `/etc/christmasdust/detection.json` while `christmasdust update` is running: concurrent manual edits are unsupported. The updater retains a simple pre-switch change check, but external editors do not participate in its lock.

After a machine power loss during an update, the durable release/config pair remains compatible, but the interrupted health check cannot finish or automatically roll back. Check `systemctl status christmasdust` and `/api/ready`, then rerun the update or recover from the retained release if needed.

The management command already installed before this migration cannot run the new migration logic on its first upgrade. That upgrade uses the new application's in-memory legacy conversion and installs the new management command; a subsequent `sudo christmasdust update` writes the versioned file with the transaction above. No manual config edit is needed.

The standard snapshot path is `/var/lib/christmasdust/snapshot.json`. Custom snapshot locations require your own backups; update rollback backs up only the standard path. Snapshot schema is not migrated in 0.1.0; detection config has an explicit versioned migration. Upstream Steam failure deliberately does not fail an application update. First install has no previous release to restore; inspect the journal and retry after correcting configuration/network access.

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

Automated tests use injected network adapters and exercise updater success, preparation failure and rollback with temporary paths and OS/network shims; live Steam access requires a real operator key. Before public launch, verify Steam results and UDP access on the deployment host, install/update/fail-health rollback on a disposable Debian/Ubuntu VM, configure TLS, and inspect desktop/mobile behavior with real server populations. No live-network tests belong in CI.
