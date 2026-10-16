import L from 'leaflet';
import { map, userLocationLayer } from './setup.ts';
import { showToast } from '../toast.ts';
import { MAX_ZOOM } from '../mapBounds.ts';
import { watchFilteredPosition, getLastKnownPosition } from '../geoWatch.ts';
import { GeoKalman } from '../kalman.ts';

export { getLastKnownPosition };

export function getCurrentGeoPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
    });
  });
}

// Punto GPS del usuario: dibuja al instante cuando se valida
// geolocalización (activación de modo prueba y cada relectura durante
// un click). Círculo exterior = radio de precisión reportado por el
// navegador (pos.coords.accuracy, en metros) — cuanto más grande, más
// incierta es la posición.
export function renderUserLocation(pos: GeolocationPosition) {
  const { latitude, longitude, accuracy } = pos.coords;
  userLocationLayer.clearLayers();
  // interactive: false — el punto suele caer justo sobre la celda real
  // donde el usuario está parado (es el caso de uso central del modo
  // prueba); sin esto, el dot capturaba el click y la celda de abajo
  // nunca llegaba a recibirlo.
  L.circle([latitude, longitude], {
    radius: Math.abs(accuracy),
    color: '#1a73e8',
    weight: 1.5,
    fillColor: '#ffffff',
    fillOpacity: 0.35,
    interactive: false,
  }).addTo(userLocationLayer);
  L.circleMarker([latitude, longitude], {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#1a73e8',
    fillOpacity: 1,
    interactive: false,
  }).addTo(userLocationLayer);
}

// Arranca el watch de geolocalización en vivo: cada lectura aceptada
// (filtrada por geoWatch.ts) redibuja el punto. Se deja corriendo
// indefinidamente mientras dure la página — el toggle de modo prueba
// no lo detiene, ver spec 2026-07-21-geolocation-live-tracking-design.md.
export function startLiveUserLocation(
  onUpdate: (pos: GeolocationPosition) => void,
  onError?: (err: GeolocationPositionError) => void,
): () => void {
  return watchFilteredPosition(onUpdate, onError);
}

// Punto de ubicación del mapa: lo activa el usuario con el botón 📍 del
// toolbar (nunca al cargar la página, para no pedir permiso sin que lo
// pida). Va por su propio watch (sin el tope de accuracy de
// geoWatch.ts, que en equipos sin GPS dejaría el punto sin dibujar) y
// el Kalman amortigua saltos; el círculo es el error estimado filtrado.
// El watch de geoWatch.ts sigue siendo el único que valida presencia
// para reportar (lastAccepted), no se toca.
let kalman = new GeoKalman();
let smoothed: L.LatLng | null = null;
let watchId: number | null = null;
let stateCb: ((on: boolean) => void) | null = null;

export function getSmoothedLatLng(): L.LatLng | null {
  return smoothed;
}

// Un solo suscriptor (el botón del toolbar) que refleja encendido/apagado.
export function onUserLocationState(cb: (on: boolean) => void): void {
  stateCb = cb;
}

export function stopUserLocationDisplay(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  smoothed = null;
  kalman = new GeoKalman();
  userLocationLayer.clearLayers();
  stateCb?.(false);
}

export function startUserLocationDisplay(centerOnFirstFix = true): void {
  if (watchId !== null) return;
  if (!navigator.geolocation) {
    showToast('Tu navegador no soporta geolocalización', 'error');
    return;
  }
  let first = centerOnFirstFix;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const e = kalman.update(latitude, longitude, accuracy, pos.timestamp);
      smoothed = L.latLng(e.lat, e.lon);
      renderUserLocation({ coords: { latitude: e.lat, longitude: e.lon, accuracy: e.accuracy } } as GeolocationPosition);
      if (first) {
        first = false;
        map.setView(smoothed, Math.min(16, MAX_ZOOM));
      }
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        showToast('Permiso de ubicación denegado', 'error');
        stopUserLocationDisplay();
      } else {
        console.info('Ubicación no disponible:', err.message);
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
  stateCb?.(true);
}

export function toggleUserLocation(): void {
  if (watchId === null) startUserLocationDisplay();
  else stopUserLocationDisplay();
}
