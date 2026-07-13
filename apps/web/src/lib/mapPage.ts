import L from 'leaflet';
import { cellToBoundary, latLngToCell } from 'h3-js';
import { OpenLocationCode } from 'open-location-code';
import { getCells, getCellOrigins } from './api.ts';
import { colorForScore } from './colors.ts';
import { showToast } from './toast.ts';
import { formatDateTimeBogota } from './datetime.ts';
import { CENTER, SANTANDER_BOUNDS, MIN_ZOOM, MAX_ZOOM, H3_RESOLUTION } from './mapBounds.ts';

const olc = new OpenLocationCode();
const token = localStorage.getItem('token');
const isAdmin = localStorage.getItem('role') === 'admin';
// admin siempre tiene modo prueba; un usuario normal lo desbloquea
// aceptando geolocalización (ver btn-enable-test más abajo).
let testModeEnabled = isAdmin;

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
let userLocationLayer = L.layerGroup().addTo(map);
const realIndexes = new Set<string>();

const CELLS_LAST_FETCH_KEY = 'meshcore:cells-last-fetch';

function markCellsFetched() {
  try {
    localStorage.setItem(CELLS_LAST_FETCH_KEY, String(Date.now()));
  } catch {
    // localStorage no disponible — el TTL solo dura esta carga de página.
  }
}

// Punto GPS del usuario: dibuja al instante cuando se valida
// geolocalización (activación de modo prueba y cada relectura durante
// un click). Círculo exterior = radio de precisión reportado por el
// navegador (pos.coords.accuracy, en metros) — cuanto más grande, más
// incierta es la posición.
function renderUserLocation(pos: GeolocationPosition) {
  const { latitude, longitude, accuracy } = pos.coords;
  userLocationLayer.clearLayers();
  // interactive: false — el punto suele caer justo sobre la celda real
  // donde el usuario está parado (es el caso de uso central del modo
  // prueba); sin esto, el dot capturaba el click y la celda de abajo
  // nunca llegaba a recibirlo.
  L.circle([latitude, longitude], {
    radius: Math.abs(accuracy),
    color: '#1a73e8',
    weight: 1.5,
    fillColor: '#ffffff',
    fillOpacity: 0.35,
    interactive: false,
  }).addTo(userLocationLayer);
  L.circleMarker([latitude, longitude], {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#1a73e8',
    fillOpacity: 1,
    interactive: false,
  }).addTo(userLocationLayer);
}

