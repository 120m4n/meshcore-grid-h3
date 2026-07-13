import L from 'leaflet';
import { cellToBoundary, latLngToCell } from 'h3-js';
import { getCells, getCellOrigins } from '../api.ts';
import { colorForScore } from '../colors.ts';
import { showToast } from '../toast.ts';
import { formatDateTimeBogota } from '../datetime.ts';
import { H3_RESOLUTION } from '../mapBounds.ts';
import { map, cellLayer, originsLayer } from './setup.ts';
import { realIndexes, cellPolygons, isTestModeEnabled } from './state.ts';
import { getCurrentGeoPosition, renderUserLocation } from './geolocation.ts';
import { copyReportMessage } from './reportMessage.ts';

const CELLS_LAST_FETCH_KEY = 'meshcore:cells-last-fetch';

function markCellsFetched() {
  try {
    localStorage.setItem(CELLS_LAST_FETCH_KEY, String(Date.now()));
  } catch {
    // localStorage no disponible — el TTL solo dura esta carga de página.
  }
}

export async function loadCells(isAdmin: boolean) {
  cellLayer.clearLayers();
  originsLayer.clearLayers();
  realIndexes.clear();
  cellPolygons.clear();
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
      cellPolygons.set(cell.h3_index, polygon);

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
        if (!isTestModeEnabled()) return;
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
    focusRequestedCell();
  } catch (err) {
    console.error('Error cargando celdas:', err);
  }
}

// Botón "Ver en mapa" del admin (adminPage.ts) abre esta página con
// ?h3=<h3_index> — enfoca esa celda puntual y abre su popup. Si ya no
// existe entre las celdas reales (borrada/desaprobada desde que se
// generó el link), avisa en vez de fallar en silencio.
function focusRequestedCell() {
  const requestedH3 = new URLSearchParams(location.search).get('h3');
  if (!requestedH3) return;
  const target = cellPolygons.get(requestedH3);
  if (!target) {
    showToast('Celda no encontrada en el mapa (puede haber sido eliminada)', 'error');
    return;
  }
  map.fitBounds(target.getBounds(), { padding: [24, 24], maxZoom: 15 });
  target.openPopup();
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
