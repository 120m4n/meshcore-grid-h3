import L from 'leaflet';
import { simulateRadialLOS } from '../api.ts';
import type { RadialSimulationRequest, RadialSimulationResponse } from '../api.ts';
import { showToast } from '../toast.ts';
import { map, radialLayer } from './setup.ts';

const COLOR_COLLIDED = '#e74c3c';
const COLOR_CLEAR = '#2ecc71';

let originMarker: L.CircleMarker | null = null;
let boundaryPolygon: L.Polygon | null = null;
let pickingOrigin = false;
let onOriginPicked: ((lat: number, lon: number) => void) | null = null;

// Simulación en vuelo, si hay una — permite que cancelRadialSimulation()
// la aborte desde el botón "Detener" sin que mapPage.ts tenga que llevar
// su propia referencia al fetch.
let activeController: AbortController | null = null;

// Activa el modo "elegir origen": el próximo click sobre el mapa fija
// el punto de origen de la simulación y llama callback(lat, lon) — el
// panel de parámetros (index.astro) usa esto para llenar los campos
// lat/lon sin que el usuario tenga que tipearlos a mano.
export function enableOriginPicking(callback: (lat: number, lon: number) => void) {
  pickingOrigin = true;
  onOriginPicked = callback;
}

// Expuesto para que los handlers de click de las capas de celdas
// (realCells.ts, testCells.ts) puedan ceder el paso a la selección de
// origen antes de correr su propia lógica (popup de info, alta/baja de
// celda de prueba) — sin esto, un polygon.on('click', ...) que hace
// L.DomEvent.stopPropagation(e) nunca deja llegar el click hasta acá.
export function isPickingOrigin(): boolean {
  return pickingOrigin;
}

export function pickOriginAt(lat: number, lon: number) {
  pickingOrigin = false;
  setOriginMarker(lat, lon);
  onOriginPicked?.(lat, lon);
  onOriginPicked = null;
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!pickingOrigin) return;
  pickOriginAt(e.latlng.lat, e.latlng.lng);
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

// Estima el total de puntos que la simulación va a pedirle al DEM
// (rayos x muestras/rayo + origen) — replica la fórmula de
// ValidateRequest en apps/api/internal/terrain/los/validate.go. El
// backend es síncrono y no reporta avance real (ver spec kit, decisión
// de diseño 2), así que esto solo sirve para una barra de progreso
// ESTIMADA en el cliente, no un porcentaje exacto.
export function estimateTotalPoints(angleStepDeg: number, maxDistanceM: number, sampleStepM: number): number {
  const rayCount = Math.ceil(360 / angleStepDeg);
  const samplesPerRay = Math.ceil(maxDistanceM / sampleStepM);
  return rayCount * samplesPerRay + 1;
}

// Cancela la simulación en vuelo, si hay una — no-op si no hay ninguna.
export function cancelRadialSimulation() {
  activeController?.abort();
}

// Nunca rechaza: 'ok'/'error' ya muestran su propio toast acá mismo;
// 'aborted' es un cancelRadialSimulation() deliberado, distinto de un
// error real (DOMException 'AbortError'), así que el caller (mapPage.ts)
// puede elegir un mensaje/label neutral en vez de uno de error.
export async function runRadialSimulation(input: RadialSimulationRequest): Promise<'ok' | 'error' | 'aborted'> {
  activeController = new AbortController();
  try {
    const result = await simulateRadialLOS(input, activeController.signal);
    drawRays(input.origin_lat, input.origin_lon, result);
    return 'ok';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return 'aborted';
    }
    console.error('Error simulando LOS radial:', err);
    showToast(err instanceof Error ? err.message : 'Error simulando LOS radial', 'error');
    return 'error';
  } finally {
    activeController = null;
  }
}

function formatDistance(distanceM: number): string {
  return distanceM >= 1000 ? `${(distanceM / 1000).toFixed(2)} km` : `${distanceM.toFixed(0)} m`;
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

  if (boundaryPolygon) {
    radialLayer.removeLayer(boundaryPolygon);
    boundaryPolygon = null;
  }

  setOriginMarker(originLat, originLon);

  // result.rays viene en orden angular creciente desde el backend (0°,
  // angle_step_deg, 2*angle_step_deg, ...) — se puede usar directo como
  // anillo del polígono de cobertura sin reordenar.
  const boundaryPoints: L.LatLngExpression[] = [];
  for (const ray of result.rays) {
    L.polyline(
      [
        [originLat, originLon],
        [ray.end_lat, ray.end_lon],
      ],
      { color: ray.collided ? COLOR_COLLIDED : COLOR_CLEAR, weight: 1.5, opacity: 0.75 }
    )
      .bindPopup(
        `<strong>Ángulo:</strong> ${ray.angle_deg.toFixed(0)}°<br/>` +
          `<strong>Longitud:</strong> ${formatDistance(ray.distance_m)}<br/>` +
          `<strong>${ray.collided ? 'Colisión con terreno' : 'Alcance máximo'}</strong>`
      )
      .addTo(radialLayer);
    boundaryPoints.push([ray.end_lat, ray.end_lon]);
  }

  // Polígono de cobertura: une los extremos finales de todos los rayos.
  // Estilo neutral (turquesa, mismo tono que el marcador de origen) para
  // no confundirse con la semántica roja/verde de colisión de cada rayo.
  if (boundaryPoints.length >= 3) {
    boundaryPolygon = L.polygon(boundaryPoints, {
      color: '#34d7c0',
      weight: 1.5,
      dashArray: '4 4',
      fillColor: '#34d7c0',
      fillOpacity: 0.08,
    }).addTo(radialLayer);
  }
}

export function clearRadialSimulation() {
  radialLayer.clearLayers();
  originMarker = null;
  boundaryPolygon = null;
}
