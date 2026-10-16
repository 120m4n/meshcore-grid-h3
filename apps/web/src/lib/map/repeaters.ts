import L from 'leaflet';
import { repeatersLayer } from './setup.ts';
import { parseRepeaters } from './repeatersParse.ts';

// Ruta relativa a la raíz web: en Docker es el volumen montado en
// /usr/share/nginx/html/data; en dev, apps/web/public/data/.
const URL_REPEATERS = '/data/MeshAzimuth-repetidores.json';

const ANTENNA_SVG = `<svg viewBox="0 0 40 52" width="40" height="52" aria-hidden="true">
  <defs><linearGradient id="rp-g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#4f8df5"/><stop offset="1" stop-color="#1f56c4"/></linearGradient></defs>
  <path d="M20 50 L14 36 A17 17 0 1 1 26 36 Z" fill="url(#rp-g)" stroke="#1d2433" stroke-width="3" stroke-linejoin="round"/>
  <g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">
    <path d="M13 15a9 9 0 0 0 0 10"/><path d="M27 15a9 9 0 0 1 0 10"/>
    <path d="M16.5 17a4.5 4.5 0 0 0 0 6"/><path d="M23.5 17a4.5 4.5 0 0 1 0 6"/>
    <path d="M20 21v9"/></g>
  <circle cx="20" cy="20" r="2" fill="#fff"/></svg>`;

function iconFor(name: string, hash: string): L.DivIcon {
  const el = document.createElement('div');
  el.className = 'rp-marker';
  el.innerHTML = ANTENNA_SVG; // constante, sin datos del archivo
  const label = document.createElement('div');
  label.className = 'rp-label';
  const n = document.createElement('span');
  n.textContent = name; // textContent: el JSON es externo
  const h = document.createElement('span');
  h.textContent = hash;
  label.append(n, h);
  el.append(label);
  return L.divIcon({ html: el, className: 'rp-icon', iconSize: [40, 52], iconAnchor: [20, 50], popupAnchor: [0, -46] });
}

// Nunca lanza: sin archivo, sin carpeta o con formato inválido el mapa
// sigue igual, solo sin la capa.
export async function loadRepeaters(): Promise<void> {
  try {
    const res = await fetch(URL_REPEATERS, { cache: 'no-cache' });
    if (!res.ok) {
      console.info(`Repetidoras: ${URL_REPEATERS} no disponible (${res.status})`);
      return;
    }
    const parsed = parseRepeaters(await res.json());
    if (!parsed) {
      console.warn('Repetidoras: formato inválido (se esperaba un array)');
      return;
    }
    if (parsed.skipped) console.warn(`Repetidoras: ${parsed.skipped} ítem(s) inválido(s) descartado(s)`);
    repeatersLayer.clearLayers();
    L.geoJSON(parsed.fc as unknown as GeoJSON.FeatureCollection, {
      pointToLayer: (f, latlng) => {
        const { name, hashPrefix } = f.properties as { name: string; hashPrefix: string };
        const m = L.marker(latlng, { icon: iconFor(name, hashPrefix), title: `${name} (${hashPrefix})` });
        const pop = document.createElement('div');
        const s = document.createElement('strong');
        s.textContent = name;
        pop.append(s, document.createElement('br'),
          `Hash: ${hashPrefix}`, document.createElement('br'),
          `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);
        return m.bindPopup(pop);
      },
    }).eachLayer((l) => repeatersLayer.addLayer(l));
  } catch (e) {
    console.warn('Repetidoras: no se pudo cargar', e);
  }
}
