// El backend guarda fechas en UTC pero las serializa como
// "YYYY-MM-DD HH:MM:SS" (sin 'Z' ni offset) — un formato no-ISO que los
// navegadores parsean como hora LOCAL en vez de UTC, corriendo la hora
// mostrada por el offset del cliente. Este helper normaliza el string a
// ISO 8601 antes de parsear (asume UTC si no trae ya zona explícita) y
// siempre formatea en America/Bogota, sin depender de la zona del
// navegador.
export function parseUtcDate(value: string): Date {
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(value);
  const isoValue = hasTimezone ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(isoValue);
}

export function formatDateTimeBogota(value: string): string {
  return parseUtcDate(value).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
}
