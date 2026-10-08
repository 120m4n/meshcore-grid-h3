// Chequeo de la copia de MeshCore: node apps/web/src/lib/tv/check.mjs
// Los vectores de ejemplo son los mismos con los que se validó en tools/tv_edge_ext/check.mjs.
import { decodeVector } from "./decoder.ts";
import { extremes, mean, niceTicks, segments } from "./chart.ts";
import { mergeTabs, parseLines } from "./tabs.ts";

const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error("FAIL", msg, a, b); process.exit(1); } };
const BME5 = "FAFBx1KKIuA3CCCBDC.C~BFA8";
const BMP1 = "GABBtFfMIUBj", BMP20 = "GAUBx23tIkBkDADABAABAACAFCBBEAAAEACBECCABACCFADAAA";

const d = decodeVector(BME5);
eq([d.kind, d.samples.map((s) => s.epochMin)], ["BME280", [29840010, 29840040, 29840070, 29840100, 29840190]], "decodeVector");
eq(decodeVector("-").samples.length, 0, "vector vacío");

eq(niceTicks(0, 100), [0, 50, 100], "niceTicks");
eq(mean([1, 2, 6]), 3, "mean");
eq(segments([{ x: 0, y: 1 }, { x: 30, y: 1 }, { x: 90, y: 1 }, { x: 120, y: 1 }]).map((s) => s.length), [2, 2], "segments");
eq(extremes([{ x: 0, y: 3 }, { x: 30, y: 3 }]), null, "extremes plano");

const txt = [BMP1, "", "-", "FAFBx1KKIuA3CCCB", BMP20, BME5].join("\n");
let p = parseLines(txt);
eq(p.tabs.map((t) => [t.line, t.samples.length, t.kind]), [[1, 1, "BMP280"], [5, 20, "BMP280"], [6, 5, "BME280"]], "tabs");
eq([p.errors.length, p.errors[0].startsWith("línea 4:"), p.skipped], [1, true, 0], "error parcial");
eq(parseLines(txt, 2).skipped, 1, "límite de tabs");
const t20 = parseLines(BMP20).tabs[0], t1 = parseLines(BMP1).tabs[0];
eq(mergeTabs([t20, t20]).samples.length, 20, "mergeTabs dedup");
eq([mergeTabs([t20, t1]).samples.length, mergeTabs([t20]), mergeTabs([t20, parseLines(BME5).tabs[0]])], [21, null, null], "mergeTabs reglas");
// Marcador de resync "!" (MeshCore >= v1.4.5; antes "~"): ambos deben decodificar igual.
const BMP_BANG = "GAwBx4-2H4BkDAAADBBABACAFAGBDAAACAAALACABCFAFCAAIAKCQAWAUAEASBIAEARBGBAAeEPBHABBLAJAAAFAACaGQEICAAHAFV!IwA2jC";
eq(decodeVector(BMP_BANG).samples.length, 48, "vector con !");
eq(decodeVector(BMP_BANG), decodeVector(BMP_BANG.replace("!", "~")), "! == ~");
console.log("ok: decoder, chart y tabs");
