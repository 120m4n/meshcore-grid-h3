// Copia de MeshCore (120m4n/MeshCore-HJ7RMN @ 373afbac), tools/tv_edge_ext/tabs.ts.
// Diferencias: import del decoder desde ./decoder.ts (extensión explícita para poder correr check.mjs en Node).
// Resincronizar copiando de ahí y reaplicando las diferencias indicadas.
// tabs.ts -- parseo de las líneas pegadas: una pestaña por línea válida (pura, sin DOM).
import { decodeVector, TvParseError } from "./decoder.ts";
import type { TvSample } from "./decoder.ts";

export const MAX_TABS = 6;

export interface Tab { line: number; kind: string; samples: TvSample[] } // line = nº de línea (1-based)

// Una línea = una página. Tolera prefijos tipo "-> ": toma el token más largo
// del alfabeto del vector (base64url + "." y "~").
const vectorOf = (line: string) =>
  (line.match(/[A-Za-z0-9_.~-]+/g) ?? []).reduce((a, b) => (b.length > a.length ? b : a), "");

// Pestaña «Todas»: junta las líneas del mismo sensor, ordenadas por epoch y sin duplicados
// (las páginas tv 0 / tv N pueden solaparse). null si hay <2 pestañas o sensores mezclados.
export function mergeTabs(tabs: Tab[]): Tab | null {
  if (tabs.length < 2 || tabs.some((t) => t.kind !== tabs[0].kind)) return null;
  const byEpoch = new Map<number, TvSample>();
  for (const t of tabs) for (const s of t.samples) byEpoch.set(s.epochMin, s);
  return { line: 0, kind: tabs[0].kind, samples: [...byEpoch.values()].sort((a, b) => a.epochMin - b.epochMin) };
}

// Válida = decodifica y trae >=1 registro. Las vacías y "-" se ignoran; las que fallan van a errors;
// las válidas por encima de max se cuentan en skipped.
export function parseLines(text: string, max = MAX_TABS) {
  const tabs: Tab[] = [], errors: string[] = [];
  let skipped = 0;
  text.split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const r = decodeVector(vectorOf(l));
      if (!r.samples.length) return;
      if (tabs.length < max) tabs.push({ line: i + 1, ...r });
      else skipped++;
    } catch (e) {
      if (!(e instanceof TvParseError)) throw e;
      errors.push(`línea ${i + 1}: ${e.message}`);
    }
  });
  return { tabs, errors, skipped };
}
