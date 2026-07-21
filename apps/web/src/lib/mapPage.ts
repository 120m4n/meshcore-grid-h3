import { loadCells } from './map/realCells.ts';
import { initTestMode, toggleTestMode } from './map/testCells.ts';
import { isTestModeEnabled } from './map/state.ts';
import { showToast } from './toast.ts';

const token = localStorage.getItem('token');
// admin siempre tiene modo prueba; un usuario normal lo desbloquea
// aceptando geolocalización (ver btn-enable-test más abajo).
const isAdmin = localStorage.getItem('role') === 'admin';

initTestMode(isAdmin);

if (!isAdmin) {
  const btnEnableTest = document.getElementById('btn-enable-test') as HTMLButtonElement;
  btnEnableTest.hidden = false;
  btnEnableTest.addEventListener('click', async () => {
    if (!navigator.geolocation) {
      showToast('Tu navegador no soporta geolocalización', 'error');
      return;
    }
    await toggleTestMode();
    btnEnableTest.textContent = isTestModeEnabled()
      ? 'Desactivar modo prueba'
      : 'Activar modo prueba';
  });
}

loadCells(isAdmin);

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
