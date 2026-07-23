import { loadCells } from './map/realCells.ts';
import { initTestMode, toggleTestMode } from './map/testCells.ts';
import { isTestModeEnabled } from './map/state.ts';
import { showToast } from './toast.ts';
import { enableOriginPicking, runRadialSimulation, clearRadialSimulation } from './map/radialSimulation.ts';

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

// Panel de simulación LOS 360° — disponible para cualquier visitante,
// mismo criterio que el mapa público (GET /cells): visualización de
// solo lectura/cómputo, no requiere sesión.
let pickedOrigin: { lat: number; lon: number } | null = null;

const radarOriginLabel = document.getElementById('radar-origin')!;
const btnPickOrigin = document.getElementById('btn-pick-origin') as HTMLButtonElement;
const btnRunRadial = document.getElementById('btn-run-radial') as HTMLButtonElement;
const btnClearRadial = document.getElementById('btn-clear-radial') as HTMLButtonElement;

btnPickOrigin.addEventListener('click', () => {
  showToast('Hacé clic en el mapa para fijar el origen');
  enableOriginPicking((lat, lon) => {
    pickedOrigin = { lat, lon };
    radarOriginLabel.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    btnRunRadial.disabled = false;
  });
});

btnRunRadial.addEventListener('click', () => {
  if (!pickedOrigin) return;
  const heightM = Number((document.getElementById('radar-height') as HTMLInputElement).value);
  const angleStepDeg = Number((document.getElementById('radar-angle-step') as HTMLInputElement).value);
  const maxDistanceM = Number((document.getElementById('radar-max-distance') as HTMLInputElement).value);
  const sampleStepM = Number((document.getElementById('radar-sample-step') as HTMLInputElement).value);

  runRadialSimulation({
    origin_lat: pickedOrigin.lat,
    origin_lon: pickedOrigin.lon,
    origin_height_m: heightM,
    angle_step_deg: angleStepDeg,
    max_distance_m: maxDistanceM,
    sample_step_m: sampleStepM,
    earth_curvature: true,
  });
});

btnClearRadial.addEventListener('click', () => {
  clearRadialSimulation();
  pickedOrigin = null;
  radarOriginLabel.textContent = '— clic en el mapa —';
  btnRunRadial.disabled = true;
});
