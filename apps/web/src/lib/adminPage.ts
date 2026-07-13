import { initReports } from './admin/reports.ts';
import { initCells } from './admin/cells.ts';
import { initInviteCodes } from './admin/inviteCodes.ts';

const token = localStorage.getItem('token');
const role = localStorage.getItem('role');
if (!token || role !== 'admin') {
  window.location.href = '/';
}

initReports();
initCells();
initInviteCodes();
