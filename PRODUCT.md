# Product

## Purpose

ChristmasDust is a small, self-hosted browser for real, playable Christmas- and winter-themed Counter-Strike 1.6 servers.

Its primary job is not to discover or display the largest possible number of endpoints. Its job is to help a player find a seasonal server worth joining, with enough context to understand why it is listed and enough continuity to return to a good server later.

A useful public list is more important than a large public list.

## Audience

ChristmasDust is built for two audiences:

- **Players** who want to find and join Christmas or winter CS 1.6 servers quickly.
- **Operators** who want to self-host the service with low maintenance and understandable failure modes.

The project is intentionally optimized for a small deployment, not an Internet-scale indexing platform.

## Product principles

### Prefer useful results over raw coverage

Discovery exists to supply good candidates. High endpoint counts are not a success metric by themselves.

A server that is seasonal, currently playable and reasonably trustworthy is more valuable than dozens of duplicated, mirrored, misleading or unreachable listings.

### Keep different kinds of evidence separate

ChristmasDust uses several signals that answer different questions:

- **Seasonal relevance:** does the server appear Christmas/winter themed?
- **Identity:** are multiple endpoints evidence of the same server?
- **Suspicious repetition:** are many listings unusually alike?
- **Reliability:** is the endpoint currently responding and fresh?
- **Population:** what does the server advertise about current occupancy?
- **Community opinion:** what do anonymous ratings say?

These signals must not be collapsed into one opaque “quality” or “fake” score.

In particular, seasonal relevance is not proof of authenticity, repeated metadata is not proof of fraud, advertised population is not proof of human players, and ratings are not proof of unique people.

### Suppress conservatively

The browser should reduce obvious low-value duplication and suspicious repetition where evidence is strong enough, but avoiding false negatives matters.

A heuristic that hides legitimate seasonal servers is a product regression even if it reduces noise.

Never describe a heuristic result as proof that a server is fake.

### Preserve player continuity

Temporary Steam, UDP, storage, proxy or browser failures should not unnecessarily erase useful last-known information.

Favorites are meant to help players return to good servers. Supporting features should not make the whole browser unavailable when they fail.

Freshness and uncertainty should be represented explicitly rather than silently turning recent good data into bad data.

### Prefer explainable behavior

A maintainer should be able to explain why a server:

- entered monitoring,
- qualified as seasonal,
- was hidden or grouped,
- became stale or unavailable,
- ranked where it did.

When a new heuristic is proposed, prefer a small rule with concrete evidence over a broad score or additional hidden coupling.

### Measure before adding another heuristic

Selection behavior already spans discovery, admission, classification, suppression, grouping, persistence and frontend filtering.

Before adding another anti-fake, admission or ranking rule:

1. Identify a real or reproducible failure mode.
2. Estimate how often it can happen in normal operation.
3. Measure existing production examples when possible.
4. Check interactions with adjacent selection stages.
5. Add a deterministic regression test for the behavior being changed.

Do not solve a hypothetical Internet-scale problem unless it is credible within the project's intended scale.

### Keep self-hosting simple

The preferred architecture remains:

- one Node.js service,
- plain HTML/CSS/ES modules,
- bounded external queries,
- cached public reads,
- local persistent state,
- minimal dependencies.

Avoid framework migrations, distributed components or new infrastructure unless they solve a demonstrated problem that cannot be handled cleanly within the current design.

### Fail soft where safe

Core configuration that makes operation unsafe or undefined should fail fast.

Optional supporting capabilities should degrade where practical instead of taking down the entire browser. Degraded state should be observable to the operator.

Last-good server observations should be preserved across partial failures when doing so does not create a security or correctness problem.

### Protect visitor privacy

Precise browser coordinates stay client-side and must not be persisted or uploaded.

Backend query latency is monitor-to-server latency and must never be presented as visitor ping.

Public users must not be able to turn ChristmasDust into an arbitrary network scanner.

## Intended scale

Design and review decisions should assume approximately **1000 monitored servers** as a practical upper bound for the current product.

Performance work should focus on credible bottlenecks at that scale, especially live-query cycle duration, public projection and browser rendering.

Designing for millions of endpoints is outside the current product scope.

## Product success

ChristmasDust is succeeding when a player can:

1. Open the page and quickly see a compact list of relevant seasonal servers.
2. Understand basic availability, map, population and location context.
3. Avoid obvious duplicate or low-value noise without losing legitimate choices.
4. Join or copy the connection command easily.
5. Save a useful server and find it again later.
6. Continue using the browser sensibly through ordinary partial failures.

For the operator, success means installation, updates, backup, recovery and troubleshooting remain understandable without running a large platform.

## Non-goals

The current product is not trying to become:

- a general-purpose CS 1.6 server browser,
- a public arbitrary-query or scanning service,
- a proof system for identifying fake servers or fake players,
- a visitor-ping measurement network,
- an account/social platform,
- a distributed monitoring system,
- an analytics warehouse,
- a frontend framework showcase,
- an Internet-scale search engine.

These boundaries may be revisited only when a concrete product need justifies the added complexity.

## Engineering decision bar

For material changes, especially to discovery, admission, suppression, grouping, ranking, favorites or persistence, document:

- the concrete scenario being solved,
- realistic likelihood,
- user/operator impact,
- blast radius,
- recovery behavior,
- interaction with adjacent selection stages,
- tests that demonstrate both the problem and the intended behavior.

Prefer the smallest change that fixes the demonstrated problem.
