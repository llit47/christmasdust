## 1. Executive summary

ChristmasDust’s overall architecture is appropriate for its purpose. One Node process, a plain HTML/CSS/ES-module frontend, bounded game queries, cached public reads, atomic snapshots and local SQLite are sensible choices for a small self-hosted service monitoring approximately 1000 servers.

Its strongest areas are:

- Clear separation between discovery, live querying and public reads.
- Preservation of last-good observations through partial failures.
- Bounded, validated public IPv4 query targets and safe metadata rendering.
- Explainable seasonal classification.
- Careful native update, configuration migration and rollback handling.
- Meaningful offline tests with injected failures.

The weakest area is the interaction between server-selection mechanisms. Admission quotas, classification, manifest suppression, repeated-name suppression, identity grouping and frontend filtering are individually understandable, but their combination can hide playable servers or prevent useful newcomers from entering monitoring.

Player continuity also needs attention: transient failures can empty the browser, focused cards can retain outdated status, and unavailable favorites have no useful management view.

**I found no credible high-priority issue.** The material findings are medium-priority correctness, reliability and product issues. There is no evidence here that a framework, database or deployment rewrite would improve the project.

The implementation serves much of the stated goal, but “trustworthy, useful servers” is currently expressed more strongly through seasonal relevance and suppression than through practical joinability and population quality.

