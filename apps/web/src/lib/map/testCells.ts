import L from 'leaflet';
import { cellToBoundary, latLngToCell } from 'h3-js';
import { showToast } from '../toast.ts';
import { colorForScore } from '../colors.ts';
import { formatDateTimeBogota } from '../datetime.ts';
import { H3_RESOLUTION } from '../mapBounds.ts';
import { map, testLayer } from './setup.ts';
import { realIndexes, setTestModeEnabled } from './state.ts';
import { getCurrentGeoPosition, renderUserLocation } from './geolocation.ts';
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

// Celdas de prueba: admin las tiene siempre y puede clickear cualquier
// celda (es una herramienta de testing, no una medición real). Un
// usuario normal las desbloquea aceptando geolocalización, pero cada
// click revalida el GPS en el momento — no alcanza con haber estado
// parado ahí una vez al activar el modo, porque medir señal exige estar
// físicamente en el lugar: si dejáramos elegir cualquier celda del mapa,
// cualquiera podría "reportar" cobertura en zonas donde nunca estuvo. El
// plus code copiado siempre sale de esa posición GPS fresca, nunca del
// punto exacto donde cayó el click.
export function enableTestMode(isAdmin: boolean) {
  setTestModeEnabled(true);
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
