// Scenario format: loading, validation and conversion to GeoJSON.
// See README.md for the full schema; tools/article_to_scenario.py emits the same shape.

export const SIDE_PALETTE = ['#d64545', '#2f6fde', '#2e9e5b', '#c77d12', '#8a4fd1', '#1a9aa6'];

export const ROUTE_KINDS = ['advance', 'retreat', 'supply', 'feint', 'planned', 'road', 'river'];
export const ZONE_KINDS = ['ambush', 'killzone', 'defense', 'obstacle', 'control', 'flood', 'forest', 'marsh'];
export const PLACE_KINDS = ['city', 'fort', 'pass', 'mountain', 'river', 'battle', 'camp', 'port', 'landmark', 'region'];

const ZONE_STYLE = {
  ambush: { color: '#ff3b30' },
  killzone: { color: '#ff2d55' },
  defense: { color: '#2f8fd8' },
  obstacle: { color: '#6e6e73' },
  control: { color: '#ffcc00' },
  flood: { color: '#0a84ff' },
  forest: { color: '#248a3d' },
  marsh: { color: '#40b8e0' },
};
export { ZONE_STYLE };

const isLonLat = (p) =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

export function normalizeScenario(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') throw new Error('Scenario must be a JSON object');
  const sc = structuredClone(raw);
  sc.title ||= 'Untitled scenario';
  sc.sides = (sc.sides || []).map((s, i) => ({ ...s, color: s.color || SIDE_PALETTE[i % SIDE_PALETTE.length] }));
  const sideColor = Object.fromEntries(sc.sides.map((s) => [s.id, s.color]));

  const ids = new Set();
  const claim = (obj, prefix, i) => {
    obj.id ||= `${prefix}${i}`;
    if (ids.has(obj.id)) warnings.push(`Duplicate id "${obj.id}"`);
    ids.add(obj.id);
  };

  sc.places = (sc.places || []).filter((p, i) => {
    claim(p, 'place', i);
    if (!isLonLat([p.lon, p.lat])) { warnings.push(`Place "${p.id}" has no valid lon/lat`); return false; }
    if (!PLACE_KINDS.includes(p.kind)) p.kind = 'landmark';
    p.color = sideColor[p.side] || '#f2f2f7';
    return true;
  });
  const placeById = Object.fromEntries(sc.places.map((p) => [p.id, p]));
  const resolve = (ref) => (typeof ref === 'string' ? placeById[ref] && [placeById[ref].lon, placeById[ref].lat] : ref);

  sc.routes = (sc.routes || []).filter((r, i) => {
    claim(r, 'route', i);
    // Waypoints may be [lon, lat] pairs or place ids.
    r.waypoints = (r.waypoints || r.coords || []).map(resolve).filter(isLonLat);
    delete r.coords;
    if (r.waypoints.length < 2) { warnings.push(`Route "${r.id}" needs at least two valid waypoints`); return false; }
    if (!ROUTE_KINDS.includes(r.kind)) r.kind = 'advance';
    r.color = r.kind === 'road' ? '#e0c28a' : r.kind === 'river' ? '#2f7fd8' : sideColor[r.side] || '#ffffff';
    r.geometry = r.waypoints; // replaced by the traced path when follow === 'terrain'
    if (r.path && r.pathKey === routeKey(r)) {
      // Pre-computed by `node tools/tow.mjs bake`: same algorithm, no tracing at load.
      Object.assign(r, { geometry: r.path, traced: true, hours: r.pathHours ?? null });
      if (r.pathProfile) r.profile = profileFromBaked(r.path, r.pathProfile);
    } else if (r.path) {
      warnings.push(`Route "${r.id}" changed since it was baked; tracing it again`);
      delete r.path;
    }
    return true;
  });

  sc.zones = (sc.zones || []).filter((z, i) => {
    claim(z, 'zone', i);
    if (!ZONE_KINDS.includes(z.kind)) z.kind = 'control';
    if (z.center) z.center = resolve(z.center);
    if (Array.isArray(z.line)) z.line = z.line.map(resolve).filter(isLonLat);
    if (Array.isArray(z.coords) && z.coords.length >= 3 && z.coords.every(isLonLat)) z.ring = z.coords;
    else if (isLonLat(z.center) && z.radiusKm > 0) z.ring = circleRing(z.center, z.radiusKm);
    else if (z.line?.length >= 2) z.ring = bufferLine(z.line, z.widthKm || 4);
    else { warnings.push(`Zone "${z.id}" needs coords (polygon), center + radiusKm, or line + widthKm`); return false; }
    z.color = ZONE_STYLE[z.kind].color;
    return true;
  });

  sc.overlays = (sc.overlays || []).filter((o, i) => {
    claim(o, 'overlay', i);
    if (!o.url) { warnings.push(`Overlay "${o.id}" has no url`); return false; }
    o.type ||= o.coordinates ? 'image' : 'xyz';
    o.opacity ??= 0.7;
    return true;
  });

  sc.steps = (sc.steps || []).map((s, i) => ({ title: `Step ${i + 1}`, text: '', ...s }));
  if (!sc.steps.length) sc.steps = [{ title: sc.title, text: sc.summary || '' }];
  for (const s of sc.steps) {
    for (const id of [...(s.show || []), ...(s.focus || [])])
      if (!ids.has(id)) warnings.push(`Step "${s.title}" references unknown id "${id}"`);
    if (s.analysis) {
      const a = s.analysis;
      for (const k of ['from', 'to', 'at']) if (a[k]) a[k] = resolve(a[k]);
      if (Array.isArray(a.coords)) a.coords = a.coords.map(resolve).filter(isLonLat);
    }
  }
  sc.camera ||= cameraFor(allCoords(sc));
  return { scenario: sc, warnings };
}

