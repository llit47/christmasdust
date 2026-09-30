export function applyInitialCountry(select, countryCode, choices, applied) {
  if (!applied) select.value = choices.some(([code]) => code === countryCode) ? countryCode : '';
  return true;
}

export function snapshotNotice(meta, hasServers) {
  const messages = [];
  if (meta.stale) messages.push('The snapshot is stale. Waiting for fresh server data.');
  if (meta.discoveryDisabled && !hasServers) messages.push('Discovery is not configured. The operator can add a Steam API key or curated servers.');
  return messages.join(' ');
}
