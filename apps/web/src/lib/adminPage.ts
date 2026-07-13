import { getPendingReports, reviewReport, getCellsPage, deleteCell, updateCellScore, revertCellScore, generateInviteCode, listInviteCodes } from './api.ts';
import type { CellAggregate } from './api.ts';
import { showToast } from './toast.ts';
import { formatDateTimeBogota, parseUtcDate } from './datetime.ts';

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
        <td>${formatDateTimeBogota(r.created_at)}</td>
        <td>
          <div class="table-actions">
            <button class="btn-secondary btn-sm" data-id="${r.id}" data-action="approved">Aprobar</button>
            <button class="btn-danger btn-sm" data-id="${r.id}" data-action="rejected">Rechazar</button>
          </div>
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
const cellsFilter = document.getElementById('cells-filter') as HTMLInputElement;
const cellsPrevBtn = document.getElementById('cells-prev') as HTMLButtonElement;
const cellsNextBtn = document.getElementById('cells-next') as HTMLButtonElement;
const cellsPageIndicator = document.getElementById('cells-page-indicator')!;

const CELLS_PAGE_SIZE = 100;
let currentCells: CellAggregate[] = []; // última página recibida — reusada al re-renderizar (editar/cancelar) sin refetch
let currentPage = 1;
let currentTotal = 0;
// h3_index de la fila en edición inline (una a la vez) — null = ninguna.
let editingH3: string | null = null;

function renderCellsTable(cells: CellAggregate[]) {
  cellsTbody.innerHTML = '';
  for (const cell of cells) {
    const tr = document.createElement('tr');
    const isEditing = editingH3 === cell.h3_index;
    const scoreCell = isEditing
      ? `<input type="number" min="0" max="100" step="1" value="${Math.round(cell.score_pct)}" id="score-input-${cell.h3_index}" style="width:5rem" />`
      : `${Math.round(cell.score_pct)}%${cell.manual_override ? ' <span class="hint" title="Fijado a mano por un admin">(manual)</span>' : ''}`;
    const actionsCell = isEditing
      ? `<div class="table-actions">
           <button class="btn-secondary btn-sm" data-action="save" data-h3="${cell.h3_index}">Guardar</button>
           <button class="btn-secondary btn-sm" data-action="cancel" data-h3="${cell.h3_index}">Cancelar</button>
         </div>`
      : `<div class="table-actions">
           <button class="btn-secondary btn-sm" data-action="edit" data-h3="${cell.h3_index}">Editar</button>
           ${cell.manual_override ? `<button class="btn-secondary btn-sm" data-action="revert" data-h3="${cell.h3_index}">Revertir a automático</button>` : ''}
           <button class="btn-danger btn-sm" data-action="delete" data-h3="${cell.h3_index}">Eliminar</button>
         </div>`;
    tr.innerHTML = `
      <td>${cell.h3_index}</td>
      <td>${cell.plus_code}</td>
      <td>${scoreCell}</td>
      <td>${cell.report_count}</td>
      <td>${formatDateTimeBogota(cell.last_report_at)}</td>
      <td>${actionsCell}</td>`;
    cellsTbody.appendChild(tr);
  }
}

// Filtra por plus_code — más fácil de recordar/tipear que el h3_index
// para alguien buscando "esa celda de tal esquina". Server-side (query
// param "q") porque la tabla está paginada: filtrar solo la página
// cargada en el cliente daría resultados incompletos/confusos.
async function loadCells(page: number) {
  try {
    const result = await getCellsPage({ page, pageSize: CELLS_PAGE_SIZE, q: cellsFilter.value.trim() });
    currentCells = result.items;
    currentPage = result.page;
    currentTotal = result.total;
    editingH3 = null;
    cellsStatus.textContent = currentTotal === 0 ? 'No hay celdas activas.' : '';
    renderCellsTable(currentCells);
    updateCellsPagination();
  } catch (err: any) {
    cellsStatus.textContent = `Error: ${err.message}`;
  }
}

function updateCellsPagination() {
  const totalPages = Math.max(1, Math.ceil(currentTotal / CELLS_PAGE_SIZE));
  cellsPageIndicator.textContent = `Página ${currentPage} de ${totalPages} (${currentTotal} celdas)`;
  cellsPrevBtn.disabled = currentPage <= 1;
  cellsNextBtn.disabled = currentPage >= totalPages;
}

