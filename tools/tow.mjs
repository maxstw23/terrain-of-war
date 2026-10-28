#!/usr/bin/env node
// Terrain of War scenario tool. Runs the app's own code (js/*.js) in Node, so its
// results are exactly what the page computes.
//
//   node tools/tow.mjs check  scenarios/x.json ...   validate; nothing is changed
//   node tools/tow.mjs snap   scenarios/x.json       move peaks onto the high point nearby
//   node tools/tow.mjs bake   scenarios/x.json       pre-compute terrain-following routes
//   node tools/tow.mjs prep   scenarios/x.json       snap + bake + check (the usual run)
//   node tools/tow.mjs place  马陵                    look a name up in the gazetteer
//
// snap, bake and prep rewrite the file in place. Elevation tiles are cached in
// ~/.cache/terrain-of-war (override with TOW_TILE_CACHE).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScenario, routeKey, PLACE_KINDS } from '../js/scenario.js';
import { leastCostRoute, bboxOf, haversine } from '../js/analysis.js';
import { nodeDem } from './lib/node-dem.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAZETTEER = path.join(ROOT, 'gazetteer.json');
const dem = nodeDem();

const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// Indented JSON, but with [lon, lat] / [d, elev] pairs kept on one line and long
// lists of pairs (baked paths) packed, so files stay small and diffs readable.
const writeJSON = (f, d) => {
  let s = JSON.stringify(d, null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, '[$1, $2]');
  s = s.replace(/\[(\s+\[-?[\d.e+-]+, -?[\d.e+-]+\],?)+\s+\]/g, (m) => `[${m.slice(1, -1).trim().split(/,\s+/).join(', ')}]`);
  fs.writeFileSync(f, s + '\n');
};
const round5 = (v) => +v.toFixed(5);
const fmt = ([lon, lat]) => `${lat.toFixed(3)}°N ${lon.toFixed(3)}°E`;

function gazetteer() {
  return fs.existsSync(GAZETTEER) ? readJSON(GAZETTEER).places : [];
}

/** Gazetteer entries whose names match a place (by zh name, local name or English name). */
function gazMatches(gaz, p) {
  const keys = [p.nameLocal, p.zh?.name, p.name].filter(Boolean).map((s) => s.trim().toLowerCase());
  return gaz.filter((g) => [g.name, g.zh, ...(g.aliases || [])].some((n) => n && keys.includes(n.toLowerCase())));
}

async function highPointNear([lon, lat], radiusM = 1500) {
  const g = await dem.grid(bboxOf([[lon, lat]], 0, radiusM), 12);
  let best = -Infinity, at = null;
  for (let j = 0; j < g.height; j++)
    for (let i = 0; i < g.width; i++) {
      const ll = g.cellToLonLat(i, j);
      if (haversine(ll, [lon, lat]) > radiusM) continue;
      const e = g.data[j * g.width + i];
      if (e > best) { best = e; at = ll; }
    }
  return { elev: best, at };
}

// ---------------------------------------------------------------------------

async function check(file) {
  const raw = readJSON(file);
  const notes = [];
  let sc, problems;
  try {
    ({ scenario: sc, warnings: problems } = normalizeScenario(raw));
  } catch (e) {
    return { problems: [e.message], notes };
  }

  // Every user-visible text needs its Chinese counterpart.
  const needZh = (obj, fields, label) => {
    for (const f of fields) if (obj[f] && !obj.zh?.[f]) problems.push(`${label}: missing zh.${f}`);
  };
  needZh(raw, ['title', 'period', 'summary'], 'scenario');
  for (const s of raw.sides || []) needZh(s, ['name'], `side ${s.id}`);
  for (const k of ['places', 'routes', 'zones']) for (const x of raw[k] || []) needZh(x, ['name', 'note'], `${k.slice(0, -1)} ${x.id}`);
  (raw.steps || []).forEach((s, i) => {
    needZh(s, ['title', 'text'], `step ${i + 1}`);
    if (s.analysis) needZh(s.analysis, ['label'], `step ${i + 1} analysis`);
    if (!s.camera) notes.push(`step ${i + 1} has no camera; it will frame its focus features`);
  });

  // Step analyses must point at something that exists.
  const routeIds = new Set(sc.routes.map((r) => r.id));
  sc.steps.forEach((s, i) => {
    const a = s.analysis;
    if (!a) return;
    const where = `step ${i + 1} ${a.type}`;
    if (!['profile', 'viewshed', 'los', 'compare'].includes(a.type)) problems.push(`${where}: unknown analysis type`);
    if (a.type === 'profile' && !a.coords && !routeIds.has(a.route)) problems.push(`${where}: unknown route "${a.route}"`);
    if (a.type === 'compare') for (const id of a.routes || []) if (!routeIds.has(id)) problems.push(`${where}: unknown route "${id}"`);
    if (a.type === 'compare' && !(a.routes?.length >= 2)) problems.push(`${where}: needs at least two routes`);
    if (a.type === 'viewshed' && !a.at) problems.push(`${where}: "at" is not a known place or [lon, lat]`);
    if (a.type === 'los' && !(a.from && a.to)) problems.push(`${where}: "from"/"to" are not known places`);
  });

  for (const p of raw.places || []) if (p.kind && !PLACE_KINDS.includes(p.kind)) problems.push(`place ${p.id}: unknown kind "${p.kind}"`);

  // Terrain sanity, from the elevation data.
  for (const p of sc.places) {
    if (p.kind === 'region') continue;
    await dem.prefetchPoints([[p.lon, p.lat]], 12);
    const e = dem.elevAt(p.lon, p.lat, 12);
    if (e < -5 && p.kind !== 'port') problems.push(`place ${p.id}: in the sea (${Math.round(e)} m) at ${fmt([p.lon, p.lat])}`);
    if (p.kind === 'mountain') {
      const hp = await highPointNear([p.lon, p.lat]);
      if (hp.elev - e > 80) problems.push(`place ${p.id}: ${Math.round(hp.elev - e)} m below the high point 1.5 km away (${fmt(hp.at)}); run snap`);
    }
  }

  // Routes: baked paths still current?
  for (const r of sc.routes) {
    if (['terrain', 'valley'].includes(r.follow) && !r.traced) notes.push(`route ${r.id}: not baked; the page will trace it on load (run bake)`);
  }

  // Gazetteer agreement: the same place should sit in the same spot in every scenario.
  const gaz = gazetteer();
  for (const p of sc.places) {
    for (const g of gazMatches(gaz, p)) {
      const d = haversine([p.lon, p.lat], [g.lon, g.lat]);
      const alt = (g.alternatives || []).some((a) => haversine([p.lon, p.lat], [a.lon, a.lat]) < 3000);
      if (d > 3000 && !alt) notes.push(`place ${p.id}: ${(d / 1000).toFixed(1)} km from gazetteer "${g.id}" (${fmt([g.lon, g.lat])})`);
    }
  }
  if (dem.failed.size) problems.push(`${dem.failed.size} elevation tiles could not be downloaded; terrain checks are incomplete`);
  return { problems, notes };
}

