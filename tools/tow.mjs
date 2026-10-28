#!/usr/bin/env node
// Terrain of War scenario tool. Runs the app's own code (js/*.js) in Node, so its
// results are exactly what the page computes.
//
//   node tools/tow.mjs check  scenarios/x.json ...   validate; nothing is changed
//   node tools/tow.mjs snap   scenarios/x.json       move peaks onto the high point nearby
//   node tools/tow.mjs bake   scenarios/x.json       pre-compute terrain-following routes
//   node tools/tow.mjs prep   scenarios/x.json       snap + bake + check (the usual run)
//   node tools/tow.mjs place  马陵                    look a name up in the gazetteer
//   node tools/tow.mjs gazetteer scenarios/x.json    add the scenario's new places to it
//   node tools/tow.mjs hidden scenarios/x.json <observer ...> [--near id] [--km 5] [--h 15]
//                                                    dead ground: spots no observer can see
//
// snap, bake and prep rewrite the file in place. Elevation tiles are cached in
// ~/.cache/terrain-of-war (override with TOW_TILE_CACHE).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScenario, routeKey, PLACE_KINDS } from '../js/scenario.js';
import { leastCostRoute, bboxOf, haversine, lineOfSight } from '../js/analysis.js';
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

/**
 * The col of a pass on a route. Trace the route's two legs through the given point, from
 * the valley floor ~4 km away on each side; a rough point on the slope below the col
 * still makes the trace climb on over the col, so the col is the trace's highest point
 * within maxShiftM of the given position. Returns null when nothing nearby is higher.
 */
