import { classify } from '../domain/classify.js';
import { metadata } from '../domain/server.js';
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
    this.ready = true;
  }
  add(raw, curated = false) {
    const address = parseAddress(raw.id);
    if (this.rules.exclude.has(address.id)) return;
    const previous = this.servers.get(address.id);
    const classification = classify(raw, this.rules, curated);
    if (classification.confidence === 'none' && !previous) return;
    if (!previous && !curated && this.servers.size >= this.config.maxServers) { this.state.discoveryPartial = true; return; }
    // Discovery metadata must not overwrite a trustworthy live response.
    this.servers.set(address.id, { ...metadata(raw), ...address, ...this.geoip(address.ip), status: 'unknown', misses: 0,
      lastSeenAt: null, lastQueryAt: null, ...previous, classification: previous && !curated ? previous.classification : classification,
      discoveredAt: this.now(), curated });
  }
  prune() {
    const included = new Set(this.rules.include.map(r => r.id));
    for (const [id, row] of this.servers) {
      if (this.rules.exclude.has(id) || (!included.has(id) && this.now() - Math.max(row.lastSeenAt || 0, row.discoveredAt || 0) > this.config.retention)) this.servers.delete(id);
      else if (!included.has(id) && row.curated) { row.curated = false; row.classification = classify(row, this.rules); }
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
          return { ...row, ...metadata(raw), ...this.geoip(row.ip), classification: classify(raw, this.rules, row.curated),
            status: 'online', misses: 0, lastSeenAt: this.now(), lastQueryAt: this.now() };
        });
        let successes = 0;
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') { successes++; this.servers.set(rows[i].id, result.value); }
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
    return { servers: [...this.servers.values()].filter(s => s.classification.confidence !== 'none').map(({ curated, discoveredAt, ...row }) => ({ ...row,
      stale: !row.lastSeenAt || this.now() - row.lastSeenAt > this.config.staleAfter,
      stability: row.misses >= 3 ? 'unreachable' : row.misses ? 'intermittent' : row.lastSeenAt ? 'responding' : 'unverified' })),
      meta: { ...this.state, snapshotAgeMs: age, stale: age === null || age > this.config.staleAfter,
        refreshing: this.busy, degraded: this.state.discoveryPartial || this.state.livePartial || this.state.persistenceError } };
  }
  start() {
    const tick = async (kind, delay) => {
      if (this.stopped) return;
      await this.run(kind);
      if (!this.stopped) this.timers.push(setTimeout(() => tick(kind, delay), delay));
      this.timers = this.timers.filter(timer => !timer._destroyed);
    };
    this.timers = [];
    // Initial live query follows discovery, including when Steam fails.
    this.initial = this.run('discovery').then(() => tick('live', this.config.liveInterval));
    this.timers.push(setTimeout(() => tick('discovery', this.config.discoveryInterval), this.config.discoveryInterval));
  }
  stop() { this.stopped = true; for (const timer of this.timers || []) clearTimeout(timer); }
}
