import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { parseAddress } from '../utils/address.js';
import { groupEndpointIds } from '../storage/ratings.js';

const cookieName = 'christmasdust_voter';
const hash = token => createHash('sha256').update(token).digest('hex');
export function voterToken(req) {
  const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim());
  const token = cookies.find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token ?? '') ? token : null;
}
export const voterHash = req => { const token = voterToken(req); return token ? hash(token) : null; };

export function ratingRoutes({ monitor, ratings, now }) {
  const router = express.Router();
  // Ephemeral keyed IP hashes keep raw addresses out of limiter keys and storage.
  const salt = randomBytes(32).toString('hex');
  const buckets = new Map();
  function limited(key, limit) {
    const time = now();
    for (const [id, bucket] of buckets) if (time >= bucket.until) buckets.delete(id);
    const bucket = buckets.get(key) ?? { count: 0, until: time + 60000 };
    if (!buckets.has(key) && buckets.size >= 10000) return true;
    buckets.set(key, bucket); return ++bucket.count > limit;
  }
  router.use((req, res, next) => {
    if (req.path !== '/' || !['PUT', 'DELETE'].includes(req.method)) return next('router');
    if (limited(`ip:${hash(salt + req.ip)}`, 60) || (voterHash(req) && limited(`voter:${voterHash(req)}`, 20)))
      return res.status(429).set('Retry-After', '60').json({ error: 'Rating cooldown' });
    next();
  });
  router.use(express.json({ limit: 1024, strict: true, type: 'application/json' }));
  router.all('/', (req, res, next) => {
    if (!['PUT', 'DELETE'].includes(req.method)) return next();
    const body = req.body;
    const keys = req.method === 'PUT' ? ['serverId', 'value'] : ['serverId'];
    if (!body || Array.isArray(body) || Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key)) ||
      typeof body.serverId !== 'string' || (req.method === 'PUT' && ![1, -1].includes(body.value)))
      return res.status(400).json({ error: 'Invalid rating body' });
    try { if (parseAddress(body.serverId).id !== body.serverId) throw new Error(); }
    catch { return res.status(400).json({ error: 'Invalid server ID' }); }
    const server = monitor.snapshot().servers.find(row => groupEndpointIds(row).includes(body.serverId));
    if (!server) return res.status(404).json({ error: 'Unknown server ID' });
    let token = voterToken(req);
    if (!token) {
      token = randomBytes(32).toString('hex');
      limited(`voter:${hash(token)}`, 20);
      res.cookie(cookieName, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 86400000, path: '/' });
    }
    const result = ratings.mutate(groupEndpointIds(server), body.serverId, hash(token), req.method === 'PUT' ? body.value : null, now());
    return res.json({ serverId: server.id, ratings: result });
  });
  router.use((error, _req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Rating body too large' });
    if (error.status === 400) return res.status(400).json({ error: 'Invalid rating JSON' });
    next(error);
  });
  return router;
}
