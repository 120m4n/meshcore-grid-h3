import L from 'leaflet';
import { map, rulerLayer, arcLayer, repeatersLayer } from './setup.ts';
import { cancelOriginPicking, formatDistance } from './radialSimulation.ts';

export type MeasureTool = 'ruler' | 'arc';

const TOOL_COLOR: Record<MeasureTool, string> = {
  ruler: '#f1c40f',
  arc: '#9b59b6',
};

let activeTool: MeasureTool | null = null;
let pendingPointA: L.LatLng | null = null;

// Punto A ya confirmado (círculo) y línea punteada que sigue al mouse
// hasta el segundo clic — sin esto, un usuario que activa la
// herramienta y hace el primer clic no tiene ninguna señal de que la
// medición ya arrancó hasta completar el segundo clic.
let previewMarker: L.CircleMarker | null = null;
let previewLine: L.Polyline | null = null;
let snapRing: L.CircleMarker | null = null;

// Radio de imán en píxeles: independiente del zoom, así el efecto se
// siente igual de cerca o de lejos.
const SNAP_PX = 24;

// Repetidora visible más cercana al punto (dentro de SNAP_PX), o null.
// Las agrupadas en un cluster no cuentan: no se ven, no se imantan.
export function snapToRepeater(p: L.LatLng): L.LatLng | null {
  if (!map.hasLayer(repeatersLayer)) return null;
  const pp = map.latLngToContainerPoint(p);
  let best: L.LatLng | null = null;
  let bestD = SNAP_PX;
  for (const m of repeatersLayer.getLayers() as L.Marker[]) {
    if (repeatersLayer.getVisibleParent(m) !== m) continue;
    const ll = m.getLatLng();
    const d = pp.distanceTo(map.latLngToContainerPoint(ll));
    if (d <= bestD) { bestD = d; best = ll; }
  }
  return best;
}

function showSnapRing(at: L.LatLng | null): void {
  const layer = activePreviewLayer();
  if (!at || !layer) {
    snapRing?.remove();
    snapRing = null;
    return;
  }
  if (snapRing) { snapRing.setLatLng(at); return; }
  snapRing = L.circleMarker(at, {
    radius: 14, color: '#fff', weight: 2, fill: false, interactive: false,
  }).addTo(layer);
}

function activePreviewLayer(): L.LayerGroup | null {
  if (activeTool === 'ruler') return rulerLayer;
  if (activeTool === 'arc') return arcLayer;
  return null;
}

function clearPreview(): void {
  showSnapRing(null);
  previewMarker?.remove();
  previewMarker = null;
  previewLine?.remove();
  previewLine = null;
}

function showPointAMarker(a: L.LatLng): void {
  const layer = activePreviewLayer();
  if (!layer || activeTool === null) return;
  const color = TOOL_COLOR[activeTool];
  previewMarker = L.circleMarker(a, {
    radius: 5,
    color,
    weight: 2,
    fillColor: color,
    fillOpacity: 0.9,
  }).addTo(layer);
}

function updatePreviewLine(a: L.LatLng, cursor: L.LatLng): void {
  const layer = activePreviewLayer();
  if (!layer || activeTool === null) return;
  if (previewLine) {
    previewLine.setLatLngs([a, cursor]);
    return;
  }
  previewLine = L.polyline([a, cursor], {
    color: TOOL_COLOR[activeTool],
    weight: 2,
    opacity: 0.6,
    dashArray: '4 4',
  }).addTo(layer);
}

function resetPending(): void {
  clearPreview();
  pendingPointA = null;
}

export function isMeasuring(): boolean {
  return activeTool !== null;
}

export function deactivateMeasureTool(): void {
  activeTool = null;
  resetPending();
  syncToolButtons();
}

function setActiveTool(tool: MeasureTool): void {
  if (activeTool === tool) {
    deactivateMeasureTool();
    return;
  }
  cancelOriginPicking();
  activeTool = tool;
  resetPending();
  syncToolButtons();
}

export function activateRuler(): void {
  setActiveTool('ruler');
}

export function activateArc(): void {
  setActiveTool('arc');
}

// Un solo click borra todo el estado de medición: la línea/tooltip ya
// dibujados de ruler y arc, y también cualquier medición a medio hacer
// (punto A pendiente + preview) — "borrar todo" sin excepciones, no solo
// mediciones terminadas.
export function clearAllMeasurements(): void {
  deactivateMeasureTool();
  rulerLayer.clearLayers();
  arcLayer.clearLayers();
}

function syncToolButtons(): void {
  document.querySelectorAll('mc-tool-button').forEach((el) => {
    el.active = el.tool === activeTool;
  });
}

function drawRuler(a: L.LatLng, b: L.LatLng): void {
  rulerLayer.clearLayers(); // reemplaza la medición anterior de ruler
  const distanceM = map.distance(a, b);
  L.polyline([a, b], { color: TOOL_COLOR.ruler, weight: 2, opacity: 0.85 })
    .bindTooltip(formatDistance(distanceM), {
      permanent: true,
      direction: 'center',
      className: 'measure-tooltip',
    })
    .addTo(rulerLayer)
    .openTooltip();
}

// Rumbo inicial (initial bearing) del segmento A→B sobre una esfera,
// normalizado a [0, 360). Misma convención que Destination() en el
// backend (apps/api/internal/terrain/los/geodesy.go): 0 = norte,
// sentido horario.
function initialBearingDeg(a: L.LatLng, b: L.LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

function drawArc(a: L.LatLng, b: L.LatLng): void {
  arcLayer.clearLayers(); // reemplaza la medición anterior de arc
  const bearingDeg = initialBearingDeg(a, b);
  L.polyline([a, b], { color: TOOL_COLOR.arc, weight: 2, opacity: 0.85 })
    .bindTooltip(`${bearingDeg.toFixed(0)}°`, {
      permanent: true,
      direction: 'center',
      className: 'measure-tooltip',
    })
    .addTo(arcLayer)
    .openTooltip();
}

export function handleMeasureClick(lat: number, lon: number): void {
  if (activeTool === null) return;
  const raw = L.latLng(lat, lon);
  const point = snapToRepeater(raw) ?? raw;
  if (pendingPointA === null) {
    pendingPointA = point;
    showPointAMarker(point);
    return;
  }
  if (activeTool === 'ruler') drawRuler(pendingPointA, point);
  else drawArc(pendingPointA, point);
  deactivateMeasureTool();
}

map.on('click', (e: L.LeafletMouseEvent) => {
  handleMeasureClick(e.latlng.lat, e.latlng.lng);
});

map.on('mousemove', (e: L.LeafletMouseEvent) => {
  if (activeTool === null || pendingPointA === null) return;
  const snapped = snapToRepeater(e.latlng);
  showSnapRing(snapped);
  updatePreviewLine(pendingPointA, snapped ?? e.latlng);
});

// Un click sobre el pin de una repetidora no llega a map.on('click')
// (Leaflet lo detiene en el marker): se mide desde acá, con las
// coordenadas exactas de la repetidora, y sin abrir su popup.
repeatersLayer.on('click', (e) => {
  if (activeTool === null) return;
  const m = e.layer as L.Marker;
  m.closePopup();
  const ll = m.getLatLng();
  handleMeasureClick(ll.lat, ll.lng);
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  if (!isMeasuring()) return;
  deactivateMeasureTool();
});

