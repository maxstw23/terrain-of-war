# Terrain of War · 兵要地志

**Open it: https://maxstw23.github.io/terrain-of-war/** (中文：`?lang=zh`)

Read military history on real terrain. Paste a text about a battle or campaign into the page
and Claude turns the places, routes and terrain it describes into a scenario. A scenario
(generated, or written by hand) becomes a narrated, step-by-step **2D map** in the style of printed Chinese
relief maps: elevation colour bands from green lowlands through cream plains to orange-brown
uplands, strong relief shading, blue rivers, large region names (秦岭, 汉中盆地) and peaks with
their heights, and every river, stream and lake from OpenStreetMap, named in Chinese or
English. On top: armies' routes, strongholds, ambush ground. Contour lines can be
switched on. Built-in terrain
analysis makes the geographic argument visible:

- **Elevation profile** of any route: climb, steepest stretch, and a Tobler walking-time
  estimate.
- **Viewshed:** what a sentry on a pass or fort can see (amber), and the dead ground where
  troops can move unseen or wait in ambush (dark).
- **Line of sight** between two points, with Earth curvature and refraction.
- **Compare routes:** the "should he have gone the other way?" view. Several routes' profiles on
  one chart, with length, total climb, highest point, steepest grade and marching days side by
  side, all measured the same way.
- **Place search** in Chinese or English (街亭, Sedan…). Disputed sites show their alternative
  identifications as extra pins.
- **March route:** the least-effort path through the terrain between waypoints. Mountain
  roads in scenarios can be traced this way (`"follow": "terrain"`).
- **Historical map overlays:** add any georeferenced old map as XYZ tiles (Allmaps, Map
  Warper, David Rumsey…) with an opacity slider, to compare with today's landscape.

The interface and the bundled scenarios are bilingual: use the **中文 / EN** button, or
`?lang=zh`.

Bundled scenarios:

| Scenario | Period | Shows |
|---|---|---|
| Han Xin crosses at Chencang (韩信暗度陈仓) | 206 BC | Four Qinling roads; Baoxie vs Old Road profiles; Dasan Pass viewshed |
| Zhuge Liang: Qishan and Jieting (诸葛亮：祁山与街亭) | 228 AD | Ziwu vs Qishan road; Jieting hill viewshed; Chencang; Wuzhangyuan |
| Through the Ardennes to Sedan (穿越阿登直抵色当) | 1940 | Maginot Line, Dyle Plan lure, Marfée heights viewshed, Monthermé gorge section |
| Why Jing province mattered (荆州为何重要：隆中对) | 207–219 | The Han and Yangtze hub; Qutang gorge section; Jing vs Yi armies compared; Fancheng flood and Lü Meng, 219 |

## Run it

It is published with GitHub Pages from the root of `main`. To run it locally, serve the
folder over HTTP (the page loads JSON with `fetch`):

```bash
python3 -m http.server 8000
# open http://localhost:8000/   (or ?scenario=scenarios/ardennes-1940.json&step=4&lang=zh)
```

No build step. MapLibre GL JS 4.7.1 is loaded from unpkg.

## Data sources

