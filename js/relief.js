// 2D elevation rendering: hypsometric tint ("分层设色") and contour lines, drawn in the
// browser from the same terrain tiles the analysis uses. Registered as MapLibre
// protocols so they behave like ordinary raster tile sources:
//   hypso://{z}/{x}/{y}?lo=<m>&hi=<m>    colour by elevation, stretched over [lo, hi]
//   contour://{z}/{x}/{y}                 transparent tile with contour lines

import { TILE } from './dem.js';

// Atlas-style ramp after common Chinese relief maps (e.g. 地图帝): green lowlands,
// pale cream plains and basins, then tan, orange and rust-brown uplands.
const RAMP = [
  [0.0, [128, 190, 120]],
  [0.1, [190, 220, 150]],
  [0.2, [240, 234, 196]],
  [0.35, [238, 214, 160]],
  [0.5, [236, 180, 100]],
  [0.65, [226, 148, 70]],
  [0.8, [206, 114, 50]],
  [1.0, [176, 84, 36]],
];
const SEA = [140, 190, 230];

function rampColor(f) {
  if (f <= 0) return RAMP[0][1];
  if (f >= 1) return RAMP[RAMP.length - 1][1];
  let i = 1;
  while (RAMP[i][0] < f) i++;
  const [f0, c0] = RAMP[i - 1], [f1, c1] = RAMP[i];
  const u = (f - f0) / (f1 - f0);
  return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * u);
}

/** CSS linear-gradient for a legend bar matching the ramp. */
export function rampCss() {
  return `linear-gradient(90deg, ${RAMP.map(([f, c]) => `rgb(${c.join(',')}) ${f * 100}%`).join(', ')})`;
}

/** Contour interval (m) for a zoom level: coarse when zoomed out, fine when zoomed in. */
export function contourInterval(z) {
  if (z <= 6) return 500;
  if (z <= 8) return 200;
  if (z <= 10) return 100;
  if (z <= 11) return 50;
  return 25;
}

async function toPng(rgba) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TILE, TILE)
    : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  canvas.getContext('2d').putImageData(new ImageData(rgba, TILE, TILE), 0, 0);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return blob.arrayBuffer();
}

function parse(url) {
  const m = url.match(/^\w+:\/\/(\d+)\/(\d+)\/(\d+)(?:\?(.*))?$/);
  if (!m) throw new Error(`Bad relief tile URL ${url}`);
  return { z: +m[1], x: +m[2], y: +m[3], q: new URLSearchParams(m[4] || '') };
}

export function registerReliefProtocols(maplibregl, dem) {
  maplibregl.addProtocol('hypso', async (params) => {
    const { z, x, y, q } = parse(params.url);
    const lo = +(q.get('lo') ?? 0), hi = +(q.get('hi') ?? 3000);
    const elev = await dem.tile(z, x, y);
    const rgba = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < elev.length; i++) {
      const e = elev[i];
      const c = e < 0 ? SEA : rampColor((e - lo) / (hi - lo));
      rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255;
    }
    return { data: await toPng(rgba) };
  });

  maplibregl.addProtocol('contour', async (params) => {
    const { z, x, y } = parse(params.url);
    const elev = await dem.tile(z, x, y);
    const step = contourInterval(z);
    const rgba = new Uint8ClampedArray(TILE * TILE * 4);
    const band = (e) => Math.floor(e / step);
    for (let j = 0; j < TILE; j++)
      for (let i = 0; i < TILE; i++) {
        const k = j * TILE + i, e = elev[k];
        if (e < 0) continue;
        // A pixel is on a contour if its right or lower neighbour lies in another band.
        const b = band(e);
        const br = i < TILE - 1 ? band(elev[k + 1]) : b, bd = j < TILE - 1 ? band(elev[k + TILE]) : b;
        if (br === b && bd === b) continue;
        const crossing = Math.max(b, br, bd); // the contour level crossed is crossing * step
        const index = crossing % 5 === 0; // every fifth contour is an index contour
        rgba[k * 4] = 70; rgba[k * 4 + 1] = 45; rgba[k * 4 + 2] = 25;
        rgba[k * 4 + 3] = index ? 210 : 110;
      }
    return { data: await toPng(rgba) };
  });
}

/**
 * Elevation range to stretch the tint over for an area: the 2nd–99th percentile of
 * heights in the bbox, so a few peaks or a coastline do not wash out the colours.
 */
export async function elevationRange(dem, bbox) {
  const z = dem.zoomFor(bbox, 120000, 9);
  const g = await dem.grid(bbox, z);
  const vals = Array.from(g.data).filter((e) => e > -50).sort((a, b) => a - b);
  if (!vals.length) return [0, 1000];
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  let lo = Math.max(0, q(0.02)), hi = q(0.99);
  if (hi - lo < 200) hi = lo + 200;
  // Round to friendly legend values.
  const r = hi - lo > 1500 ? 100 : 50;
  return [Math.floor(lo / r) * r, Math.ceil(hi / r) * r];
}
