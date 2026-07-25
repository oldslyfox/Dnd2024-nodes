"""Acceptance validation and layout measurement for graph v2.

Checks the work order's acceptance criteria directly, and measures the two
layout properties the design depends on:

  * depth normalization - "level 10" must sit at the same graph distance from
    the hub in every zone, however sparse that zone's real content is;
  * connector density - the average number of connectors a player walks through
    between two notable nodes in the same zone.
"""

from __future__ import annotations

import json
import random
import statistics
from collections import defaultdict, deque
from pathlib import Path

from . import config
from .build import COMMONS_ZONE

ROOT = Path(__file__).resolve().parents[2]
GRAPH_PATH = ROOT / "data" / "output" / "graph.v2.json"

# 2024-only scope. Anything outside this set is 2014-era content and must not
# appear anywhere in the output.
ALLOWED_SOURCES = {"XPHB", "XDMG", "EFA", None}

REQUIRED_FIELDS = ("zone", "depth", "position_x", "position_y", "point_cost", "prereqs")


def _adjacency(graph: dict, *, structural_only: bool = False) -> dict[str, set[str]]:
    adjacency: dict[str, set[str]] = {n["id"]: set() for n in graph["nodes"]}
    for edge in graph["edges"]:
        if structural_only and edge["relation"] == "references":
            continue
        adjacency[edge["from"]].add(edge["to"])
        adjacency[edge["to"]].add(edge["from"])
    return adjacency


def _hops_from(adjacency, start: str) -> dict[str, int]:
    seen = {start: 0}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        for neighbour in adjacency[node]:
            if neighbour not in seen:
                seen[neighbour] = seen[node] + 1
                queue.append(neighbour)
    return seen


