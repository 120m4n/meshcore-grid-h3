// Clima en la ubicación del usuario (Open-Meteo, sin API key) + mensaje
// copiable. Pública: no usa api.ts ni token. Anti-abuso, todo en cliente
// (la API de Open-Meteo es de terceros; no pasa por nuestro backend):
// bloqueo de reentrada, cooldown y tope por hora persistidos en
// localStorage, caché por celda de ~1 km, timeout y validación de la
// respuesta.
// ponytail: límites en cliente, un usuario que borre localStorage los
// evade; Open-Meteo aplica su propio rate-limit por IP. Si hiciera falta
// forzarlo, proxy en apps/api con límite por IP.

import { showToast } from './toast';

const COOLDOWN_MS = 30_000;
const MAX_PER_HOUR = 10;
const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;
const KEY = 'meshcore-web.clima';

interface State { hits: number[]; cache?: { k: string; at: number; msg: string } }

const load = (): State => {
  try { return { hits: [], ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; }
  catch { return { hits: [] }; }
};
const save = (s: State) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

function decodeWMO(c: number): string {
  if (c === 0) return 'Cielo despejado ☀️';
  if (c >= 1 && c <= 3) return 'Parcialmente nublado ⛅';
  if (c >= 45 && c <= 48) return 'Neblina 🌫️';
  if (c >= 51 && c <= 67) return 'Lluvia / Llovizna 🌧️';
  if (c >= 71 && c <= 77) return 'Nieve ❄️';
  if (c >= 95) return 'Tormenta eléctrica 🌩️';
  return 'Tiempo variable 🌡️';
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btnFetch = $<HTMLButtonElement>('btn-fetch');
const btnCopy = $<HTMLButtonElement>('btn-copy');
const statusEl = $('status');
const outputEl = $('output');
const previewEl = $('preview');

let busy = false;
let message = '';
let cooldownTimer: number | undefined;

function startCooldown(until: number) {
  clearInterval(cooldownTimer);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(cooldownTimer);
      btnFetch.disabled = false;
      btnFetch.textContent = 'Obtener clima y generar mensaje';
      return;
    }
    btnFetch.disabled = true;
    btnFetch.textContent = `Espera ${left}s…`;
  };
  tick();
  cooldownTimer = window.setInterval(tick, 1000);
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((ok, fail) =>
    navigator.geolocation.getCurrentPosition(ok, fail, { timeout: TIMEOUT_MS, maximumAge: 60_000 }));
}

function show(msg: string) {
  message = msg;
  previewEl.textContent = msg;
  outputEl.hidden = false;
}

async function run() {
  if (busy) return;
  if (!navigator.geolocation) { statusEl.textContent = 'Tu navegador no soporta geolocalización.'; return; }

  const now = Date.now();
  const st = load();
  st.hits = st.hits.filter((t) => now - t < 3_600_000);
  const last = st.hits[st.hits.length - 1] ?? 0;
  if (now - last < COOLDOWN_MS) { startCooldown(last + COOLDOWN_MS); return; }
  if (st.hits.length >= MAX_PER_HOUR) {
    statusEl.textContent = `Límite de ${MAX_PER_HOUR} consultas por hora alcanzado. Intenta más tarde.`;
    return;
  }

  busy = true;
  btnFetch.disabled = true;
  try {
    statusEl.textContent = 'Solicitando ubicación...';
    const { latitude, longitude } = (await getPosition()).coords;
    const lat = +latitude.toFixed(2); // ~1 km: privacidad y clave de caché
    const lon = +longitude.toFixed(2);
    const k = `${lat},${lon}`;

    if (st.cache?.k === k && now - st.cache.at < CACHE_MS) {
      show(st.cache.msg);
      statusEl.textContent = 'Datos recientes (caché).';
      return;
    }

    statusEl.textContent = 'Consultando datos del clima...';
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cw = (await res.json())?.current_weather;
    if (!Number.isFinite(cw?.temperature) || !Number.isFinite(cw?.weathercode)) {
      throw new Error('respuesta inválida');
    }

    const msg = `📍 Coordenadas: ${lat}, ${lon}\n🌡️ Temperatura: ${Math.round(cw.temperature)}°C\n🌤️ Estado: ${decodeWMO(cw.weathercode)}`;
    st.hits.push(Date.now()); // solo cuentan las consultas reales a la API
    st.cache = { k, at: Date.now(), msg };
    save(st);
    show(msg);
    statusEl.textContent = '¡Datos actualizados!';
  } catch (e) {
    statusEl.textContent = `Error: ${(e as Error).message}`;
  } finally {
    busy = false;
    startCooldown(Math.max(Date.now() + 2_000, (load().hits.at(-1) ?? 0) + COOLDOWN_MS));
  }
}

btnFetch.addEventListener('click', run);
btnCopy.addEventListener('click', async () => {
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message);
    modal.close(); // el toast queda tapado mientras el modal está abierto
    showToast('Mensaje copiado al portapapeles');
  } catch {
    statusEl.textContent = 'No se pudo copiar.';
  }
});

// Cooldown vigente tras recargar la página.
const lastHit = load().hits.at(-1) ?? 0;
if (Date.now() - lastHit < COOLDOWN_MS) startCooldown(lastHit + COOLDOWN_MS);

const modal = $<HTMLDialogElement>('clima-modal');
$('btn-clima').addEventListener('click', () => modal.showModal());
$('btn-clima-close').addEventListener('click', () => modal.close());
modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); }); // clic en el backdrop