let cellsFilterTimeout: ReturnType<typeof setTimeout>;
cellsFilter.addEventListener('input', () => {
  clearTimeout(cellsFilterTimeout);
  cellsFilterTimeout = setTimeout(() => loadCells(1), 300);
});
cellsPrevBtn.addEventListener('click', () => loadCells(currentPage - 1));
cellsNextBtn.addEventListener('click', () => loadCells(currentPage + 1));

cellsTbody.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const h3Index = btn.dataset.h3!;
  const action = btn.dataset.action;

  if (action === 'edit') {
    editingH3 = h3Index;
    renderCellsTable(currentCells);
    return;
  }
  if (action === 'cancel') {
    editingH3 = null;
    renderCellsTable(currentCells);
    return;
  }
  if (action === 'save') {
    const input = document.getElementById(`score-input-${h3Index}`) as HTMLInputElement;
    const scorePct = Number(input.value);
    if (Number.isNaN(scorePct) || scorePct < 0 || scorePct > 100) {
      showToast('La señal debe ser un número entre 0 y 100.', 'error');
      return;
    }
    try {
      await updateCellScore(h3Index, scorePct);
      showToast('Señal actualizada.', 'success');
      editingH3 = null;
      loadCells(currentPage);
    } catch (err: any) {
      showToast(err.message || 'No se pudo actualizar la señal.', 'error');
    }
    return;
  }
  if (action === 'revert') {
    if (!confirm(`¿Volver la celda ${h3Index} al cálculo automático? Se pierde el valor fijado a mano.`)) return;
    try {
      await revertCellScore(h3Index);
      showToast('Celda vuelta a cálculo automático.', 'success');
      loadCells(currentPage);
    } catch (err: any) {
      showToast(err.message || 'No se pudo revertir la celda.', 'error');
    }
    return;
  }
  if (action === 'delete') {
    if (!confirm(`¿Eliminar la celda ${h3Index} del mapa? Los reportes aprobados quedarán marcados como rechazados.`)) {
      return;
    }
    try {
      await deleteCell(h3Index);
      showToast('Celda eliminada del mapa.', 'success');
      loadCells(currentPage);
    } catch (err: any) {
      showToast(err.message || 'No se pudo eliminar la celda.', 'error');
    }
  }
});

const inviteCodesTbody = document.querySelector('#invite-codes-table tbody')!;
const inviteCodesStatus = document.getElementById('invite-codes-status')!;

// Estado del código calculado client-side a partir de used_at/expires_at
// — el backend no guarda un campo "status" separado, son derivados.
function inviteCodeState(code: { used_at?: string; expires_at: string }): 'usado' | 'expirado' | 'activo' {
  if (code.used_at) return 'usado';
  if (parseUtcDate(code.expires_at) < new Date()) return 'expirado';
  return 'activo';
}

async function loadInviteCodes() {
  inviteCodesTbody.innerHTML = '';
  try {
    const codes = await listInviteCodes();
    inviteCodesStatus.textContent = codes.length === 0 ? 'No hay códigos generados.' : '';
    for (const code of codes) {
      const state = inviteCodeState(code);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${code.code}</td>
        <td>${state}</td>
        <td>${formatDateTimeBogota(code.created_at)}</td>
        <td>${state === 'usado'
          ? formatDateTimeBogota(code.used_at!)
          : formatDateTimeBogota(code.expires_at)}</td>`;
      inviteCodesTbody.appendChild(tr);
    }
  } catch (err: any) {
    inviteCodesStatus.textContent = `Error: ${err.message}`;
  }
}

document.getElementById('btn-generate-invite')!.addEventListener('click', async () => {
  try {
    const { code } = await generateInviteCode();
    try {
      await navigator.clipboard.writeText(code);
      showToast(`Código generado y copiado: ${code}`);
    } catch {
      showToast(`Código generado: ${code}`);
    }
    loadInviteCodes();
  } catch (err: any) {
    showToast(err.message || 'No se pudo generar el código.', 'error');
  }
});

load();
loadCells(1);
loadInviteCodes();
