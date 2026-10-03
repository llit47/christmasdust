# Roadmap

This roadmap is a short priority guide, not a release promise. It is based on the project-wide audit in [docs/PROJECT_AUDIT.md](docs/PROJECT_AUDIT.md) and the product principles in [PRODUCT.md](PRODUCT.md).

Do not treat every audit observation as an implementation requirement. Measured product value and realistic failure likelihood take priority over theoretical completeness.

## Current baseline

- The project-wide audit is preserved in the repository.
- The current architecture is considered appropriate for the intended small self-hosted deployment.
- No credible high-priority architectural or security issue was identified by the audit.
- Selection behavior is the main area that needs careful interaction testing: discovery → admission → classification → suppression → identity grouping → frontend filtering.

## Next

These should remain small, reviewable changes rather than one large cleanup.

### 1. Correct duplicate visibility interactions

Address audit findings **M1 and M2** together:

- Ensure a healthy/fresh endpoint is not hidden behind an uncertain duplicate representative.
- Prevent manifest suppression from eliminating all endpoints when matching endpoints have credible shared identity.
- Add deterministic interaction regressions for both cases.

Keep identity evidence separate from similar-name or manifest heuristics.

### 2. Fix browser polling continuity

Address **M6**:

- Do not mark all cached server observations stale solely because one snapshot HTTP request failed.
- Queue a skipped poll render while a card is focused and flush it after focus leaves.
- Keep status/update labels consistent with what is actually rendered.
- Add application-level regression tests.

This should be a focused frontend reliability change.

### 3. Degrade supporting storage safely

Address **M5** and the relevant part of **L1**:

- Ratings storage failure at startup should not unnecessarily take down the entire browser.
- Expose supporting-feature availability/degradation clearly.
- Preserve fail-fast behavior for unsafe or malformed core configuration.
- Add startup/failure regression tests.

Do not introduce a new storage system.

### 4. Reconcile documentation drift

Address **L3** in one documentation pass:

- Security/privacy wording for rating request bodies and voter cookies.
- Current supported-version wording.
- API inventory.
- Ranking/history descriptions.
- Significant selection/discovery changes in the changelog where appropriate.
- Branding inconsistencies.

Keep implementation mechanics in the detailed docs and product intent in PRODUCT.md.

## Measure before changing policy

These findings are credible but should not trigger broad algorithm changes without deployment evidence.

### Query-cycle freshness — M4

Collect or expose enough information to understand:

- live-cycle duration,
- number/rate of timeouts,
- how many observations are already old when a batch is published,
- behavior near the intended 1000-server ceiling.

Add a deterministic scale regression.

Only then decide whether modest retry backoff, scheduling changes or freshness adjustments are necessary. Progressive publication is a later option, not the default solution.

### Suppressed clusters consuming monitoring capacity — M3

Measure:

- monitored endpoints versus public representatives,
- occupancy of repeated-name/manifest-suppressed clusters,
- useful arrivals rejected because capacity is full.

Do not generalize the winter quota or add broad Christmas-name quotas without reviewed real-world examples.

### Recommendation ordering — L2

Treat changes to recommended ordering as a product experiment.

Compare fine-grained relevance score, joinability, locality and ratings within seasonal relevance tiers. Avoid changing ranking merely because a different comparator looks cleaner in isolation.

## Worthwhile product improvements

These are useful after the correctness/reliability work above.

### Unavailable favorites — M7

Provide a small saved-server view for favorites that are currently unavailable or no longer represented in the public list.

Requirements:

- keep unavailable state explicit,
- allow removing the saved entry,
- reuse last-known/local data where safe,
- do not add visitor-controlled network probes.

### Inconsistent population handling — M8

Treat impossible advertised occupancy such as players greater than capacity as inconsistent metadata.

Consider excluding inconsistent counts from popularity ordering and aggregate totals while still showing the server cautiously. Known bot counts may provide additional context but must not be treated as proof of human occupancy.

### Explain why a server is listed

Reuse existing seasonal classification reasons/signals to provide a compact explanation where it improves player trust.

Keep seasonal evidence separate from authenticity claims.

## Backlog / experiments

Keep these out of near-term work until the core list is demonstrably better:

- Typical active hours from existing player-history samples.
- A local/operator-only endpoint explanation tool for diagnosing missing servers.
- Independent discovery sources if Steam coverage gaps are measured and important.
- Automatic retained-release cleanup.
- Stronger ratings-abuse controls if actual abuse appears.
- Longer historical analysis if there is a concrete player use case.

## Explicitly outside current priorities

Do not prioritize without a new demonstrated requirement:

- account systems,
- precise visitor ping measurement,
- public arbitrary server probes,
- frontend framework migration,
- distributed monitoring,
- major database replacement,
- Internet-scale architecture.

## Roadmap maintenance

When a roadmap item is implemented:

- link the relevant PR/issue or summarize the completed behavior,
- move durable product rules into PRODUCT.md or the appropriate technical documentation,
- remove obsolete implementation detail from this file.

When new work is proposed, prefer adding it here only after the problem and intended outcome are understood.
