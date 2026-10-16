import L from 'leaflet';
import { map, tempPointsLayer } from './setup.ts';
import { snapToRepeater, isMeasuring } from './measureTools.ts';

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

// Un solo punto temporal, compartido por "Ir a coordenadas", pulsación
// larga (touch) y shift+click. Si cae a pocos px de una repetidora
// visible, se ajusta a sus coordenadas exactas.
export function setTempPoint(latlng: L.LatLng): void {
  const at = snapToRepeater(latlng) ?? latlng;
  tempPointsLayer.clearLayers();
  L.circleMarker(at, {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#e67e22',
    fillOpacity: 0.9,
    interactive: false,
  }).addTo(tempPointsLayer);
}

// Para los handlers de click de polígonos (que detienen la propagación
// y no llegan a map.on('click')): true si era shift+click y ya se atendió.
export function handleShiftClick(e: L.LeafletMouseEvent): boolean {
  if (!e.originalEvent.shiftKey || isMeasuring()) return false;
  setTempPoint(e.latlng);
  return true;
}

export function initTempPoints(): void {
  map.on('click', (e: L.LeafletMouseEvent) => {
    handleShiftClick(e);
  });

  // Pulsación larga: Leaflet 1.9 no la emite, y iOS Safari tampoco manda
  // 'contextmenu' — se detecta a mano con touch events.
  const el = map.getContainer();
  let timer: number | undefined;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  const cancel = () => {
    window.clearTimeout(timer);
    start = null;
  };

  el.addEventListener('touchstart', (e) => {
    fired = false;
    cancel();
    if (e.touches.length !== 1 || isMeasuring()) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = window.setTimeout(() => {
      if (!start) return;
      fired = true;
      setTempPoint(map.mouseEventToLatLng({ clientX: start.x, clientY: start.y } as MouseEvent));
      navigator.vibrate?.(30);
      start = null;
    }, LONG_PRESS_MS);
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (start && (e.touches.length > 1 ||
        Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_TOLERANCE_PX)) cancel();
  }, { passive: true });

  el.addEventListener('touchend', () => {
    cancel();
    if (!fired) return;
    // El click sintético tras soltar no debe llegar al mapa (crearía una
    // celda de prueba o abriría un popup): se absorbe en captura.
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    el.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => el.removeEventListener('click', swallow, true), 600);
  });

  // Android Chrome emite 'contextmenu' tras la pulsación larga.
  el.addEventListener('contextmenu', (e) => { if (fired) e.preventDefault(); });
}
