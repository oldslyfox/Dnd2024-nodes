"""Work Order 7, Tasks 5-6: the pipeline absorbs newly-populated zones.

The sweep needs the 5etools dump, which lives outside this repository. What can
be proved without it is that nothing downstream special-cases an empty zone: if
Artificer content is dropped into the extraction, the generator must populate the
zone, flip its status, fold it into the point economy, and keep every Work Order 5
layout guarantee - with no code change.

These tests build a real graph from the real corpus plus injected content, so
they are the rehearsal for the merge rather than a mock of it.
"""

from __future__ import annotations

import json
import math
import shutil

import pytest

from dnd2024 import build, config


SUBCLASSES = ["Alchemist", "Armorer", "Artillerist", "Battle Smith", "Cartographer", "Reanimator"]


def _artificer_nodes() -> list[dict]:
    """Content shaped exactly like the sweep's output for the EFA Artificer."""
    nodes: list[dict] = []
    for level in (1, 2, 3, 5, 6, 7, 9, 10, 11, 14, 18, 20):
        nodes.append(
            {
                "id": f"cf_artificer_feature_{level}",
                "name": f"Artificer Feature {level}",
                "type": "class_feature",
                "source_class": "Artificer",
                "class_source": "EFA",
                "source_book": "EFA",
                "level": level,
                "point_cost": None,
                "prereqs": [],
                "tags": [],
                "effect_summary": "Invented content standing in for the EFA class feature.",
            }
        )
    for subclass in SUBCLASSES:
        for level in (3, 5, 9, 15):
            slug = subclass.lower().replace(" ", "_")
            nodes.append(
                {
                    "id": f"scf_artificer_{slug}_feature_{level}",
                    "name": f"{subclass} Feature {level}",
                    "type": "subclass_feature",
                    "source_class": "Artificer",
                    "subclass": subclass,
                    "subclass_source": "RHW" if subclass == "Reanimator" else "EFA",
                    "source_book": "RHW" if subclass == "Reanimator" else "EFA",
                    "level": level,
                    "point_cost": None,
                    "prereqs": [],
                    "tags": [],
                    "effect_summary": "Invented content standing in for the subclass feature.",
                }
            )
    for index, name in enumerate(("Enhanced Defense", "Repeating Shot", "Spell-Refueling Ring")):
        nodes.append(
            {
                "id": f"of_{name.lower().replace(' ', '_').replace('-', '_')}_efa",
                "name": name,
                "type": "optional_feature",
                "feature_types": ["AI"],
                "feature_type_labels": ["artificer_infusion"],
                "source_book": "EFA",
                "point_cost": None,
                "prereqs_raw": [{"level": {"level": 2, "class": {"name": "Artificer"}}}],
                "tags": [],
                "effect_summary": "Invented content standing in for the infusion.",
            }
        )
    return nodes


@pytest.fixture(scope="module")
def populated_graph(tmp_path_factory) -> dict:
    """The real extraction plus an Artificer zone, built through the real pipeline."""
    staging = tmp_path_factory.mktemp("input")
    for path in build.INPUT.glob("*.json"):
        shutil.copy(path, staging / path.name)

    with open(staging / "graph.json") as handle:
        document = json.load(handle)
    document["nodes"].extend(_artificer_nodes())
    document["meta"]["node_count"] = len(document["nodes"])
    with open(staging / "graph.json", "w") as handle:
        json.dump(document, handle)

    original = build.INPUT
    build.INPUT = staging
    try:
        return build.GraphBuilder().build()
    finally:
        build.INPUT = original


def test_a_newly_populated_zone_needs_no_special_casing(populated_graph):
    real = [
        node
        for node in populated_graph["nodes"]
        if node["zone"] == "Artificer" and not node.get("generated")
    ]
    # infusions live in the Artificer zone on the Wizard boundary, exactly as
    # invocations live in the Warlock zone - so the whole injection lands here
    assert len(real) == len(_artificer_nodes())
    assert populated_graph["meta"]["zone_status"]["Artificer"]["state"] == "populated"
    assert populated_graph["meta"]["zone_status"]["Artificer"]["extracted_nodes"] > 0


def test_every_subclass_becomes_its_own_subregion(populated_graph):
    subregions = {
        node["subregion"]
        for node in populated_graph["nodes"]
        if node["zone"] == "Artificer" and node["type"] == "subclass_feature"
    }
    assert subregions == set(SUBCLASSES)


def test_the_new_zone_keeps_the_half_caster_spine_it_already_had(populated_graph):
    slots = [
        node
        for node in populated_graph["nodes"]
        if node["zone"] == "Artificer" and node["type"] == "spell_slot"
    ]
    assert len(slots) == 5, "Artificer was already a half caster; content must not change that"


def test_the_new_content_joins_the_point_economy(populated_graph):
    """Work Order 2 skipped Artificer because it had no features to measure."""
    per_class = populated_graph["meta"]["point_economy"]["per_class_raw_baseline"]
    assert "Artificer" in per_class
    assert per_class["Artificer"] > 0


def test_work_order_5_separation_survives_the_new_content(populated_graph):
    """The layout guarantee is re-measured, not assumed to hold with more nodes."""
    points = [(node["position_x"], node["position_y"], node["id"]) for node in populated_graph["nodes"]]
    cells: dict[tuple[int, int], list] = {}
    cell = config.MIN_NODE_SEPARATION * 2
    for x, y, node_id in points:
        cells.setdefault((int(x // cell), int(y // cell)), []).append((x, y, node_id))

    worst = math.inf
    pair = None
    for (cx, cy), bucket in cells.items():
        neighbours = [
            point
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for point in cells.get((cx + dx, cy + dy), [])
        ]
        for x, y, node_id in bucket:
            for other_x, other_y, other_id in neighbours:
                if node_id >= other_id:
                    continue
                distance = math.hypot(x - other_x, y - other_y)
                if distance < worst:
                    worst, pair = distance, (node_id, other_id)

    # positions are rounded to three decimals on the way out, so the guarantee is
    # the designed minimum less that rounding, not an exact float comparison
    assert worst >= config.MIN_NODE_SEPARATION - 0.002, f"{pair} are {worst:.3f} apart"


def test_depth_ordering_survives_the_new_content(populated_graph):
    by_depth: dict[float, list[float]] = {}
    for node in populated_graph["nodes"]:
        radius = math.hypot(node["position_x"], node["position_y"])
        by_depth.setdefault(float(node["depth"]), []).append(radius)
    depths = sorted(by_depth)
    for shallow, deep in zip(depths, depths[1:]):
        assert max(by_depth[shallow]) < min(by_depth[deep]) + config.RADIAL_SLACK


def test_the_zone_is_reachable_and_costed_like_any_other(populated_graph):
    from dnd2024.pathing import PathEngine

    engine = PathEngine(populated_graph)
    budget = populated_graph["meta"]["point_economy"]["total_points_at_level_20"]
    state = engine.start_state("Wizard", budget)
    result = engine.can_afford(state, "cf_artificer_feature_1")
    assert result["affordable"], result
    assert "gate_artificer" in result["path"], "the gate still guards the zone"
