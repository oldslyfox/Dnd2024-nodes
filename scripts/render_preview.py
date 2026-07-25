#!/usr/bin/env python3
"""Render graph v2 to a plain SVG so the layout can be eyeballed.

    python3 scripts/render_preview.py   ->  data/output/layout_preview.svg

Not part of the deliverable - a review aid. The real renderer is the UI layer.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dnd2024 import config  # noqa: E402

ZONE_COLOURS = [
    "#b4453c", "#c26a2b", "#c9a227", "#8ab02e", "#3f9e57", "#2f9c93",
    "#2b7fc4", "#5a5fd0", "#8a4fd0", "#c04bb0", "#c2456f", "#7a5c3e", "#6f7d8c",
]
TYPE_RADIUS = {
    "connector": 1.1,
    "spell_slot": 2.0,
    "class_feature": 2.2,
    "subclass_feature": 2.0,
    "feat": 2.4,
    "optional_feature": 1.9,
    "weapon_mastery": 2.4,
}


def colour_for(node: dict) -> str:
    zone = node["zone"]
    if zone in config.ZONE_RING:
        return ZONE_COLOURS[config.ZONE_RING.index(zone) % len(ZONE_COLOURS)]
    return "#8d8d8d" if zone == "commons" else "#d8d8d8"


def main() -> int:
    with open(ROOT / "data" / "output" / "graph.v2.json") as handle:
        graph = json.load(handle)
    by_id = {node["id"]: node for node in graph["nodes"]}

    extent = max(abs(node[axis]) for node in graph["nodes"] for axis in ("position_x", "position_y"))
    size = extent + 6
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-size} {-size} {2 * size} {2 * size}" '
        f'width="1400" height="1400">',
        f'<rect x="{-size}" y="{-size}" width="{2 * size}" height="{2 * size}" fill="#12141a"/>',
    ]

    for edge in graph["edges"]:
        a, b = by_id[edge["from"]], by_id[edge["to"]]
        opacity = 0.5 if edge["relation"] in ("spine", "gate") else 0.18
        stroke = "#ff6b6b" if edge["relation"] == "references" else "#7f8fa6"
        parts.append(
            f'<line x1="{a["position_x"]}" y1="{a["position_y"]}" '
            f'x2="{b["position_x"]}" y2="{b["position_y"]}" '
            f'stroke="{stroke}" stroke-width="0.25" opacity="{opacity}"/>'
        )

    for node in graph["nodes"]:
        parts.append(
            f'<circle cx="{node["position_x"]}" cy="{node["position_y"]}" '
            f'r="{TYPE_RADIUS.get(node["type"], 1.5)}" fill="{colour_for(node)}" '
            f'opacity="{0.55 if node["type"] == "connector" else 0.95}">'
            f'<title>{node["name"]} - {node["zone"]} - depth {node["depth"]:g}</title></circle>'
        )

    for zone in config.ZONE_RING:
        gate = by_id[f"gate_{zone.lower()}"]
        scale = 3.4
        parts.append(
            f'<text x="{gate["position_x"] * scale}" y="{gate["position_y"] * scale}" '
            f'fill="#e6e6e6" font-size="3.4" font-family="sans-serif" '
            f'text-anchor="middle">{zone}</text>'
        )

    parts.append("</svg>")
    out = ROOT / "data" / "output" / "layout_preview.svg"
    out.write_text("\n".join(parts))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
