import { getPendingReports, reviewReport, getCells, deleteCell } from './api.ts';
import { showToast } from './toast.ts';

const token = localStorage.getItem('token');
const role = localStorage.getItem('role');
if (!token || role !== 'admin') {
  window.location.href = '/';
}

const tbody = document.querySelector('#reports-table tbody')!;
const status = document.getElementById('status')!;

async function load() {
  tbody.innerHTML = '';
  try {
    const reports = await getPendingReports();
    if (reports.length === 0) {
      status.textContent = 'No hay reportes pendientes.';
    }
    for (const r of reports) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.h3_index}</td>
        <td>${r.reporter_display_name || 'Anónimo'} <span class="hint">(cuenta: ${r.reporter_name})</span></td>
        <td>${r.signal_quality}</td>
        <td>${r.message || '-'}</td>
        <td>${new Date(r.created_at).toLocaleString('es-CO')}</td>
        <td>
          <button data-id="${r.id}" data-action="approved">Aprobar</button>
          <button data-id="${r.id}" data-action="rejected">Rechazar</button>
        </td>`;
      tbody.appendChild(tr);
    }
  } catch (err: any) {
    status.textContent = `Error: ${err.message}`;
  }
}

tbody.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  try {
    await reviewReport(btn.dataset.id!, btn.dataset.action as 'approved' | 'rejected');
    load();
  } catch (err: any) {
    status.textContent = `Error: ${err.message}`;
  }
});

const cellsTbody = document.querySelector('#cells-table tbody')!;
const cellsStatus = document.getElementById('cells-status')!;

async function loadCells() {
  cellsTbody.innerHTML = '';
  try {
    const cells = await getCells();
    cellsStatus.textContent = cells.length === 0 ? 'No hay celdas activas.' : '';
    for (const cell of cells) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${cell.h3_index}</td>
        <td>${Math.round(cell.score_pct)}%</td>
        <td>${cell.report_count}</td>
        <td>${new Date(cell.last_report_at).toLocaleString('es-CO')}</td>
        <td><button class="btn-danger" data-h3="${cell.h3_index}">Eliminar</button></td>`;
      cellsTbody.appendChild(tr);
    }
  } catch (err: any) {
    cellsStatus.textContent = `Error: ${err.message}`;
  }
}

cellsTbody.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const h3Index = btn.dataset.h3!;
  if (!confirm(`¿Eliminar la celda ${h3Index} del mapa? Los reportes aprobados quedarán marcados como rechazados.`)) {
    return;
  }
  try {
    await deleteCell(h3Index);
    showToast('Celda eliminada del mapa.', 'success');
    loadCells();
  } catch (err: any) {
    showToast(err.message || 'No se pudo eliminar la celda.', 'error');
  }
});

load();
loadCells();