async function snap(file) {
  const raw = readJSON(file);
  let moved = 0;
  for (const p of raw.places || []) {
    if (p.kind !== 'mountain') continue;
    await dem.prefetchPoints([[p.lon, p.lat]], 12);
    const e = dem.elevAt(p.lon, p.lat, 12);
    const hp = await highPointNear([p.lon, p.lat]);
    if (hp.elev - e > 30) {
      console.log(`  snap ${p.id}: ${fmt([p.lon, p.lat])} (${Math.round(e)} m) -> ${fmt(hp.at)} (${Math.round(hp.elev)} m)`);
      [p.lon, p.lat] = hp.at.map((v) => +v.toFixed(4));
      moved++;
    }
  }
  writeJSON(file, raw);
  console.log(`  ${moved} place(s) snapped`);
}

async function bake(file) {
  const raw = readJSON(file);
  const { scenario: sc } = normalizeScenario(raw);
  let n = 0;
  for (const r of sc.routes) {
    if (!['terrain', 'valley'].includes(r.follow)) continue;
    const src = raw.routes.find((x) => x.id === r.id);
    const key = routeKey(r);
    if (src.path && src.pathKey === key) continue; // already current
    const t0 = Date.now();
    const res = await leastCostRoute(dem, r.waypoints, { mode: r.follow === 'valley' ? 'valley' : 'march' });
    src.path = res.coords.map(([x, y]) => [round5(x), round5(y)]);
    src.pathKey = key;
    src.pathZoom = res.z;
    // Elevation along the traced cells, [distance m, elevation m], at most ~800 samples
    // (always keeping the highest and lowest point) so profiles need no tile downloads.
    const prof = res.profile, step = Math.max(1, Math.ceil(prof.length / 800));
    const hi = prof.reduce((a, p) => (p.elev > a.elev ? p : a)), lo = prof.reduce((a, p) => (p.elev < a.elev ? p : a));
    src.pathProfile = prof.filter((p, i) => i % step === 0 || i === prof.length - 1 || p === hi || p === lo)
      .map((p) => [Math.round(p.d), Math.round(p.elev)]);
    if (r.follow === 'terrain') src.pathHours = +res.hours.toFixed(2);
    else delete src.pathHours;
    console.log(`  bake ${r.id}: ${src.path.length} points, ${(res.length / 1000).toFixed(0)} km, z${res.z} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    n++;
  }
  if (dem.failed.size) throw new Error(`${dem.failed.size} elevation tiles could not be downloaded; not writing ${file}`);
  writeJSON(file, raw);
  console.log(`  ${n} route(s) baked`);
}

function place(query) {
  const q = query.trim().toLowerCase();
  const hits = gazetteer().filter((g) => [g.id, g.name, g.zh, ...(g.aliases || [])].some((n) => n && n.toLowerCase().includes(q)));
  if (!hits.length) console.log(`no gazetteer entry for "${query}"`);
  for (const g of hits) {
    console.log(`${g.id}: ${g.zh || ''} ${g.name} — ${fmt([g.lon, g.lat])}${g.approximate ? ' (approximate)' : ''}`);
    for (const a of g.alternatives || []) console.log(`    alternative: ${a.label} — ${fmt([a.lon, a.lat])}`);
    if (g.note) console.log(`    ${g.note}`);
  }
}

// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
const report = ({ problems, notes }, file) => {
  for (const p of problems) console.log(`  ✗ ${p}`);
  for (const n of notes) console.log(`  · ${n}`);
  console.log(problems.length ? `  ${file}: ${problems.length} problem(s)` : `  ${file}: OK`);
  return problems.length;
};

try {
  if (cmd === 'place') place(args.join(' '));
  else if (['check', 'snap', 'bake', 'prep'].includes(cmd) && args.length) {
    let failed = 0;
    for (const file of args.filter((f) => path.basename(f) !== 'index.json')) {
      console.log(file);
      if (cmd === 'snap' || cmd === 'prep') await snap(file);
      if (cmd === 'bake' || cmd === 'prep') await bake(file);
      if (cmd === 'check' || cmd === 'prep') failed += report(await check(file), file);
    }
    process.exitCode = failed ? 1 : 0;
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
