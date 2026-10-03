// Copia de MeshCore (120m4n/MeshCore-HJ7RMN @ 373afbac), tools/tv_edge_ext/chart.ts.
// Diferencias: ninguna.
// Resincronizar copiando de ahí y reaplicando las diferencias indicadas.
// chart.ts -- gráficas de línea en SVG a mano (sin dependencias): un panel por
// magnitud, mismo eje X, línea de promedio y hover sincronizado.

export interface Pt { x: number; y: number } // x = epoch_min
export interface Panel { title: string; pts: Pt[] }

const SLOT_MIN = 30; // intervalo de muestreo del firmware (INTERVAL_MIN)

// Puntos de mínimo y máximo; null si la serie es plana (no hay extremos que marcar).
export function extremes(pts: Pt[]): { min: Pt; max: Pt } | null {
  const min = pts.reduce((a, b) => (b.y < a.y ? b : a));
  const max = pts.reduce((a, b) => (b.y > a.y ? b : a));
  return min.y === max.y ? null : { min, max };
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Ticks "redondos" que cubren [min, max] con ~n divisiones.
export function niceTicks(min: number, max: number, n = 4): number[] {
  const raw = (max - min || 1) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v < max + step - 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

// Parte la serie donde falta alguna muestra: la línea no une lo que el nodo no registró.
export function segments(pts: Pt[]): Pt[][] {
  const out: Pt[][] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.x - pts[i - 1].x <= SLOT_MIN) out[out.length - 1].push(p);
    else out.push([p]);
  });
  return out;
}

// epoch_min -> "YYYY-MM-DD HH:MM" desplazado offsetMin (0 = UTC).
export const fmtTime = (x: number, offsetMin: number) =>
  new Date((x + offsetMin) * 60_000).toISOString().slice(0, 16).replace("T", " ");

const W = 540, L = 46, R = 14, PH = 110, BLOCK = PH + 46;
const NS = "http://www.w3.org/2000/svg";

function el(parent: Element, name: string, attrs: Record<string, string | number> = {}, text?: string) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export function renderCharts(host: HTMLElement, panels: Panel[], offsetMin: number) {
  host.replaceChildren();
  const all = panels[0].pts;
  if (!all.length) return;

  let x0 = all[0].x, x1 = all[all.length - 1].x;
  if (x0 === x1) { x0 -= SLOT_MIN; x1 += SLOT_MIN; }
  const px = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - R);

  // Ticks de X cada 1/2/3/6/12 h (el menor que deje <= 6 marcas), alineados a hora local o UTC.
  const stepMin = [60, 120, 180, 360, 720].find((s) => (x1 - x0) / s <= 6) ?? 1440;
  const xticks: number[] = [];
  for (let t = Math.ceil((x0 + offsetMin) / stepMin) * stepMin; t <= x1 + offsetMin; t += stepMin) xticks.push(t - offsetMin);

  const svg = el(host, "svg", { viewBox: `0 0 ${W} ${panels.length * BLOCK}`, width: "100%", role: "img",
    "aria-label": panels.map((p) => p.title).join(" y ") });
  const ys: ((y: number) => number)[] = [];

  panels.forEach((p, i) => {
    const top = i * BLOCK + 18;
    const ticks = niceTicks(Math.min(...p.pts.map((q) => q.y)), Math.max(...p.pts.map((q) => q.y)));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const py = (y: number) => top + PH - ((y - lo) / (hi - lo)) * PH;
    ys.push(py);

    el(svg, "text", { x: L, y: top - 10, class: "t-ink" }, p.title);
    for (const v of ticks) {
      el(svg, "line", { x1: L, x2: W - R, y1: py(v), y2: py(v), class: "grid" });
      el(svg, "text", { x: L - 6, y: py(v) + 3, "text-anchor": "end", class: "t-mute" }, String(v));
    }
    for (const t of xticks) {
      const d = new Date((t + offsetMin) * 60_000);
      const label = d.getUTCHours() === 0 && d.getUTCMinutes() === 0
        ? fmtTime(t, offsetMin).slice(5, 10)
        : fmtTime(t, offsetMin).slice(11);
      el(svg, "text", { x: px(t), y: top + PH + 14, "text-anchor": "middle", class: "t-mute" }, label);
    }
    for (const seg of segments(p.pts)) {
      if (seg.length === 1) el(svg, "circle", { cx: px(seg[0].x), cy: py(seg[0].y), r: 2.5, class: "dot" });
      else el(svg, "path", { d: "M" + seg.map((q) => `${px(q.x)} ${py(q.y)}`).join("L"), class: "line" });
    }
    const ex = extremes(p.pts);
    if (ex) {
      // Etiqueta al costado del punto, hacia el interior, para no pisar el título ni el eje X.
      const mark = (q: Pt, label: string) => {
        const x = px(q.x), side = x < (L + W - R) / 2 ? 1 : -1;
        el(svg, "circle", { cx: x, cy: py(q.y), r: 4, class: "ext" });
        el(svg, "text", { x: x + side * 8, y: py(q.y) + 4, "text-anchor": side > 0 ? "start" : "end", class: "t-ink halo" },
          `${label} ${q.y.toFixed(1)}`);
      };
      mark(ex.max, "máx");
      mark(ex.min, "mín");
    }
    // ponytail: promedio simple, no ponderado por tiempo; con huecos grandes puede sesgarse.
    const m = mean(p.pts.map((q) => q.y));
    el(svg, "line", { x1: L, x2: W - R, y1: py(m), y2: py(m), class: "mean" });
    el(svg, "text", { x: W - R, y: py(m) - 4, "text-anchor": "end", class: "t-ink halo" }, `prom ${m.toFixed(1)}`);
  });

  // Hover: crosshair + marcadores en cada panel y tooltip HTML sobre la muestra más cercana.
  const cross = el(svg, "line", { y1: 0, y2: panels.length * BLOCK, class: "cross", visibility: "hidden" });
  const marks = panels.map(() => el(svg, "circle", { r: 4, class: "dot", visibility: "hidden" }));
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.appendChild(tip);

  svg.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect(), k = r.width / W, mx = (ev.clientX - r.left) / k;
    const i = all.reduce((b, q, j) => (Math.abs(px(q.x) - mx) < Math.abs(px(all[b].x) - mx) ? j : b), 0);
    const x = px(all[i].x);
    cross.setAttribute("x1", String(x));
    cross.setAttribute("x2", String(x));
    cross.setAttribute("visibility", "visible");
    marks.forEach((m, j) => {
      m.setAttribute("cx", String(x));
      m.setAttribute("cy", String(ys[j](panels[j].pts[i].y)));
      m.setAttribute("visibility", "visible");
    });
    tip.textContent = [fmtTime(all[i].x, offsetMin), ...panels.map((p) => `${p.title}: ${p.pts[i].y.toFixed(1)}`)].join("\n");
    tip.hidden = false;
    tip.style.left = `${Math.min(x * k + 10, r.width - tip.offsetWidth)}px`;
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    marks.forEach((m) => m.setAttribute("visibility", "hidden"));
    tip.hidden = true;
  });
}
