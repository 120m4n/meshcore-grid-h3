import { getPendingReports, reviewReport, getCells, deleteCell, updateCellScore, revertCellScore, generateInviteCode, listInviteCodes } from './api.ts';
import type { CellAggregate } from './api.ts';
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
const cellsFilter = document.getElementById('cells-filter') as HTMLInputElement;

let allCells: CellAggregate[] = [];
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
      ? `<button data-action="save" data-h3="${cell.h3_index}">Guardar</button>
         <button data-action="cancel" data-h3="${cell.h3_index}">Cancelar</button>`
      : `<button data-action="edit" data-h3="${cell.h3_index}">Editar</button>
         ${cell.manual_override ? `<button data-action="revert" data-h3="${cell.h3_index}">Revertir a automático</button>` : ''}
         <button class="btn-danger" data-action="delete" data-h3="${cell.h3_index}">Eliminar</button>`;
    tr.innerHTML = `
      <td>${cell.h3_index}</td>
      <td>${cell.plus_code}</td>
      <td>${scoreCell}</td>
      <td>${cell.report_count}</td>
      <td>${new Date(cell.last_report_at).toLocaleString('es-CO')}</td>
      <td>${actionsCell}</td>`;
    cellsTbody.appendChild(tr);
  }
}

async function loadCells() {
  try {
    allCells = await getCells();
    cellsStatus.textContent = allCells.length === 0 ? 'No hay celdas activas.' : '';
    applyCellsFilter();
  } catch (err: any) {
    cellsStatus.textContent = `Error: ${err.message}`;
  }
}

// Filtra por plus_code — más fácil de recordar/tipear que el h3_index
// para alguien buscando "esa celda de tal esquina".
function applyCellsFilter() {
  const query = cellsFilter.value.trim().toUpperCase();
  const filtered = query
    ? allCells.filter((c) => c.plus_code.toUpperCase().includes(query))
    : allCells;
  renderCellsTable(filtered);
}
cellsFilter.addEventListener('input', applyCellsFilter);

cellsTbody.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const h3Index = btn.dataset.h3!;
  const action = btn.dataset.action;

  if (action === 'edit') {
    editingH3 = h3Index;
    applyCellsFilter();
    return;
  }
  if (action === 'cancel') {
    editingH3 = null;
    applyCellsFilter();
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
      loadCells();
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
      loadCells();
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
      loadCells();
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
  if (new Date(code.expires_at) < new Date()) return 'expirado';
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
        <td>${new Date(code.created_at).toLocaleString('es-CO')}</td>
        <td>${state === 'usado'
          ? new Date(code.used_at!).toLocaleString('es-CO')
          : new Date(code.expires_at).toLocaleString('es-CO')}</td>`;
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
loadCells();
loadInviteCodes();
