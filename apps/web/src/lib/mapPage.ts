import { map } from './map/setup.ts';
import { loadCells } from './map/realCells.ts';
import { enableTestMode } from './map/testCells.ts';
import { getCurrentGeoPosition, renderUserLocation } from './map/geolocation.ts';
import { MAX_ZOOM } from './mapBounds.ts';
import { showToast } from './toast.ts';

const token = localStorage.getItem('token');
// admin siempre tiene modo prueba; un usuario normal lo desbloquea
// aceptando geolocalización (ver btn-enable-test más abajo).
const isAdmin = localStorage.getItem('role') === 'admin';

if (isAdmin) {
  enableTestMode(isAdmin);
} else {
  const btnEnableTest = document.getElementById('btn-enable-test')!;
  btnEnableTest.hidden = false;
  btnEnableTest.addEventListener('click', async () => {
    if (!navigator.geolocation) {
      showToast('Tu navegador no soporta geolocalización', 'error');
      return;
    }
    let pos: GeolocationPosition;
    try {
      pos = await getCurrentGeoPosition();
    } catch {
      showToast('No se pudo activar el modo prueba sin acceso a tu ubicación', 'error');
      return;
    }
    btnEnableTest.hidden = true;
    renderUserLocation(pos);
    map.setView([pos.coords.latitude, pos.coords.longitude], Math.min(16, MAX_ZOOM));
    enableTestMode(isAdmin);
    showToast('Modo prueba activado');
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
