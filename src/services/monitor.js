import { filterSameNameMirrors, normalizedName } from '../domain/name-mirrors.js';
import { classify } from '../domain/classify.js';
import { metadata, liveMetadata, cleanText } from '../domain/server.js';
import { a2sFingerprint, groupDuplicates } from '../domain/duplicates.js';
import { liveManifestFingerprint, establishManifests, filterMirroredManifests } from '../domain/manifests.js';
import { mapLimit } from '../utils/concurrency.js';
import { parseAddress } from '../utils/address.js';
export class Monitor {
  constructor({ config, rules, discover, query, geoip = () => ({}), store, stats, now = Date.now, log = console }) {
    Object.assign(this, { config, rules, discover, query, geoip, store, stats, now, log });
    this.servers = new Map(); this.busy = null; this.ready = false; this.stopped = false;
    this.state = { lastDiscoveryAt: null, lastLiveAt: null, discoveryPartial: false, livePartial: false, persistenceError: false, discoveryDisabled: false };
    this.coverage = {
      discovery: { steamEndpoints: 0, candidatesRetained: 0, candidatesDropped: 0 },
      live: { queriedEndpoints: 0, queryFailures: 0, classificationNone: 0 }
    };
  }
  async init() {
    try {
      const saved = await this.store.load();
      if (saved) {
        Object.assign(this.state, saved.state);
        for (const row of saved.servers) {
          if (this.rules.exclude.has(row.id)) continue;
          if (row.classification?.confidence === 'none') { this.servers.set(row.id, { ...row, ...this.geoip(row.ip) }); continue; }
          const classification = this.classification({ ...row, tags: row.discoveryTags, description: row.discoveryDescription,
            discoverySources: row.discoverySources }, row.curated, row.lastSeenAt != null &&
              row.classification?.signals?.some(signal => signal.kind === 'live-verified-winter-name'));
          // Apply updated relevance rules to complete restored metadata immediately.
          if (classification.confidence === 'none' && cleanText(row.name).trim() && cleanText(row.map).trim()) continue;
          this.servers.set(row.id, { ...row, ...this.geoip(row.ip), classification: classification.confidence === 'none' ? row.classification : classification });
        }
      }
    } catch { this.log.warn('Snapshot restore failed; starting with configured seeds'); this.state.persistenceError = true; }
    this.prune();
    for (const row of this.rules.include) this.add(row, true);
    this.prune();
    this.ready = true;
  }
  classification(raw, curated, liveVerified = false) {
    const classification = classify(raw, this.rules, curated);
    const name = normalizedName(raw.name);
    if (classification.confidence === 'none' && liveVerified && raw.discoverySources?.includes('name:winter') &&
      ` ${name} `.includes(' winter ') && !['no', 'not', 'non', 'without', 'anti'].some(word =>
        ` ${name} `.includes(` ${word} winter `))) {
      const reason = 'name: live-verified targeted winter identity';
      return { ...classification, confidence: 'probable',
        signals: [...classification.signals, { field: 'name', kind: 'live-verified-winter-name', term: 'winter', points: 0, reason }],
        reasons: [...classification.reasons, reason] };
    }
    return classification;
  }
  themeObservation(raw, previous, curated, liveVerified = false) {
    // An omitted map retains both the last-good metadata and its strong map evidence.
    const retainStrongMap = !cleanText(raw.map).trim() && previous?.classification?.signals?.some(signal =>
      signal.field === 'map' && signal.points > 0 && ['known-strong-map', 'explicit'].includes(signal.kind));
    const classification = this.classification({ ...raw, map: retainStrongMap ? previous.map : raw.map }, curated, liveVerified);
    if (classification.confidence !== 'none') {
      const observedTheme = curated || !retainStrongMap || classification.signals.some(signal =>
        ['name', 'tags', 'description'].includes(signal.field) && signal.points > 0);
      return { classification, themeMisses: observedTheme ? 0 : previous.themeMisses || 0,
        lastThemeMatchAt: observedTheme ? this.now() : previous.lastThemeMatchAt, retire: false };
    }
    if (!previous) return { retire: true };
    // Empty/incomplete responses and query failures are not evidence of a theme change.
    if (!cleanText(raw.name).trim() || !cleanText(raw.map).trim()) {
      return { classification: previous.classification, themeMisses: previous.themeMisses || 0,
        lastThemeMatchAt: previous.lastThemeMatchAt, retire: false };
    }
    const themeMisses = (previous.themeMisses || 0) + 1;
    return { classification, themeMisses,
      lastThemeMatchAt: previous.lastThemeMatchAt ?? Math.max(previous.lastSeenAt || 0, previous.discoveredAt || 0),
      retire: themeMisses >= 2 };
  }
  add(raw, curated = false) {
    const address = parseAddress(raw.id);
    if (this.rules.exclude.has(address.id)) return;
    const previous = this.servers.get(address.id);
    const discoveryTags = typeof raw.tags === 'string' ? cleanText(raw.tags) : previous?.discoveryTags;
    const discoveryDescription = typeof raw.description === 'string' ? cleanText(raw.description) : previous?.discoveryDescription;
    const discoverySources = Array.isArray(raw.discoverySources) ?
      [...new Set([...(previous?.discoverySources || []), ...raw.discoverySources])] : previous?.discoverySources;
    // Discovery cannot re-verify winter identity or overwrite its last live observation.
    const verifiedWinter = previous?.lastSeenAt != null && previous.classification?.signals?.some(signal =>
      signal.kind === 'live-verified-winter-name');
    const { retire, ...theme } = this.themeObservation({ ...raw,
      ...(verifiedWinter ? { name: previous.name, map: previous.map } : {}), tags: discoveryTags, description: discoveryDescription,
      discoverySources }, previous, curated, verifiedWinter);
    if (retire) {
      if (!previous && raw.candidateOnly === true) Object.assign(theme, { classification: classify({}, this.rules), themeMisses: 0 });
      else { this.servers.delete(address.id); return; }
    }
    // Bound new winter-only mirrors across discovery cycles and live promotion.
    // Existing, independently relevant and operator-included rows bypass admission caps.
    if (!previous && !curated && theme.classification.confidence === 'none' && discoverySources?.includes('name:winter')) {
      const name = normalizedName(raw.name);
      if ([...this.servers.values()].filter(row => normalizedName(row.name) === name).length >= 2) return;
    }
    if (!previous && !curated && this.servers.size >= this.config.maxServers) { this.state.discoveryPartial = true; return; }
    // Targeted samples and compatible legacy snapshots share one bounded pending pool.
    if (!previous && !curated && raw.candidateOnly === true && theme.classification.confidence === 'none' &&
      [...this.servers.values()].filter(row => row.classification.confidence === 'none').length >= 128) {
      this.state.discoveryPartial = true; return;
    }
    // Discovery metadata must not overwrite a trustworthy live response.
    this.servers.set(address.id, { ...metadata(raw), ...address, status: 'unknown', misses: 0,
      lastSeenAt: null, lastQueryAt: null, ...previous, ...this.geoip(address.ip), discoveryTags, discoveryDescription, discoverySources, ...theme,
      discoveredAt: theme.classification.confidence === 'none' ? previous?.discoveredAt ?? this.now() : this.now(), curated });
  }
  prune() {
    const included = new Set(this.rules.include.map(r => r.id));
    for (const [id, row] of this.servers) {
      const lastThemeMatch = row.lastThemeMatchAt ?? Math.max(row.lastSeenAt || 0, row.discoveredAt || 0);
      if (this.rules.exclude.has(id) || (!included.has(id) && (this.now() - Math.max(row.lastSeenAt || 0, row.discoveredAt || 0) > this.config.retention ||
        (row.classification.confidence === 'none' && this.now() - lastThemeMatch > this.config.retention)))) this.servers.delete(id);
      else if (!included.has(id) && row.curated) { row.curated = false; row.classification = classify({ ...row, tags: row.discoveryTags,
        description: row.discoveryDescription, discoverySources: row.discoverySources }, this.rules); }
    }
    const capacity = Math.max(this.config.maxServers, included.size);
    const removable = [...this.servers.values()].filter(row => !included.has(row.id))
      .sort((a, b) => (a.lastSeenAt || a.discoveredAt || 0) - (b.lastSeenAt || b.discoveredAt || 0));
    for (const row of removable) {
      if (this.servers.size <= capacity) break;
      this.servers.delete(row.id);
    }
  }
  async run(kind, ids) {
    if (this.busy || this.stopped) return false;
    this.busy = kind;
    try {
      this.prune();
      if (kind === 'discovery') {
        const result = await this.discover();
        this.state.discoveryDisabled = result.disabled;
        this.state.discoveryPartial = result.partial || (!result.disabled && !result.successfulRequests && !result.samplingSkipped);
        if (result.successfulRequests) this.state.lastDiscoveryAt = this.now();
        const counters = this.coverage.discovery;
        for (const field of ['steamEndpoints']) {
          const value = result.coverage?.[field];
          if (value === undefined) continue;
          counters[field] = Number.isSafeInteger(value) ? Math.max(0, Math.min(1000000, value)) : 0;
        }
        counters.candidatesRetained = 0; counters.candidatesDropped = 0;
        const included = new Set(this.rules.include.map(row => row.id));
        const priority = row => classify(row, this.rules, included.has(row.id)).confidence !== 'none' ? 0 :
          row.discoverySources?.some(source => typeof source === 'string' &&
            (source.startsWith('name:') || source.startsWith('map:') || source.startsWith('master:map:'))) ? 1 : 2;
        // Decide before any admission consumes MAX_SERVERS or the shared pending pool.
        const candidates = result.servers.map(row => ({ row, priority: priority(row) }))
          .sort((a, b) => a.priority - b.priority);
        for (const { row } of candidates) this.add(row, included.has(row.id));
        for (const row of result.servers) {
          if (this.servers.has(row.id)) counters.candidatesRetained++;
          else counters.candidatesDropped++;
        }
      } else {
        const rows = [...this.servers.values()].filter(row => !ids || ids.includes(row.id));
        const samples = [];
        const results = await mapLimit(rows, this.config.concurrency, async row => {
          const raw = await this.query(row);
          const measured = liveMetadata(raw);
          const playerCount = raw.numplayers ?? raw.players;
          if (!this.stopped && this.stats && Number.isInteger(playerCount) && playerCount >= 0 && playerCount <= 65535)
            samples.push({ id: row.id, players: measured.players, timestamp: this.now() });
          return { ...row, ...measured, a2sFingerprint: a2sFingerprint(raw),
            liveManifestFingerprint: liveManifestFingerprint(raw), ...this.geoip(row.ip),
            ...this.themeObservation({ ...raw, tags: row.discoveryTags,
              description: typeof raw.description === 'string' ? raw.description : row.discoveryDescription,
              discoverySources: row.discoverySources }, row, row.curated, true),
            status: 'online', misses: 0, lastSeenAt: this.now(), lastQueryAt: this.now() };
        });
        if (!this.stopped) {
          // No SQLite transaction is held while game queries are in flight.
          try { this.stats?.recordMany(samples); this.stats?.prune(this.now()); }
          catch { /* Retry history writes/cleanup on later live activity. */ }
        }
        let successes = 0;
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            successes++;
            if (result.value.retire) this.servers.delete(rows[i].id);
            else { const { retire, ...updated } = result.value; this.servers.set(rows[i].id, updated); }
          }
          else {
            const row = rows[i]; const misses = (row.misses || 0) + 1;
            const sources = row.discoverySources;
            const pendingSource = Array.isArray(sources) && (sources.some(source => typeof source === 'string' &&
              (source.startsWith('name:') || source.startsWith('map:'))) ||
              (sources.includes('master-udp') && sources.every(source => typeof source === 'string' &&
                (source === 'master-udp' || source.startsWith('master:')))));
            // Recycle unreachable pending discovery slots; any successful live response protects last-good data.
            if (misses >= 3 && row.lastSeenAt == null && row.classification.confidence === 'none' &&
              !row.curated && pendingSource)
              this.servers.delete(row.id);
            else this.servers.set(row.id, { ...row, misses, lastQueryAt: this.now(), status: misses >= 3 ? 'offline' : 'uncertain' });
          }
        });
        establishManifests([...this.servers.values()], new Set(results.flatMap((result, i) =>
          result.status === 'fulfilled' ? [rows[i].id] : [])), this.now(), this.config.staleAfter);
        this.state.livePartial = successes !== rows.length;
        this.coverage.live = { queriedEndpoints: rows.length, queryFailures: rows.length - successes,
          classificationNone: results.filter(result => result.status === 'fulfilled' && result.value.classification.confidence === 'none').length };
        if (successes || rows.length === 0) this.state.lastLiveAt = this.now();
      }
      this.state.persistenceError = false;
      try { await this.store.save({ schema: 1, state: this.state, servers: [...this.servers.values()] }); }
      catch { this.state.persistenceError = true; this.log.warn('Snapshot persistence failed'); }
    } catch {
      this.state[kind === 'discovery' ? 'discoveryPartial' : 'livePartial'] = true;
      this.log.warn(`${kind} refresh failed; retaining previous data`);
    } finally { this.busy = null; }
    return true;
  }
  snapshot() {
    const age = this.state.lastLiveAt === null ? null : Math.max(0, this.now() - this.state.lastLiveAt);
    // CS 1.6 supports 32 clients. Keep oversized records monitored so they can recover.
    const rows = [...this.servers.values()].filter(s => s.classification.confidence !== 'none' && !(s.maxPlayers > 32)).map(({ discoveredAt, themeMisses, lastThemeMatchAt, discoveryTags, discoveryDescription, discoverySources, ...row }) => ({ ...row,
      stale: !row.lastSeenAt || this.now() - row.lastSeenAt > this.config.staleAfter,
      stability: row.misses >= 3 ? 'unreachable' : row.misses ? 'intermittent' : row.lastSeenAt ? 'responding' : 'unverified' }));
    const manifests = filterMirroredManifests(rows);
    const names = filterSameNameMirrors(manifests);
    const grouped = groupDuplicates(names);
    return { servers: grouped,
      meta: { ...this.state, snapshotAgeMs: age, stale: age === null || age > this.config.staleAfter,
        coverage: { ...this.coverage, visibility: {
          monitoredEndpoints: this.servers.size,
          classificationNone: [...this.servers.values()].filter(row => row.classification.confidence === 'none').length,
          capacityHidden: [...this.servers.values()].filter(row => row.classification.confidence !== 'none' && row.maxPlayers > 32).length,
          manifestSuppressed: rows.length - manifests.length, nameMirrorSuppressed: manifests.length - names.length,
          duplicateAliases: names.length - grouped.length, publicServers: grouped.length
        } },
        refreshing: this.busy, degraded: this.state.discoveryPartial || this.state.livePartial || this.state.persistenceError } };
  }
  start() {
    this.timers = new Set();
    const schedule = (kind, delay) => {
      if (this.stopped) return;
      const timer = setTimeout(async () => {
        this.timers.delete(timer);
        await this.run(kind);
        schedule(kind, delay);
      }, delay);
      this.timers.add(timer);
    };
    // Initial live query follows discovery, including when Steam fails.
    this.initial = this.run('discovery').then(() => this.run('live')).then(() => {
      schedule('discovery', this.config.discoveryInterval);
      schedule('live', this.config.liveInterval);
    });
  }
  stop() { this.stopped = true; for (const timer of this.timers || []) clearTimeout(timer); }
}