**Audit baseline:** GitHub’s current `main`, [`147f187`](https://github.com/llit47/christmasdust/commit/147f187c8f508dd23974d3941c84026844732492). Its tree exactly matched the clean checkout. The local `main` ref was stale, so it was not used as the audit baseline.

No repository files, branches, commits or PRs were changed. All requested documentation and runtime configuration were read. Tests ran against a temporary copy of the matching tree.

## 2. Current system overview

The actual implementation follows this path:

1. **Initialization:** load configuration, detection rules and optional GeoIP; restore the snapshot; reconcile retained candidates and operator includes.
2. **Discovery:** Steam Web API performs eight regional searches, rotating exact-map searches and rotating name searches. Runtime discovery requires a key; legacy Master UDP code is isolated and unused.
3. **Admission:** prioritize already-classifiable candidates, bound unclassified targeted candidates to 128, enforce `MAX_SERVERS`, and apply special two-member quotas to winter-name-only candidates.
4. **Live monitoring:** serialized batches query GameDig with bounded concurrency. An optional GoldSrc challenge probe supplies identity evidence. Successful observations update metadata, classification and player history; failures preserve previous fields.
5. **Public projection:** exclude non-matches and oversized capacities, apply manifest suppression, apply repeated-name suppression, then group identity duplicates.
6. **API:** return cached observations, attach anonymous ratings, and serve separately cached player-history aggregates. Public requests cannot initiate game queries.
7. **Browser:** poll snapshots every 30 seconds, retain local preferences/favorites/hidden IDs, filter to fresh online representatives, then rank results. Optional geographic distance is calculated locally.

Snapshots retain monitored endpoint records, including many publicly suppressed records. Ratings and player history live in separate persistent databases outside release directories.

A consequential distinction: the API’s `publicServers` counter counts projected representatives, including some stale or uncertain rows. It does **not** necessarily equal the number of cards the browser displays.

## 3. Findings

### High priority

**None identified with sufficient evidence and realistic likelihood.**

### Medium priority

#### M1. An uncertain duplicate representative can hide a healthy endpoint

**Category:** Confirmed bug.

**Evidence:** [Duplicate grouping](../src/domain/duplicates.js#L35) selects a representative using the shared recommendation comparator. [That comparator](../public/js/ranking.js#L28) compares relevance score before response health. Failed queries retain fingerprints, while the [frontend filter](../public/js/filters.js#L19) excludes uncertain representatives.

**Concrete scenario:** Two endpoints share complete identity evidence. Targeted discovery gives one endpoint a slightly higher score. It subsequently times out, while its sibling responds. The uncertain endpoint remains the representative; the healthy endpoint becomes an alias; the browser displays neither. This was reproduced with the real Monitor and injected adapters.

**Likelihood:** Occasional within duplicate groups. Endpoint-specific UDP failures are normal; differing discovery provenance is plausible.

**Impact and blast radius:** One playable identity group disappears, including its visible favorite association.

**Recovery:** Automatic when the preferred endpoint responds, becomes stale enough to split grouping, or otherwise diverges. Observations remain stored.

**Existing mitigation/tests:** All aliases remain monitored. Tests cover availability, failure retention and stale separation separately, but omit unequal relevance scores combined with an alias failure.

**Recommendation:** Give backend representative selection its own small comparator, prioritizing fresh responding endpoints and usability before relevance.

#### M2. Three matching aliases can disappear before identity grouping

**Category:** Confirmed feature-interaction bug.

**Evidence:** The [projection pipeline](../src/services/monitor.js#L295) applies manifest suppression before identity grouping. The [manifest filter](../src/domain/manifests.js#L35) counts distinct IPs without accounting for shared identity and can suppress every unestablished member.

**Concrete scenario:** Three newly discovered endpoints have the same usable server identity and identical complete A2S manifests. All three are suppressed, yielding zero results. With two endpoints, identity grouping correctly yields one. This was reproduced with injected observations.

**Likelihood:** Conditional on three-IP aliases; less common than ordinary query failures, but directly within supported functionality.

**Impact and blast radius:** One otherwise playable server identity disappears.

**Recovery:** Automatic when observations diverge or the fresh cluster falls below three IPs. Operator inclusion or prior independent manifest establishment can protect a member. No records are lost.

**Existing mitigation/tests:** Curated and established members are protected. Manifest tests use distinct identities; multi-alias tests vary populations. The overlapping case is missing.

**Recommendation:** Count qualifying identity groups once when evaluating manifest thresholds, or resolve identity representatives before statistical suppression. Similar names must remain separate from identity evidence.

#### M3. Suppressed classified clusters can monopolize monitoring capacity

**Category:** Realistic reliability/product risk.

**Evidence:** [Admission](../src/services/monitor.js#L124) bounds winter-only names, but independently classified Christmas/XMAS rows bypass that quota. Full-cap eviction principally targets never-verified pending rows. Public suppression does not release monitored capacity.

**Concrete scenario:** An injected set of 1000 responding `Xmas Public` endpoints on an ordinary map produced one public representative and 999 name-suppressed copies. A subsequently discovered genuine strong-map server was rejected because monitoring remained full.

**Likelihood:** Conditional on repeated listings filling the cap; easier to trigger with a smaller configured cap. Live prevalence was not measured.

**Impact and blast radius:** Global admission quality suffers despite a small visible list. Redundant queries also worsen refresh duration.

**Recovery:** No prompt automatic recovery while existing rows continue matching and being rediscovered or responding. Operator intervention, metadata changes or retention expiry can free capacity. The condition survives restoration.

**Existing mitigation/tests:** Includes receive priority; pending and winter-only pools are bounded. Tests separately require classified-capacity protection and preservation of suppressed rows, but do not assess their combined product outcome.

**Recommendation:** Preserve observations while reserving some exploration capacity or reducing the monitoring allocation of persistently suppressed clusters. Validate policy against real examples before generalizing quotas to all Christmas names.

#### M4. Default freshness can fail near the intended 1000-server scale

**Category:** Realistic reliability risk; reproduced timing model.

**Evidence:** [Live results](../src/services/monitor.js#L223) are published after the entire batch finishes. Individual observations retain their response timestamps. Subsequent cycles wait another 45 seconds; default staleness is 180 seconds.

**Concrete scenario:** Using the actual eight-worker scheduling with a virtual clock, 700 early endpoints responded in 100 ms and 300 later endpoints timed out after five seconds. The batch took 198.7 seconds. At publication, all 700 successful observations were already stale, although global snapshot freshness had just advanced.

**Likelihood:** Plausible near capacity with a substantial timeout cohort. Actual deployment timeout prevalence remains unmeasured.

**Impact and blast radius:** Potentially the entire useful list, repeatedly under stable query ordering.

**Recovery:** Automatic as the timeout cohort shrinks, or after configuration/scheduling adjustments. Stored data is preserved.

**Existing mitigation/tests:** Concurrency, timeout, capacity and freshness are configurable; operations documentation acknowledges long cycles. Existing tests omit this combined live-cycle/freshness case at 1000 endpoints.

**Recommendation:** Measure cycle duration and timeout concentration, add the deterministic scale test, and introduce modest retry backoff for repeatedly unreachable endpoints. Consider progressive publication only if simpler scheduling and freshness changes prove insufficient.

#### M5. Optional ratings storage can prevent the whole service from starting

**Category:** Confirmed failure behavior; reliability risk.

**Evidence:** [Startup](../src/index.js#L19) constructs ratings storage without a degradation path. [Initialization](../src/storage/ratings.js#L9) can fail during directory creation, SQLite opening, permission changes or schema setup.

**Concrete scenario:** A corrupt ratings database or broken storage permissions stops startup before HTTP listening, despite a readable snapshot. Invalid-database and invalid-path startup failures were reproduced without changing the repository.

**Likelihood:** Low during healthy operation; realistic after restoration, permission changes or disk failures.

**Impact and blast radius:** All browsing and APIs become unavailable because a supporting feature failed. Repeated systemd restarts can reach the start limit.

**Recovery:** Requires repairing storage and restarting. Corrupt votes may require backup restoration; the good snapshot is unaffected.

**Existing mitigation/tests:** Runtime rating-read failures preserve list reads and report `ratingsPartial`. History startup already degrades gracefully. Entry-point partial-storage startup is untested.

**Recommendation:** Make ratings initialization optional, with explicit availability reporting. Keep malformed core configuration fail-fast.

Configured unreadable GeoIP also stops startup, but this is explicitly documented. Consider a degraded location mode for an unavailable database alongside this policy review.

#### M6. Browser refresh handling can erase useful results or retain misleading cards

**Category:** Confirmed bug plus UX/reliability issue.

**Evidence:** [Polling failure handling](../public/js/app.js#L131) immediately marks every cached row stale. [Focused rendering](../public/js/view-state.js#L5) skips replacement without queuing a later poll render; the deferred mechanism is used for ratings instead.

**Concrete scenarios:**

- One failed snapshot request hides a server verified seconds earlier.
- Focus “Copy command,” then receive a snapshot removing that server: the old card remains “Online” while the update label advances. Leaving focus does not flush the skipped render.

Both paths were reproduced in an in-memory frontend harness.

**Likelihood:** Ordinary mobile/network interruptions and common button-focus behavior.

**Impact and blast radius:** One visitor’s entire list can disappear or display outdated availability.

**Recovery:** Successful subsequent polling restores failed-fetch results. Skipped rendering requires a later unfocused poll or another rendering action. No persistent data is lost.

**Existing mitigation/tests:** Automatic retry, outage messaging and deliberate focus preservation exist. Tests cover the helpers individually, not these application-level interactions.

**Recommendation:** Separate fetch availability from observation age. Queue the latest render and flush after focus exits, while preserving keyboard position. Avoid allowing the update label to imply cards were refreshed when they were not.

#### M7. Favorites are inaccessible during ordinary server failures

**Category:** UX/product issue.

**Evidence:** [Filtering](../public/js/filters.js#L16) always requires fresh online status, including Favorites mode. [Favorites storage](../public/js/app.js#L17) retains only endpoint IDs. Missing favorites have no directory comparable to missing Hidden entries.

**Concrete scenario:** A saved server becomes uncertain after one failed query. Its card disappears, and the player cannot retrieve its endpoint or remove the favorite through the UI. Repeated-name suppression can similarly replace the visible representative without preserving that favorite association.

**Likelihood:** Routine over the lifetime of saved servers.

**Impact and blast radius:** Individual saved entries; directly weakens returning to known good servers.

**Recovery:** Reappearance restores the association. Stored IDs survive, but absent/suppressed entries can remain inaccessible indefinitely.

**Existing mitigation/tests:** Identity-group representative changes preserve favorites through aliases. Tests cover that association, but not unavailable-favorite management.

**Recommendation:** Keep the general list fresh and online, but provide a small saved-server view with explicit unavailable/not-currently-listed states. Reuse already known data; do not add visitor-controlled probes or equate repeated names with identity.

#### M8. Impossible population counts remain authoritative in presentation

**Category:** Product trust/input-quality issue.

**Evidence:** [Metadata projection](../src/domain/server.js#L2) bounds counts but does not relate players to capacity. Cards display raw counts, totals sum them, and Most players sorts by them. [Tests](../test/player-history-ui.test.js#L123) explicitly preserve `65535/32` presentation.

**Concrete scenario:** A responding server advertises `255/32`, a value possible through the installed Valve INFO parser’s byte-sized fields. Capacity suppression does not reject it because capacity itself is 32. It can dominate popularity sorting and inflate totals.

**Likelihood:** Unknown without production sampling; credible for hostile or broken metadata.

**Impact and blast radius:** One endpoint can distort list ordering and aggregate population. Its history also retains anomalous measurements.

**Recovery:** Current presentation corrects after a sensible response; stored samples expire normally.

**Existing mitigation/tests:** Counts are bounded, capacities above 32 are hidden, and documentation acknowledges advertised populations. Tests verify rendering rather than conservative treatment of inconsistent occupancy.

**Recommendation:** Mark inconsistent counts and exclude them from popularity/totals without declaring the server fake. Show known bot counts, preserving unknown separately. Neither signal proves genuine human occupancy.

### Low priority / technical debt

#### L1. Supporting-feature failures are poorly observable

**Category:** Observability concern.

[History writes and cleanup](../src/services/monitor.js#L238) silently catch failures, while health degradation excludes history. A disk or SQLite failure can therefore stop samples while health appears normal. Later batches retry automatically, but missed measurements cannot be reconstructed. Store retry behavior is tested; operator-visible transitions are not.

The browser also retains old history indefinitely after fetch failures without a visible chart-age indication.

**Recommendation:** Add compact history availability/write status, last successful collection/fetch information and safe failure/recovery logs. Clarify API representatives versus fresh online browser results. No metrics platform is necessary.

#### L2. Recommended ordering overweights evidence volume relative to joinability

**Category:** Product-policy concern; intentional behavior.

The comparator places confidence, exact relevance score and ratings before availability and locality. A full or passworded high-score server can outrank a playable server in the same confidence tier. Open-slots filtering mitigates this, and tests explicitly preserve rating precedence.

**Likelihood/impact:** Common whenever results have differing evidence scores; affects ordering rather than admission or data. Users can change filters/sort.

**Recommendation:** Experiment with relevance tiers followed by joinability and useful locality, with ratings as a supporting signal. Additional repeated theme words should not automatically imply a better place to play.

#### L3. Documentation contains contradictory security and behavior claims

**Category:** Confirmed documentation mismatch.

[SECURITY.md](../SECURITY.md#L13) says all APIs reject bodies and that there are no cookies. Ratings accept bounded JSON and create a one-year voter cookie. Other drift includes:

- Supported-version wording still referring to 0.1.x.
- Architecture ranking prose omitting ratings.
- History prose describing fallback scaling that implementation/tests reject.
- Missing changelog entries for ratings, newer selection rules and runtime Master removal.
- ChristmasDust documentation versus WinterDust page branding.
- README’s API inventory omitting rating mutations.

These affect maintainers’ and operators’ understanding, without directly changing runtime data.

**Recommendation:** Reconcile the existing documents in one pass. Include proxy configuration’s effect on Secure voter cookies and per-IP limits: the default TLS proxy example alone does not make Express recognize HTTPS.

## 4. Complexity review

| Mechanism | Assessment |
|---|---|
| Separate discovery, monitoring and public reads | Justified and effective. Preserve. |
| Atomic snapshots and transactional native updates | Complexity protects real recovery requirements. |
| Separate ratings/history SQLite stores | Appropriate failure and lifecycle boundaries. |
| Whole-token classification and verified map catalog | Understandable, explainable and meaningfully tested. |
| Pending-pool bounds and complete-observation retirement | Useful controls on query cost and accidental removal. |
| Winter admission/live/restore quotas | Address a real capacity problem, but eligibility logic is spread across several methods. |
| Manifest and repeated-name suppression | Different evidence types; neither is simply redundant. Their ordering, exemptions and capacity effects need coordinated review. |
| Shared frontend/backend recommendation comparator | Creates inappropriate coupling for duplicate representative selection. |
| Legacy Master implementation and extensive tests | No runtime benefit today; optional removal/archive debt. |
| Seven days of raw samples for a 24-hour UI | Modest bounded cost, but much of retention currently has no player-facing use. No urgent change needed. |

The best simplification is an explicit selection pipeline with shared eligibility predicates and interaction tests. Avoid adding another heuristic layer before examining rejected and suppressed real-world examples.

In particular, retain distinctions between:

- Seasonal relevance.
- Identity-based aliases.
- Suspicious repetition.
- Response reliability.
- Advertised population.
- Community opinion.

Collapsing these into one “quality score” would make the system harder to explain.

## 5. Product/UX review

ChristmasDust already supports the basic player journey well: find a themed result, inspect map/country/population, connect or copy a command, and save preferences.

The largest product gaps are continuity and confidence in the list.

Concrete improvements worth pursuing:

- **Unavailable favorites:** players should retain access to a good server during temporary monitoring problems.
- **Population context:** expose known bots and inconsistent counts using cautious wording.
- **“Why listed?” explanation:** reuse existing reasons to distinguish current seasonal-map evidence, seasonal server branding and operator curation.
- **Clearer labels:** “Probable winter” is more accurate than calling an ordinary-map winter-name promotion “Christmas · probable.”
- **Practical recommendations:** test joinability/locality ahead of fine score differences within a relevance tier.

Discovery is now Steam-only plus operator curation. Consequently, finding servers Steam does not index is an operator workflow, not an automatic capability. That is a substantive limitation relative to the stated intent.

Exact-map searches are implemented, but their effectiveness through the Web API remains explicitly unverified. Likewise, requiring identity corroboration for catalogued winter maps may exclude useful ordinary-named servers. Validate those tradeoffs against reviewed examples before loosening rules.

Mobile CSS makes sensible adjustments: wrapped filters, simplified decoration, stacked actions and compact charts. Labels, focus treatment and reduced-motion support are present. Actual touch ergonomics, long-name overflow, SVG tooltips and screen-reader behavior were **not** validated in a browser engine. The small rating controls and dense sparklines deserve device testing.

## 6. Operations review

Native installation and updates are substantially sound:

- Unprivileged application process and protected configuration/releases.
- Immutable staged releases with locked dependency installation.
- Tests/checks before switching.
- Durable configuration/pointer ordering.
- Readiness plus revision verification.
- Exact legacy configuration backup and rollback.
- Persistent database paths supplied to older installations.
- GeoIP validation before replacing working files.

Important operational boundaries are documented honestly:

- Custom snapshot paths require separate rollback planning.
- Application updates preserve SQLite files rather than rolling their contents back.
- Interrupted power-loss health checks cannot finish automatic rollback.
- Retained releases need disk housekeeping.
- Node and systemd-unit updates are separate operator actions.

Back up protected environment/detection configuration, snapshot, ratings and player history separately. Database backup while stopped is the simplest documented approach. The legacy detection backup also matters when selecting pre-v2 releases.

Readiness appropriately means initialization completed; dependency outages should not cause restart loops. Health coverage is useful, but needs the supporting-feature and per-server freshness improvements above.

The deployment remains suitable for a small service. Add a short, concrete Node patching recipe and perhaps a retained-release listing aid; a larger deployment system is unnecessary.

No real systemd installation, GeoIP timer refresh or historical-release rollback was exercised during this audit.

## 7. Test review

**Actually run:**

- `npm test`: **320 passed, 0 failed**.
- `npm run check`: passed.
- `bash -n install.sh scripts/christmasdust scripts/setup-geoip`: passed.
- ShellCheck: unavailable.

The first test attempt encountered sandbox loopback restrictions. The successful rerun enabled the ephemeral local HTTP listeners.

Coverage is strong for classification, malformed endpoints/configuration, partial query fields, zero values, retirement, restoration, winter quotas, grouping, ratings transactions, history gaps/retries and deployment fault injection.

The main missing deterministic tests are:

- Unequal-score duplicate aliases plus one failed endpoint and frontend filtering.
- Identical three-alias manifests.
- Suppressed clusters occupying full admission capacity.
- Live-cycle freshness at 1000 endpoints with timeout cohorts.
- Entry-point startup with unavailable optional stores.
- Poll focus exit and failed fetches versus observation age.
- Unavailable favorite management.
- Conservative treatment of inconsistent population.

Some tests correctly enforce implementation contracts that should now be reconsidered as product decisions, particularly preservation of impossible counts and full classified-capacity protection.

Deployment tests execute meaningful transaction logic but shim systemd, ownership, downloads and readiness. DOM stubs and CSS assertions similarly cannot establish real layout or browser focus behavior.

**Integration/live validation should cover:** Steam filter effectiveness and result quality; actual GameDig/identity metadata; supported-host install/update/failed-health rollback; proxy cookies and limits; desktop/mobile connection, clipboard and accessibility behavior.

At 1000 endpoints, the database architecture does not justify a rewrite. A synthetic in-memory measurement of the ratings portion of a list read took approximately 14 ms with ten votes per endpoint and 78–82 ms with 100. This does not certify disk or HTTP performance. The more credible current scale concern is query-cycle timing; full-list DOM/SVG rebuilding is a mobile benchmark target.

## 8. Documentation review

The repository explains implementation, configuration, limitations and rollback unusually thoroughly. A new maintainer can learn how the service works.

It explains **why particular implementation rules exist** less consistently. Long selection descriptions are repeated across README, architecture and configuration, increasing drift.

I recommend a short **`PRODUCT.md`**, linked from README and AGENTS, containing:

- Useful, playable seasonal results over raw count.
- Intended players and small-service operators.
- Conservative suppression and false-negative tradeoffs.
- Relevance versus authenticity, popularity, reliability and ratings.
- Favorites and outage continuity.
- Location/privacy boundaries.
- Approximately 1000 monitored-server scope.
- Evidence required before adding heuristics or dependencies.

AGENTS should additionally require checking admission, suppression, grouping, favorites and restoration together when changing selection policy.

A **`ROADMAP.md` is optional**. Introduce it only with a small prioritized set of accepted work and explicit experiments. Another vision document would duplicate `PRODUCT.md`.

Keep README focused on purpose, setup and major limitations; retain detailed mechanics in their existing documents.

## 9. Recommended next steps

### Fixes that should probably be done soon

1. **Correct duplicate visibility.**
   Use response health for representative selection and prevent qualifying identity aliases from triggering whole-group manifest suppression. Add the two interaction regressions.

2. **Repair freshness and degraded operation.**
   Fix deferred polling and preserve recent observations through fetch failures. Add optional ratings startup handling, supporting-feature health fields and the 1000-endpoint timing test. Use measured timeout behavior to choose modest backoff/freshness adjustments.

3. **Reconcile documentation.**
   Correct privacy/API/ranking/history claims, record significant selection changes, and add the concise product principles.

### Worthwhile improvements

4. **Improve returning to and assessing servers.**
   Add unavailable-favorite management, cautious population/bot context and an optional seasonal-evidence disclosure. These reuse current data and directly support player decisions.

### Experiments to validate before implementation

5. **Evaluate selection quality with reviewed deployment samples.**
   Measure suppressed occupancy, rejected useful arrivals, Steam exact-map effectiveness and borderline winter-map classifications. Compare a small exploration reserve and alternative recommendation ordering.

6. **Exercise one supported deployment and real mobile browser.**
   Validate installation, update, failed-health rollback, GeoIP refresh, proxy behavior and realistic list performance.

### Backlog

Independent discovery sources, larger historical analysis, automatic release cleanup and more elaborate ratings abuse controls should remain backlog items until observed needs justify them. Keep precise ping measurement, accounts, framework migration and distributed monitoring outside current priorities.

## 10. Ideas

| Idea | User benefit | Complexity / reuse | Main downside or risk |
|---|---|---|---|
| **Saved-server drawer** | Return to a favorite despite temporary absence | Modest; local IDs and last-known metadata | Must distinguish unavailable/suppressed entries from current recommendations |
| **Seasonal evidence disclosure** | Understand why a result appears | Low; existing classification signals/reasons | Evidence must not imply authenticity |
| **Typical active hours** | Know when an empty seasonal server may have company | Modest; seven-day samples already collected | Sparse data and advertised counts can mislead; require sufficient observations |
| **Local endpoint explanation command** | Help an operator recover a missing useful server | Low/modest; snapshot, rules and coverage stages | Must remain local/protected and avoid public arbitrary-query capability |
