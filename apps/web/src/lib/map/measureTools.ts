import L from 'leaflet';
import { map, rulerLayer, arcLayer } from './setup.ts';
import { cancelOriginPicking, formatDistance } from './radialSimulation.ts';

export type MeasureTool = 'ruler' | 'arc';

let activeTool: MeasureTool | null = null;
let pendingPointA: L.LatLng | null = null;

export function isMeasuring(): boolean {
  return activeTool !== null;
}

export function deactivateMeasureTool(): void {
  activeTool = null;
  pendingPointA = null;
  syncToolButtons();
}

function setActiveTool(tool: MeasureTool): void {
  if (activeTool === tool) {
    deactivateMeasureTool();
    return;
  }
  cancelOriginPicking();
  activeTool = tool;
  pendingPointA = null;
  syncToolButtons();
}

export function activateRuler(): void {
  setActiveTool('ruler');
}

export function activateArc(): void {
  setActiveTool('arc');
}

function syncToolButtons(): void {
  document.querySelectorAll('mc-tool-button').forEach((el) => {
    el.active = el.tool === activeTool;
  });
}

function drawRuler(a: L.LatLng, b: L.LatLng): void {
  rulerLayer.clearLayers(); // reemplaza la medición anterior de ruler
  const distanceM = map.distance(a, b);
  L.polyline([a, b], { color: '#f1c40f', weight: 2, opacity: 0.85 })
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
  L.polyline([a, b], { color: '#9b59b6', weight: 2, opacity: 0.85 })
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
  const point = L.latLng(lat, lon);
  if (pendingPointA === null) {
    pendingPointA = point;
    return;
  }
  if (activeTool === 'ruler') drawRuler(pendingPointA, point);
  else drawArc(pendingPointA, point);
  deactivateMeasureTool();
}

map.on('click', (e: L.LeafletMouseEvent) => {
  handleMeasureClick(e.latlng.lat, e.latlng.lng);
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  if (!isMeasuring()) return;
  deactivateMeasureTool();
});

