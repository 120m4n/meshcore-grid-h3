// tvPage.ts -- página pública /decoder: una pestaña por línea válida. Port de tools/tv_edge_ext/popup.ts
// (MeshCore @ 5824e828); diferencias: imports desde ./tv/ y clave de preferencias propia.
import { MAX_TABS, mergeTabs, parseLines, type Tab } from "./tv/tabs";
import { renderCharts } from "./tv/chart";
import { showToast } from "./toast";

const BMP_OFFSET_HPA = 800;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Preferencias de la página: localStorage puede no estar disponible (modo privado).
const PREFS = "meshcore-web.tv-decoder.prefs";
const loadPrefs = (): { charts?: boolean; local?: boolean } => {
  try { return JSON.parse(localStorage.getItem(PREFS) ?? "{}"); } catch { return {}; }
};
const savePrefs = () => {
  try { localStorage.setItem(PREFS, JSON.stringify({ charts: showCharts, local: $<HTMLInputElement>("local").checked })); } catch {}
};

let showCharts = loadPrefs().charts ?? true;
let tabs: Tab[] = []; // pestañas de líneas + «Todas» al final si aplica
let active = 0;
let errors: string[] = [];
let skipped = 0;
let rows: string[][] = [];
let header: string[] = [];

// Muestra u oculta un banner (err/warn) con su texto.
const banner = (id: string, text = "") => {
  $(id).textContent = text;
  $(id).hidden = !text;
};

function copy(text: string, btn: HTMLElement) {
  navigator.clipboard.writeText(text);
  const label = btn.textContent;
  btn.textContent = "Copiado ✓";
  setTimeout(() => (btn.textContent = label), 1200);
}

function decode() {
  let lines: Tab[];
  ({ tabs: lines, errors, skipped } = parseLines($<HTMLTextAreaElement>("in").value));
  const all = mergeTabs(lines);
  tabs = all ? [...lines, all] : lines;
  active = 0;
  $("empty").hidden = true;
  render();
}

function render() {
  const bar = $("tabs");
  bar.replaceChildren();
  $("charts").replaceChildren();
  rows = [];
  $("info").hidden = true;
  $("panel").hidden = true;
  $<HTMLButtonElement>("csv").disabled = true;

  const warns: string[] = [];
  if (skipped) warns.push(`Se muestran ${tabs.length} de ${tabs.length + skipped} líneas válidas (máx. ${MAX_TABS}).`);
  if (!tabs.length && !errors.length) warns.push("No hay líneas válidas con datos.");
  banner("err", errors.join("\n"));
  if (!tabs.length) return banner("warn", warns.join("\n"));

  bar.hidden = tabs.length < 2;
  tabs.forEach((t, i) => {
    const b = document.createElement("button");
    b.role = "tab";
    b.textContent = `${t.line ? `L${t.line}` : "Todas"} · ${t.samples.length} reg`;
    b.setAttribute("aria-selected", String(i === active));
    b.tabIndex = i === active ? 0 : -1;
    b.addEventListener("click", () => select(i));
    bar.appendChild(b);
  });

  const { kind, samples } = tabs[active];
  const bmp = kind === "BMP280", local = $<HTMLInputElement>("local").checked;
  const hVal = (h: number) => (bmp ? h + BMP_OFFSET_HPA : h);
  if (showCharts && samples.length < 2) warns.push("Se necesitan al menos 2 puntos para graficar.");
  banner("warn", warns.join("\n"));

  $("info").textContent = `${kind} · ${samples.length} registro${samples.length === 1 ? "" : "s"}`;
  $("info").hidden = false;
  header = ["#", "T (°C)", bmp ? "Presión (hPa)" : "%RH", "epoch_min", local ? "Local" : "UTC"];
  rows = samples.map((s, i) => [
    String(i),
    s.tempC.toFixed(1),
    String(hVal(s.hRaw)),
    String(s.epochMin),
    local
      ? s.date.toLocaleString("sv-SE")
      : s.date.toISOString().replace("T", " ").replace(".000Z", "Z"),
  ]);
  const tbl = $<HTMLTableElement>("tbl");
  tbl.tHead!.innerHTML = "<tr>" + header.map((h) => `<th>${h}</th>`).join("") + "</tr>";
  tbl.tBodies[0].innerHTML = rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("");
  if (showCharts && samples.length >= 2) {
    renderCharts($("charts"), [
      { title: "Temperatura (°C)", pts: samples.map((s) => ({ x: s.epochMin, y: s.tempC })) },
      { title: bmp ? "Presión (hPa)" : "Humedad (%RH)", pts: samples.map((s) => ({ x: s.epochMin, y: hVal(s.hRaw) })) },
    ], local ? -new Date().getTimezoneOffset() : 0);
  }
  $("next").textContent = `tv ${samples[samples.length - 1].epochMin}`;
  $("panel").hidden = false;
  $<HTMLButtonElement>("csv").disabled = false;
}

