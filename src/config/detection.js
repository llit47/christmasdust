import { parseAddress } from '../utils/address.js';

export const DETECTION_VERSION = 2;
const required = ['strong', 'weak', 'include', 'exclude'];
const added = { strong: ['weihnachten'], related: ['santa', 'jinglebells'], weak: ['holiday', 'ice', 'frozen'] };

const termKey = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/(^|[^\p{L}\p{N}])x[^\p{L}\p{N}]+mas(?=$|[^\p{L}\p{N}])/gu, '$1xmas')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || value.trim().toLowerCase();

export function validateDetection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid detection configuration');
  const version = Object.hasOwn(value, 'version') ? value.version : 1;
  if (version !== 1 && version !== DETECTION_VERSION) throw new Error(`Unsupported detection version: ${String(version)}`);
  const allowed = new Set([...required, 'related', ...(value.version === undefined ? [] : ['version'])]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown detection key: ${key}`);
  for (const key of [...required, ...(version === 2 || value.related !== undefined ? ['related'] : [])]) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length > 1000 || entries.some(entry =>
      typeof entry !== 'string' || !entry.trim() || entry.length > 100)) throw new Error(`Invalid detection ${key}`);
  }
  for (const key of ['include', 'exclude']) for (const entry of value[key]) parseAddress(entry);
  if (version === DETECTION_VERSION) {
    const seen = new Set();
    for (const key of ['strong', 'related', 'weak']) for (const term of value[key]) {
      const normalized = termKey(term);
      if (seen.has(normalized)) throw new Error('Duplicate normalized detection term');
      seen.add(normalized);
    }
  }
  return version;
}

export function migrateDetection(value) {
  const version = validateDetection(value);
  if (version === DETECTION_VERSION) return { config: structuredClone(value), changed: false };
  const seen = new Set();
  const unique = values => values.filter(term => {
    const key = termKey(term);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  // Only the old built-in "santa" changes category. Keep every other custom term.
  const strong = unique([...value.strong.filter(term => termKey(term) !== 'santa'), ...added.strong]);
  const related = unique([...(value.related || []), ...added.related]);
  const weak = unique([...value.weak, ...added.weak]);
  const config = { version: DETECTION_VERSION, strong, related, weak,
    include: [...value.include], exclude: [...value.exclude] };
  validateDetection(config);
  return { config, changed: true };
}

export const serializeDetection = value => `${JSON.stringify(value, null, 2)}\n`;
