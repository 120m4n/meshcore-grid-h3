// Parseo y validación de data/MeshAzimuth-repetidores.json — sin Leaflet,
// para poder chequearlo con node (ver repeatersCheck.mjs).
export interface RepeaterProps { name: string; hashPrefix: string }
export interface RepeaterFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] }; // [lon, lat]
  properties: RepeaterProps;
}
export interface RepeaterCollection { type: 'FeatureCollection'; features: RepeaterFeature[] }

// Devuelve null si la raíz no es un array; descarta ítems inválidos y
// cuenta cuántos para que el llamador los reporte.
export function parseRepeaters(raw: unknown): { fc: RepeaterCollection; skipped: number } | null {
  if (!Array.isArray(raw)) return null;
  const features: RepeaterFeature[] = [];
  let skipped = 0;
  for (const r of raw) {
    const { latitude: lat, longitude: lon, name, hashPrefix } = (r ?? {}) as Record<string, unknown>;
    if (
      typeof lat !== 'number' || typeof lon !== 'number' ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
      typeof name !== 'string' || !name.trim() ||
      typeof hashPrefix !== 'string'
    ) { skipped++; continue; }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name: name.trim(), hashPrefix: hashPrefix.trim().toUpperCase() },
    });
  }
  return { fc: { type: 'FeatureCollection', features }, skipped };
}