async function loadCells() {
  cellLayer.clearLayers();
  originsLayer.clearLayers();
  realIndexes.clear();
  markCellsFetched();
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
        <strong>Último reporte:</strong> ${formatDateTimeBogota(cell.last_report_at)}
      `);
      // evitar que el clic sobre una celda real también dispare el
      // creador/eliminador de celdas de prueba del mapa
      polygon.on('click', async (e) => {
        L.DomEvent.stopPropagation(e);
        showCellOrigins(cell.h3_index); // ver info siempre, sin importar dónde esté parado

        // Encadenar el reporte: una celda ya reportada puede seguir
        // sumando reportes desde otras ubicaciones físicas dentro del
        // mismo hexágono — si el modo prueba está activo y el GPS
        // confirma que el usuario está parado en ESTA celda, copiar el
        // mensaje igual que al crear una celda de prueba nueva.
        if (!testModeEnabled) return;
        if (isAdmin) {
          copyReportMessage(e.latlng.lat, e.latlng.lng);
          return;
        }
        let pos: GeolocationPosition;
        try {
          pos = await getCurrentGeoPosition();
        } catch {
          return; // solo navegando el mapa, sin GPS no hay nada más que hacer
        }
        renderUserLocation(pos);
        const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
        if (userH3 !== cell.h3_index) return; // viendo la celda, pero no parado ahí
        copyReportMessage(pos.coords.latitude, pos.coords.longitude);
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
    <strong>Creada:</strong> ${formatDateTimeBogota(cell.created_at)}<br/>
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
  // score_pct fijo en 100 (verde vía colorForScore) — la celda de
  // prueba ya no simula un score real, solo marca "acá reporto".
  cells.push({ h3_index: h3Index, score_pct: 100, created_at: new Date().toISOString() });
  saveTestCells(cells);
  renderAllTestCells();
}

async function copyReportMessage(lat: number, lng: number) {
  const message = `Reportar ${olc.encode(lat, lng, 10)}`;
  try {
    await navigator.clipboard.writeText(message);
    showToast(`Copiado al portapapeles: ${message}`);
  } catch {
    showToast('No se pudo copiar al portapapeles', 'error');
  }
}

function removeTestCell(h3Index: string) {
  saveTestCells(loadTestCells().filter((c) => c.h3_index !== h3Index));
  renderAllTestCells();
}

function clearTestCells() {
  saveTestCells([]);
  renderAllTestCells();
}

function getCurrentGeoPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
    });
  });
}

// Celdas de prueba: admin las tiene siempre y puede clickear cualquier
// celda (es una herramienta de testing, no una medición real). Un
// usuario normal las desbloquea aceptando geolocalización, pero cada
// click revalida el GPS en el momento — no alcanza con haber estado
// parado ahí una vez al activar el modo, porque medir señal exige estar
// físicamente en el lugar: si dejáramos elegir cualquier celda del mapa,
// cualquiera podría "reportar" cobertura en zonas donde nunca estuvo. El
// plus code copiado siempre sale de esa posición GPS fresca, nunca del
// punto exacto donde cayó el click.
function enableTestMode() {
  testModeEnabled = true;
  map.on('click', async (e: L.LeafletMouseEvent) => {
    const h3Index = latLngToCell(e.latlng.lat, e.latlng.lng, H3_RESOLUTION);
    if (realIndexes.has(h3Index)) return; // no pisar datos reales aprobados

    const isTestCell = loadTestCells().some((c) => c.h3_index === h3Index);
    if (isTestCell) {
      removeTestCell(h3Index);
      return;
    }

    if (isAdmin) {
      addTestCell(h3Index);
      copyReportMessage(e.latlng.lat, e.latlng.lng);
      return;
    }

    let pos: GeolocationPosition;
    try {
      pos = await getCurrentGeoPosition();
    } catch {
      showToast('No se pudo obtener tu ubicación GPS', 'error');
      return;
    }
    renderUserLocation(pos);
    const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
    if (userH3 !== h3Index) {
      showToast('Solo podés reportar la celda donde estás parado ahora mismo', 'error');
      return;
    }
    addTestCell(h3Index);
    copyReportMessage(pos.coords.latitude, pos.coords.longitude);
  });
  // solo admin puede acumular varias celdas de prueba en cualquier parte
  // del mapa (sin el candado de GPS) — un usuario normal tiene como
  // máximo una, la de su ubicación actual, y ya puede quitarla clickeando
  // de nuevo esa misma celda (ver isTestCell arriba). Mostrarles este
  // botón es redundante y sugiere un estado acumulado que nunca existe.
  if (isAdmin) {
    document.getElementById('btn-clear-test')!.hidden = false;
    document.getElementById('btn-clear-test')!.addEventListener('click', clearTestCells);
  }
  renderAllTestCells();
}

if (isAdmin) {
  enableTestMode();
} else {
  const btnEnableTest = document.getElementById('btn-enable-test')!;
  btnEnableTest.hidden = false;
  btnEnableTest.addEventListener('click', async () => {
    if (!navigator.geolocation) {
      showToast('Tu navegador no soporta geolocalización', 'error');
      return;
    }
    let pos: GeolocationPosition;
    try {
      pos = await getCurrentGeoPosition();
    } catch {
      showToast('No se pudo activar el modo prueba sin acceso a tu ubicación', 'error');
      return;
    }
    btnEnableTest.hidden = true;
    renderUserLocation(pos);
    map.setView([pos.coords.latitude, pos.coords.longitude], Math.min(16, MAX_ZOOM));
    enableTestMode();
    showToast('Modo prueba activado');
  });
}

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
