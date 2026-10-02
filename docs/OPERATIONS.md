# Operations

```sh
sudo systemctl status christmasdust
sudo journalctl -u christmasdust -f
curl -fsS http://127.0.0.1:3001/api/health
curl -fsS http://127.0.0.1:3001/api/ready
christmasdust version
sudo christmasdust update
sudo christmasdust setup-geoip  # optional interactive MaxMind City setup
sudo christmasdust update v0.1.0    # once that tag exists
```

`/api/health` returns version, readiness, last successful discovery/live timestamps (Unix milliseconds), snapshot age, in-progress job and degraded/partial flags. `/api/ready` is 200 after initialization, 503 otherwise. Dependency outages do not make the process unready; alert separately on stale age, discoveryPartial, livePartial or persistenceError. Discovery-disabled mode is explicit. Server statuses: unknown, online, uncertain (one/two misses), offline (three or more). Offline means the monitor could not query the server; it is not proof the server stopped. Each server also has per-observation staleness and stability.

`/api/health` and `/api/servers` meta expose a compact `coverage` object. These counters are observations, not estimates of all internet servers; they reset with the process and contain no endpoint lists, API keys or filter configuration:

| Group | Counters | Meaning |
| --- | --- | --- |
| `discovery` | `steamEndpoints`, `masterRegionalEndpoints`, `masterMapEndpoints` | Unique validated endpoints returned by each source in the latest completed discovery pass, including useful partial responses. A shared endpoint may count in multiple sources. Master counts precede the merged adapter cap. |
| `discovery` | `candidatesRetained`, `candidatesDropped` | Returned merged candidates still in monitoring after admission/classification/exclusion checks, or dropped before live querying. Previously retained endpoints count as retained; these are not just new arrivals. |
| `live` | `queriedEndpoints`, `queryFailures`, `classificationNone` | Endpoints attempted in the latest live batch (including scoped batches), failed queries, and successful responses left hidden/rejected with `none` classification. Failures are separate from non-matching responses. |
| `visibility` | `monitoredEndpoints`, `classificationNone`, `capacityHidden`, `manifestSuppressed`, `nameMirrorSuppressed`, `duplicateAliases`, `publicServers` | Current pipeline counts: monitored, non-matching, oversized, removed by each mirror filter, grouped identity aliases and public representatives. Filters apply sequentially; don't add suppressed counts to source-return counts. |

For a missing server, low source returns suggest discovery/indexing gaps; high `candidatesDropped` suggests admission/exclusion or discovery classification loss; `queryFailures` identifies live reachability loss; `classificationNone` identifies relevance rejection; visibility counters separate slot limits, mirrors and grouping. Correlate with `lastDiscoveryAt`, `lastLiveAt` and partial flags. Counters reflect the latest completed batch; a thrown adapter failure preserves the previous counters while marking partial. To verify a particular endpoint, inspect the local protected snapshot/operator configuration rather than exposing address lists in public diagnostics.


Cadences are delays after completed cycles, not real-time deadlines. Slow cycles lengthen refresh time. Busy jobs are skipped; no overlapping global query workloads. Default queries can take minutes with a full candidate cap; reduce the cap or increase concurrency carefully. Last successful live timestamp means at least one server succeeded (or no candidates); per-server timestamps are the authority for individual freshness. No global success flag claims every server is fresh.

## Update and rollback

Updater takes a lock, clones the configured branch/tag into a separate staging directory, runs `npm ci --omit=dev --ignore-scripts`, tests and static checks. The staged release resolves the absolute `DETECTION_PATH` from the protected environment file, migrates that file into a candidate beside it, and validates the candidate plus environment/GeoIP before touching the live service. It keeps an exact transaction backup and preserves file ownership/mode. Before committing v2, the first migration also durably saves the exact v1 file in a root-only `rollback` directory beside the configured detection file. This retained backup survives success and is never overwritten; a newly created backup is removed after a completed pre-commit rollback. The updater flushes the completed release, durably switches `current`, then flushes the migrated config file and its actual directory. The new application can read either legacy or v2 config, so a power loss between those steps leaves a compatible state. It starts the service and checks HTTP readiness and the expected Git revision for up to 30 attempts. Failure before those checks pass restores and flushes the exact old detection file and snapshot before switching the old release pointer back. Current-version detection files are left untouched; custom terms and include/exclude lists survive migration. Previous release directories are retained; temporary transaction files are removed.

Readiness plus matching revision is the deployment commit point. Later failure to refresh the management command or save the channel is reported with a nonzero update status, but the healthy new release stays active. Do not manually edit the configured `DETECTION_PATH` while `christmasdust update` is running: concurrent manual edits are unsupported. The updater retains a simple pre-switch change check, but external editors do not participate in its lock.

After a machine power loss during an update, the durable release/config pair remains compatible, but the interrupted health check cannot finish or automatically roll back. Check `systemctl status christmasdust` and `/api/ready`, then rerun the update or recover from the retained release if needed.

The management command already installed before this migration cannot run the new migration logic on its first upgrade. That upgrade uses the new application's in-memory legacy conversion and installs the new management command; a subsequent `sudo christmasdust update` writes the versioned file with the transaction above. No manual config edit is needed.

