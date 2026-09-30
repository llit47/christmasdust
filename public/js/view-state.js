export function applyInitialCountry(select, countryCode, choices, applied) {
  if (applied) return true;
  if (!countryCode || !choices.some(([code]) => code === countryCode)) return false;
  select.value = countryCode;
  return true;
}

export function lastUpdateLabel(lastLiveAt) {
  const date = typeof lastLiveAt === 'number' ? new Date(lastLiveAt) : null;
  const time = date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
  return `Updated ${time} · refreshes every 30s`;
}

export function snapshotNotice(meta, hasServers) {
  const messages = [];
  if (meta.stale) messages.push('The snapshot is stale. Waiting for fresh server data.');
  if (meta.discoveryDisabled && !hasServers) messages.push('Discovery is not configured. The operator can add a Steam API key or curated servers.');
  return messages.join(' ');
}
