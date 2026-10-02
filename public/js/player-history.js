export const HISTORY_REFRESH_MS = 300000;
const SVG_NS = 'http://www.w3.org/2000/svg';

export function playerSparkline(document, points, maxPlayers, historyWindow) {
  const noData = () => {
    const empty = document.createElement('span');
    empty.setAttribute('class', 'player-sparkline player-sparkline-empty');
    empty.setAttribute('aria-label', '24 hour player history: no data');
    empty.textContent = 'No data';
    return empty;
  };
  if (!Array.isArray(points) || points.length !== 48 || points.some(value =>
    value !== null && (!Number.isFinite(value) || value < 0 || value > 65535)) ||
    !Number.isFinite(maxPlayers) || maxPlayers <= 0) return noData();
  const measured = points.filter(value => value !== null);
  if (measured.length === 0) return noData();
  const peak = Math.max(...measured);
  const average = measured.reduce((sum, value) => sum + value, 0) / measured.length;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'player-sparkline');
  svg.setAttribute('viewBox', '0 0 60 24');
  svg.setAttribute('role', 'img');
  const label = `24 hour player history, average ${Math.round(average)}, peak ${Math.round(peak)}, scale 0 to ${maxPlayers} players; gaps indicate missing samples`;
  svg.setAttribute('aria-label', label);
  const title = document.createElementNS(SVG_NS, 'title'); title.textContent = label; svg.append(title);
  const levels = [maxPlayers, maxPlayers / 2, 0];
  // Reserve room for the capacity labels without changing the chart's outer size.
  const right = 60 - Math.max(...levels.map(value => String(value).length)) * 4 - 3;
  const xAt = index => 1 + index * (right - 1) / (points.length - 1);
  const yAt = value => 23 - Math.min(value / maxPlayers, 1) * 22;
  levels.forEach((value, index) => {
    const y = yAt(value);
    const guide = document.createElementNS(SVG_NS, 'line');
    guide.setAttribute('class', 'sparkline-guide');
    guide.setAttribute('x1', '1'); guide.setAttribute('x2', String(right));
    guide.setAttribute('y1', String(y)); guide.setAttribute('y2', String(y));
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'sparkline-scale');
    text.setAttribute('x', '60'); text.setAttribute('y', String([6, 14.5, 23][index]));
    text.setAttribute('text-anchor', 'end'); text.textContent = String(value);
    svg.append(guide, text);
  });
  let segment = [];
  const draw = () => {
    if (segment.length >= 2) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', segment.map((point, index) => `${index ? 'L' : 'M'}${point}`).join(' '));
      svg.append(path);
    } else if (segment.length === 1) {
      const [x, y] = segment[0].split(',');
      const marker = document.createElementNS(SVG_NS, 'circle');
      marker.setAttribute('cx', x); marker.setAttribute('cy', y);
      marker.setAttribute('r', '1'); marker.setAttribute('fill', 'currentColor');
      svg.append(marker);
    }
    segment = [];
  };
  points.forEach((value, index) => {
    if (value === null) { draw(); return; }
    segment.push(`${xAt(index).toFixed(2)},${yAt(value).toFixed(2)}`);
  });
  draw();
  // Full-height hit areas make even baseline points easy to inspect with a pointer.
  if (Number.isSafeInteger(historyWindow?.startAt) && historyWindow.bucketMs === 1800000) {
    const step = (right - 1) / (points.length - 1);
    points.forEach((value, index) => {
      if (value === null) return;
      const hit = document.createElementNS(SVG_NS, 'rect');
      hit.setAttribute('class', 'sparkline-sample');
      hit.setAttribute('x', String(Math.max(0, xAt(index) - step / 2)));
      hit.setAttribute('y', '0'); hit.setAttribute('width', String(step)); hit.setAttribute('height', '24');
      const tooltip = document.createElementNS(SVG_NS, 'title');
      const time = new Date(historyWindow.startAt + index * historyWindow.bucketMs).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      tooltip.textContent = `${time} · ${value}/${maxPlayers} players`;
      hit.append(tooltip); svg.append(hit);
    });
  }
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
      onHistory(data.histories, { startAt: data.startAt, bucketMs: data.bucketMs });
    } catch { /* History is optional; preserve the normal list and last good charts. */ }
    finally { loading = false; }
  };
}