async function colOnRoute(pass, prev, next, maxShiftM = 3000) {
  // Start and end on the valley floor: the lowest ground within 2.5 km of a point 4 km
  // from the pass towards each neighbour (a straight line can end on a high slope).
  const valleyToward = async (to) => {
    const d = haversine(pass, to), f = Math.min(1, 4000 / d);
    const c = [pass[0] + (to[0] - pass[0]) * f, pass[1] + (to[1] - pass[1]) * f];
    const g = await dem.grid(bboxOf([c], 0, 2500), 12);
    let lo = Infinity, at = c;
    for (let j = 0; j < g.height; j++)
      for (let i = 0; i < g.width; i++) {
        const ll = g.cellToLonLat(i, j);
        if (haversine(ll, c) <= 2500 && g.data[j * g.width + i] < lo) { lo = g.data[j * g.width + i]; at = ll; }
      }
    return at;
  };
  const res = await leastCostRoute(dem, [await valleyToward(prev), pass, await valleyToward(next)], { padM: 3000, maxCells: 4e5 });
  const near = res.profile.filter((p) => haversine([p.lon, p.lat], pass) <= maxShiftM);
  if (!near.length) return null;
  const top = near.reduce((a, p) => (p.elev > a.elev ? p : a));
  return { elev: top.elev, at: [top.lon, top.lat] };
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

  // Claims the step text makes about sight lines must hold on the elevation data.
  const placeById = new Map(sc.places.map((p) => [p.id, p]));
  for (const [i, s] of sc.steps.entries()) {
    const a = s.analysis, x = a?.expect;
    if (!x) continue;
    const where = `step ${i + 1} ${a.type}`;
    const obsH = a.observerH ?? 15, tgtH = a.targetH ?? 2;
    if (x.sight && a.type === 'los' && a.from && a.to) {
      const r = await lineOfSight(dem, a.from, a.to, { observerH: obsH, targetH: tgtH });
      if ((x.sight === 'clear') !== r.visible)
        problems.push(`${where}: expected the sight line ${x.sight}, but it is ${r.visible ? 'clear' : `blocked ${(r.blockedAt.d / 1000).toFixed(1)} km out`}`);
    }
    const from = a.at || a.from;
    for (const want of ['hidden', 'visible']) {
      for (const id of x[want] || []) {
        const p = placeById.get(id);
        if (!p) { problems.push(`${where}: expect.${want} names unknown place "${id}"`); continue; }
        if (!from) continue;
        const d = haversine(from, [p.lon, p.lat]);
        const r = await lineOfSight(dem, from, [p.lon, p.lat], { observerH: obsH, targetH: tgtH });
        const radius = (a.radiusKm ?? 12) * 1000;
        if (want === 'visible' && d > radius) problems.push(`${where}: ${id} is ${(d / 1000).toFixed(1)} km away, outside the ${radius / 1000} km radius`);
        else if ((want === 'visible') !== r.visible)
          problems.push(`${where}: expected ${id} ${want}, but it is ${r.visible ? 'visible' : 'hidden'} from ${fmt(from)}${r.visible ? '; find dead ground with: tow.mjs hidden' : ''}`);
      }
    }
  }

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
    if (p.kind === 'region') continue; // a label, placed wherever it reads best
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
  const { scenario: sc } = normalizeScenario(raw);
  let moved = 0;
  // For each pass, the neighbouring waypoints of a terrain route through it.
  const neighbours = (id) => {
    for (const r of raw.routes || []) {
      const i = (r.waypoints || []).indexOf(id);
      if (i <= 0 || i >= r.waypoints.length - 1) continue;
      const nr = sc.routes.find((x) => x.id === r.id);
      if (nr) return [nr.waypoints[i - 1], nr.waypoints[i + 1]];
    }
    return null;
  };
  for (const p of raw.places || []) {
    if (p.kind !== 'mountain' && p.kind !== 'pass') continue;
    if (p.snap === false) continue; // the author placed it deliberately
    await dem.prefetchPoints([[p.lon, p.lat]], 13);
    const e = dem.elevAt(p.lon, p.lat, 13);
    let target;
    if (p.kind === 'mountain') target = await highPointNear([p.lon, p.lat]);
    else {
      const nb = neighbours(p.id);
      if (!nb) { console.log(`  snap ${p.id}: pass is not a waypoint inside a route; left as is`); continue; }
      target = await colOnRoute([p.lon, p.lat], ...nb);
      if (!target) { console.log(`  snap ${p.id}: no crossing found near it; left as is (check it)`); continue; }
    }
    const shift = haversine([p.lon, p.lat], target.at);
    if (Math.abs(target.elev - e) > 30 && shift > 60) {
      console.log(`  snap ${p.id} (${p.kind}): ${fmt([p.lon, p.lat])} (${Math.round(e)} m) -> ${fmt(target.at)} (${Math.round(target.elev)} m), ${Math.round(shift)} m away`);
      [p.lon, p.lat] = target.at.map((v) => +v.toFixed(4));
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

/** Add a scenario's places that the gazetteer does not have yet. */
function addToGazetteer(file) {
  const raw = readJSON(file);
  const doc = fs.existsSync(GAZETTEER) ? readJSON(GAZETTEER) : { places: [] };
  const ids = new Set(doc.places.map((g) => g.id));
  const added = [];
  const skipped = [];
  for (const p of raw.places || []) {
    if (gazMatches(doc.places, p).length) continue;
    // Camps and positions described rather than named belong to one telling of one battle.
    if (p.gazetteer === false || p.kind === 'camp') { skipped.push(p.id); continue; }
    const zhFull = p.zh?.name || p.nameLocal || '';
    let id = p.id.replace(/^r-/, '');
    if (ids.has(id)) id = `${id}-${path.basename(file, '.json')}`;
    for (let n = 2; ids.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
    const g = {
      id,
      zh: zhFull.split(/[（(]/)[0].trim(), name: p.name.split(' (')[0].trim(), kind: p.kind, lon: p.lon, lat: p.lat,
    };
    if (p.approximate) g.approximate = true;
    const aliases = [zhFull, p.name, p.nameLocal].filter((a) => a && a !== g.zh && a !== g.name);
    if (aliases.length) g.aliases = [...new Set(aliases)];
    doc.places.push(g);
    ids.add(g.id);
    added.push(`${g.id} (${g.zh || g.name})`);
  }
  let out = JSON.stringify(doc, null, 1).replace(/\n\s+("(?:lon|lat|kind|approximate)")/g, ' $1');
  fs.writeFileSync(GAZETTEER, out + '\n');
  console.log(added.length ? `  added ${added.length}: ${added.join(', ')}` : '  nothing new');
  if (skipped.length) console.log(`  not added (camps or "gazetteer": false): ${skipped.join(', ')}`);
}

/**
 * Dead ground: points within km of `near` that none of the observers can see (a man
 * standing there, from a lookout observerH up). For placing hidden troops where the
 * terrain really hides them, rather than where a text loosely puts them.
 */
async function hidden(file, refs, { near, km = 5, h = 15 }) {
  const { scenario: sc } = normalizeScenario(readJSON(file));
  const at = (ref) => {
    const p = sc.places.find((x) => x.id === ref);
    if (p) return [p.lon, p.lat];
    const ll = ref.split(',').map(Number);
    if (ll.length === 2 && ll.every(Number.isFinite)) return ll;
    throw new Error(`"${ref}" is neither a place id nor lon,lat`);
  };
  const observers = refs.map(at), centre = at(near ?? refs[0]);
  const step = (km * 1000) / 10, kx = 111320 * Math.cos((centre[1] * Math.PI) / 180);
  const found = [];
  let total = 0;
  for (let dy = -km * 1000; dy <= km * 1000; dy += step)
    for (let dx = -km * 1000; dx <= km * 1000; dx += step) {
      if (Math.hypot(dx, dy) > km * 1000) continue;
      total++;
      const pt = [centre[0] + dx / kx, centre[1] + dy / 111320];
      let seen = false;
      for (const o of observers) if ((seen = (await lineOfSight(dem, o, pt, { observerH: h, targetH: 2 })).visible)) break;
      if (!seen) {
        await dem.prefetchPoints([pt], 12);
        found.push({ pt, d: Math.hypot(dx, dy), elev: dem.elevAt(pt[0], pt[1], 12) });
      }
    }
  console.log(`  ${found.length} of ${total} sample points within ${km} km of ${fmt(centre)} are hidden from ${refs.join(', ')} (eye ${h} m):`);
  const picked = [];
  for (const f of found.sort((a, b) => a.d - b.d)) {
    if (picked.some((p) => haversine(p.pt, f.pt) < step * 2.5)) continue;
    picked.push(f);
    console.log(`    [${f.pt[0].toFixed(4)}, ${f.pt[1].toFixed(4)}]  ${(f.d / 1000).toFixed(1)} km from centre, ${Math.round(f.elev)} m`);
    if (picked.length >= 10) break;
  }
}

function place(query) {
  const q = query.trim().toLowerCase();
  const hits = gazetteer().filter((g) => [g.id, g.name, g.zh, ...(g.aliases || [])].some((n) => n && n.toLowerCase().includes(q)));
  if (!hits.length) console.log(`no gazetteer entry for "${query}"`);
  for (const g of hits) {
    const flags = [g.approximate && 'approximate', g.source === 'estimated' && 'estimated, not checked against a reference'].filter(Boolean);
    console.log(`${g.id}: ${g.zh || ''} ${g.name} — ${fmt([g.lon, g.lat])}${flags.length ? ` (${flags.join('; ')})` : ''}`);
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
  else if (cmd === 'gazetteer' && args.length) for (const f of args) addToGazetteer(f);
  else if (cmd === 'hidden' && args.length >= 2) {
    const flag = (k) => { const i = args.indexOf(`--${k}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
    const near = flag('near'), km = +(flag('km') ?? 5), h = +(flag('h') ?? 15);
    await hidden(args[0], args.slice(1), { near, km, h });
  }
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
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n').replace(/^\/\/ ?/gm, ''));
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
