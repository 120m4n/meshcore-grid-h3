// Copia de MeshCore (120m4n/MeshCore-HJ7RMN @ 5b578581), tools/tv_decoder/tv_decoder.ts.
// Diferencias: sin main()/CLI, V0_HINT sin el comando git, y además acepta v1
// (deprecado, devuelve `version` para avisar) con hValue() que convierte H según versión.
// Resincronizar copiando de ahí y reaplicando las diferencias indicadas.
// tv_decoder.ts -- decodifica vectores v3 del comando `tv <since>` de
// MeshCore (formato compacto base64url, ver encode() en
// src/helpers/tv_telemetry.h y README_TV_TELEMETRY.md). Sin dependencias.
//
// El header del vector dice qué sensor tiene el nodo: con BME280 la columna H
// es %RH; con BMP280 es presión escalada (hPa - 545) / 2 y se muestra en hPa.
//
// Vectores del formato viejo ("T,H,t;dT,dH,dt;...") se rechazan: usar el
// decoder anterior desde git (ver V0_HINT).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INTERVAL_MIN = 30;
const FORMAT_VERSION = 3;
export const DEPRECATED_VERSION = 1; // ponytail: v1 se acepta solo con aviso; quitar cuando no queden nodos v1
const KINDS: Record<number, string> = { 1: "BME280", 2: "BMP280" };
// BMP280: v3 lleva (hPa-545)/2 (hpa_code() en tv_telemetry.h); v1 llevaba hPa-800.
export const hValue = (kind: string, version: number, h: number) =>
  kind !== "BMP280" ? h : version === DEPRECATED_VERSION ? h + 800 : h * 2 + 545;
const V0_HINT = 'vector en formato viejo v0 ("T,H,t;..."): este decoder solo soporta el formato v3 (base64url)';

export interface TvSample {
  epochMin: number; // minutos desde epoch, UTC
  date: Date;        // el mismo instante como Date
  tempC: number;      // °C con 1 decimal
  hRaw: number;        // %RH (BME280) o presión codificada (BMP280), ver hValue()
}

export class TvParseError extends Error {}

const unzigzag = (u: number) => (u >>> 1) ^ -(u & 1);

// Devuelve el sensor ("BME280", "BMP280" o "" si vacío) y las muestras.
export function decodeVector(s: string): { kind: string; version: number; samples: TvSample[] } {
  const v = s.trim();
  if (v === "" || v === "-") return { kind: "", version: FORMAT_VERSION, samples: [] };
  if (v.includes(",")) throw new TvParseError(V0_HINT);

  let pos = 0;
  const take = (n: number): number => {
    if (pos + n > v.length) throw new TvParseError("vector truncado");
    let val = 0;
    for (let i = 0; i < n; i++) {
      const d = B64.indexOf(v[pos + i]);
      if (d < 0) throw new TvParseError(`carácter inválido "${v[pos + i]}" en posición ${pos + i}`);
      val = val * 64 + d; // sin << para no desbordar 32 bits con signo
    }
    pos += n;
    return val;
  };

  const head = take(1);
  const kind = KINDS[head & 3], version = head >> 2;
  if ((version !== FORMAT_VERSION && version !== DEPRECATED_VERSION) || !kind) {
    throw new TvParseError(`header desconocido "${v[0]}" (versión ${head >> 2})`);
  }
  const count = take(2);
  const e0 = take(5);
  let t = unzigzag(take(2));
  let h = take(2);
  const recs: [number, number, number][] = [[e0, t, h]];
  let slot = Math.floor(e0 / INTERVAL_MIN);

  while (pos < v.length) {
    const c = v[pos];
    if (c === ".") {
      pos++;
      slot += take(1);
      continue;
    }
    if (c === "~" || c === "!") {
      pos++;
      t = unzigzag(take(2));
      h = take(2);
    } else {
      t += unzigzag(take(1));
      h += unzigzag(take(1));
    }
    slot++;
    recs.push([slot * INTERVAL_MIN, t, h]);
  }

  if (recs.length !== count) {
    throw new TvParseError(`se esperaban ${count} registros y llegaron ${recs.length}: vector truncado`);
  }

  const samples = recs.map(([e, t, h], i) => {
    if (h < 0 || h > 255) throw new TvParseError(`registro ${i}: H fuera de rango (${h})`);
    return { epochMin: e, date: new Date(e * 60_000), tempC: t / 10, hRaw: h };
  });
  return { kind, version, samples };
}
