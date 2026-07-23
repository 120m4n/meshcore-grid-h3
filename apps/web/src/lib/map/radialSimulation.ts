import L from 'leaflet';
import { simulateRadialLOS } from '../api.ts';
import type { RadialSimulationRequest, RadialSimulationResponse } from '../api.ts';
import { showToast } from '../toast.ts';
import { map, radialLayer } from './setup.ts';

const COLOR_COLLIDED = '#e74c3c';
const COLOR_CLEAR = '#2ecc71';

let originMarker: L.CircleMarker | null = null;
let pickingOrigin = false;
let onOriginPicked: ((lat: number, lon: number) => void) | null = null;

// Activa el modo "elegir origen": el próximo click sobre el mapa fija
// el punto de origen de la simulación y llama callback(lat, lon) — el
// panel de parámetros (index.astro) usa esto para llenar los campos
// lat/lon sin que el usuario tenga que tipearlos a mano.
export function enableOriginPicking(callback: (lat: number, lon: number) => void) {
  pickingOrigin = true;
  onOriginPicked = callback;
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!pickingOrigin) return;
  pickingOrigin = false;
  setOriginMarker(e.latlng.lat, e.latlng.lng);
  onOriginPicked?.(e.latlng.lat, e.latlng.lng);
  onOriginPicked = null;
});

function setOriginMarker(lat: number, lon: number) {
  if (originMarker) {
    originMarker.setLatLng([lat, lon]);
  } else {
    originMarker = L.circleMarker([lat, lon], {
      radius: 6,
      color: '#34d7c0',
      fillColor: '#34d7c0',
      fillOpacity: 0.9,
    }).addTo(radialLayer);
  }
}

export async function runRadialSimulation(input: RadialSimulationRequest) {
  try {
    const result = await simulateRadialLOS(input);
    drawRays(input.origin_lat, input.origin_lon, result);
  } catch (err) {
    console.error('Error simulando LOS radial:', err);
    showToast(err instanceof Error ? err.message : 'Error simulando LOS radial', 'error');
  }
}

function drawRays(originLat: number, originLon: number, result: RadialSimulationResponse) {
  // Limpia solo los rayos previos; el marcador de origen se conserva
  // (se reposiciona más abajo) para no perder de vista dónde se está
  // parado entre una simulación y la siguiente.
  const toRemove: L.Layer[] = [];
  radialLayer.eachLayer((layer) => {
    if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) toRemove.push(layer);
  });
  toRemove.forEach((layer) => radialLayer.removeLayer(layer));

  setOriginMarker(originLat, originLon);

  for (const ray of result.rays) {
    L.polyline(
      [
        [originLat, originLon],
        [ray.end_lat, ray.end_lon],
      ],
      { color: ray.collided ? COLOR_COLLIDED : COLOR_CLEAR, weight: 1.5, opacity: 0.75 }
    ).addTo(radialLayer);
  }
}

export function clearRadialSimulation() {
  radialLayer.clearLayers();
  originMarker = null;
}
