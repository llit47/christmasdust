import express from 'express';
import { ratingRoutes, voterHash } from './ratings.js';
import { groupEndpointIds } from '../storage/ratings.js';
import { SAMPLE_MS } from '../storage/player-stats.js';
import helmet from 'helmet';
import proxyaddr from 'proxy-addr';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
let revision = null;
try { revision = readFileSync(new URL('../../REVISION', import.meta.url), 'utf8').trim(); } catch { /* Development checkout. */ }
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
export function createApp({ config, monitor, geoip = () => ({}), now = Date.now, ratings, stats }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('env', config.mode);
  const trust = proxyaddr.compile(config.trustedProxies);
  app.set('trust proxy', trust);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'connect-src': ["'self'"], 'upgrade-insecure-requests': null } }, strictTransportSecurity: false }));
  app.use((_req, res, next) => { res.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()'); next(); });
  app.use((req, res, next) => {
    if (ratings && req.path === '/api/ratings' && ['PUT', 'DELETE'].includes(req.method)) return next();
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) return res.status(413).set('Connection', 'close').json({ error: 'Request bodies are not accepted' });
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (ratings) app.use('/api/ratings', ratingRoutes({ monitor, ratings, now }));
  app.get('/api/health', (_req, res) => res.json({ version, revision, status: 'ok', ready: monitor.ready, ...monitor.snapshot().meta }));
  app.get('/api/ready', (_req, res) => res.status(monitor.ready ? 200 : 503).json({ version, revision, ready: monitor.ready }));
  let historyCache = null;
  app.get('/api/player-history', (_req, res) => {
    try {
      if (!stats) throw new Error('History unavailable');
      const ids = [...new Set(monitor.snapshot().servers.map(server => server.id))].sort();
      const key = JSON.stringify(ids);
      const timestamp = now();
      // One shared entry, checked against current visibility on every request.
      if (!historyCache || historyCache.key !== key || timestamp < historyCache.createdAt ||
        timestamp - historyCache.createdAt >= SAMPLE_MS) {
        const payload = JSON.stringify(stats.history(ids, timestamp));
        historyCache = { key, createdAt: timestamp, payload };
      }
      res.type('json').send(historyCache.payload);
    } catch {
      historyCache = null;
      res.status(503).json({ error: 'Player history unavailable' });
    }
  });
  app.get('/api/servers', (req, res) => {
    let countryCode = geoip(req.ip).countryCode ?? null;
    if (config.trustCf && trust(req.socket.remoteAddress, 0)) {
      const cf = req.get('CF-IPCountry');
      if (/^[A-Z]{2}$/.test(cf ?? '') && !['XX', 'T1'].includes(cf)) countryCode = cf;
    }
    const snapshot = monitor.snapshot();
    const currentVoter = voterHash(req);
    let ratingsFailed = false;
    const servers = ratings ? snapshot.servers.map(server => {
      let totals = { up: 0, down: 0, vote: null };
      if (!ratingsFailed) {
        try { totals = ratings.totals(groupEndpointIds(server), currentVoter); }
        catch { ratingsFailed = true; /* Avoid repeated SQLite busy-timeout waits in this request. */ }
      }
      return { ...server, ratings: totals };
    }) : snapshot.servers;
    res.json({ ...snapshot, servers, meta: { ...snapshot.meta, ratingsPartial: ratingsFailed, serverGeoipConfigured: Boolean(config.geoipPath) }, visitor: { countryCode }, version });
  });
  let lastAdmin = -Infinity;
  app.post('/api/admin/refresh', (req, res) => {
    if (!config.adminToken) return res.sendStatus(404);
    const received = Buffer.from(req.get('Authorization') ?? '');
    const expected = Buffer.from(`Bearer ${config.adminToken}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return res.sendStatus(401);
    if (now() - lastAdmin < 60000) return res.status(429).set('Retry-After', '60').json({ error: 'Refresh cooldown' });
    if (monitor.busy) return res.status(409).json({ error: 'Refresh already running' });
    lastAdmin = now();
    void monitor.run('discovery').then(() => monitor.run('live'));
    return res.status(202).json({ accepted: true });
  });
  // Only rating mutations accept bodies; public reads never query network adapters.
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(fileURLToPath(new URL('../../public', import.meta.url)), { maxAge: 0, dotfiles: 'deny' }));
  app.use((_req, res) => res.sendStatus(404));
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Internal server error' }));
  return app;
}
