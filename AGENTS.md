# Working on ChristmasDust

Before non-trivial work, read [PRODUCT.md](PRODUCT.md) for product intent and [ROADMAP.md](ROADMAP.md) for current priorities. Use [docs/PROJECT_AUDIT.md](docs/PROJECT_AUDIT.md) as the baseline project-wide audit, not as an instruction to implement every finding.

Inspect git status, branch and remotes first. Never work directly on main; use a feature branch. Keep changes small and reviewable and commit recovery checkpoints. Run npm test and npm run check, and bash -n for changed shell scripts. Avoid unnecessary dependencies and framework rewrites. Preserve plain HTML/CSS/ES module frontend simplicity.

When changing discovery, admission, classification, suppression, duplicate grouping, ranking, favorites or restoration, review the selection pipeline end to end. Check interactions with adjacent stages and add deterministic interaction tests for the concrete scenario being changed. Do not add a new heuristic for a purely theoretical case; prefer measured or reproducible evidence and the smallest sufficient fix.

Never label backend GameDig latency as visitor ping. Keep discovery separate from live queries and public snapshot reads. Preserve last good data across partial failures. Treat external server metadata as hostile input; use textContent and validated public IPv4 endpoints. Never persist precise visitor coordinates. Do not log secrets. Report files changed, tests actually run and tradeoffs honestly.
