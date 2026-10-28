// Map, story player and terrain tools. The map is a flat (2D, north-up) map; relief
// is shown with hypsometric tint, hillshade and contours.

import { DemSource, TERRARIUM } from './dem.js';
import { elevationProfile, profileStats, lineOfSight, viewshed, leastCostRoute, lineLength, haversine, bboxOf } from './analysis.js';
import { normalizeScenario, routesGeoJSON, zonesGeoJSON, PLACE_ICONS, ZONE_STYLE, cameraFor, allCoords } from './scenario.js';
import { renderProfile } from './chart.js';
import { registerReliefProtocols, elevationRange, rampCss } from './relief.js';
import { t, tr, names, getLang, setLang, translateDom } from './i18n.js';
import { generateScenario, GenerateError } from './generate.js';

const $ = (s) => document.querySelector(s);
const dem = new DemSource(TERRARIUM);
const EMPTY = { type: 'FeatureCollection', features: [] };
/** Filter expression: feature property `prop` is one of `values`. */
const inList = (prop, values) => {
  const v = [...new Set(values)];
  return ['match', ['get', prop], v.length ? v : ['\u0000'], true, false];
};

const BASEMAPS = {
  s2: {
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'],
    maxzoom: 15,
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2016</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0',
  },
  esri: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 18,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  otm: {
    tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'],
    maxzoom: 17,
    attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC BY-SA)',
  },
};

const state = {
  scenario: null,
  step: 0,
  markers: [],
  tool: null,
  picks: [],
  dash: null,
  focusRoutes: [],
  generated: new Map(), // "generated:<title>" -> scenario made from text on this device
  runId: 0, // bumped whenever an analysis starts or is cleared; stale async results are dropped
};

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

registerReliefProtocols(maplibregl, dem);

// Rivers, streams and lakes from OpenStreetMap (OpenMapTiles schema, served free by
// OpenFreeMap). Names follow the interface language.
const OSM_ATTRIBUTION = '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const osmName = () => (getLang() === 'zh'
  ? ['coalesce', ['get', 'name:zh'], ['get', 'name:zh-Hans'], ['get', 'name']]
  : ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']]);
const OSM_LAYERS = ['osm-water', 'osm-streams', 'osm-rivers', 'osm-river-labels', 'osm-lake-labels'];

const style = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    ...Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => [`base-${k}`, { type: 'raster', tileSize: 256, ...b }])),
    hypso: { type: 'raster', tiles: ['hypso://{z}/{x}/{y}?lo=0&hi=3000'], tileSize: 256, maxzoom: 12, attribution: TERRARIUM.attribution },
    contours: { type: 'raster', tiles: ['contour://{z}/{x}/{y}'], tileSize: 256, minzoom: 5, maxzoom: 13 },
    labels: {
      type: 'raster', tileSize: 256, maxzoom: 18,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Labels © Esri',
    },
    'dem-shade': { type: 'raster-dem', tiles: [TERRARIUM.url], encoding: 'terrarium', tileSize: 256, maxzoom: 15 },
    zones: { type: 'geojson', data: EMPTY },
    routes: { type: 'geojson', data: EMPTY },
    analysis: { type: 'geojson', data: EMPTY },
    cursor: { type: 'geojson', data: EMPTY },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#c9c2b0' } },
    ...Object.keys(BASEMAPS).map((k) => ({ id: `base-${k}`, type: 'raster', source: `base-${k}`, layout: { visibility: 'none' } })),
    { id: 'hypso', type: 'raster', source: 'hypso', paint: { 'raster-fade-duration': 0 } },
    {
      id: 'hillshade', type: 'hillshade', source: 'dem-shade',
      // Strong, embossed relief in the manner of printed Chinese relief maps.
      paint: { 'hillshade-exaggeration': 0.85, 'hillshade-shadow-color': '#4a2c12', 'hillshade-highlight-color': '#fffaf0', 'hillshade-accent-color': '#5a3a1e', 'hillshade-illumination-anchor': 'map' },
    },
    { id: 'contours', type: 'raster', source: 'contours', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0, 'raster-opacity': 0.85 } },
    { id: 'overlays-anchor', type: 'background', paint: { 'background-opacity': 0 } },
    { id: 'labels', type: 'raster', source: 'labels', layout: { visibility: 'none' } },
    { id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 } },
    { id: 'zones-line', type: 'line', source: 'zones', filter: ['!=', ['get', 'kind'], 'obstacle'], paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [3, 2] } },
    {
      id: 'routes-casing', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
      filter: ['!', inList('kind', ['road', 'river'])],
      paint: { 'line-color': '#000', 'line-opacity': 0.55, 'line-width': 7, 'line-blur': 1 },
    },
    {
      id: 'routes-solid', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
      filter: inList('kind', ['advance', 'supply', 'river']),
      paint: { 'line-color': ['get', 'color'], 'line-width': ['match', ['get', 'kind'], 'supply', 2.5, 'river', 3.2, 4] },
    },
    {
      id: 'routes-dashed', type: 'line', source: 'routes', layout: { 'line-join': 'round' },
      filter: inList('kind', ['retreat', 'feint', 'planned']),
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-dasharray': [2, 1.5] },
    },
    {
      id: 'routes-road', type: 'line', source: 'routes', layout: { 'line-join': 'round' },
      filter: ['==', ['get', 'kind'], 'road'],
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [0.5, 1.5] },
    },
    {
      id: 'routes-flow', type: 'line', source: 'routes',
      filter: inList('id', []),
      paint: { 'line-color': '#fff', 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [0, 4, 3] },
    },
    {
      id: 'routes-arrows', type: 'symbol', source: 'routes',
      filter: ['!', inList('kind', ['road', 'river'])],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'icon-image': 'chevron', 'icon-size': 0.55, 'icon-allow-overlap': true, 'icon-rotation-alignment': 'map' },
      paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#000', 'icon-halo-width': 1 },
    },
    { id: 'routes-hit', type: 'line', source: 'routes', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } },
    {
      id: 'analysis-draft', type: 'line', source: 'analysis', filter: ['==', ['get', 'role'], 'draft'],
      paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 2] },
    },
    {
      id: 'analysis-line', type: 'line', source: 'analysis',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'role'], 'draft']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'role'], 'los-blocked', '#ff6b6b', 'los-clear', '#63e6a0', 'march', '#ffd60a', '#ffffff'],
        'line-width': ['match', ['get', 'role'], 'march', 4, 3],
      },
    },
    {
      id: 'analysis-pts', type: 'circle', source: 'analysis', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': ['match', ['get', 'role'], 'block', '#ff6b6b', '#ffd60a'], 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 },
    },
    { id: 'cursor', type: 'circle', source: 'cursor', paint: { 'circle-radius': 6, 'circle-color': '#ffd60a', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 } },
  ],
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [107.5, 34],
  zoom: 6,
  pitch: 0,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.FullscreenControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

