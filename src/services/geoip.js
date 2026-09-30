import maxmind from 'maxmind';
export async function loadGeoip(path) {
  if (!path) return () => ({ countryCode: null, country: null, latitude: null, longitude: null, accuracyRadiusKm: null });
  const reader = await maxmind.open(path);
  return ip => {
    const row = reader.get(ip.replace(/^::ffff:/, ''));
    return { countryCode: row?.country?.iso_code ?? null, country: row?.country?.names?.en ?? null,
      latitude: row?.location?.latitude ?? null, longitude: row?.location?.longitude ?? null,
      accuracyRadiusKm: row?.location?.accuracy_radius ?? null };
  };
}
