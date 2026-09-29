# Security

Report vulnerabilities privately through the repository's GitHub private vulnerability reporting facility if enabled. If unavailable, contact the repository owner privately; do not post credentials or exploit details in public issues. Version 0.1.x is the initial supported line.

## Boundaries

Game server metadata is hostile. Backend metadata is bounded and projected to known fields; no raw player lists or upstream exceptions reach the API. Frontend rendering uses textContent and native DOM nodes. Steam links and console commands accept only parsed IP:port endpoints. A restrictive self-only script/style CSP, Helmet headers, no inline scripts and no remote cosmetic libraries reduce injection exposure.

Only discovery and operator configuration choose query targets. Public routes read cached data and cannot request arbitrary network probes. Literal public IPv4 validation prevents DNS rebinding and private-network scanning; IPv6 game endpoints are intentionally unsupported. GameDig queries use fixed ports, bounded concurrency, timeout and one attempt. Steam requests use a fixed HTTPS origin, no redirects, regional limits and a bounded response size.

Visitor IP is read from the connection unless explicitly trusted proxy networks are configured. Those proxies must sanitize forwarded IP/country headers. CF-IPCountry is accepted only when enabled and the immediate peer is trusted. Never configure broad trust as a substitute for an origin firewall. Visitor IP and precise coordinates are not persisted or logged by the application. Browser geolocation is opt-in and memory-only; distance calculations stay in the browser. Hosting/proxy logs have their own privacy implications.

All APIs reject request bodies. No CORS sharing is enabled. The optional admin endpoint requires a constant-time Bearer token comparison, rejects when busy and permits at most one accepted refresh per minute. It accepts no target addresses. Configure a high-entropy token, HTTPS and optionally reverse-proxy access restrictions/rate limits. The browser never receives the token. There is no admin UI or cookie-based authentication.

The systemd process is unprivileged, has no capabilities, and can write only its state directory and private temporary directory. Application releases are root-owned. Root-owned configuration must never be writable by the service. Dependency install uses a lockfile and disables lifecycle scripts. Updates execute reviewed repository code and tests as the service user; release channels must be trusted. The root installer is powerful: inspect or pin it as appropriate. Node downloads use official HTTPS checksums, not a separate signature trust chain.

TLS and denial-of-service protections belong at the reverse proxy. The app intentionally does not set HSTS on local HTTP; configure HSTS at your TLS terminator. HTTP header/request deadlines and no-body APIs bound common inputs. There are no analytics, visitor accounts or cookies.

Snapshots contain public server observations, no keys or visitor data. Atomic writes prevent torn JSON; corruption is reported and falls back to seeds. Protect backups and don't commit `.env`, runtime snapshots, MMDB files or logs. Run npm audit when upgrading dependencies. GameDig's protocol dependency tree is a residual supply-chain surface.
