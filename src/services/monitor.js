import { classify } from '../domain/classify.js';
import { metadata, liveMetadata, cleanText } from '../domain/server.js';
import { mapLimit } from '../utils/concurrency.js';
import { parseAddress } from '../utils/address.js';
export class Monitor {
  constructor({ config, rules, discover, query, geoip = () => ({}), store, now = Date.now, log = console }) {
    Object.assign(this, { config, rules, discover, query, geoip, store, now, log });
    this.servers = new Map(); this.busy = null; this.ready = false; this.stopped = false;
    this.state = { lastDiscoveryAt: null, lastLiveAt: null, discoveryPartial: false, livePartial: false, persistenceError: false, discoveryDisabled: false };
  }
  async init() {
    try {
      const saved = await this.store.load();
      if (saved) { Object.assign(this.state, saved.state); for (const row of saved.servers) if (!this.rules.exclude.has(row.id)) this.servers.set(row.id, row); }
    } catch { this.log.warn('Snapshot restore failed; starting with configured seeds'); this.state.persistenceError = true; }
    this.prune();
    for (const row of this.rules.include) this.add(row, true);
    this.prune();
    this.ready = true;
  }
  themeObservation(raw, previous, curated) {
    const classification = classify(raw, this.rules, curated);
    if (classification.confidence !== 'none') return { classification, themeMisses: 0, lastThemeMatchAt: this.now(), retire: false };
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
    const { retire, ...theme } = this.themeObservation({ ...raw, tags: discoveryTags }, previous, curated);
    if (retire) { this.servers.delete(address.id); return; }
    if (!previous && !curated && this.servers.size >= this.config.maxServers) { this.state.discoveryPartial = true; return; }
    // Discovery metadata must not overwrite a trustworthy live response.
    this.servers.set(address.id, { ...metadata(raw), ...address, ...this.geoip(address.ip), status: 'unknown', misses: 0,
      lastSeenAt: null, lastQueryAt: null, ...previous, discoveryTags, ...theme,
      discoveredAt: theme.classification.confidence === 'none' ? previous.discoveredAt : this.now(), curated });
  }
  prune() {
    const included = new Set(this.rules.include.map(r => r.id));
    for (const [id, row] of this.servers) {
      const lastThemeMatch = row.lastThemeMatchAt ?? Math.max(row.lastSeenAt || 0, row.discoveredAt || 0);
      if (this.rules.exclude.has(id) || (!included.has(id) && (this.now() - Math.max(row.lastSeenAt || 0, row.discoveredAt || 0) > this.config.retention ||
        (row.classification.confidence === 'none' && this.now() - lastThemeMatch > this.config.retention)))) this.servers.delete(id);
      else if (!included.has(id) && row.curated) { row.curated = false; row.classification = classify({ ...row, tags: row.discoveryTags }, this.rules); }
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
        this.state.discoveryPartial = result.partial || (!result.disabled && !result.successfulRequests);
        if (result.successfulRequests) this.state.lastDiscoveryAt = this.now();
        for (const row of result.servers) this.add(row, this.rules.include.some(s => s.id === row.id));
      } else {
        const rows = [...this.servers.values()].filter(row => !ids || ids.includes(row.id));
        const results = await mapLimit(rows, this.config.concurrency, async row => {
          const raw = await this.query(row);
          return { ...row, ...liveMetadata(raw), ...this.geoip(row.ip),
            ...this.themeObservation({ ...raw, tags: row.discoveryTags }, row, row.curated),
            status: 'online', misses: 0, lastSeenAt: this.now(), lastQueryAt: this.now() };
        });
        let successes = 0;
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            successes++;
            if (result.value.retire) this.servers.delete(rows[i].id);
            else { const { retire, ...updated } = result.value; this.servers.set(rows[i].id, updated); }
          }
          else {
            const row = rows[i]; const misses = (row.misses || 0) + 1;
            this.servers.set(row.id, { ...row, misses, lastQueryAt: this.now(), status: misses >= 3 ? 'offline' : 'uncertain' });
          }
        });
        this.state.livePartial = successes !== rows.length;
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
    return { servers: [...this.servers.values()].filter(s => s.classification.confidence !== 'none').map(({ curated, discoveredAt, themeMisses, lastThemeMatchAt, discoveryTags, ...row }) => ({ ...row,
      stale: !row.lastSeenAt || this.now() - row.lastSeenAt > this.config.staleAfter,
      stability: row.misses >= 3 ? 'unreachable' : row.misses ? 'intermittent' : row.lastSeenAt ? 'responding' : 'unverified' })),
      meta: { ...this.state, snapshotAgeMs: age, stale: age === null || age > this.config.staleAfter,
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
