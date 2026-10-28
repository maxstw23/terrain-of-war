// Elevation-profile chart (inline SVG). Optionally draws a line of sight.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
}

/**
 * Render a profile into `container`. points: [{d, elev, sight?}].
 * onHover(point | null) is called as the pointer moves over the chart.
 */
export function renderProfile(container, points, { onHover, blockedAt, markers = [] } = {}) {
  container.replaceChildren();
  const W = container.clientWidth || 600, H = container.clientHeight || 170;
  const m = { l: 48, r: 12, t: 10, b: 24 };
  const D = points[points.length - 1].d;
  let lo = Math.min(...points.map((p) => Math.min(p.elev, p.sight ?? Infinity)));
  let hi = Math.max(...points.map((p) => Math.max(p.elev, p.sight ?? -Infinity)));
  const pad = Math.max(20, (hi - lo) * 0.08);
  lo -= pad; hi += pad;
  const x = (d) => m.l + ((W - m.l - m.r) * d) / D;
  const y = (e) => H - m.b - ((H - m.t - m.b) * (e - lo)) / (hi - lo);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'profile-svg' });

  const yStep = niceStep(hi - lo, 4);
  for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }));
    const t = el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' });
    t.textContent = `${Math.round(v)}`;
    svg.append(t);
  }
  const xStep = niceStep(D / 1000, 6);
  for (let v = 0; v <= D / 1000 + 1e-9; v += xStep) {
    const t = el('text', { x: x(v * 1000), y: H - 6, 'text-anchor': 'middle', class: 'tick' });
    t.textContent = `${+v.toFixed(1)} km`;
    svg.append(t);
  }

  const line = points.map((p) => `${x(p.d).toFixed(1)},${y(p.elev).toFixed(1)}`).join(' L');
  svg.append(el('path', { d: `M${x(0)},${y(lo)} L${line} L${x(D)},${y(lo)} Z`, class: 'terrain-fill' }));
  svg.append(el('path', { d: `M${line}`, class: 'terrain-line' }));

  if (points[0].sight !== undefined) {
    const sl = `M${x(0)},${y(points[0].sight)} L${x(D)},${y(points[points.length - 1].sight)}`;
    svg.append(el('path', { d: sl, class: blockedAt ? 'sight blocked' : 'sight clear' }));
    if (blockedAt) svg.append(el('circle', { cx: x(blockedAt.d), cy: y(blockedAt.elev), r: 5, class: 'block-pt' }));
  }
  for (const mk of markers) {
    svg.append(el('line', { x1: x(mk.d), x2: x(mk.d), y1: m.t, y2: H - m.b, class: 'marker-line' }));
    const t = el('text', { x: x(mk.d) + 3, y: m.t + 10, class: 'marker-label' });
    t.textContent = mk.label;
    svg.append(t);
  }

  const cursor = el('line', { y1: m.t, y2: H - m.b, class: 'cursor', visibility: 'hidden' });
  const readout = el('text', { y: m.t + 12, class: 'readout', visibility: 'hidden' });
  svg.append(cursor, readout);
  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const d = ((ev.clientX - r.left - m.l) / (W - m.l - m.r)) * D;
    if (d < 0 || d > D) return;
    let i = 0, j = points.length - 1;
    while (j - i > 1) { const k = (i + j) >> 1; if (points[k].d < d) i = k; else j = k; }
    const p = points[j];
    cursor.setAttribute('x1', x(p.d)); cursor.setAttribute('x2', x(p.d));
    cursor.setAttribute('visibility', 'visible');
    readout.textContent = `${(p.d / 1000).toFixed(2)} km · ${Math.round(p.elev)} m`;
    const rx = x(p.d) > W / 2 ? x(p.d) - 6 : x(p.d) + 6;
    readout.setAttribute('x', rx);
    readout.setAttribute('text-anchor', x(p.d) > W / 2 ? 'end' : 'start');
    readout.setAttribute('visibility', 'visible');
    onHover?.(p);
  });
  svg.addEventListener('pointerleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    readout.setAttribute('visibility', 'hidden');
    onHover?.(null);
  });
  container.append(svg);
}