The standard snapshot path is `/var/lib/christmasdust/snapshot.json`. Custom snapshot locations require your own backups; update rollback backs up only the standard path. Snapshot schema is not migrated in 0.1.0; detection config has an explicit versioned migration. Upstream Steam failure deliberately does not fail an application update. First install has no previous release to restore; inspect the journal and retry after correcting configuration/network access.

The updater refreshes the management command only after successful health. It does not silently replace the systemd unit or Node runtime on regular application updates. Review future unit/runtime changes explicitly. Keep Node 24 security patches current using checksum-verified official binaries and restart; runtime upgrades should be staged separately. Release tags are supported by the same command; changing the channel is persisted only after a successful update.

For manual application rollback, confirm snapshot schema compatibility first, then stop the service. If the retained release understands the current detection schema, repoint `/opt/christmasdust/current` and restart. A **pre-v2 release** also needs the preserved v1 config restored **before** its pointer is selected. For the default path, the exact v1 copy is `/etc/christmasdust/rollback/detection-v1.json`; for a custom `DETECTION_PATH`, it is `rollback/<detection-basename-without-.json>-v1.json` beside that file. Back up the current v2 file if you may need to return to it. With the service stopped, copy the v1 backup to a temporary file beside the configured detection file, atomically rename it over the live file, and flush that filesystem (`sync -f <detection-directory>`). Then create a symlink to the retained release, atomically rename it over `/opt/christmasdust/current`, flush `/opt/christmasdust`, start the service, and check `/api/ready`. Do not point a pre-v2 release at the v2 config. Retained releases consume disk; remove old inactive releases only after confirming they are neither the current target nor a needed rollback point. Back up operator config and data with access controls.

For the default detection path, the schema-changing portion is:

```sh
sudo systemctl stop christmasdust
sudo cp -p /etc/christmasdust/rollback/detection-v1.json /etc/christmasdust/.detection-manual-v1.tmp
sudo sync -f /etc/christmasdust
sudo mv -Tf /etc/christmasdust/.detection-manual-v1.tmp /etc/christmasdust/detection.json
sudo sync -f /etc/christmasdust
sudo ln -s /opt/christmasdust/releases/CHOSEN_OLD_RELEASE /opt/christmasdust/.manual-next-$$
sudo mv -Tf /opt/christmasdust/.manual-next-$$ /opt/christmasdust/current
sudo sync -f /opt/christmasdust
sudo systemctl start christmasdust
curl --noproxy '*' -fsS http://127.0.0.1:3001/api/ready
```

Use the actual retained release and configured detection path; the example name is a placeholder. Restore a compatible snapshot first if the snapshot schema changed.

## Troubleshooting

- Empty list: no live-verified matches, unavailable master DNS/UDP, seeds mode without includes, an invalid Web API key, upstream filtering or firewall. In `auto` mode the Web API key is optional and improves coverage. See health and journal. Edit includes for missing servers; do not publish unverified fixtures.
- Servers unreachable: outbound UDP may be blocked, query port differs or remote rate limiting applies. Monitor latency is not player latency.
- Stale after restart: the previous snapshot is intentionally served immediately while refresh runs.
- Disk warning: check free space and service ownership of state directory. Memory still serves last observations but restart durability is compromised.
- Country unknown: configure a current local MMDB or a properly trusted Cloudflare chain. Never trust headers from the open Internet.
- Geolocation denied: normal operation; country filtering and every connection action remain available.
- Changed classification config: restart. Includes/excludes are loaded at startup.

The admin refresh endpoint is optional. Set a generated high-entropy ADMIN_TOKEN in the protected environment, restart, then send a bodyless POST with `Authorization: Bearer <token>` over HTTPS. It schedules discovery followed by live queries, returns 202, 409 when busy or 429 during cooldown. Never put the token in query strings or browser code.

## Release validation still required

Automated tests use injected network adapters and exercise updater success, preparation failure and rollback with temporary paths and OS/network shims; live Web API access requires a real operator key; master UDP discovery does not. Before public launch, verify Steam results and UDP access on the deployment host, install/update/fail-health rollback on a disposable Debian/Ubuntu VM, configure TLS, and inspect desktop/mobile behavior with real server populations. No live-network tests belong in CI.

## Player history storage

Back up `/var/lib/christmasdust/player-stats.sqlite` separately from the snapshot and ratings database, preferably while the service is stopped. `STATS_PATH` selects its location; native upgrades atomically add the persistent default to older env files and preserve explicit overrides, ownership and mode. Application updates and rollback do not copy, replace or delete this database. The service closes it on shutdown. An unavailable store at startup disables history until restart; history read failures return 503, and write failures retry during later live batches without changing monitoring.

Seven days of raw five-minute measurements are retained. Cleanup deletes at most 10000 expired rows once per five minutes of existing live activity, without another timer; a large backlog drains over multiple batches. Dormant installations prune when live activity resumes. There is no stored visitor data or old-server query registry. A new endpoint needs measurements in at least two half-hour buckets before a line can appear; missing half hours break the line. Server-advertised counts are informational, not independently verified occupancy.
