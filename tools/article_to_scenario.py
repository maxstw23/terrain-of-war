#!/usr/bin/env python3
"""Turn a text about a historical campaign into a Terrain of War scenario JSON.

Claude reads the article (English, Chinese or another language), works out the
geography it relies on (places, routes, rivers, choke points, ambush ground),
estimates coordinates, and writes a narrated, step-by-step scenario in English with
a Simplified Chinese translation, in the format the map app loads. It illustrates
the text as written; it does not fact-check it. The web page does the same from
its "Create from text" panel, using the same prompt (scenario_prompt.md) and schema. Coordinates for ancient sites are estimates; the
app marks places flagged "approximate" with ≈ so you can check and correct them.

    python tools/article_to_scenario.py article.txt -o scenarios/my-battle.json
    cat article.txt | python tools/article_to_scenario.py - -o scenarios/my-battle.json

Credentials are resolved by the Anthropic SDK (ANTHROPIC_API_KEY, or an
`ant auth login` profile).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Literal, Optional

import anthropic
from pydantic import BaseModel, Field, ValidationError

MODEL = "claude-opus-5-5"

LonLat = list[float]  # [lon, lat]


class ZhName(BaseModel):
    name: str = Field(description="Simplified Chinese name")


class ZhNamed(BaseModel):
    name: str = Field(description="Simplified Chinese name, e.g. 街亭, 色当")
    note: Optional[str] = Field(None, description="Simplified Chinese translation of note")


class ZhStep(BaseModel):
    title: str
    text: str


class ZhLabel(BaseModel):
    label: str


class ZhScenario(BaseModel):
    title: str
    period: str
    summary: str
    sources: list[str]


class Side(BaseModel):
    id: str
    name: str
    color: Optional[str] = Field(None, description="CSS hex colour, e.g. #d64545")
    zh: ZhName


class Place(BaseModel):
    id: str = Field(description="short kebab-case id, unique across the scenario")
    name: str
    nameLocal: Optional[str] = Field(None, description="name in the local language/script, e.g. 街亭")
    kind: Literal["city", "fort", "pass", "mountain", "river", "battle", "camp", "port", "landmark", "region"] = Field(
        description='"region" is a name label for a basin, plain, plateau or range (e.g. 汉中盆地), drawn without a symbol'
    )
    side: Optional[str] = Field(None, description="side id controlling it at the time, if any")
    lon: float
    lat: float
    approximate: bool = Field(description="true if the historical site is uncertain or your coordinates are rough")
    note: str = Field(description="1-3 sentences: what happened here and why its terrain mattered")
    zh: ZhNamed


class Route(BaseModel):
    id: str
    name: str
    kind: Literal["advance", "retreat", "supply", "feint", "planned", "road", "river"]
    side: Optional[str] = None
    waypoints: list[LonLat] = Field(description="ordered [lon, lat] waypoints at known stations along the route")
    follow: Optional[Literal["terrain", "valley"]] = Field(
        None,
        description='"terrain" for foot/horse marches through mountains: the app replaces the line with '
        'the least-effort path through the elevation model between waypoints. "valley" for rivers: the line '
        "is snapped to the valley floor between waypoints (give points on the river, in order). Omit for schematic arrows.",
    )
    note: Optional[str] = None
    zh: ZhNamed


class Zone(BaseModel):
    id: str
    name: str
    kind: Literal["ambush", "killzone", "defense", "obstacle", "control", "flood", "forest", "marsh"]
    side: Optional[str] = None
    coords: Optional[list[LonLat]] = Field(None, description="polygon ring of [lon, lat]")
    center: Optional[LonLat] = Field(None, description="circle centre [lon, lat], with radiusKm")
    radiusKm: Optional[float] = None
    line: Optional[list[LonLat]] = Field(None, description="polyline for a corridor (defensive line), with widthKm")
    widthKm: Optional[float] = None
    note: Optional[str] = None
    zh: ZhNamed


class Camera(BaseModel):
    center: LonLat
    zoom: float = Field(description="6 = region, 9 = valley, 11-12 = single battlefield (flat north-up map)")


class Analysis(BaseModel):
    type: Literal["profile", "viewshed", "los"]
    route: Optional[str] = Field(None, description="route id, for profile")
    coords: Optional[list[LonLat]] = Field(None, description="ad-hoc profile line, e.g. a cross-section of a gorge")
    at: Optional[LonLat] = Field(None, description="observer [lon, lat], for viewshed")
    from_: Optional[LonLat] = Field(None, alias="from", description="observer [lon, lat], for los")
    to: Optional[LonLat] = Field(None, description="target [lon, lat], for los")
    radiusKm: Optional[float] = None
    observerH: Optional[float] = Field(None, description="eye height above ground in m (tower 10-20, rider 3)")
    label: Optional[str] = None
    zh: Optional[ZhLabel] = Field(None, description="Chinese label, when label is set")


class Step(BaseModel):
    title: str
    text: str = Field(description="2-3 short paragraphs separated by blank lines")
    focus: list[str] = Field(description="ids of places/routes/zones to highlight in this step")
    camera: Camera
    analysis: Optional[Analysis] = None
    zh: ZhStep


class Scenario(BaseModel):
    title: str
    period: str
    summary: str
    sources: list[str]
    sides: list[Side]
    places: list[Place]
    routes: list[Route]
    zones: list[Zone]
    steps: list[Step]
    zh: ZhScenario


SYSTEM = (Path(__file__).with_name("scenario_prompt.md")).read_text(encoding="utf-8")


def generate(article: str, client: anthropic.Anthropic) -> Scenario:
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=64000,
        system=SYSTEM,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        output_format=Scenario,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": f"Build a scenario from this text:\n\n<article>\n{article}\n</article>"}],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        raise SystemExit(f"Request declined: {message.stop_details}")
    if message.stop_reason == "max_tokens":
        raise SystemExit("Output was truncated (max_tokens); try a shorter article.")
    text = next(b.text for b in message.content if b.type == "text")
    return Scenario.model_validate_json(text)


def api_schema() -> dict:
    """The Scenario JSON schema in the form structured outputs accept (used by the web page)."""

    def clean(node):
        if isinstance(node, dict):
            node = {k: clean(v) for k, v in node.items() if k not in ("title", "default")}
            if node.get("type") == "object":
                node["additionalProperties"] = False
            return node
        if isinstance(node, list):
            return [clean(v) for v in node]
        return node

    return clean(Scenario.model_json_schema(by_alias=True))


def check_references(sc: Scenario) -> list[str]:
    ids = {x.id for x in [*sc.places, *sc.routes, *sc.zones]}
    problems = []
    for step in sc.steps:
        problems += [f"step '{step.title}': unknown id '{i}'" for i in step.focus if i not in ids]
        a = step.analysis
        if a and a.route and a.route not in ids:
            problems.append(f"step '{step.title}': unknown route '{a.route}'")
    for x in [*sc.places, *[p for r in sc.routes for p in r.waypoints]]:
        lon, lat = (x.lon, x.lat) if isinstance(x, Place) else (x[0], x[1])
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            problems.append(f"coordinate out of range: {lon}, {lat}")
    return problems


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("article", nargs="?", help="text file with the article, or - for stdin")
    ap.add_argument("--write-schema", type=Path, metavar="PATH",
                    help="write the scenario JSON schema used by the web page (e.g. scenario.schema.json) and exit")
    ap.add_argument("-o", "--out", type=Path, help="output JSON path (default: stdout)")
    ap.add_argument("--index", type=Path, help="also register the scenario in this index.json (e.g. scenarios/index.json)")
    args = ap.parse_args()
    if args.write_schema:
        args.write_schema.write_text(json.dumps(api_schema(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"wrote {args.write_schema}", file=sys.stderr)
        return
    if not args.article:
        ap.error("article is required")

    article = sys.stdin.read() if args.article == "-" else Path(args.article).read_text(encoding="utf-8")
    try:
        scenario = generate(article, anthropic.Anthropic())
    except ValidationError as e:
        raise SystemExit(f"Model output did not match the scenario schema:\n{e}")
    except anthropic.APIStatusError as e:
        raise SystemExit(f"API error {e.status_code}: {e.message}")
    except anthropic.APIConnectionError:
        raise SystemExit("Could not reach the Anthropic API.")

    for p in check_references(scenario):
        print(f"warning: {p}", file=sys.stderr)

    data = scenario.model_dump(by_alias=True, exclude_none=True)
    data["overlays"] = []
    out = json.dumps(data, ensure_ascii=False, indent=2)
    if not args.out:
        print(out)
        return
    args.out.write_text(out + "\n", encoding="utf-8")
    print(f"wrote {args.out}", file=sys.stderr)

    if args.index:
        index = json.loads(args.index.read_text()) if args.index.exists() else []
        rel = args.out.resolve().relative_to(args.index.resolve().parent.parent).as_posix()
        index = [e for e in index if e["file"] != rel] + [{"file": rel, "title": scenario.title, "period": scenario.period}]
        args.index.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n")
        print(f"registered in {args.index}", file=sys.stderr)


if __name__ == "__main__":
    main()
