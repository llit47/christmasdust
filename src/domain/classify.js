const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export function classify(server, rules, curated = false) {
  const reasons = [];
  let strong = false;
  for (const field of ['name', 'map', 'tags']) {
    const text = normalize(server[field]).slice(0, 512);
    for (const kind of ['strong', 'weak']) for (const term of rules[kind]) {
      if (text.includes(normalize(term))) { reasons.push(`${field}: ${term}`); strong ||= kind === 'strong'; }
    }
  }
  return { confidence: curated ? 'curated' : strong ? 'high' : reasons.length ? 'probable' : 'none', reasons: curated ? ['Operator included', ...reasons] : reasons };
}
