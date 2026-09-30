# Changelog

## 0.2.0 — Unreleased

- Persist browser search, filters, and sort preferences locally, with safe fallback when server options change.
- Add personal Hidden servers with endpoint-aware grouping and restore controls; favorites remain independent.
- Keep the compact browser focused on online, fresh servers, with manual country filtering, optional local distance sorting, and last-update time.

## 0.1.0

Initial Christmas server browser: Steam discovery, GameDig monitoring, resilient snapshots, configurable classification, private location ranking, favorites, native installation and rollback updates.

- Score Christmas relevance from explicit name/tag/description and map evidence; require corroboration for probable maps and reject generic snow-only matches.
- Add a vetted Christmas map catalog and bounded exact-map discovery alongside regional and name searches.
- Version detection configuration and migrate legacy operator files transactionally during native updates.
- Show server countries from a local City MMDB when configured, explain unavailable country filtering, and add a frontend-only Hide empty servers control.
- Add `sudo christmasdust setup-geoip` for native MaxMind download, protected configuration, periodic refresh and app reload.
- Group strongly matching live A2S endpoints into one public result while retaining every monitored endpoint.