def validate(graph: dict) -> dict:
    nodes = graph["nodes"]
    by_id = {n["id"]: n for n in nodes}
    errors: list[str] = []
    warnings: list[str] = []

    if len(by_id) != len(nodes):
        errors.append("duplicate node ids present")

    for node in nodes:
        for field in REQUIRED_FIELDS:
            if node.get(field) is None:
                errors.append(f"{node['id']}: missing {field}")
        prereqs = node.get("prereqs") or {}
        if not isinstance(prereqs, dict) or "logic" not in prereqs:
            errors.append(f"{node['id']}: prereqs not normalized")
        elif prereqs["logic"] not in ("AND", "OR", "THRESHOLD"):
            errors.append(f"{node['id']}: bad prereq logic {prereqs['logic']}")
        elif not isinstance(prereqs.get("nodes"), list):
            errors.append(f"{node['id']}: prereqs.nodes is not a list")
        else:
            for reference in prereqs["nodes"]:
                if reference not in by_id:
                    errors.append(f"{node['id']}: prereq references unknown {reference}")
        if node.get("point_cost") is None:
            errors.append(f"{node['id']}: null point_cost")
        if node.get("source_book") not in ALLOWED_SOURCES:
            errors.append(f"{node['id']}: non-2024 source {node.get('source_book')}")
        depth = node.get("depth")
        if depth is not None and not (config.DEPTH_MIN <= float(depth) <= config.DEPTH_MAX):
            errors.append(f"{node['id']}: depth {depth} out of range")
        zone = node.get("zone")
        if zone not in set(config.ZONE_RING) | {config.CORE_ZONE, COMMONS_ZONE}:
            errors.append(f"{node['id']}: unknown zone {zone}")

    positions: dict[tuple, str] = {}
    for node in nodes:
        point = (node.get("position_x"), node.get("position_y"))
        if point in positions:
            errors.append(
                f"{node['id']} shares a position with {positions[point]} at {point}"
            )
        positions[point] = node["id"]

    for edge in graph["edges"]:
        if edge["from"] not in by_id or edge["to"] not in by_id:
            errors.append(f"edge references unknown node: {edge}")

    adjacency = _adjacency(graph)
    reachable = _hops_from(adjacency, "conn_core_hub")
    orphans = sorted(set(by_id) - set(reachable))
    if orphans:
        errors.append(f"{len(orphans)} nodes unreachable from the hub: {orphans[:5]}")

    # every class zone must be enterable only through its gate, structurally
    for zone in config.ZONE_RING:
        if f"gate_{zone.lower()}" not in by_id:
            errors.append(f"zone {zone} has no gate node")

    # -- depth normalization ---------------------------------------------
    # Measured on the structural graph. The extraction's `references` edges are
    # traversable (Task 5 says so) but a few of them join two class zones
    # directly, which shortcuts the ladder; those are surfaced separately in
    # balance_flags.json rather than silently deleted here.
    structural = _adjacency(graph, structural_only=True)
    structural_hops = _hops_from(structural, "conn_core_hub")
    probe_level = 9  # the ladder rung nearest level 10
    depth_probe = {
        zone: structural_hops.get(f"conn_{zone.lower()}_rung_{probe_level}")
        for zone in config.ZONE_RING
    }
    full_probe = {
        zone: reachable.get(f"conn_{zone.lower()}_rung_{probe_level}")
        for zone in config.ZONE_RING
    }
    distinct = {v for v in depth_probe.values() if v is not None}
    if len(distinct) != 1:
        errors.append(f"depth normalization broken on the structural graph: {depth_probe}")
    if len({v for v in full_probe.values() if v is not None}) != 1:
        warnings.append(
            "reference edges from the Work Order 1 extraction shortcut the ladder; "
            "see the cross_zone_reference_shortcuts flag"
        )

    # -- connector density -------------------------------------------------
    notable_by_zone: dict[str, list[str]] = defaultdict(list)
    for node in nodes:
        if node["type"] in ("class_feature", "subclass_feature") and node["zone"] in config.ZONE_RING:
            notable_by_zone[node["zone"]].append(node["id"])

    rng = random.Random(20240101)
    crossings: list[int] = []
    for zone, members in notable_by_zone.items():
        if len(members) < 2:
            continue
        for _ in range(60):
            a, b = rng.sample(members, 2)
            path = _shortest_path(adjacency, a, b)
            if path:
                crossings.append(
                    sum(1 for node_id in path[1:-1] if by_id[node_id]["type"] == "connector")
                )

    # -- what a path actually costs ---------------------------------------
    # Hop counts alone understate the difference between staying home and
    # shopping abroad: a player's own zone spine is free to walk (Task 2b), so
    # the same trip that costs 1 point at home costs several abroad. This is the
    # measurement that backs "cross-zone paths cross meaningfully more".
    from .pathing import PathEngine  # local import keeps validate importable alone

    engine = PathEngine(graph)
    same_cost: list[int] = []
    cross_cost: list[int] = []
    cost_rng = random.Random(99)
    zone_list = sorted(notable_by_zone)
    for zone in zone_list:
        state = engine.start_state(zone, 10_000)
        for _ in range(30):
            result = engine.can_afford(state, cost_rng.choice(notable_by_zone[zone]))
            if result["affordable"]:
                same_cost.append(result["total_cost"])
            other = cost_rng.choice([z for z in zone_list if z != zone])
            result = engine.can_afford(state, cost_rng.choice(notable_by_zone[other]))
            if result["affordable"]:
                cross_cost.append(result["total_cost"])

    zones_with_content = sorted(notable_by_zone)
    cross_crossings: list[int] = []
    for _ in range(400):
        zone_a, zone_b = rng.sample(zones_with_content, 2)
        a = rng.choice(notable_by_zone[zone_a])
        b = rng.choice(notable_by_zone[zone_b])
        path = _shortest_path(adjacency, a, b)
        if path:
            cross_crossings.append(
                sum(1 for node_id in path[1:-1] if by_id[node_id]["type"] == "connector")
            )

    report = {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "nodes": len(nodes),
            "edges": len(graph["edges"]),
            "by_type": graph["meta"]["node_counts_by_type"],
        },
        "depth_normalization": {
            "probe_rung_level": probe_level,
            "structural_hops_from_hub": depth_probe,
            "uniform_on_structural_graph": len(distinct) == 1,
            "hops_including_reference_edges": full_probe,
        },
        "connector_density": {
            "same_zone": {
                "sampled_pairs": len(crossings),
                "mean_connectors_crossed": round(statistics.mean(crossings), 2)
                if crossings
                else None,
                "median_connectors_crossed": round(statistics.median(crossings), 2)
                if crossings
                else None,
                "target_band": "2-4 (Task 1)",
                "in_band": bool(crossings) and 2 <= statistics.mean(crossings) <= 4,
            },
            "cross_zone": {
                "sampled_pairs": len(cross_crossings),
                "mean_connectors_crossed": round(statistics.mean(cross_crossings), 2)
                if cross_crossings
                else None,
                "target": "meaningfully more than same-zone (Task 1)",
            },
        },
        "traversal_cost": {
            "note": (
                "Points a fresh character in the named home zone pays to reach a "
                "random notable node. Home-zone spine connectors are free (Task 2b), "
                "foreign ones are not, which is where the cross-zone premium lives."
            ),
            "mean_points_same_zone": round(statistics.mean(same_cost), 2)
            if same_cost
            else None,
            "mean_points_cross_zone": round(statistics.mean(cross_cost), 2)
            if cross_cost
            else None,
            "cross_zone_premium": round(
                statistics.mean(cross_cost) / statistics.mean(same_cost), 2
            )
            if same_cost and cross_cost and statistics.mean(same_cost)
            else None,
        },
    }
    return report


def _shortest_path(adjacency, start: str, goal: str) -> list[str]:
    if start == goal:
        return [start]
    previous = {start: None}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        for neighbour in adjacency[node]:
            if neighbour in previous:
                continue
            previous[neighbour] = node
            if neighbour == goal:
                path = [goal]
                while path[-1] is not None:
                    path.append(previous[path[-1]])
                return list(reversed(path[:-1]))
            queue.append(neighbour)
    return []


def main() -> int:
    with open(GRAPH_PATH) as handle:
        graph = json.load(handle)
    report = validate(graph)
    with open(ROOT / "data" / "output" / "validation_report.json", "w") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != "errors"}, indent=2))
    if report["errors"]:
        print(f"\n{len(report['errors'])} errors:")
        for error in report["errors"][:20]:
            print("  -", error)
    return 0 if report["ok"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
