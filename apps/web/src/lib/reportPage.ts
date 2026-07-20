import L from 'leaflet';
// ?url fuerza a Vite a devolver la URL cruda como string — sin el
// sufijo, el plugin de assets de Astro envuelve el import en un objeto
// {src, width, height, ...} y Leaflet termina pidiendo "[object Object]".
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png?url';
import markerIcon from 'leaflet/dist/images/marker-icon.png?url';
import markerShadow from 'leaflet/dist/images/marker-shadow.png?url';
import { createReport } from './api.ts';
import { CENTER, SANTANDER_BOUNDS, MIN_ZOOM, MAX_ZOOM } from './mapBounds.ts';
import { showToast } from './toast.ts';

// Vite reescribe las rutas de assets al bundlear — el _getIconUrl por
// defecto de Leaflet asume rutas relativas al HTML servido y rompe en
// build (404 de marker-icon-2x.png/marker-shadow.png). Se reconfigura
// con las URLs ya resueltas por el bundler.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

if (!localStorage.getItem('token')) {
  window.location.href = '/login';
}

const MESSAGE_MAX = 120;

const latInput = document.getElementById('lat') as HTMLInputElement;
const lonInput = document.getElementById('lon') as HTMLInputElement;

// ============ toggle entre los 3 métodos de ubicación ============
const radios = document.querySelectorAll<HTMLInputElement>('input[name="input_method"]');
function currentMethod(): string {
  return document.querySelector<HTMLInputElement>('input[name="input_method"]:checked')!.value;
}
function syncFieldVisibility() {
  const method = currentMethod();
  document.getElementById('coords-fields')!.hidden = method !== 'coords';
  document.getElementById('pluscode-fields')!.hidden = method !== 'pluscode';
  document.getElementById('mapclick-fields')!.hidden = method !== 'mapclick';
  if (method === 'mapclick') ensurePickerMap();
}
radios.forEach((r) => r.addEventListener('change', syncFieldVisibility));

document.getElementById('btn-geo')!.addEventListener('click', () => {
  navigator.geolocation.getCurrentPosition((pos) => {
    latInput.value = String(pos.coords.latitude);
    lonInput.value = String(pos.coords.longitude);
  });
});

// pegar "lat,lon" en el campo de latitud separa ambos valores en sus
// respectivos campos, en vez de dejar el texto crudo en un input numérico.
const LAT_LON_PASTE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;
latInput.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text')?.trim();
  if (!text) return;
  const match = text.match(LAT_LON_PASTE);
  if (!match) return;
  e.preventDefault();
  latInput.value = match[1];
  lonInput.value = match[2];
});

// ============ mini-mapa "clic en el mapa" (carga perezosa) ============
let pickerMap: L.Map | null = null;
let pickerMarker: L.Marker | null = null;

function ensurePickerMap() {
  if (pickerMap) return;
  pickerMap = L.map('map-picker', {
    center: CENTER,
    zoom: 11,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    maxBounds: SANTANDER_BOUNDS,
    maxBoundsViscosity: 1.0,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
  }).addTo(pickerMap);

  pickerMap.on('click', (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;
    latInput.value = String(lat);
    lonInput.value = String(lng);
    if (pickerMarker) {
      pickerMarker.setLatLng(e.latlng);
    } else {
      pickerMarker = L.marker(e.latlng).addTo(pickerMap!);
    }
    const confirm = document.getElementById('picker-confirm')!;
    confirm.textContent = `Ubicación seleccionada: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });

  // el contenedor estaba oculto (display:none) al crear el mapa —
  // Leaflet mide el tamaño mal en ese caso, hay que recalcular.
  setTimeout(() => pickerMap!.invalidateSize(), 0);
}

// ============ contador de caracteres de la observación ============
const messageInput = document.getElementById('message') as HTMLTextAreaElement;
const messageCount = document.getElementById('message-count')!;
function updateMessageCount() {
  messageCount.textContent = `${messageInput.value.length}/${MESSAGE_MAX}`;
}
messageInput.addEventListener('input', updateMessageCount);
updateMessageCount();

// ============ submit ============
const submitBtn = document.querySelector<HTMLButtonElement>('#report-form button[type="submit"]')!;
const submitLabel = submitBtn.textContent!;

document.getElementById('report-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const method = currentMethod();

  if (method === 'mapclick' && (!latInput.value || !lonInput.value)) {
    showToast('Hacé clic en el mini-mapa para elegir la ubicación.', 'error');
    return;
  }

  const displayName = (document.getElementById('reporter_display_name') as HTMLInputElement).value.trim();

  const payload: Parameters<typeof createReport>[0] = {
    signal_quality: (document.getElementById('signal_quality') as HTMLSelectElement).value,
    message: messageInput.value,
  };
  if (displayName) payload.reporter_display_name = displayName;

  if (method === 'pluscode') {
    payload.plus_code = (document.getElementById('plus_code') as HTMLInputElement).value;
  } else {
    payload.lat = parseFloat(latInput.value);
    payload.lon = parseFloat(lonInput.value);
  }

  submitBtn.disabled = true;
  submitBtn.setAttribute('aria-busy', 'true');
  submitBtn.textContent = 'Enviando…';
  try {
    await createReport(payload);
    showToast('Reporte enviado. Pendiente de aprobación.', 'success');
    (document.getElementById('report-form') as HTMLFormElement).reset();
    syncFieldVisibility();
    updateMessageCount();
  } catch (err: any) {
    showToast(err.message || 'No se pudo enviar el reporte.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.removeAttribute('aria-busy');
    submitBtn.textContent = submitLabel;
  }
});
