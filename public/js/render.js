import { playerSparkline } from './player-history.js';
import { haversine } from './ranking.js';
export function element(document, tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
export function connection(id) {
  if (typeof id !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(id)) throw new Error('Invalid endpoint');
  const [ip, port] = id.split(':');
  if (ip.split('.').some(part => +part > 255) || +port < 1 || +port > 65535) throw new Error('Invalid endpoint');
  return { url: `steam://connect/${id}`, command: `connect ${id}` };
}
export function flag(code) { return /^[A-Z]{2}$/.test(code ?? '') ? [...code].map(c => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('') : '◈'; }
export function serverCard(document, server, { location, favorite, toggleFavorite, hide, copy, rate, history, onRatingChange }) {
  const e = (tag, text, cls) => element(document, tag, text, cls);
  const card = e('article', undefined, 'server');
  const title = e('div', undefined, 'server-title');
  const star = e('button', favorite ? '★' : '☆', 'favorite');
  star.type = 'button'; star.setAttribute('aria-label', `Favorite ${server.name || server.id}`); star.setAttribute('aria-pressed', String(favorite));
  star.addEventListener('click', () => toggleFavorite(server));
  const heading = e('h3', server.name || server.id);
  title.append(star, heading);
  const ratings = e('div', undefined, 'ratings');
  ratings.setAttribute('aria-label', 'Anonymous server ratings');
  let ratingPending = false;
  const buttons = [1, -1].map(value => {
    const button = e('button'); button.type = 'button';
    button.addEventListener('click', async () => {
      if (ratingPending) return;
      ratingPending = true;
      let updated;
      buttons.forEach(node => {
        // Keep the focused control focusable while blocking repeated votes.
        node.disabled = document.activeElement !== node;
        node.setAttribute('aria-disabled', 'true');
      });
      try {
        updated = await rate(server, server.ratings?.vote === value ? null : value);
        if (updated) server.ratings = updated;
        drawRatings();
      } finally {
        ratingPending = false;
        buttons.forEach(node => { node.disabled = false; node.setAttribute('aria-disabled', 'false'); });
      }
      if (updated) onRatingChange?.();
    });
    ratings.append(button); return button;
  });
  function drawRatings() {
    buttons.forEach((button, index) => {
      const value = index === 0 ? 1 : -1;
      const selected = server.ratings?.vote === value;
      button.textContent = `${value === 1 ? '👍' : '👎'} ${server.ratings === null ? '—' : server.ratings?.[value === 1 ? 'up' : 'down'] ?? 0}`;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', `${selected ? 'Remove' : 'Vote'} thumbs ${value === 1 ? 'up' : 'down'} for ${server.name || server.id}`);
    });
  }
  drawRatings(); title.append(ratings);
  const sub = e('div', undefined, 'server-meta');
  sub.append(e('span', `${flag(server.countryCode)} ${server.country || server.countryCode || 'Location unknown'}`), e('span', server.map || 'Map unknown'));
  const tags = e('div', undefined, 'tags');
  const status = server.stale ? 'Stale status' : server.status === 'online' ? 'Online' : server.status === 'offline' ? 'Unreachable' : 'Unverified';
  tags.append(e('span', status, server.status === 'online' && !server.stale ? 'tag online' : 'tag'), e('span', { high: 'Christmas · high confidence', probable: 'Christmas · probable', curated: 'Curated' }[server.classification.confidence] || 'Unclassified', 'tag'));
  if (server.password) tags.append(e('span', 'Password required', 'tag'));
  const population = e('div', undefined, 'population');
  const top = e('div', undefined, 'population-top');
  top.append(e('strong', `${server.players}/${server.maxPlayers}`));
  const sparkline = playerSparkline(document, history, server.maxPlayers);
  if (sparkline) top.append(sparkline);
  population.append(top, e('span', `${Math.max(0, server.maxPlayers - server.players)} open slots${server.stale || server.status !== 'online' ? ' · last known' : ''}`));
  const distance = haversine(location, server);
  if (Number.isFinite(distance)) population.append(e('small', `≈ ${Math.round(distance).toLocaleString()} km away`));
  const actions = e('div', undefined, 'server-actions');
  const { url, command } = connection(server.id);
  const join = e('a', 'Connect ↗', 'button primary'); join.href = url;
  const copyButton = e('button', 'Copy command', 'button'); copyButton.type = 'button'; copyButton.addEventListener('click', () => copy(command));
  const hideButton = e('button', 'Hide', 'button hide-action'); hideButton.type = 'button'; hideButton.setAttribute('aria-label', `Hide ${server.name || server.id}`); hideButton.addEventListener('click', () => hide(server));
  actions.append(join, copyButton, hideButton);
  const info = e('div', undefined, 'server-info'); info.append(title, sub, tags);
  card.append(info, population, actions);
  return card;
}
