import { generateInviteCode, listInviteCodes } from '../api.ts';
import { formatDateTimeBogota, parseUtcDate } from '../datetime.ts';
import { showToast } from '../toast.ts';

// Estado del código calculado client-side a partir de used_at/expires_at
// — el backend no guarda un campo "status" separado, son derivados.
function inviteCodeState(code: { used_at?: string; expires_at: string }): 'usado' | 'expirado' | 'activo' {
  if (code.used_at) return 'usado';
  if (parseUtcDate(code.expires_at) < new Date()) return 'expirado';
  return 'activo';
}

export function initInviteCodes() {
  const inviteCodesTbody = document.querySelector('#invite-codes-table tbody')!;
  const inviteCodesStatus = document.getElementById('invite-codes-status')!;

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

  loadInviteCodes();
}
