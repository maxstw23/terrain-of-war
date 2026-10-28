# CLAUDE.md

Terrain of War (兵要地志) is a static web app, published with GitHub Pages from the root of
`main` at https://maxstw23.github.io/terrain-of-war/. It shows military history on real
terrain: narrated 2D relief maps with viewsheds, elevation profiles and march routes, in
English and Chinese. There is no build step; see README.md for the code layout.

## Main task: turn a pasted text into a scenario

When the user pastes a text about a battle, campaign or historical debate (a book passage, an
article, a Reddit / 小红书 / 知乎 thread, in any language) and asks for a scenario, or just pastes
such a text, follow `.claude/commands/new-scenario.md` (also available as `/new-scenario`).
In short: rules from `tools/scenario_prompt.md` → coordinates from `gazetteer.json`
(`node tools/tow.mjs place <name>`) → write `scenarios/<name>.json` and `sources/<name>.md`
→ `node tools/tow.mjs prep scenarios/<name>.json` until OK → add new places to the gazetteer
→ push and send the link.

Ask the user before guessing when the text does not make clear which battle, place or period
it describes.

## Tools

- `node tools/tow.mjs check|snap|bake|prep <scenario.json>`: runs the app's own terrain code in
  Node (needs `curl`; tiles are cached in `~/.cache/terrain-of-war`). `prep` = snap + bake +
  check, and rewrites the file. Re-run `prep` after editing a scenario's places or routes: baked
  routes carry a fingerprint, and the page re-traces stale ones on load (slow).
- `node tools/tow.mjs place <name>`: gazetteer lookup.
- `python tools/article_to_scenario.py`: the same generation through the API (needs a key).

## Other conventions

- Keep the English and Chinese interface strings in `js/i18n.js` in step.
- After changing the `Scenario` model, regenerate the page's schema:
  `python tools/article_to_scenario.py --write-schema scenario.schema.json`.
- Edit scenario JSON with care for the compact formatting `tow.mjs` writes; re-running `prep`
  (or `bake`) restores it.
- Library versions are pinned (MapLibre GL 4.7.1, Anthropic SDK 0.133.0 in the browser).
