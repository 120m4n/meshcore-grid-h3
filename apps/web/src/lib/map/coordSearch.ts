import L from 'leaflet';
import { showToast } from '../toast.ts';
import { SANTANDER_BOUNDS } from '../mapBounds.ts';
import { map } from './setup.ts';

// Mismo formato que LAT_LON_PASTE en reportPage.ts:85 — un solo par
// "lat,lon" separado por coma, sin soportar Plus Codes ni direcciones.
const LAT_LON_FORMAT = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

// Zoom fijo al navegar, igual al que usa geolocalización en vivo
// (testCells.ts) para consistencia visual entre "ir a mi ubicación" e
// "ir a estas coordenadas".
const TARGET_ZOOM = 16;

let searchMarker: L.CircleMarker | null = null;

// Incrementado en cada búsqueda válida — el callback de moveend de una
// búsqueda vieja se descarta si para cuando corre ya hay una más nueva
// en vuelo (flyTo interrumpido por un segundo pegado rápido).
let searchToken = 0;

function goToCoords(rawText: string) {
  const text = rawText.trim();
  const match = text.match(LAT_LON_FORMAT);
  if (!match) {
    showToast('Formato inválido — usá lat,lon (ej: 7.12,-73.13)', 'error');
    return;
  }

  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  const [[minLat, minLon], [maxLat, maxLon]] = SANTANDER_BOUNDS;
  if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) {
    showToast('Coordenadas fuera del área de Santander', 'error');
    return;
  }

  const token = ++searchToken;
  map.flyTo([lat, lon], TARGET_ZOOM);
  map.once('moveend', () => {
    if (token !== searchToken) return; // una búsqueda más nueva ya interrumpió esta animación
    if (searchMarker) {
      map.removeLayer(searchMarker);
    }
    searchMarker = L.circleMarker([lat, lon], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#e67e22',
      fillOpacity: 0.9,
    }).addTo(map);
  });
}

export function initCoordSearch() {
  const input = document.getElementById('coord-input') as HTMLInputElement;
  const btnGo = document.getElementById('btn-coord-go') as HTMLButtonElement;

  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text')?.trim();
    if (!text || !LAT_LON_FORMAT.test(text)) return;
    e.preventDefault();
    input.value = text;
    goToCoords(text);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    goToCoords(input.value);
  });

  btnGo.addEventListener('click', () => {
    goToCoords(input.value);
  });
}
