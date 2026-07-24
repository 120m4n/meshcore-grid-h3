import L from 'leaflet';
import { map, rulerLayer, arcLayer } from './setup.ts';
import { cancelOriginPicking } from './radialSimulation.ts';

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

// El dibujo real (distancia/rumbo) llega en las Tasks 4 y 5 — por ahora
// el segundo clic solo cierra el modo, para poder verificar la máquina
// de estados de forma aislada.
export function handleMeasureClick(lat: number, lon: number): void {
  if (activeTool === null) return;
  if (pendingPointA === null) {
    pendingPointA = L.latLng(lat, lon);
    return;
  }
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

// rulerLayer/arcLayer todavía no se usan en esta tarea — el import
// deliberadamente los trae ya para que las Tasks 4/5 no tengan que
// tocar esta línea de imports.
void rulerLayer;
void arcLayer;
