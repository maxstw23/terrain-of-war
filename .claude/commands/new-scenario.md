---
description: Turn a pasted text (article, book passage, Reddit / 小红书 thread) into a scenario and publish it
argument-hint: [paste the text, or a short name for it]
---

Turn the text below (or the text the user pasted earlier in this conversation) into a Terrain of
War scenario and publish it. Do the steps in order; do not skip the check.

$ARGUMENTS

1. **Read the rules.** Read `tools/scenario_prompt.md` and follow it exactly: illustrate the
   text as written, attribute views in a discussion, flag only uncertain locations.
2. **Look up the places first.** For each place the text names, run
   `node tools/tow.mjs place <name>` (Chinese or English). Use the gazetteer's coordinates when
   there is a match. Only estimate coordinates for places it does not have.
3. **Write the scenario** to `scenarios/<short-kebab-name>.json`, matching
   `scenario.schema.json` and the finished examples in `scenarios/`, with every `zh` field.
   Save the source text as `sources/<same-name>.md` with a line saying where it came from
   (for a forum post: the site and, if given, the URL; never personal details beyond the
   username shown). Add the entry to `scenarios/index.json` (newest first).
4. **Prepare and check:** `node tools/tow.mjs prep scenarios/<name>.json`. This snaps peaks,
   pre-computes terrain-following routes and runs every check. Fix each ✗ and run it again
   until it prints OK. Read the · notes: a place far from its gazetteer entry is usually a
   mistake.
5. **Add new places to `gazetteer.json`** (id, zh, name, kind, lon, lat, approximate,
   alternatives for disputed sites, note / note_zh), so the next scenario reuses them.
6. **Commit and push** to `main`, then give the user the link
   `https://maxstw23.github.io/terrain-of-war/?scenario=scenarios/<name>.json` (add `&lang=zh`
   when the text is Chinese) and one line on what the scenario shows.

Only open a browser to look at the result if `prep` flags something it cannot explain, or the
user asks.
