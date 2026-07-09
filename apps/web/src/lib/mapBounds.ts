// Acotamiento geográfico compartido: Bucaramanga centro, extent Santander.
// Único punto de verdad para cualquier mapa Leaflet de la app (mapa
// público y el selector de ubicación del formulario de reporte deben
// respetar el mismo encuadre).
export const CENTER: [number, number] = [7.1193, -73.1227];
export const SANTANDER_BOUNDS: [[number, number], [number, number]] = [
  [5.65, -74.45], // suroeste
  [8.35, -72.50], // noreste
];
export const MIN_ZOOM = 9;
export const MAX_ZOOM = 17;
export const H3_RESOLUTION = 8; // debe igualar H3_RESOLUTION del backend