| Layer | Source | Licence |
|---|---|---|
| Rivers, streams, lakes and their names | [OpenStreetMap](https://www.openstreetmap.org/copyright) via [OpenFreeMap](https://openfreemap.org) (OpenMapTiles) | ODbL, attribution |
| Elevation (tint, hillshade, contours, all analysis) | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, GMTED, ETOPO1…) | open data, attribution |
| Satellite (open) | [Sentinel-2 cloudless 2016](https://s2maps.eu) by EOX | CC BY 4.0 |
| Satellite (high-res) | Esri World Imagery | free to view, not open |
| Topographic | [OpenTopoMap](https://opentopomap.org) | CC BY-SA |

The elevation tint and contours are drawn in the browser from the DEM tiles (`js/relief.js`);
the tint is stretched over each scenario's elevation range, so lowland battlefields and high
mountains are both legible.

**Limitations:** the base data is today's landscape. Reservoirs (e.g. the Shimen reservoir
that drowned the Baoxie road's southern gate), shifted rivers and drained marshes are noted in
the scenarios where they matter; use historical overlays to compare. The DEM is ~30 m and in
forest it partly measures the canopy, so viewsheds shift with the exact observer position:
treat them as illustrations of the ground's shape, not exact sight lines. The elevation model
cannot see cliff galleries or fords, and least-effort routes are a model of foot travel, not
the historical road line.

## From a text to a scenario

It works for discussions too: paste a Reddit / 小红书 / 知乎 thread arguing about what a commander
could have done, and the scenario maps the options each side raises, including the routes not
taken, with a comparison wherever the text weighs one route against another.

**With a Claude subscription (no API key):** open this repository in Claude Code, paste the
text and run `/new-scenario` (or just ask for a scenario). `CLAUDE.md` tells Claude to write it with the same prompt and
schema, add it to `scenarios/`, and push; it appears on the site a minute or two later.

**With an API key, in the page:**

Open **Create from text** in the page, paste a passage (any language) and your Anthropic API
key, and press **Generate scenario**. Claude identifies the places, routes, rivers, choke points
and ambush ground the text relies on, estimates coordinates (marking uncertain ones as
approximate), and writes a narrated scenario in English with a Simplified Chinese translation.
It illustrates the text as written and does not fact-check it. A run takes a few minutes and
is billed to your key.

The key and text go straight from the browser to the Anthropic API (the page is static; there
is no server of ours in between). The key is kept only if you tick "Remember", in that
browser's local storage. The last five generated scenarios are kept in the browser, too; use
**Export** to save one as a file.

The same generator is available from the command line:

```bash
pip install -r tools/requirements.txt
export ANTHROPIC_API_KEY=...
python tools/article_to_scenario.py article.txt -o scenarios/my-battle.json --index scenarios/index.json
```

Load the JSON with **Open JSON…** or by dropping it on the map. The page and the script share
the prompt (`tools/scenario_prompt.md`) and schema. After changing the `Scenario` model in the
script, regenerate the page's copy with
`python tools/article_to_scenario.py --write-schema scenario.schema.json`.

## Tools

```bash
node tools/tow.mjs prep  scenarios/x.json   # snap peaks, pre-compute routes, check (rewrites the file)
node tools/tow.mjs check scenarios/*.json   # validate only
node tools/tow.mjs place 街亭                # look a place up in the gazetteer
node tools/tow.mjs hidden scenarios/x.json lookout --near camp --km 3   # dead ground near a place
```

`tow.mjs` runs the app's own terrain code in Node (no npm install; needs `curl`), so what it
computes is exactly what the page shows. `check` catches missing translations, broken
references, places in the sea, peaks that sit below their summit, and places that drifted from
their `gazetteer.json` entry. Pre-computed routes make scenarios open without tracing; each
carries a fingerprint of its waypoints, so an edited route is traced again instead of drawn
stale. `gazetteer.json` holds agreed coordinates for recurring places; both generators pass it
to Claude so the same place lands in the same spot every time. Entries marked
`"source": "estimated"` were seeded from general knowledge and not checked against a
reference; replace them with checked coordinates when you have them. A GitHub Actions job runs
`tow.mjs check` on every scenario at each push.

Scenarios that were not pre-computed (for example one just generated in the page) are traced
in a background worker: a quick preview first, then the same full-detail trace as `bake`;
analyses shown in between are marked as previews and refresh themselves.

## Scenario format

```jsonc
{
  "title": "…", "period": "…", "summary": "…", "sources": ["…"],
  "zh": { "title": "…", "period": "…", "summary": "…" },        // optional Chinese text
  "sides":  [{ "id": "han", "name": "Han", "color": "#d64545", "zh": { "name": "汉" } }],
  "places": [{ "id": "dasan", "name": "Dasan Pass", "nameLocal": "大散关",
               "kind": "pass",            // city fort pass mountain river battle camp port landmark
                                          // region = big name label only (basin, plain, range);
                                          // mountain = red ▲ with its height read from the DEM
               "side": "han", "lon": 106.99, "lat": 34.23, "approximate": true,
               "note": "…", "zh": { "name": "大散关", "note": "…" } }],
  "routes": [{ "id": "gudao", "name": "Old Road", "kind": "advance",
               // advance retreat supply feint planned road river
               "side": "han", "waypoints": ["nanzheng", [106.67, 33.15], "chencang"],  // place ids or [lon, lat]
               "follow": "terrain",       // optional: trace the least-effort path;
                                          // "valley" (for rivers) snaps the line to the valley floor
               "note": "…", "zh": { … } }],
  "zones":  [{ "id": "z1", "kind": "ambush",  // ambush killzone defense obstacle control flood forest marsh
               "coords": [[lon, lat], …]      // polygon, or
               // "center": "jieting", "radiusKm": 3, or
               // "line": [[lon, lat], …], "widthKm": 8   (a corridor, e.g. a defensive line)
             }],
  "overlays": [{ "id": "old", "name": "1940 map", "type": "xyz",
                 "url": "https://…/{z}/{x}/{y}.png", "opacity": 0.7 }],
  "steps": [{ "title": "…", "text": "Paragraphs separated by blank lines.",
              "focus": ["gudao", "dasan"],      // highlighted; everything else dims
              "show": ["…"],                    // optional: hide everything else
              // the view frames the focus and the analysis; "camera": {center, zoom} only as a fallback
              "analysis": { "type": "viewshed", "at": "dasan", "radiusKm": 10, "observerH": 15,
                            "expect": { "hidden": ["camp"], "visible": ["gudao-mouth"] } },  // checked by tow.mjs
              // or { "type": "profile", "route": "gudao" } / { "type": "profile", "coords": [...] }
              // or { "type": "los", "from": "a", "to": "b", "expect": { "sight": "blocked" } }
              // or { "type": "compare", "routes": ["gudao", "baoxie"] }
              "zh": { "title": "…", "text": "…" } }]
}
```

## Code layout

- `js/dem.js`: terrain tile fetching, decoding and sampling
- `js/analysis.js`: profiles, line of sight, viewshed, least-cost routes
- `js/relief.js`: elevation tint and contour tiles
- `js/scenario.js`: scenario validation and GeoJSON
- `js/i18n.js`: English and Chinese interface strings
- `js/generate.js`: Create from text (Claude API from the browser)
- `js/app.js`: map, story player, tools, place search
- `tools/tow.mjs`, `tools/lib/`: check / snap / bake / gazetteer lookup in Node
- `gazetteer.json`: agreed coordinates for recurring places
- `.claude/commands/new-scenario.md`: the fixed text-to-scenario steps for Claude Code
- `tools/article_to_scenario.py`, `tools/scenario_prompt.md`, `scenario.schema.json`: the generator
