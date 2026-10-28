// Terrain analysis: elevation profiles, line of sight, viewsheds and least-cost
// (march) routes. Everything works on heights from DemSource, so results do not
// depend on what the map has rendered.

import { metersPerPixel, DemGrid } from './dem.js';

const R_EARTH = 6371008.8;
const REFRACTION_K = 0.13; // standard atmospheric refraction coefficient

const rad = (d) => (d * Math.PI) / 180;

export function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

export function bboxOf(coords, padFrac = 0, padMinM = 0) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  }
  const midLat = (s + n) / 2;
  const padLat = Math.max((n - s) * padFrac, padMinM / 111320);
  const padLon = Math.max((e - w) * padFrac, padMinM / (111320 * Math.cos(rad(midLat))));
  return [w - padLon, s - padLat, e + padLon, n + padLat];
}

/** Points every ~stepM metres along a polyline, each with cumulative distance d. */
export function densify(coords, stepM) {
  const out = [{ lon: coords[0][0], lat: coords[0][1], d: 0 }];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const seg = haversine(a, b);
    const n = Math.max(1, Math.ceil(seg / stepM));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, d: total + seg * t });
    }
    total += seg;
  }
  return out;
}

function profileZoom(lengthM) {
  if (lengthM < 25e3) return 13;
  if (lengthM < 80e3) return 12;
  if (lengthM < 250e3) return 11;
  return 10;
}

/** Height drop of a distant point due to earth curvature, net of refraction. */
const curvatureDrop = (d) => ((d * d) / (2 * R_EARTH)) * (1 - REFRACTION_K);

export async function elevationProfile(dem, coords, { maxSamples = 2500 } = {}) {
  const length = lineLength(coords);
  const z = profileZoom(length);
  const step = Math.max(metersPerPixel(coords[0][1], z), length / maxSamples);
  const pts = densify(coords, step);
  await dem.prefetchPoints(pts.map((p) => [p.lon, p.lat]), z);
  for (const p of pts) p.elev = dem.elevAt(p.lon, p.lat, z);
  return { points: pts, length, z, stats: profileStats(pts) };
}

export function profileStats(pts) {
  let ascent = 0, descent = 0, min = Infinity, max = -Infinity, maxGrade = 0, maxGradeAt = 0;
  for (const p of pts) {
    min = Math.min(min, p.elev);
    max = Math.max(max, p.elev);
  }
  // Grades over a ~200 m window, so single-pixel DEM noise does not dominate.
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    while (j < pts.length - 1 && pts[j].d - pts[i].d < 200) j++;
    const run = pts[j].d - pts[i].d;
    if (run >= 100) {
      const g = Math.abs(pts[j].elev - pts[i].elev) / run;
      if (g > maxGrade) { maxGrade = g; maxGradeAt = pts[i].d; }
    }
  }
  // Ascent/descent with a 5 m hysteresis to ignore noise.
  let ref = pts[0].elev;
  for (const p of pts) {
    if (p.elev - ref > 5) { ascent += p.elev - ref; ref = p.elev; }
    else if (ref - p.elev > 5) { descent += ref - p.elev; ref = p.elev; }
  }
  return { ascent, descent, min, max, maxGrade, maxGradeAt, length: pts[pts.length - 1].d };
}

/**
 * Line of sight from a to b. Observer and target heights are metres above ground.
 * Returns the profile with a per-point sight-line height and the first obstruction.
 */
export async function lineOfSight(dem, a, b, { observerH = 10, targetH = 2 } = {}) {
  const prof = await elevationProfile(dem, [a, b]);
  const pts = prof.points;
  const D = pts[pts.length - 1].d;
  const z0 = pts[0].elev + observerH;
  const z1 = pts[pts.length - 1].elev + targetH - curvatureDrop(D);
  let blockedAt = null, maxIntrusion = 0;
  for (const p of pts) {
    p.sight = z0 + ((z1 - z0) * p.d) / D + curvatureDrop(p.d); // sight line, in ground frame
    if (p.d > 0 && p.d < D) {
      const intrusion = p.elev - p.sight;
      if (intrusion > 0 && blockedAt === null) blockedAt = p;
      maxIntrusion = Math.max(maxIntrusion, intrusion);
    }
  }
  return { ...prof, visible: blockedAt === null, blockedAt, maxIntrusion, observerH, targetH };
}

