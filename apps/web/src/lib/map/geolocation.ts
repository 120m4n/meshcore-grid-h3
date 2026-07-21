import L from 'leaflet';
import { userLocationLayer } from './setup.ts';
import { watchFilteredPosition, getLastKnownPosition } from '../geoWatch.ts';

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
  onError?: (err: GeolocationPositionError) => void,
): () => void {
  return watchFilteredPosition(renderUserLocation, onError);
}
