// Consulta de geolocalización en vivo (watchPosition) con filtro
// anti-drift: descarta lecturas de mala precisión o que caen dentro del
// círculo de incertidumbre de la última posición aceptada, para que el
// punto no "tiemble" con el ruido normal del GPS estando quieto. Ver
// docs/superpowers/specs/2026-07-21-geolocation-live-tracking-design.md.

export const MAX_ACCURACY_M = 50;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function shouldAcceptFix(
  prev: GeolocationPosition | null,
  next: GeolocationPosition,
): boolean {
  if (next.coords.accuracy > MAX_ACCURACY_M) return false;
  if (!prev) return true;
  const distance = haversineMeters(
    { lat: prev.coords.latitude, lon: prev.coords.longitude },
    { lat: next.coords.latitude, lon: next.coords.longitude },
  );
  return distance >= next.coords.accuracy;
}

let lastAccepted: GeolocationPosition | null = null;

export function getLastKnownPosition(): GeolocationPosition | null {
  return lastAccepted;
}

export function watchFilteredPosition(
  onUpdate: (pos: GeolocationPosition) => void,
  onError?: (err: GeolocationPositionError) => void,
): () => void {
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!shouldAcceptFix(lastAccepted, pos)) return;
      lastAccepted = pos;
      onUpdate(pos);
    },
    (err) => {
      onError?.(err);
      if (err.code === err.PERMISSION_DENIED) {
        navigator.geolocation.clearWatch(watchId);
      }
    },
    { enableHighAccuracy: true },
  );
  return () => navigator.geolocation.clearWatch(watchId);
}
