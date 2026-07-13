import { OpenLocationCode } from 'open-location-code';
import { showToast } from '../toast.ts';

const olc = new OpenLocationCode();

export async function copyReportMessage(lat: number, lng: number) {
  const message = `Reportar ${olc.encode(lat, lng, 10)}`;
  try {
    await navigator.clipboard.writeText(message);
    showToast(`Copiado al portapapeles: ${message}`);
  } catch {
    showToast('No se pudo copiar al portapapeles', 'error');
  }
}