/**
 * Viewshed: which ground (plus targetH) is visible from an observer standing
 * observerH metres above the ground at `center`, within radiusM.
 * Returns an RGBA image (for a MapLibre image source) plus summary statistics.
 */
export async function viewshed(dem, center, radiusM, { observerH = 15, targetH = 2, maxCells = 1.2e6 } = {}) {
  const bbox = bboxOf([center], 0, radiusM);
  const z = dem.zoomFor(bbox, maxCells, 13);
  const g = await dem.grid(bbox, z);
  const W = g.width, H = g.height;
  const mpp = metersPerPixel(center[1], z);
  const [ci, cj] = g.toCell(center[0], center[1]);
  const zObs = g.sample(ci, cj) + observerH;
  const rCells = radiusM / mpp;
  const state = new Uint8Array(W * H); // 0 = outside, 1 = hidden, 2 = visible

  // Cast a ray to every perimeter cell; this covers each cell at least once.
  const targets = [];
  for (let i = 0; i < W; i++) targets.push([i, 0], [i, H - 1]);
  for (let j = 1; j < H - 1; j++) targets.push([0, j], [W - 1, j]);
  for (const [ti, tj] of targets) {
    const dx = ti - ci, dy = tj - cj;
    const len = Math.hypot(dx, dy);
    const steps = Math.min(Math.ceil(len), Math.ceil(rCells));
    const ux = dx / len, uy = dy / len;
    let maxSlope = -Infinity;
    for (let s = 1; s <= steps; s++) {
      const x = ci + ux * s, y = cj + uy * s;
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) break;
      const dist = s * mpp;
      const ground = g.sample(x, y) - curvatureDrop(dist);
      const k = iy * W + ix;
      const visible = (ground + targetH - zObs) / dist >= maxSlope;
      if (visible) state[k] = 2;
      else if (state[k] === 0) state[k] = 1;
      maxSlope = Math.max(maxSlope, (ground - zObs) / dist);
    }
  }

  const rgba = new Uint8ClampedArray(W * H * 4);
  let vis = 0, tot = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (Math.hypot(i - ci, j - cj) > rCells) continue;
      tot++;
      if (state[k] === 2) {
        vis++;
        rgba.set([255, 214, 10, 150], k * 4); // seen: amber
      } else {
        rgba.set([20, 30, 60, 120], k * 4); // dead ground: dark
      }
    }
  // MapLibre mipmaps power-of-two textures, which garbles this overlay; pad such
  // sizes by one transparent pixel.
  const isPot = (n) => (n & (n - 1)) === 0;
  const W2 = W + (isPot(W) ? 1 : 0), H2 = H + (isPot(H) ? 1 : 0);
  let out = rgba;
  if (W2 !== W || H2 !== H) {
    out = new Uint8ClampedArray(W2 * H2 * 4);
    for (let j = 0; j < H; j++) out.set(rgba.subarray(j * W * 4, (j + 1) * W * 4), j * W2 * 4);
  }
  return {
    width: W2, height: H2, rgba: out, corners: new DemGrid(z, g.x0, g.y0, W2, H2, null).corners(), z,
    observerElev: zObs - observerH, observerH, targetH, radiusM,
    visibleFraction: tot ? vis / tot : 0,
  };
}

// ---------------------------------------------------------------------------
// Least-cost march routes
// ---------------------------------------------------------------------------

/** Tobler's hiking function: walking speed (km/h) on a slope dz/dx. */
export function toblerKmh(slope) {
  return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
}

/**
 * Travel-time cost (hours) of moving distM with signed slope. Tobler alone lets a
 * hiker scramble up 40% grades; armies with carts and baggage cannot, so grades
 * beyond ~25% are penalised steeply. Sea cells are close to impassable.
 */
function stepHours(distM, slope, elevTo) {
  let h = distM / 1000 / toblerKmh(slope);
  const a = Math.abs(slope);
  if (a > 0.25) h *= 1 + ((a - 0.25) * 12) ** 2;
  if (elevTo < -1) h *= 60;
  return h;
}

class MinHeap {
  constructor(cap = 1 << 16) {
    this.ids = new Int32Array(cap);
    this.keys = new Float64Array(cap);
    this.size = 0;
  }
  push(id, key) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2), keys = new Float64Array(this.size * 2);
      ids.set(this.ids); keys.set(this.keys);
      this.ids = ids; this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p]; i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop() {
    const top = this.ids[0];
    const id = this.ids[--this.size], key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.ids[i] = this.ids[c]; this.keys[i] = this.keys[c]; i = c;
    }
    this.ids[i] = id; this.keys[i] = key;
    return top;
  }
}

