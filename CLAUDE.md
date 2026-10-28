# CLAUDE.md

Terrain of War (兵要地志) is a static web app, published with GitHub Pages from the root of
`main` at https://maxstw23.github.io/terrain-of-war/. It shows military history on real
terrain: narrated 2D relief maps with viewsheds, elevation profiles and march routes, in
English and Chinese. There is no build step; see README.md for the code layout.

## Main task: turn a pasted text into a scenario

When the user pastes a passage about a battle or campaign (in any language) and asks for a
scenario, or just pastes such a passage with no other request:

1. Follow `tools/scenario_prompt.md` exactly. It is the same instruction the web page and
   `tools/article_to_scenario.py` give the API: illustrate the text as written, never
   fact-check or dispute it, and flag only uncertain locations (`"approximate": true`).
2. Write the scenario JSON so it matches `scenario.schema.json` (generated from the
   `Scenario` model in `tools/article_to_scenario.py`), including every `zh` translation.
   Use real coordinates in `[lon, lat]` order; place ids may also be used as waypoints.
   Look at `scenarios/*.json` for finished examples.
3. Save it as `scenarios/<short-kebab-name>.json` and add an entry to
   `scenarios/index.json`: `{"file": "scenarios/<name>.json", "title": …, "period": …,
   "zh": {"title": …, "period": …}}`.
4. Check it: the JSON parses, every id in a step's `focus` / `analysis.route` exists, and
   every coordinate is in range. If a local check is possible, serve the folder
   (`python3 -m http.server`) and load `?scenario=scenarios/<name>.json`.
5. Commit and push to `main`. The page updates within a minute or two; tell the user the
   link `https://maxstw23.github.io/terrain-of-war/?scenario=scenarios/<name>.json` (add
   `&lang=zh` for Chinese).

Ask the user before guessing when the text does not make clear which battle, place or period
it describes.

## Other conventions

- Keep the English and Chinese interface strings in `js/i18n.js` in step.
- After changing the `Scenario` model, regenerate the page's schema:
  `python tools/article_to_scenario.py --write-schema scenario.schema.json`.
- Library versions are pinned (MapLibre GL 4.7.1, Anthropic SDK 0.133.0 in the browser).