function chevronImage() {
  const size = 48, c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(16, 10); ctx.lineTo(34, 24); ctx.lineTo(16, 38); ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

// Scenario rivers are traced from the DEM; once OpenStreetMap rivers are showing, draw
// only their labels so the two lines do not double up. Without OSM they stay as lines.
state.osmOk = false;
map.on('sourcedata', (e) => {
  if (e.sourceId === 'osm' && e.isSourceLoaded && !state.osmOk && map.querySourceFeatures('osm', { sourceLayer: 'waterway' }).length) {
    state.osmOk = true;
    applyStepVisibility();
  }
});
map.on('error', (e) => {
  if (e.sourceId === 'osm' || /openfreemap/.test(e.error?.url || e.error?.message || '')) return; // optional layer
  console.warn(e.error || e);
});

/**
 * Add the OpenStreetMap water layers. Done after the map has loaded: if the tile
 * service is unreachable, only these layers are missing instead of the whole map
 * never finishing its style load.
 */
function addOsmLayers() {
  map.addSource('osm', { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: OSM_ATTRIBUTION });
  for (const layer of [
    { id: 'osm-water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#8cc0ea', 'fill-opacity': 0.95 } },
    {
      id: 'osm-streams', type: 'line', source: 'osm', 'source-layer': 'waterway', minzoom: 9,
      filter: ['==', ['get', 'class'], 'stream'],
      paint: { 'line-color': '#3b86d8', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.5] },
    },
    {
      id: 'osm-rivers', type: 'line', source: 'osm', 'source-layer': 'waterway',
      filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#2f7fd8', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 7, 1.6, 10, 2.4, 14, 4] },
    },
  ]) map.addLayer(layer, 'overlays-anchor');
  for (const layer of [
    {
      id: 'osm-river-labels', type: 'symbol', source: 'osm', 'source-layer': 'waterway', minzoom: 6,
      filter: ['==', ['get', 'class'], 'river'],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 400, 'text-field': osmName(), 'text-font': ['Noto Sans Bold'], 'text-size': 12.5, 'text-letter-spacing': 0.2, 'text-max-angle': 30 },
      paint: { 'text-color': '#1f5fbf', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
    },
    {
      id: 'osm-lake-labels', type: 'symbol', source: 'osm', 'source-layer': 'water_name',
      filter: ['==', ['get', 'class'], 'lake'],
      layout: { 'text-field': osmName(), 'text-font': ['Noto Sans Bold'], 'text-size': 12 },
      paint: { 'text-color': '#1f5fbf', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
    },
  ]) map.addLayer(layer, 'cursor');
}

map.on('load', async () => {
  map.addImage('chevron', chevronImage(), { sdf: true });
  addOsmLayers();
  setLang(getLang());
  translateUI();
  bindUI();
  await loadScenarioList();
});

function translateUI() {
  translateDom();
  $('#lang-toggle').textContent = getLang() === 'zh' ? 'EN' : '中文';
  $('#overlay-hint').innerHTML = t('overlay.hint', {
    allmaps: '<a href="https://allmaps.org" target="_blank" rel="noopener">Allmaps</a> (<code>https://allmaps.xyz/maps/&lt;id&gt;/{z}/{x}/{y}.png</code>)',
    warper: '<a href="https://mapwarper.net" target="_blank" rel="noopener">Map Warper</a> (<code>https://mapwarper.net/maps/tile/&lt;id&gt;/{z}/{x}/{y}.png</code>)',
  });
  $('#tool-hint').textContent = state.tool ? t(`hint.${state.tool}`) : '';
  $('#elev-bar').style.background = rampCss();
}

function renderScenarioOptions() {
  const sel = $('#scenario-select');
  const current = sel.value;
  const opts = [
    ...[...(state.generated || new Map())].map(([key, sc]) => new Option(`✦ ${tr(sc, 'title')} (${t('gen.generated')})`, key)),
    ...(state.index || []).map((s) => new Option(`${tr(s, 'title')} (${tr(s, 'period')})`, s.file)),
  ];
  // Keep an entry for a scenario loaded from a URL or file that is not in the index.
  if (state.source && !opts.some((o) => o.value === state.source)) opts.push(new Option(state.source, state.source));
  sel.replaceChildren(...opts);
  if (current) sel.value = current;
}

/** (Re)build everything that shows scenario text, e.g. after a language switch. */
function renderScenarioContent() {
  renderMarkers();
  renderLegend();
  renderStepList();
  renderOverlayList();
}

/** Stretch the elevation tint over the heights found in the scenario's area. */
async function fitElevationTint(sc) {
  const coords = allCoords(sc);
  if (!coords.length) return;
  const [lo, hi] = sc.elevationRange || await elevationRange(dem, bboxOf(coords, 0.1, 10000));
  if (state.scenario !== sc) return;
  map.getSource('hypso').setTiles([`hypso://{z}/{x}/{y}?lo=${lo}&hi=${hi}`]);
  $('#elev-bar').style.background = rampCss();
  $('#elev-lo').textContent = `${lo}`;
  $('#elev-mid').textContent = `${Math.round((lo + hi) / 2)}`;
  $('#elev-hi').textContent = `${hi}`;
}