const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Cost of a river step: distance plus a steep charge for every metre climbed, so the
 * cheapest line between two points on a river stays on the valley floor.
 */
function riverStep(distM, slope) {
  return distM + 60 * Math.max(0, slope * distM);
}

function astar(g, rowMpp, start, goal, mode) {
  const W = g.width, H = g.height, N = W * H, elev = g.data;
  const valley = mode === 'valley';
  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const maxKmh = toblerKmh(-0.05);
  const gi = goal % W, gj = (goal / W) | 0;
  const heuristic = (k) => {
    const i = k % W, j = (k / W) | 0;
    const d = Math.hypot(i - gi, j - gj) * rowMpp[j];
    return valley ? d : d / 1000 / maxKmh;
  };
  const heap = new MinHeap();
  cost[start] = 0;
  heap.push(start, heuristic(start));
  while (heap.size) {
    const k = heap.pop();
    if (closed[k]) continue;
    if (k === goal) break;
    closed[k] = 1;
    const i = k % W, j = (k / W) | 0;
    for (const [di, dj, f] of NEIGHBOURS) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nk = nj * W + ni;
      if (closed[nk]) continue;
      const dist = f * rowMpp[j];
      const slope = (elev[nk] - elev[k]) / dist;
      const c = cost[k] + (valley ? riverStep(dist, slope) : stepHours(dist, slope, elev[nk]));
      if (c < cost[nk]) {
        cost[nk] = c;
        prev[nk] = k;
        heap.push(nk, c + heuristic(nk));
      }
    }
  }
  if (prev[goal] === -1 && goal !== start) return null;
  const path = [];
  for (let k = goal; k !== -1; k = prev[k]) path.push(k);
  path.reverse();
  return { path, hours: cost[goal] };
}

/** Douglas–Peucker on [x, y] arrays. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Fastest foot route through the terrain visiting the waypoints in order.
 * Returns the route geometry, its length and the Tobler walking time.
 * With mode "valley" it instead finds the lowest line between the waypoints, which
 * snaps a roughly drawn river onto its valley floor (hours is then meaningless).
 */
export async function leastCostRoute(dem, waypoints, { maxCells = 1.5e6, padM = 8000, mode = 'march' } = {}) {
  if (waypoints.length < 2) throw new Error('Need at least two waypoints');
  const bbox = bboxOf(waypoints, 0.15, padM);
  const z = dem.zoomFor(bbox, maxCells, 12);
  const g = await dem.grid(bbox, z);
  const rowMpp = new Float64Array(g.height);
  for (let j = 0; j < g.height; j++) rowMpp[j] = metersPerPixel(g.cellToLonLat(0, j)[1], z);

  const cellOf = ([lon, lat]) => {
    const [i, j] = g.toCell(lon, lat);
    const ci = Math.max(0, Math.min(g.width - 1, Math.round(i)));
    const cj = Math.max(0, Math.min(g.height - 1, Math.round(j)));
    return cj * g.width + ci;
  };
  let cells = [], hours = 0;
  for (let w = 1; w < waypoints.length; w++) {
    const leg = astar(g, rowMpp, cellOf(waypoints[w - 1]), cellOf(waypoints[w]), mode);
    if (!leg) throw new Error(`No route found for leg ${w}`);
    hours += leg.hours;
    cells = cells.concat(w === 1 ? leg.path : leg.path.slice(1));
  }
  const xy = cells.map((k) => [k % g.width, (k / g.width) | 0]);
  const coords = simplify(xy, 0.8).map(([i, j]) => g.cellToLonLat(i, j));
  coords[0] = waypoints[0];
  coords[coords.length - 1] = waypoints[waypoints.length - 1];
  // Profile straight from the cells the path runs through. Re-sampling the simplified
  // line instead would put points on the walls of narrow gorges and inflate the climb.
  const profile = [];
  let d = 0, prevLL = null;
  for (const [i, j] of xy) {
    const ll = g.cellToLonLat(i, j);
    if (prevLL) d += haversine(prevLL, ll);
    profile.push({ lon: ll[0], lat: ll[1], d, elev: g.data[j * g.width + i] });
    prevLL = ll;
  }
  return { coords, hours, length: d, z, profile };
}

