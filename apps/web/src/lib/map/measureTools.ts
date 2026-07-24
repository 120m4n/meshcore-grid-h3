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

export function handleMeasureClick(lat: number, lon: number): void {
  if (activeTool === null) return;
  const point = L.latLng(lat, lon);
  if (pendingPointA === null) {
    pendingPointA = point;
    return;
  }
  if (activeTool === 'ruler') drawRuler(pendingPointA, point);
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