// ---------------------------------------------------------------------------
// Status & helpers
// ---------------------------------------------------------------------------

let statusTimer;
function status(msg, ms = 0) {
  const s = $('#status');
  clearTimeout(statusTimer);
  if (!msg) { s.hidden = true; return; }
  s.textContent = msg;
  s.hidden = false;
  if (ms) statusTimer = setTimeout(() => (s.hidden = true), ms);
}

const fmtKm = (m) => (m >= 10000 ? `${(m / 1000).toFixed(0)} km` : `${(m / 1000).toFixed(1)} km`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paragraphs = (t) => esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

function fmtHours(h) {
  return h < 24 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days (24 h walking)`;
}

/** March estimate: armies covered ~8 h of marching per day at well below hiking pace. */
function marchDays(hours) {
  return `${Math.max(1, Math.round((hours * 1.6) / 8))}`;
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

async function loadScenarioList() {
  const sel = $('#scenario-select');
  let list = [];
  try {
    list = await (await fetch('scenarios/index.json')).json();
  } catch (e) {
    status(t('status.noindex'), 8000);
  }
  state.index = list;
  renderScenarioOptions();
  const params = new URLSearchParams(location.search);
  const want = params.get('scenario') || list[0]?.file;
  if (want) {
    state.source = want;
    renderScenarioOptions();
    sel.value = want;
    await loadScenarioFromUrl(want, +(params.get('step') || 1) - 1);
  }
}

async function loadScenarioFromUrl(url, step = 0) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadScenario(await res.json(), step, url);
  } catch (e) {
    status(t('status.loadfail', { url, err: e.message }), 8000);
  }
}

async function loadScenario(raw, step = 0, source = null) {
  const { scenario, warnings } = normalizeScenario(raw);
  state.scenario = scenario;
  state.source = source;
  const w = $('#warnings');
  w.hidden = !warnings.length;
  w.innerHTML = warnings.map((x) => `⚠ ${esc(x)}`).join('<br>');

  clearAnalysis();
  renderOverlays();
  renderScenarioContent();
  map.getSource('zones').setData(zonesGeoJSON(scenario));
  map.getSource('routes').setData(routesGeoJSON(scenario));
  goToStep(Math.max(0, Math.min(step, scenario.steps.length - 1)), { instant: true });
  fitElevationTint(scenario);
  await traceTerrainRoutes(scenario);
}

/** Replace routes flagged follow: "terrain" with a least-cost path through the DEM. */
async function traceTerrainRoutes(sc) {
  const todo = sc.routes.filter((r) => ['terrain', 'valley'].includes(r.follow) && !r.traced);
  for (const [i, r] of todo.entries()) {
    status(t('status.tracing', { name: names(r)[0], i: i + 1, n: todo.length }));
    try {
      const valley = r.follow === 'valley';
      const res = await leastCostRoute(dem, r.waypoints, { mode: valley ? 'valley' : 'march' });
      if (state.scenario !== sc) return;
      Object.assign(r, { geometry: res.coords, traced: true, hours: valley ? null : res.hours, profile: res.profile });
      map.getSource('routes').setData(routesGeoJSON(sc));
    } catch (e) {
      console.warn(e);
    }
  }
  status(todo.length ? t('status.traced') : '', 2500);
  renderRouteLabels();
  // A profile shown before tracing finished was drawn on the raw waypoints; redo it.
  const a = sc.steps[state.step]?.analysis;
  if (todo.length && a?.type === 'profile' && a.route) runStepAnalysis(a);
}

// ---------------------------------------------------------------------------
// Markers, labels, legend, overlays
// ---------------------------------------------------------------------------

function renderMarkers() {
  state.markers.forEach((m) => m.remove());
  state.markers = [];
  for (const p of state.scenario.places) {
    const el = document.createElement('div');
    el.className = 'place-marker';
    el.dataset.id = p.id;
    const [primary, secondary] = names(p);
    let marker;
    if (p.kind === 'region') {
      // Region names (basins, plains, ranges) are big spaced lettering, no symbol.
      el.className = 'region-label';
      el.innerHTML = `${esc(primary)}${secondary ? `<small>${esc(secondary)}</small>` : ''}`;
      marker = new maplibregl.Marker({ element: el, anchor: 'center' });
    } else {
      // Peaks are red triangles with their height, as on printed relief maps.
      const color = p.kind === 'mountain' ? '#d62d20' : p.color;
      el.innerHTML = `<svg viewBox="0 0 24 24" style="color:${color}">${PLACE_ICONS[p.kind]}</svg>` +
        `<span class="lbl">${esc(primary)}${secondary ? `<small>${esc(secondary)}</small>` : ''}` +
        `${p.kind === 'mountain' ? `<span class="peak">${p.peakElev ? fmtPeak(p.peakElev) : ''}</span>` : ''}` +
        `${p.approximate ? ' <span class="approx">≈</span>' : ''}</span>`;
      marker = new maplibregl.Marker({ element: el, anchor: 'left', offset: [-11, 0] });
    }
    marker
      .setLngLat([p.lon, p.lat])
      .setPopup(new maplibregl.Popup({ offset: 14, maxWidth: '300px' }).setDOMContent(placePopup(p)))
      .addTo(map);
    state.markers.push(marker);
  }
  renderRouteLabels();
  annotatePeaks(state.scenario);
}

const fmtPeak = (m) => (getLang() === 'zh' ? `${Math.round(m)}米` : `${Math.round(m).toLocaleString()} m`);

/** Height of each mountain from the DEM: the highest point within ~1.5 km of it. */
async function annotatePeaks(sc) {
  for (const p of sc.places.filter((x) => x.kind === 'mountain' && !x.peakElev)) {
    try {
      const g = await dem.grid(bboxOf([[p.lon, p.lat]], 0, 1500), 12);
      p.peakElev = Math.max(...g.data);
    } catch (e) {
      continue;
    }
    if (state.scenario !== sc) return;
    const el = state.markers.find((m) => m.getElement().dataset.id === p.id)?.getElement().querySelector('.peak');
    if (el) el.textContent = fmtPeak(p.peakElev);
  }
}

function placePopup(p) {
  const div = document.createElement('div');
  div.className = 'popup';
  const [primary, secondary] = names(p);
  div.innerHTML = `<h4>${esc(primary)} ${secondary ? `<small>${esc(secondary)}</small>` : ''}</h4>
    <div class="meta">${esc(t(`kind.${p.kind}`))}${p.side ? ` · ${esc(sideName(p.side))}` : ''} · ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}
    ${p.approximate ? `<span class="approx">· ${t('popup.approx')}</span>` : ''}</div>
    ${paragraphs(tr(p, 'note'))}
    <div class="row"><button class="btn small" data-act="vs">${t('popup.vs')}</button>
    <button class="btn small" data-act="elev">${t('popup.elev')}</button></div>`;
  div.querySelector('[data-act=vs]').onclick = () => runViewshed([p.lon, p.lat], primary);
  div.querySelector('[data-act=elev]').onclick = async (ev) => {
    await dem.prefetchPoints([[p.lon, p.lat]], 13);
    ev.target.textContent = t('popup.asl', { e: Math.round(dem.elevAt(p.lon, p.lat, 13)) });
  };
  return div;
}

let routeLabelMarkers = [];
function renderRouteLabels() {
  routeLabelMarkers.forEach((m) => m.remove());
  routeLabelMarkers = [];
  for (const r of state.scenario?.routes || []) {
    if (!r.name) continue;
    const g = r.geometry;
    // Label at the half-way point by length.
    const half = lineLength(g) / 2;
    let acc = 0, at = g[0];
    for (let i = 1; i < g.length; i++) {
      const seg = haversine(g[i - 1], g[i]);
      if (acc + seg >= half) {
        const t = (half - acc) / seg;
        at = [g[i - 1][0] + (g[i][0] - g[i - 1][0]) * t, g[i - 1][1] + (g[i][1] - g[i - 1][1]) * t];
        break;
      }
      acc += seg;
    }
    const el = document.createElement('div');
    el.className = r.kind === 'river' ? 'route-label river-label' : 'route-label';
    el.dataset.id = r.id;
    el.textContent = names(r)[0];
    routeLabelMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(at).addTo(map));
  }
  // Natural obstacles and forests get a region-style name in the middle of the area.
  for (const z of state.scenario?.zones || []) {
    if (!['obstacle', 'forest'].includes(z.kind) || !z.name) continue;
    const pts = z.line || z.ring.slice(0, -1);
    const at = z.line ? pts[Math.floor(pts.length / 2)]
      : [pts.reduce((a, c) => a + c[0], 0) / pts.length, pts.reduce((a, c) => a + c[1], 0) / pts.length];
    const el = document.createElement('div');
    el.className = 'region-label';
    el.dataset.id = z.id;
    el.textContent = names(z)[0];
    routeLabelMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(map));
  }
  applyStepVisibility();
}

function sideName(id) {
  return tr(state.scenario.sides.find((s) => s.id === id), 'name') || id;
}

function renderLegend() {
  const sc = state.scenario;
  const zoneKinds = [...new Set(sc.zones.map((z) => z.kind))];
  $('#legend').innerHTML =
    sc.sides.map((s) => `<span><i style="background:${s.color}"></i>${esc(tr(s, 'name'))}</span>`).join('') +
    zoneKinds.map((k) => `<span><i class="box" style="background:${ZONE_STYLE[k].color}"></i>${t(`zone.${k}`)}</span>`).join('') +
    (sc.routes.some((r) => r.kind === 'road') ? `<span><i style="background:#e0c28a"></i>${t('legend.road')}</span>` : '') +
    (sc.routes.some((r) => ['planned', 'feint', 'retreat'].includes(r.kind)) ? `<span><i style="background:repeating-linear-gradient(90deg,#ccc 0 4px,transparent 4px 7px)"></i>${t('legend.dashed')}</span>` : '');
}

const overlayLayers = new Set();
function renderOverlays() {
  for (const id of overlayLayers) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  overlayLayers.clear();
  for (const o of state.scenario.overlays) addOverlay(o);
}

function addOverlay(o) {
  const id = `ov-${o.id}`;
  const src = o.type === 'image'
    ? { type: 'image', url: o.url, coordinates: o.coordinates }
    : { type: 'raster', tiles: [o.url], tileSize: o.tileSize || 256, attribution: o.attribution || '' };
  if (o.type === 'image' && o.attribution) src.attribution = o.attribution;
  map.addSource(id, src);
  map.addLayer({
    id, type: 'raster', source: id,
    layout: { visibility: o.visible === false ? 'none' : 'visible' },
    paint: { 'raster-opacity': o.opacity, 'raster-fade-duration': 0 },
  }, 'overlays-anchor');
  overlayLayers.add(id);
}

function renderOverlayList() {
  const box = $('#overlay-list');
  box.replaceChildren();
  for (const o of state.scenario.overlays) {
    const id = `ov-${o.id}`;
    const item = document.createElement('div');
    item.className = 'overlay-item';
    const note = tr(o, 'note');
    item.innerHTML = `<input type="checkbox" ${o.visible === false ? '' : 'checked'}><span>${esc(tr(o, 'name') || o.id)}</span>
      <input type="range" min="0" max="1" step="0.05" value="${o.opacity}">
      ${note ? `<span class="note">${esc(note)}</span>` : ''}`;
    const [cb, , range] = item.children;
    cb.onchange = () => { o.visible = cb.checked; map.setLayoutProperty(id, 'visibility', cb.checked ? 'visible' : 'none'); };
    range.oninput = () => { o.opacity = +range.value; map.setPaintProperty(id, 'raster-opacity', +range.value); };
    box.append(item);
  }
}

// ---------------------------------------------------------------------------
// Story steps
// ---------------------------------------------------------------------------

function renderStepList() {
  const ol = $('#step-list');
  ol.replaceChildren(...state.scenario.steps.map((s, i) => {
    const li = document.createElement('li');
    li.textContent = tr(s, 'title');
    li.onclick = () => goToStep(i);
    return li;
  }));
}

function goToStep(i, { instant = false, keepCamera = false } = {}) {
  const sc = state.scenario;
  if (!sc || i < 0 || i >= sc.steps.length) return;
  state.step = i;
  const s = sc.steps[i];
  $('#step-title').textContent = tr(s, 'title');
  $('#step-text').innerHTML = paragraphs(tr(s, 'text'));
  $('#step-count').textContent = `${tr(sc, 'title')} · ${i + 1} / ${sc.steps.length}`;
  [...$('#step-list').children].forEach((li, k) => li.classList.toggle('current', k === i));
  $('#prev-step').disabled = i === 0;
  $('#next-step').disabled = i === sc.steps.length - 1;

  const cam = s.camera || (i === 0 ? sc.camera : null) || cameraFor(focusCoords(s));
  if (!keepCamera) moveCamera(cam, instant);
  applyStepVisibility();
  if (s.analysis) runStepAnalysis(s.analysis);
  else clearAnalysis();

  const params = new URLSearchParams(location.search);
  if (state.source) params.set('scenario', state.source);
  params.set('step', i + 1);
  params.set('lang', getLang());
  history.replaceState(null, '', `?${params}`);
}

function focusCoords(s) {
  const sc = state.scenario;
  const ids = new Set(s.focus || s.show || []);
  const pick = { ...sc, places: sc.places.filter((p) => ids.has(p.id)), routes: sc.routes.filter((r) => ids.has(r.id)), zones: sc.zones.filter((z) => ids.has(z.id)) };
  const c = allCoords(pick);
  return c.length ? c : allCoords(sc);
}

// Flat, north-up map: scenario pitch/bearing (used by 3D viewers) are ignored.
function moveCamera(cam, instant) {
  const wide = window.innerWidth > 760;
  // Keep the subject clear of the side panel (desktop) or bottom sheet (phone).
  const panel = wide ? { top: 20, bottom: 20, left: 380, right: 20 } : { top: 20, bottom: window.innerHeight * 0.46, left: 0, right: 0 };
  const opts = { duration: instant ? 0 : 2000, essential: true };
  if (cam.bounds) map.fitBounds(cam.bounds, { ...opts, padding: { top: panel.top + 40, bottom: panel.bottom + 40, left: panel.left + 40, right: panel.right + 40 } });
  else map.flyTo({ ...opts, center: cam.center, zoom: cam.zoom ?? 9, padding: panel });
}

function applyStepVisibility() {
  const sc = state.scenario;
  if (!sc || !map.getLayer('routes-solid')) return;
  const s = sc.steps[state.step] || {};
  const show = s.show ? new Set([...s.show, ...(s.focus || [])]) : null;
  const focus = new Set(s.focus || []);
  const visible = (id) => !show || show.has(id);
  const dimmed = (id) => focus.size && !focus.has(id);

  const routeIds = sc.routes.filter((r) => visible(r.id)).map((r) => r.id);
  const zoneIds = sc.zones.filter((z) => visible(z.id)).map((z) => z.id);
  const opacity = (base) => ['case', inList('id', [...focus]), base, focus.size ? base * 0.3 : base];
  for (const l of ['routes-casing', 'routes-solid', 'routes-dashed', 'routes-road', 'routes-arrows', 'routes-hit']) {
    const base = baseFilters[l];
    const f = inList('id', routeIds);
    map.setFilter(l, base ? ['all', base, f] : f);
  }
  for (const l of ['routes-solid', 'routes-dashed', 'routes-road']) map.setPaintProperty(l, 'line-opacity', opacity(1));
  if (state.osmOk && $('#rivers-on').checked)
    map.setPaintProperty('routes-solid', 'line-opacity', ['case', ['==', ['get', 'kind'], 'river'], 0, opacity(1)]);
  map.setPaintProperty('routes-casing', 'line-opacity', opacity(0.55));
  map.setPaintProperty('routes-arrows', 'icon-opacity', opacity(1));
  for (const l of ['zones-fill', 'zones-line']) {
    const f = inList('id', zoneIds);
    map.setFilter(l, baseFilters[l] ? ['all', baseFilters[l], f] : f);
  }
  // Natural obstacles are shown by the relief itself plus a name, not a wash of colour.
  map.setPaintProperty('zones-fill', 'fill-opacity', ['case', ['==', ['get', 'kind'], 'obstacle'], 0, opacity(0.22)]);

  state.focusRoutes = sc.routes.filter((r) => focus.has(r.id) && r.kind !== 'road' && r.kind !== 'river').map((r) => r.id);
  map.setFilter('routes-flow', inList('id', state.focusRoutes));
  animateFlow();

  for (const m of state.markers) {
    const el = m.getElement(), id = el.dataset.id;
    el.style.display = visible(id) ? '' : 'none';
    el.classList.toggle('dim', !!dimmed(id));
    el.classList.toggle('focus', focus.has(id));
  }
  for (const m of routeLabelMarkers) {
    const id = m.getElement().dataset.id;
    m.getElement().style.display = visible(id) ? '' : 'none';
    m.getElement().style.opacity = dimmed(id) ? 0.35 : 1;
  }
}

const baseFilters = Object.fromEntries(style.layers.filter((l) => l.filter).map((l) => [l.id, l.filter]));

// Marching-ants animation on focused routes.
const DASH_SEQ = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
function animateFlow() {
  cancelAnimationFrame(state.dash);
  if (!state.focusRoutes.length) return;
  let k = 0, last = 0;
  const tick = (t) => {
    if (t - last > 70) {
      map.setPaintProperty('routes-flow', 'line-dasharray', DASH_SEQ[k = (k + 1) % DASH_SEQ.length]);
      last = t;
    }
    state.dash = requestAnimationFrame(tick);
  };
  state.dash = requestAnimationFrame(tick);
}

async function runStepAnalysis(a) {
  const sc = state.scenario;
  const obs = a.observerH ?? +$('#obs-h').value;
  const tgt = a.targetH ?? +$('#tgt-h').value;
  const label = tr(a, 'label');
  if (a.type === 'viewshed' && a.at) await runViewshed(a.at, label || t('vs.point'), a.radiusKm, obs, tgt);
  else if (a.type === 'los' && a.from && a.to) await runLOS(a.from, a.to, obs, tgt, label);
  else if (a.type === 'profile' && a.coords?.length >= 2) await runProfile(a.coords, label || t('profile.generic'));
  else if (a.type === 'profile') {
    const r = sc.routes.find((x) => x.id === a.route);
    if (r) await runProfile(r.geometry, label || t('profile.title', { name: names(r)[0] }), r, { keepLine: false });
  }
}

// ---------------------------------------------------------------------------
// Analysis display
// ---------------------------------------------------------------------------

function setAnalysis(features) {
  map.getSource('analysis').setData({ type: 'FeatureCollection', features });
}
const lineF = (coords, role) => ({ type: 'Feature', properties: { role }, geometry: { type: 'LineString', coordinates: coords } });
const ptF = (c, role = 'pick') => ({ type: 'Feature', properties: { role }, geometry: { type: 'Point', coordinates: c } });

function clearAnalysis() {
  state.runId++;
  if (!map.getSource('analysis')) return;
  setAnalysis([]);
  map.getSource('cursor').setData(EMPTY);
  removeViewshed();
  $('#drawer').hidden = true;
}

function removeViewshed() {
  if (map.getLayer('viewshed')) map.removeLayer('viewshed');
  if (map.getSource('viewshed')) map.removeSource('viewshed');
}

function openDrawer(title, statsHtml) {
  $('#drawer').hidden = false;
  $('#chart').hidden = false;
  $('#drawer-title').textContent = title;
  $('#drawer-stats').innerHTML = statsHtml;
}

const hoverCursor = (p) => map.getSource('cursor').setData(p ? ptF([p.lon, p.lat]) : EMPTY);

async function runProfile(coords, title, route = null, { keepLine = true } = {}) {
  const run = ++state.runId;
  status(t('status.sampling'));
  try {
    const prof = route?.profile
      ? { points: route.profile, stats: profileStats(route.profile) }
      : await elevationProfile(dem, coords);
    if (run !== state.runId) return;
    const s = prof.stats;
    if (keepLine) setAnalysis([lineF(coords, 'profile'), ...coords.map((c) => ptF(c))]);
    else { setAnalysis([]); removeViewshed(); }
    const hours = route?.hours;
    openDrawer(title, `
      <span>${t('st.length')} <b>${fmtKm(s.length)}</b></span>
      <span>${t('st.climb')} <b>${Math.round(s.ascent)} m</b> / ${t('st.descent')} <b>${Math.round(s.descent)} m</b></span>
      <span>${t('st.range')} <b>${Math.round(s.min)}–${Math.round(s.max)} m</b></span>
      <span>${t('st.steepest')} <b>${(s.maxGrade * 100).toFixed(0)}%</b> ${t('st.at')} ${fmtKm(s.maxGradeAt)}</span>
      ${hours ? `<span>${t('st.walk')} <b>${fmtHours(hours)}</b> · ${t('st.army')} <b>${t('st.days', { n: marchDays(hours) })}</b></span>` : ''}`);
    const markers = [];
    if (route) {
      // Mark named places that lie close to the route.
      for (const p of state.scenario.places) {
        let best = Infinity, at = 0;
        for (const q of prof.points) {
          const d = haversine([p.lon, p.lat], [q.lon, q.lat]);
          if (d < best) { best = d; at = q.d; }
        }
        if (best < 3000) markers.push({ d: at, label: names(p)[0] });
      }
    }
    renderProfile($('#chart'), prof.points, { onHover: hoverCursor, markers });
    status('');
  } catch (e) {
    status(t('status.failed', { what: t('profile.generic'), err: e.message }), 5000);
  }
}

async function runLOS(a, b, observerH, targetH, label) {
  const run = ++state.runId;
  status(t('status.los'));
  try {
    const r = await lineOfSight(dem, a, b, { observerH, targetH });
    if (run !== state.runId) return;
    const feats = [ptF(a), ptF(b)];
    if (r.blockedAt) {
      const bc = [r.blockedAt.lon, r.blockedAt.lat];
      feats.push(lineF([a, bc], 'los-clear'), lineF([bc, b], 'los-blocked'), ptF(bc, 'block'));
    } else feats.push(lineF([a, b], 'los-clear'));
    setAnalysis(feats);
    openDrawer(label || t('los.title'), `
      <span>${t('los.distance')} <b>${fmtKm(r.length)}</b></span>
      <span>${t('los.observer', { o: observerH, t: targetH })}</span>
      ${r.visible ? `<span class="good"><b>${t('los.visible')}</b></span>`
        : `<span class="bad"><b>${t('los.blocked', { d: fmtKm(r.blockedAt.d), m: Math.round(r.maxIntrusion) })}</b></span>`}`);
    renderProfile($('#chart'), r.points, { onHover: hoverCursor, blockedAt: r.blockedAt });
    status('');
  } catch (e) {
    status(t('status.failed', { what: t('los.title'), err: e.message }), 5000);
  }
}

async function runViewshed(center, label = t('vs.point'), radiusKm = +$('#vs-r').value, observerH = +$('#obs-h').value, targetH = +$('#tgt-h').value) {
  const run = ++state.runId;
  status(t('status.vs'));
  await new Promise((r) => setTimeout(r, 30)); // let the status paint
  try {
    const v = await viewshed(dem, center, radiusKm * 1000, { observerH, targetH });
    if (run !== state.runId) return;
    const c = document.createElement('canvas');
    c.width = v.width; c.height = v.height;
    c.getContext('2d').putImageData(new ImageData(v.rgba, v.width, v.height), 0, 0);
    removeViewshed();
    map.addSource('viewshed', { type: 'canvas', canvas: c, coordinates: v.corners, animate: false });
    map.addLayer({ id: 'viewshed', type: 'raster', source: 'viewshed', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, 'zones-fill');
    setAnalysis([ptF(center)]);
    openDrawer(t('vs.title', { name: label }), `
      <span>${t('vs.radius')} <b>${radiusKm} km</b></span>
      <span>${t('vs.ground', { e: Math.round(v.observerElev), o: observerH })}</span>
      <span><b>${t('vs.visible', { p: (v.visibleFraction * 100).toFixed(0) })}</b></span>
      <span class="muted">${t('vs.note')}</span>`);
    $('#chart').replaceChildren();
    $('#chart').hidden = true;
    status('');
  } catch (e) {
    status(t('status.failed', { what: t('tool.viewshed'), err: e.message }), 5000);
  }
}

async function runMarch(waypoints) {
  const run = ++state.runId;
  status(t('status.march'));
  await new Promise((r) => setTimeout(r, 30));
  try {
    const res = await leastCostRoute(dem, waypoints);
    if (run !== state.runId) return;
    await runProfile(res.coords, t('march.title'), { hours: res.hours, profile: res.profile }, { keepLine: false });
    setAnalysis([lineF(waypoints, 'draft'), lineF(res.coords, 'march'), ...waypoints.map((c) => ptF(c))]);
  } catch (e) {
    status(t('status.failed', { what: t('tool.march'), err: e.message }), 5000);
  }
}

// ---------------------------------------------------------------------------
// Interactive tools
// ---------------------------------------------------------------------------

function setTool(tool) {
  state.tool = state.tool === tool ? null : tool;
  state.picks = [];
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  $('#tool-hint').textContent = state.tool ? t(`hint.${state.tool}`) : '';
  $('#tool-finish').hidden = !['profile', 'march'].includes(state.tool);
  map.getCanvas().style.cursor = state.tool ? 'crosshair' : '';
  if (state.tool) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
}

function finishTool() {
  const pts = state.picks;
  if (pts.length >= 2) {
    if (state.tool === 'profile') runProfile(pts, t('profile.generic'));
    if (state.tool === 'march') runMarch(pts);
  }
  setTool(null);
}

function onMapClick(e) {
  if (!state.tool) {
    const hit = map.queryRenderedFeatures(e.point, { layers: ['routes-hit'] })[0];
    if (hit) routePopup(hit.properties.id, e.lngLat);
    return;
  }
  const c = [e.lngLat.lng, e.lngLat.lat];
  state.picks.push(c);
  const pts = state.picks;
  setAnalysis([...(pts.length > 1 ? [lineF(pts, 'draft')] : []), ...pts.map((p) => ptF(p))]);
  if (state.tool === 'viewshed') { runViewshed(c, `${c[1].toFixed(3)}, ${c[0].toFixed(3)}`); setTool(null); }
  else if (state.tool === 'los' && pts.length === 2) { runLOS(pts[0], pts[1], +$('#obs-h').value, +$('#tgt-h').value); setTool(null); }
}

function routePopup(id, lngLat) {
  const r = state.scenario.routes.find((x) => x.id === id);
  if (!r) return;
  const div = document.createElement('div');
  div.className = 'popup';
  const len = lineLength(r.geometry);
  const [primary, secondary] = names(r);
  div.innerHTML = `<h4>${esc(primary)} ${secondary ? `<small>${esc(secondary)}</small>` : ''}</h4>
    <div class="meta">${esc(t(`kind.${r.kind}`))}${r.side ? ` · ${esc(sideName(r.side))}` : ''} · ${fmtKm(len)}
    ${r.traced ? ` · ${t('popup.traced')}` : ''}</div>
    ${paragraphs(tr(r, 'note'))}
    <div class="row"><button class="btn small">${t('popup.profile')}</button></div>`;
  div.querySelector('button').onclick = () => runProfile(r.geometry, t('profile.title', { name: primary }), r, { keepLine: false });
  new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(div).addTo(map);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function bindUI() {
  $('#scenario-select').onchange = (e) => {
    const v = e.target.value;
    if (state.generated.has(v)) loadScenario(state.generated.get(v), 0, null);
    else if (v) loadScenarioFromUrl(v);
  };
  $('#prev-step').onclick = () => goToStep(state.step - 1);
  $('#next-step').onclick = () => goToStep(state.step + 1);
  $('#panel-toggle').onclick = () => {
    const p = $('#panel');
    p.classList.toggle('collapsed');
    $('#panel-toggle').textContent = p.classList.contains('collapsed') ? '⟩' : '⟨';
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowRight') goToStep(state.step + 1);
    if (e.key === 'ArrowLeft') goToStep(state.step - 1);
    if (e.key === 'Escape') setTool(null);
    if (e.key === 'Enter' && state.tool) finishTool();
  });

  $('#basemap').onchange = (e) => {
    const v = e.target.value;
    for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`base-${k}`, 'visibility', k === v ? 'visible' : 'none');
    map.setLayoutProperty('hypso', 'visibility', v === 'hypso' ? 'visible' : 'none');
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', v === 'hypso' ? 0.85 : 0.3);
    $('#elev-bar').style.opacity = v === 'hypso' ? 1 : 0.35;
  };
  $('#rivers-on').onchange = (e) => {
    for (const l of OSM_LAYERS) map.setLayoutProperty(l, 'visibility', e.target.checked ? 'visible' : 'none');
    applyStepVisibility();
  };
  $('#contours-on').onchange = (e) => map.setLayoutProperty('contours', 'visibility', e.target.checked ? 'visible' : 'none');
  $('#lang-toggle').onclick = () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    translateUI();
    for (const l of ['osm-river-labels', 'osm-lake-labels']) map.setLayoutProperty(l, 'text-field', osmName());
    renderScenarioOptions();
    if (state.scenario) {
      renderScenarioContent();
      goToStep(state.step, { instant: true, keepCamera: true });
    }
  };
  map.on('mousemove', (e) => {
    const h = dem.elevAtLoaded(e.lngLat.lng, e.lngLat.lat, Math.floor(map.getZoom()));
    $('#cursor-elev').textContent = h === null ? '' :
      `${t('cursor.elev', { e: Math.round(h).toLocaleString() })} · ${e.lngLat.lat.toFixed(3)}°, ${e.lngLat.lng.toFixed(3)}°`;
  });
  $('#hillshade-on').onchange = (e) => map.setLayoutProperty('hillshade', 'visibility', e.target.checked ? 'visible' : 'none');
  $('#labels-on').onchange = (e) => map.setLayoutProperty('labels', 'visibility', e.target.checked ? 'visible' : 'none');
  $('#xyz-add').onclick = () => {
    const url = $('#xyz-url').value.trim();
    if (!/^https?:\/\/.*\{z\}.*\{x\}.*\{y\}/.test(url)) { status(t('overlay.bad'), 4000); return; }
    const o = { id: `user${Date.now()}`, name: $('#xyz-name').value.trim() || t('overlay.default'), type: 'xyz', url, opacity: 0.75 };
    state.scenario.overlays.push(o);
    addOverlay(o);
    renderOverlayList();
    $('#xyz-url').value = $('#xyz-name').value = '';
  };

  document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $('#tool-finish').onclick = finishTool;
  $('#clear-analysis').onclick = () => { setTool(null); clearAnalysis(); };
  $('#drawer-close').onclick = clearAnalysis;
  map.on('click', onMapClick);
  map.on('dblclick', (e) => { if (state.tool) { e.preventDefault(); finishTool(); } });
  map.on('mouseenter', 'routes-hit', () => { if (!state.tool) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'routes-hit', () => { if (!state.tool) map.getCanvas().style.cursor = ''; });

  $('#file-input').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) await loadLocalFile(f);
    e.target.value = '';
  };
  const hint = $('#drop-hint');
  window.addEventListener('dragover', (e) => { e.preventDefault(); hint.hidden = false; });
  hint.addEventListener('dragleave', () => (hint.hidden = true));
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    hint.hidden = true;
    const f = e.dataTransfer.files[0];
    if (f) await loadLocalFile(f);
  });
  $('#export-btn').onclick = exportScenario;
  bindGenerator();
}

// ---------------------------------------------------------------------------
// Create from text
// ---------------------------------------------------------------------------

const KEY_STORE = 'tow-api-key';
const GEN_STORE = 'tow-generated';

function bindGenerator() {
  try {
    const saved = localStorage.getItem(KEY_STORE);
    if (saved) { $('#gen-key').value = saved; $('#gen-remember').checked = true; }
    // Scenarios generated earlier on this device (they cost money; don't lose them on reload).
    for (const sc of JSON.parse(localStorage.getItem(GEN_STORE) || '[]')) addGeneratedOption(sc);
  } catch { /* storage unavailable */ }

  let controller = null;
  $('#gen-cancel').onclick = () => controller?.abort();
  $('#gen-go').onclick = async () => {
    const text = $('#gen-text').value.trim(), apiKey = $('#gen-key').value.trim();
    const say = (msg) => ($('#gen-status').textContent = msg);
    if (!text || !apiKey) { say(t('gen.need')); return; }
    try {
      if ($('#gen-remember').checked) localStorage.setItem(KEY_STORE, apiKey);
      else localStorage.removeItem(KEY_STORE);
    } catch { /* ignore */ }

    controller = new AbortController();
    $('#gen-go').disabled = true;
    $('#gen-cancel').hidden = false;
    const started = Date.now();
    let progress = { phase: 'thinking', chars: 0 };
    const elapsed = () => { const s = Math.round((Date.now() - started) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const show = () => say(progress.phase === 'writing'
      ? t('gen.writing', { n: progress.chars.toLocaleString(), t: elapsed() })
      : t('gen.thinking', { t: elapsed() }));
    const timer = setInterval(show, 1000);
    show();
    try {
      const raw = await generateScenario({ apiKey, text, signal: controller.signal, onProgress: (p) => { progress = p; } });
      clearInterval(timer);
      say(t('gen.tracing'));
      rememberGenerated(raw);
      addGeneratedOption(raw, true);
      await loadScenario(raw, 0, null);
      say(t('gen.done', { title: tr(raw, 'title') }));
    } catch (e) {
      clearInterval(timer);
      say(e instanceof GenerateError ? t(`gen.err.${e.code}`, { d: e.message }) : `${e.message}`);
      if (!(e instanceof GenerateError)) console.error(e);
    } finally {
      $('#gen-go').disabled = false;
      $('#gen-cancel').hidden = true;
      controller = null;
    }
  };
}

function rememberGenerated(sc) {
  try {
    const list = JSON.parse(localStorage.getItem(GEN_STORE) || '[]').filter((x) => x.title !== sc.title);
    localStorage.setItem(GEN_STORE, JSON.stringify([sc, ...list].slice(0, 5)));
  } catch { /* quota or storage unavailable: the scenario still loads */ }
}

function addGeneratedOption(sc, select = false) {
  const key = `generated:${sc.title}`;
  state.generated.set(key, sc);
  renderScenarioOptions();
  if (select) $('#scenario-select').value = key;
}

async function loadLocalFile(f) {
  try {
    await loadScenario(JSON.parse(await f.text()));
    const sel = $('#scenario-select');
    sel.add(new Option(`${tr(state.scenario, 'title')} (${t('local')})`, ''), 0);
    sel.selectedIndex = 0;
  } catch (e) {
    status(t('status.badfile', { name: f.name, err: e.message }), 6000);
  }
}

/** Download the current scenario (normalized, plus any overlays added in the UI). */
function exportScenario() {
  const sc = state.scenario;
  if (!sc) return;
  const out = {
    ...sc,
    places: sc.places.map(({ color, ...p }) => p),
    routes: sc.routes.map(({ color, geometry, traced, hours, profile, ...r }) => r),
    zones: sc.zones.map(({ color, ring, ...z }) => z),
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `${(sc.title || 'scenario').replace(/[^\w-]+/g, '_').toLowerCase()}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// Exposed for debugging and automated checks.
window.__app = { map, dem, state, loadScenario, goToStep };
