import L from 'leaflet';
import { CENTER, SANTANDER_BOUNDS, MIN_ZOOM, MAX_ZOOM } from '../mapBounds.ts';
import './webcomponents/mc-map-toolbar.ts';

export const map = L.map('map', {
  center: CENTER,
  // zoom 13, no 11: una celda H3 resolución 8 mide ~460m de lado y a
  // zoom 11 ocupa unos pocos píxeles — se ve como un punto oscuro
  // indistinguible en vez de un hexágono de color.
  zoom: 13,
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  maxBounds: SANTANDER_BOUNDS,
  maxBoundsViscosity: 1.0,
});

// dos mapas base, ambos cacheados por el service worker (public/sw.js)
// vía cache-first sobre las URLs de tiles.
const osmLight = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
});
const osmBlack = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  subdomains: 'abcd',
});
const cartoLight = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  subdomains: 'abcd',
});
cartoLight.addTo(map); // default
L.control.layers(
  { 'CARTO Light': cartoLight, 'OSM Black': osmBlack, 'OSM': osmLight },
  undefined,
  { position: 'topright' }
).addTo(map);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

map.setMaxBounds(SANTANDER_BOUNDS);

export const cellLayer = L.layerGroup().addTo(map);
export const testLayer = L.layerGroup().addTo(map);
export const originsLayer = L.layerGroup().addTo(map);
export const userLocationLayer = L.layerGroup().addTo(map);
export const radialLayer = L.layerGroup().addTo(map);
export const rulerLayer = L.layerGroup().addTo(map);
export const arcLayer = L.layerGroup().addTo(map);

// Control propio para la barra de herramientas de medición — 'topleft'
// porque 'topright' ya lo usa el selector de capas base. Apila debajo
// del control de zoom nativo (+/-), que Leaflet agrega automáticamente
// a ese mismo rincón antes de que este código corra.
const MeasureToolbarControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd(): HTMLElement {
    const toolbar = document.createElement('mc-map-toolbar');
    // Sin esto, un clic en los botones de la toolbar también llegaría a
    // map.on('click', ...) (measureTools.ts lo agrega) y se
    // interpretaría como un punto de medición sobre el mapa.
    L.DomEvent.disableClickPropagation(toolbar);
    return toolbar;
  },
});
new MeasureToolbarControl().addTo(map);
