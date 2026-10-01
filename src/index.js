import { readConfig, loadDetection } from './config/index.js';
import { combinedDiscovery } from './services/combined-discovery.js';
import { gameQuery } from './services/query.js';
import { loadGeoip } from './services/geoip.js';
import { Monitor } from './services/monitor.js';
import { RatingsStore } from './storage/ratings.js';
import { SnapshotStore } from './storage/snapshot.js';
import { createApp } from './routes/app.js';
async function main() {
  const config = readConfig();
  const rules = await loadDetection(config.detectionPath);
  const geoip = await loadGeoip(config.geoipPath);
  const monitor = new Monitor({ config, rules, geoip, discover: combinedDiscovery(config, rules), query: gameQuery(config), store: new SnapshotStore(config.snapshotPath) });
  await monitor.init();
  const ratings = new RatingsStore(config.ratingsPath);
  const app = createApp({ config, monitor, geoip, ratings });
  const server = app.listen(config.port, config.host, () => {
    console.info(`ChristmasDust listening on ${config.host}:${config.port}`);
    if (!config.steamKey && config.discoveryMode !== 'seeds') console.warn('Steam Web API unavailable: configure STEAM_API_KEY; using master discovery and configured seeds');
    monitor.start();
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('error', () => { console.error('HTTP listen failed'); process.exitCode = 1; monitor.stop(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    monitor.stop(); server.close(() => ratings.close());
    const deadline = setTimeout(() => process.exit(0), 15000); deadline.unref();
  });
}
main().catch(error => { console.error(`Startup failed: ${error.message}`); process.exitCode = 1; });
