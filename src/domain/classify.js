const WEIGHT = Object.freeze({
  knownStrongMap: 12, knownProbableMap: 5,
  explicitName: 9, explicitMap: 8, explicitTags: 8, explicitDescription: 7,
  relatedName: 4, relatedMap: 3, relatedTags: 3, relatedDescription: 2,
  seasonalName: 2, seasonalMap: 1, seasonalTags: 1, seasonalDescription: 1,
  targetedDiscovery: 1
});
const HIGH_SCORE = 7;
const PROBABLE_SCORE = 6;
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().slice(0, 512)
  .replace(/(^|[^\p{L}\p{N}])x[^\p{L}\p{N}]+mas(?=$|[^\p{L}\p{N}])/gu, '$1xmas')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const matches = (text, term) => Boolean(term && ` ${text} `.includes(` ${normalize(term)} `));
const firstMatch = (text, terms = []) => terms.find(term => matches(text, term));
const negated = (text, term) => ['no', 'not', 'non', 'without', 'anti'].some(word =>
  ` ${text} `.includes(` ${word} ${normalize(term)} `));

export function classify(server, rules, curated = false) {
  const signals = [];
  const add = (field, kind, term, points, reason = `${field}: ${term}`) => signals.push({ field, kind, term, points, reason });
  const map = normalize(server.map).replaceAll(' ', '_').replace(/_bsp$/, '');
  const strongMap = rules.maps?.strong?.has(map) || false;
  const probableMap = !strongMap && (rules.maps?.probable?.has(map) || false);
  if (strongMap) add('map', 'known-strong-map', map, WEIGHT.knownStrongMap, `map: known Christmas map (${map})`);
  else if (probableMap) add('map', 'known-probable-map', map, WEIGHT.knownProbableMap, `map: verified winter map (${map})`);

  let explicit = false;
  let relatedIdentity = false;
  const identityFields = ['name', 'tags', 'description'];
  for (const field of [...identityFields, 'map']) {
    // Catalog evidence already accounts for this map; it is one signal.
    if (field === 'map' && (strongMap || probableMap)) continue;
    const text = normalize(server[field]);
    if (!text) continue;
    const strong = firstMatch(text, rules.strong);
    if (strong && negated(text, strong)) add(field, 'negated', strong, 0, `${field}: negated ${strong}`);
    else if (strong) {
      add(field, 'explicit', strong, WEIGHT[`explicit${field[0].toUpperCase()}${field.slice(1)}`]);
      explicit = true;
    } else {
      const related = firstMatch(text, rules.related);
      if (related) {
        if (negated(text, related)) add(field, 'negated', related, 0, `${field}: negated ${related}`);
        else {
          add(field, 'related', related, WEIGHT[`related${field[0].toUpperCase()}${field.slice(1)}`]);
          relatedIdentity ||= identityFields.includes(field);
        }
      } else {
        const weak = firstMatch(text, rules.weak);
        if (weak && negated(text, weak)) add(field, 'negated', weak, 0, `${field}: negated ${weak}`);
        else if (weak) add(field, 'seasonal', weak, WEIGHT[`seasonal${field[0].toUpperCase()}${field.slice(1)}`]);
      }
    }
  }
  if (Array.isArray(server.discoverySources) && server.discoverySources.some(source =>
    typeof source === 'string' && (source.startsWith('name:') || source.startsWith('map:'))))
    add('discovery', 'targeted-discovery', 'targeted search', WEIGHT.targetedDiscovery);

  const score = signals.reduce((total, signal) => total + signal.points, 0);
  const independentFields = new Set(signals.filter(signal => signal.points > 1 && signal.field !== 'discovery').map(signal => signal.field));
  const seasonalIdentity = signals.some(signal => signal.points > 0 && identityFields.includes(signal.field));
  let confidence = 'none';
  if (curated) confidence = 'curated';
  else if (strongMap || (explicit && score >= HIGH_SCORE)) confidence = 'high';
  else if ((probableMap && seasonalIdentity) || (score >= PROBABLE_SCORE && relatedIdentity && independentFields.size >= 2)) confidence = 'probable';
  return { confidence, score, signals, reasons: [ ...(curated ? ['Operator included'] : []),
    ...signals.filter(signal => signal.points > 1).map(signal => signal.reason) ] };
}
