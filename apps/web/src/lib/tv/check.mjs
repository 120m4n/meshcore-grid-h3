// Chequeo de la copia de MeshCore: node apps/web/src/lib/tv/check.mjs
// Los vectores de ejemplo son los mismos con los que se validó en tools/tv_edge_ext/check.mjs.
import { decodeVector, hValue } from "./decoder.ts";
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
// v3: mismo cuerpo, header N (BME280) / O (BMP280); H de BMP280 = h*2+545.
const v3 = decodeVector("N" + BME5.slice(1)), v1 = decodeVector(BME5);
eq([v3.version, v1.version, v3.samples], [3, 1, v1.samples], "v3 y v1 deprecado");
eq([hValue("BMP280", 3, 230), hValue("BMP280", 1, 213), hValue("BME280", 3, 55)], [1005, 1013, 55], "hValue");
const pv = parseLines(["O" + BMP20.slice(1), BMP20].join("\n"));
eq([pv.tabs.map((t) => t.version), mergeTabs(pv.tabs)], [[3, 1], null], "no mezcla v1 con v3");
let bad = null; try { decodeVector("J" + BME5.slice(1)); } catch (e) { bad = e.message; }
eq(bad?.startsWith("header desconocido"), true, "v2 rechazada");
console.log("ok: decoder, chart y tabs");
