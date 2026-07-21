import L from 'leaflet';
import { cellToBoundary, latLngToCell } from 'h3-js';
import { showToast } from '../toast.ts';
import { colorForScore } from '../colors.ts';
import { formatDateTimeBogota } from '../datetime.ts';
import { H3_RESOLUTION, MAX_ZOOM } from '../mapBounds.ts';
import { map, testLayer } from './setup.ts';
import { realIndexes, isTestModeEnabled, setTestModeEnabled } from './state.ts';
import {
  getCurrentGeoPosition,
  getLastKnownPosition,
  renderUserLocation,
  startLiveUserLocation,
} from './geolocation.ts';
import { copyReportMessage } from './reportMessage.ts';

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

function removeTestCell(h3Index: string) {
  saveTestCells(loadTestCells().filter((c) => c.h3_index !== h3Index));
  renderAllTestCells();
}

function clearTestCells() {
  saveTestCells([]);
  renderAllTestCells();
}

let isAdminMode = false;
let hasStartedLiveWatch = false;

// Click sobre el mapa vacío: crea/quita una celda de prueba. Gatea todo
// con isTestModeEnabled() — el toggle de "Activar/Desactivar modo
// prueba" solo mueve este flag, nunca detiene el GPS ni redibuja nada.
//
// Un usuario normal: la última posición del watch en curso sirve de
// prueba de presencia, sin pedir una lectura GPS puntual por click —
// cada click revalida el GPS en el momento pero sin el costo de una
// nueva consulta al navegador, porque el watch ya empuja lecturas
// frescas y filtradas constantemente. No alcanza con haber estado
// parado ahí una vez al activar el modo, porque medir señal exige estar
// físicamente en el lugar: si dejáramos elegir cualquier celda del mapa,
// cualquiera podría "reportar" cobertura en zonas donde nunca estuvo. El
// plus code copiado siempre sale de esa posición GPS, nunca del punto
// exacto donde cayó el click.
async function handleMapClick(e: L.LeafletMouseEvent) {
  if (!isTestModeEnabled()) return;
  const h3Index = latLngToCell(e.latlng.lat, e.latlng.lng, H3_RESOLUTION);
  if (realIndexes.has(h3Index)) return; // no pisar datos reales aprobados

  const isTestCell = loadTestCells().some((c) => c.h3_index === h3Index);
  if (isTestCell) {
    removeTestCell(h3Index);
    return;
  }

  if (isAdminMode) {
    addTestCell(h3Index);
    copyReportMessage(e.latlng.lat, e.latlng.lng);
    return;
  }

  const pos = getLastKnownPosition();
  if (!pos) {
    showToast('No se pudo obtener tu ubicación GPS', 'error');
    return;
  }
  const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
  if (userH3 !== h3Index) {
    showToast('Solo podés reportar la celda donde estás parado ahora mismo', 'error');
    return;
  }
  addTestCell(h3Index);
  copyReportMessage(pos.coords.latitude, pos.coords.longitude);
}

// Registro único: se llama una sola vez al cargar la página, para
// cualquier usuario. Admin queda con el modo prueba activo de una (sin
// GPS, como hoy); no-admin arranca desactivado hasta que use el botón
// (ver toggleTestMode).
export function initTestMode(isAdmin: boolean) {
  isAdminMode = isAdmin;
  map.on('click', handleMapClick);

  if (isAdmin) {
    setTestModeEnabled(true);
    document.getElementById('btn-clear-test')!.hidden = false;
    document.getElementById('btn-clear-test')!.addEventListener('click', clearTestCells);
  } else {
    setTestModeEnabled(false);
  }
  renderAllTestCells();
}

// Toggle del botón "Activar/Desactivar modo prueba" (no-admin). Solo la
// primera vez que se activa pide el fix GPS inicial y arranca el watch
// en vivo — queda corriendo indefinidamente; los toggles siguientes
// solo prenden/apagan la interacción de click.
export async function toggleTestMode(): Promise<void> {
  if (isTestModeEnabled()) {
    setTestModeEnabled(false);
    showToast('Modo prueba desactivado');
    return;
  }

  if (!hasStartedLiveWatch) {
    let firstPos: GeolocationPosition;
    try {
      firstPos = await getCurrentGeoPosition();
    } catch {
      showToast('No se pudo activar el modo prueba sin acceso a tu ubicación', 'error');
      return;
    }
    hasStartedLiveWatch = true;
    renderUserLocation(firstPos);
    map.setView([firstPos.coords.latitude, firstPos.coords.longitude], Math.min(16, MAX_ZOOM));
    startLiveUserLocation((err) => {
      if (err.code === err.PERMISSION_DENIED) {
        showToast('Se perdió el acceso a tu ubicación GPS', 'error');
      }
    });
  }
  setTestModeEnabled(true);
  showToast('Modo prueba activado');
}
