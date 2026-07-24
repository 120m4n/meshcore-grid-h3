import { loadCells } from './map/realCells.ts';
import { initTestMode, toggleTestMode } from './map/testCells.ts';
import { initCoordSearch } from './map/coordSearch.ts';
import { isTestModeEnabled } from './map/state.ts';
import { showToast } from './toast.ts';
import {
  enableOriginPicking,
  runRadialSimulation,
  cancelRadialSimulation,
  clearRadialSimulation,
  estimateTotalPoints,
} from './map/radialSimulation.ts';
import { activateRuler, activateArc, clearAllMeasurements } from './map/measureTools.ts';

const token = localStorage.getItem('token');
// admin siempre tiene modo prueba; un usuario normal lo desbloquea
// aceptando geolocalización (ver btn-enable-test más abajo).
const isAdmin = localStorage.getItem('role') === 'admin';

initTestMode(isAdmin);
initCoordSearch();

document.addEventListener('mc-tool-toggle', (e: Event) => {
  const { tool } = (e as CustomEvent<{ tool: 'ruler' | 'arc' | 'eraser' }>).detail;
  if (tool === 'ruler') activateRuler();
  else if (tool === 'arc') activateArc();
  else clearAllMeasurements();
});

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
const radarProgress = document.getElementById('radar-progress') as HTMLDivElement;
const radarProgressFill = document.getElementById('radar-progress-fill') as HTMLDivElement;
const radarProgressLabel = document.getElementById('radar-progress-label') as HTMLSpanElement;

// Tasa asumida para estimar el % de avance mostrado en el cliente — el
// endpoint es síncrono y no reporta avance real (ver spec kit, decisión
// de diseño 2). Debe aproximar DEM_MAX_REQUESTS_PER_SEC del backend
// (infra/docker-compose.yml); si ese valor cambia, ajustar acá también
// para que la estimación no se aleje demasiado del tiempo real.
const ASSUMED_REQUESTS_PER_SEC = 40;

let simulationRunning = false;

function setOriginLabel(lat: number, lon: number) {
  radarOriginLabel.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// Refleja simulationRunning en el botón: ▶ Simular (idle, btn-secondary,
// habilitado solo si ya hay origen) ⇄ ⏹ Detener (corriendo, btn-danger —
// reusa el token de color de alerta para marcar "esto ahora cancela",
// siempre habilitado mientras corre para poder cancelar).
function syncRunButton() {
  if (simulationRunning) {
    btnRunRadial.textContent = '⏹ Detener';
    btnRunRadial.classList.remove('btn-secondary');
    btnRunRadial.classList.add('btn-danger');
    btnRunRadial.disabled = false;
  } else {
    btnRunRadial.textContent = '▶ Simular';
    btnRunRadial.classList.remove('btn-danger');
    btnRunRadial.classList.add('btn-secondary');
    btnRunRadial.disabled = !pickedOrigin;
  }
  btnPickOrigin.disabled = simulationRunning;
}
syncRunButton(); // estado inicial — idempotente con el HTML estático de index.astro

btnPickOrigin.addEventListener('click', () => {
  showToast('Hacé clic en el mapa para fijar el origen');
  enableOriginPicking((lat, lon) => {
    pickedOrigin = { lat, lon };
    setOriginLabel(lat, lon);
    syncRunButton();
  });
});

btnRunRadial.addEventListener('click', async () => {
  if (simulationRunning) {
    cancelRadialSimulation();
    return;
  }
  if (!pickedOrigin) return;

  const heightM = Number((document.getElementById('radar-height') as HTMLInputElement).value);
  const angleStepDeg = Number((document.getElementById('radar-angle-step') as HTMLInputElement).value);
  const maxDistanceM = Number((document.getElementById('radar-max-distance') as HTMLInputElement).value);
  const sampleStepM = Number((document.getElementById('radar-sample-step') as HTMLInputElement).value);
  const startAngleDeg = Number((document.getElementById('radar-start-angle') as HTMLInputElement).value);
  const endAngleDeg = Number((document.getElementById('radar-end-angle') as HTMLInputElement).value);

  // Validado acá, antes de llamar al backend, para no disparar una
  // request que se va a rechazar igual (validate.go tiene la misma
  // regla como defensa en profundidad, no como primera línea).
  if (
    Number.isNaN(startAngleDeg) || Number.isNaN(endAngleDeg) ||
    startAngleDeg < 0 || startAngleDeg > 360 ||
    endAngleDeg < 0 || endAngleDeg > 360 ||
    endAngleDeg <= startAngleDeg
  ) {
    showToast('Frente de onda inválido: el ángulo final debe ser mayor que el inicial, ambos entre 0 y 360', 'error');
    return;
  }

  // El ancho del frente de onda tiene que alcanzar al menos para un
  // paso angular completo — con un ancho menor que angle_step_deg el
  // barrido termina siendo un solo rayo parado en start_angle_deg, sin
  // llegar nunca a end_angle_deg (ver Simulator.Run: rayCount =
  // ceil(ancho/paso)). Se corta acá antes de llamar al backend, mismo
  // criterio que el resto de esta validación.
  const wavefrontWidthDeg = endAngleDeg - startAngleDeg;
  if (wavefrontWidthDeg < angleStepDeg) {
    showToast(
      `Frente de onda inválido: el ancho (${wavefrontWidthDeg}°) debe ser mayor o igual al paso angular (${angleStepDeg}°)`,
      'error'
    );
    return;
  }

  const totalPoints = estimateTotalPoints(startAngleDeg, endAngleDeg, angleStepDeg, maxDistanceM, sampleStepM);
  const estimatedMs = (totalPoints / ASSUMED_REQUESTS_PER_SEC) * 1000;

  simulationRunning = true;
  syncRunButton();
  showToast(`Simulación iniciada — ${totalPoints} muestras`);

  radarProgress.hidden = false;
  radarProgressFill.style.width = '0%';
  radarProgressLabel.textContent = 'Simulando… ~0% (estimado)';
  const startedAt = Date.now();
  const progressTimer = window.setInterval(() => {
    const pct = Math.min(99, Math.round(((Date.now() - startedAt) / estimatedMs) * 100));
    radarProgressFill.style.width = `${pct}%`;
    radarProgressLabel.textContent = `Simulando… ~${pct}% (estimado)`;
  }, 300);

  const outcome = await runRadialSimulation({
    origin_lat: pickedOrigin.lat,
    origin_lon: pickedOrigin.lon,
    origin_height_m: heightM,
    angle_step_deg: angleStepDeg,
    max_distance_m: maxDistanceM,
    sample_step_m: sampleStepM,
    earth_curvature: true,
    start_angle_deg: startAngleDeg,
    end_angle_deg: endAngleDeg,
  });

  window.clearInterval(progressTimer);
  if (outcome === 'ok') {
    radarProgressFill.style.width = '100%';
    radarProgressLabel.textContent = 'Listo';
  } else {
    radarProgressFill.style.width = '0%';
    radarProgressLabel.textContent = outcome === 'aborted' ? 'Simulación detenida' : 'Simulación falló';
    if (outcome === 'aborted') showToast('Simulación detenida');
  }
  setTimeout(() => {
    radarProgress.hidden = true;
  }, 600);

  simulationRunning = false;
  syncRunButton();
});

btnClearRadial.addEventListener('click', () => {
  cancelRadialSimulation();
  clearRadialSimulation();
  pickedOrigin = null;
  radarOriginLabel.textContent = '— clic en el mapa —';
  syncRunButton();
});
