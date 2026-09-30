import { parseAddress } from '../utils/address.js';

export const DETECTION_VERSION = 2;
export const LEGACY_TERM_LIMIT = 1000;
export const CURRENT_TERM_LIMIT = LEGACY_TERM_LIMIT + 3;
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
    const limit = version === DETECTION_VERSION && !['include', 'exclude'].includes(key)
      ? CURRENT_TERM_LIMIT : LEGACY_TERM_LIMIT;
    if (!Array.isArray(entries) || entries.length > limit || entries.some(entry =>
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
  // Deduplicate operator terms before adding defaults so custom placement wins.
  // Only the old built-in "santa" changes category.
  const santas = value.strong.filter(term => termKey(term) === 'santa');
  const strong = unique(value.strong.filter(term => termKey(term) !== 'santa'));
  const related = unique([...(value.related || []), ...santas]);
  const weak = unique(value.weak);
  const addDefaults = (entries, defaults) => {
    for (const term of defaults) {
      const key = termKey(term);
      if (seen.has(key) || entries.length >= CURRENT_TERM_LIMIT) continue;
      seen.add(key); entries.push(term);
    }
  };
  addDefaults(strong, added.strong);
  addDefaults(related, added.related);
  addDefaults(weak, added.weak);
  const config = { version: DETECTION_VERSION, strong, related, weak,
    include: [...value.include], exclude: [...value.exclude] };
  validateDetection(config);
  return { config, changed: true };
}

export const serializeDetection = value => `${JSON.stringify(value, null, 2)}\n`;
