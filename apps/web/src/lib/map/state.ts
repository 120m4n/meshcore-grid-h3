import type L from 'leaflet';

// Estado compartido entre los módulos del mapa: celdas reales y celdas
// de prueba necesitan verse entre sí (no pisar una celda real con una
// de prueba) y el modo prueba es una sola bandera, sin importar si lo
// activó el flujo de admin o el de un usuario normal con GPS.
export const realIndexes = new Set<string>();

// h3_index -> polígono dibujado, para poder ubicar/enfocar una celda
// puntual (ver query param "h3", usado por el botón "Ver en mapa" del
// admin) sin recorrer cellLayer buscando capa por capa.
export const cellPolygons = new Map<string, L.Polygon>();

let testModeEnabled = false;

export function isTestModeEnabled(): boolean {
  return testModeEnabled;
}

export function setTestModeEnabled(value: boolean) {
  testModeEnabled = value;
}
