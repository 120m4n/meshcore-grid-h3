import L from 'leaflet';
import { cellToBoundary, latLngToCell } from 'h3-js';
import { getCells, getCellOrigins } from './api.ts';
import { colorForScore } from './colors.ts';
import { CENTER, SANTANDER_BOUNDS, MIN_ZOOM, MAX_ZOOM, H3_RESOLUTION } from './mapBounds.ts';

const token = localStorage.getItem('token');
const isAdmin = localStorage.getItem('role') === 'admin';

const map = L.map('map', {
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
osmBlack.addTo(map); // default
L.control.layers(
  { 'OSM Black': osmBlack, 'OSM': osmLight },
  undefined,
  { position: 'topright' }
).addTo(map);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

map.setMaxBounds(SANTANDER_BOUNDS);

let cellLayer = L.layerGroup().addTo(map);
let testLayer = L.layerGroup().addTo(map);
let originsLayer = L.layerGroup().addTo(map);
const realIndexes = new Set<string>();

async function loadCells() {
  cellLayer.clearLayers();
  originsLayer.clearLayers();
  realIndexes.clear();
  try {
    const cells = await getCells();
    let bounds: L.LatLngBounds | null = null;
    for (const cell of cells) {
      realIndexes.add(cell.h3_index);
      const boundary = cellToBoundary(cell.h3_index); // [[lat,lon], ...]
      const polygon = L.polygon(boundary, {
        color: '#345070',
        weight: 1,
        fillColor: colorForScore(cell.score_pct),
        fillOpacity: 0.55,
      }).addTo(cellLayer);

      polygon.bindPopup(`
        <strong>Celda:</strong> ${cell.h3_index}<br/>
        <strong>Conectividad:</strong> ${cell.score_pct.toFixed(0)}%<br/>
        <strong>Reportes:</strong> ${cell.report_count}<br/>
        <strong>Último reporte:</strong> ${new Date(cell.last_report_at).toLocaleString('es-CO')}
      `);
      // evitar que el clic sobre una celda real también dispare el
      // creador/eliminador de celdas de prueba del mapa
      polygon.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        showCellOrigins(cell.h3_index);
      });

      bounds = bounds ? bounds.extend(polygon.getBounds()) : polygon.getBounds();
    }
    // sin celdas reales no hay extent que calcular — se deja la vista
    // actual tal cual, en vez de saltar al CENTER por defecto.
    if (bounds) {
      map.fitBounds(bounds, { padding: [24, 24] });
    }
  } catch (err) {
    console.error('Error cargando celdas:', err);
  }
}

async function showCellOrigins(h3Index: string) {
  originsLayer.clearLayers();
  try {
    const origins = await getCellOrigins(h3Index);
    for (const origin of origins) {
      L.rectangle(
        [
          [origin.lat_lo, origin.lng_lo],
          [origin.lat_hi, origin.lng_hi],
        ],
        { color: '#34d7c0', weight: 2, fillOpacity: 0.25 }
      ).addTo(originsLayer);
    }
  } catch (err) {
    console.error('Error cargando orígenes de la celda:', err);
  }
}

// ============ celdas de prueba (mock, solo localStorage) ============
// No toca el backend ni cell_agg real. Sirve para probar la interacción
// "crear celda → aparece en el mapa" / "eliminar celda → desaparece"
// directamente sobre el mapa público, sin flujo de reportes+aprobación.
const TEST_STORAGE_KEY = 'meshcore:test-cells';

interface TestCell {
  h3_index: string;
  score_pct: number;
  created_at: string;
}

function loadTestCells(): TestCell[] {
  try {
    const raw = localStorage.getItem(TEST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTestCells(cells: TestCell[]) {
  try {
    localStorage.setItem(TEST_STORAGE_KEY, JSON.stringify(cells));
  } catch {
    // localStorage no disponible (modo privado, cuota) — la celda
    // igual queda pintada en memoria para esta sesión.
  }
}

function renderTestCell(cell: TestCell) {
  const boundary = cellToBoundary(cell.h3_index);
  const polygon = L.polygon(boundary, {
    color: '#34d7c0',
    weight: 1.5,
    dashArray: '4 3', // punteado marca visualmente "temporal/prueba"
    fillColor: colorForScore(cell.score_pct),
    fillOpacity: 0.45,
  }).addTo(testLayer);

  polygon.bindPopup(`
    <strong>Celda de prueba (temporal):</strong> ${cell.h3_index}<br/>
    <strong>Conectividad:</strong> ${cell.score_pct.toFixed(0)}%<br/>
    <strong>Creada:</strong> ${new Date(cell.created_at).toLocaleString('es-CO')}<br/>
    <em>Clic de nuevo sobre la celda para quitarla</em>
  `);
  polygon.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    removeTestCell(cell.h3_index);
  });
}

function renderAllTestCells() {
  testLayer.clearLayers();
  loadTestCells().forEach(renderTestCell);
}

function addTestCell(h3Index: string) {
  const cells = loadTestCells();
  if (cells.some((c) => c.h3_index === h3Index)) return;
  cells.push({ h3_index: h3Index, score_pct: Math.random() * 100, created_at: new Date().toISOString() });
  saveTestCells(cells);
  renderAllTestCells();
}

function removeTestCell(h3Index: string) {
  saveTestCells(loadTestCells().filter((c) => c.h3_index !== h3Index));
  renderAllTestCells();
}

function clearTestCells() {
  saveTestCells([]);
  renderAllTestCells();
}

// Celdas de prueba: solo interactivas/visibles para admin.
if (isAdmin) {
  map.on('click', (e: L.LeafletMouseEvent) => {
    const h3Index = latLngToCell(e.latlng.lat, e.latlng.lng, H3_RESOLUTION);
    if (realIndexes.has(h3Index)) return; // no pisar datos reales aprobados
    const isTestCell = loadTestCells().some((c) => c.h3_index === h3Index);
    if (isTestCell) {
      removeTestCell(h3Index);
    } else {
      addTestCell(h3Index);
    }
  });
  document.getElementById('btn-clear-test')!.hidden = false;
  document.getElementById('btn-clear-test')!.addEventListener('click', clearTestCells);
  renderAllTestCells();
}

document.getElementById('btn-refresh')!.addEventListener('click', () => {
  if (isAdmin) clearTestCells();
  loadCells();
});
loadCells();

// Mostrar/ocultar nav según sesión
if (token) {
  document.getElementById('nav-report')!.hidden = false;
  const navLogin = document.getElementById('nav-login')!;
  navLogin.textContent = 'Salir';
  navLogin.addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.clear();
    location.reload();
  });
}
if (isAdmin) {
  document.getElementById('nav-admin')!.hidden = false;
}
