export const HISTORY_REFRESH_MS = 300000;
const SVG_NS = 'http://www.w3.org/2000/svg';

export function playerSparkline(document, points, maxPlayers) {
  if (!Array.isArray(points) || points.length !== 48 || points.some(value =>
    value !== null && (!Number.isFinite(value) || value < 0 || value > 65535))) return null;
  const measured = points.filter(value => value !== null);
  if (measured.length < 2) return null;
  const peak = Math.max(...measured);
  const average = measured.reduce((sum, value) => sum + value, 0) / measured.length;
  const scale = Number.isFinite(maxPlayers) && maxPlayers > 0 ? maxPlayers : Math.max(1, peak);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'player-sparkline');
  svg.setAttribute('viewBox', '0 0 60 24');
  svg.setAttribute('role', 'img');
  const label = `24 hour player history, average ${Math.round(average)}, peak ${Math.round(peak)}`;
  svg.setAttribute('aria-label', label);
  const title = document.createElementNS(SVG_NS, 'title'); title.textContent = label; svg.append(title);
  let segment = [];
  const draw = () => {
    if (segment.length >= 2) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', segment.map((point, index) => `${index ? 'L' : 'M'}${point}`).join(' '));
      svg.append(path);
    }
    segment = [];
  };
  points.forEach((value, index) => {
    if (value === null) { draw(); return; }
    const x = 1 + index * 58 / (points.length - 1);
    const y = 23 - Math.min(value / scale, 1) * 22;
    segment.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  });
  draw();
  return svg;
}

export function createHistoryPoller({ fetchHistory, onHistory, now = Date.now, isHidden = () => false }) {
  let loading = false; let lastAttemptAt = -Infinity;
  return async function pollHistory() {
    if (loading || isHidden() || now() - lastAttemptAt < HISTORY_REFRESH_MS) return;
    loading = true; lastAttemptAt = now();
    try {
      const response = await fetchHistory('/api/player-history', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('History unavailable');
      const data = await response.json();
      if (!Number.isSafeInteger(data.startAt) || data.bucketMs !== 1800000 ||
        !data.histories || typeof data.histories !== 'object' || Array.isArray(data.histories) ||
        Object.keys(data.histories).length > 5000 || Object.values(data.histories).some(points =>
          !Array.isArray(points) || points.length !== 48 || points.some(value =>
            value !== null && (!Number.isFinite(value) || value < 0 || value > 65535)))) throw new Error('Invalid history');
      onHistory(data.histories);
    } catch { /* History is optional; preserve the normal list and last good charts. */ }
    finally { loading = false; }
  };
}
