import { getPendingReports, reviewReport } from '../api.ts';
import { formatDateTimeBogota } from '../datetime.ts';

export function initReports() {
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

  load();
}