function select(i: number, focus = false) {
  active = i;
  render();
  if (focus) ($("tabs").children[i] as HTMLElement).focus();
}

$("tabs").addEventListener("keydown", (e) => {
  const d = { ArrowRight: 1, ArrowLeft: -1 }[(e as KeyboardEvent).key];
  if (d) select((active + d + tabs.length) % tabs.length, true);
});
// Filas de la tabla: click mueve el marcador de las gráficas (si están on); pulsación larga copia hora local, T y P/%RH.
// chart.ts es una copia sincronizada (no se edita), así que se le simula el pointermove sobre el SVG.
const LONG_PRESS_MS = 600, CH_W = 540, CH_L = 46, CH_R = 14; // CH_* = W/L/R de chart.ts
let pressTimer = 0, longPressed = false;
const rowIdx = (e: Event) => {
  const tr = (e.target as HTMLElement).closest("tr");
  return tr && tr.parentElement === $("tbl").tBodies[0] ? tr.sectionRowIndex : -1;
};
const cancelPress = () => clearTimeout(pressTimer);

function moveMarker(i: number) {
  const svg = $("charts").querySelector("svg");
  const s = tabs[active]?.samples;
  if (!showCharts || !svg || !s || s.length < 2) return;
  let x0 = s[0].epochMin, x1 = s[s.length - 1].epochMin;
  if (x0 === x1) { x0 -= 30; x1 += 30; }
  const r = svg.getBoundingClientRect();
  const x = CH_L + ((s[i].epochMin - x0) / (x1 - x0)) * (CH_W - CH_L - CH_R);
  svg.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + (x * r.width) / CH_W, clientY: r.top }));
}

const tbody = $("tbl").tBodies[0];
tbody.addEventListener("pointerdown", (e) => {
  const i = rowIdx(e);
  longPressed = false;
  if (i < 0) return;
  pressTimer = window.setTimeout(() => {
    longPressed = true;
    const r = rows[i], t = tabs[active].samples[i].date.toLocaleString("sv-SE");
    navigator.clipboard.writeText(`${t}\n${header[1]}: ${r[1]}\n${header[2]}: ${r[2]}`).then(
      () => showToast("Copiado: hora local, temperatura y " + (header[2] ?? "")),
      () => showToast("No se pudo copiar al portapapeles", "error"),
    );
  }, LONG_PRESS_MS);
});
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) tbody.addEventListener(ev, cancelPress);
tbody.addEventListener("click", (e) => {
  const i = rowIdx(e);
  if (i >= 0 && !longPressed) moveMarker(i);
  longPressed = false;
});
tbody.addEventListener("contextmenu", (e) => e.preventDefault()); // menú nativo de pulsación larga en móvil

$("go").addEventListener("click", decode);
$("toggle").addEventListener("click", () => {
  showCharts = !showCharts;
  $("toggle").textContent = `Gráficas: ${showCharts ? "on" : "off"}`;
  $("toggle").setAttribute("aria-pressed", String(showCharts));
  savePrefs();
  render();
});
$("local").addEventListener("change", () => {
  savePrefs();
  render();
});
$("csv").addEventListener("click", () =>
  copy([header, ...rows].map((r) => r.join(",")).join("\n"), $("csv")),
);
$("copynext").addEventListener("click", () => copy($("next").textContent!, $("copynext")));

// Estado inicial de los controles según las preferencias guardadas.
$("toggle").textContent = `Gráficas: ${showCharts ? "on" : "off"}`;
$("toggle").setAttribute("aria-pressed", String(showCharts));
$<HTMLInputElement>("local").checked = loadPrefs().local ?? false;