/** Expand a baked [distance, elevation] profile into chart points along the path. */
function profileFromBaked(path, samples) {
  const R = 6371008.8, rad = Math.PI / 180;
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad), y = (b[1] - a[1]) * rad;
    cum.push(cum[i - 1] + R * Math.hypot(x, y));
  }
  // Baked distances follow the raster cells, slightly longer than the simplified line.
  const scale = cum[cum.length - 1] / (samples[samples.length - 1][0] || 1);
  let k = 0;
  return samples.map(([d, elev]) => {
    const t = d * scale;
    while (k < cum.length - 2 && cum[k + 1] < t) k++;
    const f = cum[k + 1] > cum[k] ? (t - cum[k]) / (cum[k + 1] - cum[k]) : 0;
    const a = path[k], b = path[k + 1] || a;
    return { lon: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f, d, elev };
  });
}

/**
 * Fingerprint of what a traced route depends on (mode and resolved waypoints). A
 * pre-computed path is used only while it still matches, so moving a place or a
 * waypoint makes the app trace the route again instead of drawing a stale line.
 */
export function routeKey(r) {
  return JSON.stringify([r.follow, r.waypoints.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)])]);
}

export function allCoords(sc) {
  return [
    ...sc.places.map((p) => [p.lon, p.lat]),
    ...sc.routes.flatMap((r) => r.waypoints),
    ...sc.zones.flatMap((z) => z.ring),
  ];
}

export function cameraFor(coords) {
  if (!coords.length) return { center: [0, 20], zoom: 2 };
  const lons = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
  return { bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], pitch: 50 };
}

export function circleRing([lon, lat], radiusKm, n = 72) {
  const ring = [];
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    ring.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return ring;
}

/** Polygon ring for a corridor of widthKm around a polyline (a defensive line, a river). */
export function bufferLine(line, widthKm) {
  const kx = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);
  const half = widthKm / 2;
  const left = [], right = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const k = kx(line[i][1]);
    const dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * 111.32;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // unit normal, km space
    left.push([line[i][0] + (nx * half) / k, line[i][1] + (ny * half) / 111.32]);
    right.push([line[i][0] - (nx * half) / k, line[i][1] - (ny * half) / 111.32]);
  }
  return [...left, ...right.reverse(), left[0]];
}

export function routesGeoJSON(sc) {
  return {
    type: 'FeatureCollection',
    features: sc.routes.map((r) => ({
      type: 'Feature',
      properties: { id: r.id, name: r.name || r.id, kind: r.kind, color: r.color, side: r.side || '' },
      geometry: { type: 'LineString', coordinates: r.geometry },
    })),
  };
}

export function zonesGeoJSON(sc) {
  const ring = (c) => (c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1] ? c : [...c, c[0]]);
  return {
    type: 'FeatureCollection',
    features: sc.zones.map((z) => ({
      type: 'Feature',
      properties: { id: z.id, name: z.name || z.id, kind: z.kind, color: z.color },
      geometry: { type: 'Polygon', coordinates: [ring(z.ring)] },
    })),
  };
}

// Small inline SVG glyphs for place markers (no font or sprite server needed).
export const PLACE_ICONS = {
  city: '<circle cx="12" cy="12" r="7" fill="currentColor"/><circle cx="12" cy="12" r="3" fill="#111"/>',
  fort: '<path d="M4 20V8h3v3h2V8h2v3h2V8h2v3h2V8h3v12z" fill="currentColor"/>',
  pass: '<path d="M2 20 8 6l4 8 4-8 6 14z" fill="currentColor"/><path d="M12 14v6" stroke="#111" stroke-width="2"/>',
  mountain: '<path d="M2 20 10 5l5 8 2-3 5 10z" fill="currentColor"/>',
  river: '<path d="M2 9c3-3 5 3 8 0s5 3 8 0 4 0 4 0M2 15c3-3 5 3 8 0s5 3 8 0 4 0 4 0" stroke="currentColor" stroke-width="2.5" fill="none"/>',
  battle: '<path d="m4 4 16 16M20 4 4 20" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>',
  camp: '<path d="M12 4 3 20h18z" fill="currentColor"/><path d="M12 12l-3 8h6z" fill="#111"/>',
  port: '<path d="M12 3v15M7 8h10M5 14c0 4 3 6 7 6s7-2 7-6" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
  landmark: '<path d="M12 2 15 9l7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill="currentColor"/>',
};
