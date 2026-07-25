"""Acceptance criteria for graph v2 itself."""

from __future__ import annotations

import json

import pytest

from dnd2024 import config
from dnd2024.build import COMMONS_ZONE
from dnd2024.validate import GRAPH_PATH, validate


@pytest.fixture(scope="module")
def graph() -> dict:
    with open(GRAPH_PATH) as handle:
        return json.load(handle)


def test_validation_passes(graph):
    report = validate(graph)
    assert report["ok"], report["errors"][:10]


def test_every_node_is_fully_specified(graph):
    for node in graph["nodes"]:
        assert node["zone"], node["id"]
        assert node["depth"] is not None, node["id"]
        assert node["position_x"] is not None and node["position_y"] is not None, node["id"]
        assert node["point_cost"] is not None, node["id"]
        assert set(node["prereqs"]) >= {"logic", "nodes", "threshold_count"}, node["id"]


def test_costs_are_flat(graph):
    """Task 4 - one point, everything, no tiers. The hub is the only free node."""
    costs = {node["id"]: node["point_cost"] for node in graph["nodes"]}
    assert costs.pop("conn_core_hub") == 0
    assert set(costs.values()) == {config.FLAT_POINT_COST}


#: Source codes from the 2014 edition. Work Order 7 widened the extraction from a
#: two-book allowlist to a derived one, so the guarantee is stated as "no 2014
#: content" rather than "only these two books" - which is what the scope actually
#: says, and what stays true as new books are released.
LEGACY_2014_SOURCES = {
    "PHB", "DMG", "MM", "XGE", "TCE", "SCAG", "VGM", "MTF", "FTD", "MPMM",
    "EGW", "ERLW", "GGR", "SCC", "AI", "BGDIA", "IDRotF", "CoS", "TCE-legacy",
}


def test_no_2014_content(graph):
    used = {node.get("source_book") for node in graph["nodes"]} - {None}
    assert not (used & LEGACY_2014_SOURCES), sorted(used & LEGACY_2014_SOURCES)

    allowlist_path = GRAPH_PATH.parent / "source_allowlist.json"
    if allowlist_path.exists():
        # once a sweep has run, the graph may only contain books it accepted
        with open(allowlist_path) as handle:
            allowed = set(json.load(handle)["sources"])
        assert used <= allowed, sorted(used - allowed)


def test_every_class_has_a_zone_and_a_gate(graph):
    zones = {node["zone"] for node in graph["nodes"]}
    assert set(config.ZONE_RING) <= zones
    assert {config.CORE_ZONE, COMMONS_ZONE} <= zones
    ids = {node["id"] for node in graph["nodes"]}
    for zone in config.ZONE_RING:
        assert f"gate_{zone.lower()}" in ids


def test_depth_follows_level_for_extracted_content(graph):
    for node in graph["nodes"]:
        if node["type"] in ("class_feature", "subclass_feature"):
            assert node["depth"] == float(node["level"]), node["id"]


def test_depth_ordering_of_feat_categories(graph):
    by_category = {}
    for node in graph["nodes"]:
        if node["type"] == "feat" and not node.get("repeat_index", 1) > 1:
            by_category.setdefault(node["category"], set()).add(node["depth"])
    assert max(by_category["origin"]) < min(by_category["general"])
    assert max(by_category["general"]) < min(by_category["epic_boon"])
    # epic boons are the deepest nodes in the whole graph
    deepest = max(node["depth"] for node in graph["nodes"])
    assert min(by_category["epic_boon"]) == deepest


def test_radius_is_monotonic_in_depth(graph):
    for node in graph["nodes"]:
        if node["zone"] in (config.CORE_ZONE,):
            continue
        expected = config.CORE_RADIUS + node["depth"] * config.RING_STEP
        assert node["polar"]["radius"] >= expected - 2.0, node["id"]


def test_slot_spine_shapes(graph):
    slots = [node for node in graph["nodes"] if node["type"] == "spell_slot"]
    by_zone = {}
    for node in slots:
        if node.get("caster_chassis") in ("full", "half", "third"):
            by_zone.setdefault((node["zone"], node.get("subregion")), []).append(node)

    for zone in config.FULL_CASTERS:
        assert len(by_zone[(zone, None)]) == config.FULL_CASTER_SPINE_LEN
    for zone in config.HALF_CASTERS:
        assert len(by_zone[(zone, None)]) == config.HALF_CASTER_SPINE_LEN
    for zone, subclass in config.THIRD_CASTERS:
        assert len(by_zone[(zone, subclass)]) == config.THIRD_CASTER_SPINE_LEN

    # deeper tier == deeper node, in every spine
    for members in by_zone.values():
        ordered = sorted(members, key=lambda n: n["slot_tier"])
        depths = [n["depth"] for n in ordered]
        assert depths == sorted(depths)


def test_warlock_is_not_a_slot_count_spine(graph):
    pact = [n for n in graph["nodes"] if n.get("caster_chassis") == "pact"]
    assert pact, "Warlock has no Pact Magic chain"
    assert all(n["zone"] == "Warlock" for n in pact)
    branches = {n["mechanical_data"].get("branch") for n in pact}
    assert branches == {None, "slot_level", "slot_count", "arcanum"}
    # and no full/half spine was generated for Warlock
    assert not [
        n for n in graph["nodes"] if n["zone"] == "Warlock" and n.get("caster_chassis") == "full"
    ]


def test_repeatable_feats_are_chains(graph):
    ids = {node["id"] for node in graph["nodes"]}
    by_id = {node["id"]: node for node in graph["nodes"]}
    for feat_id, depths in config.REPEATABLE_FEAT_CHAINS.items():
        if feat_id not in ids:
            continue
        assert by_id[feat_id]["depth"] == float(depths[0])
        previous = by_id[feat_id]["depth"]
        for index, depth in enumerate(depths[1:], start=2):
            repeat = by_id[f"{feat_id}_r{index}"]
            assert repeat["depth"] == float(depth) > previous
            previous = repeat["depth"]


def test_connectors_are_generated_content_only(graph):
    for node in graph["nodes"]:
        if node["type"] == "connector":
            assert node["generated"] is True
            assert node["source_book"] is None
            assert node["effect_summary"]


def test_point_economy_is_inside_the_locked_band(graph):
    economy = graph["meta"]["point_economy"]
    ratio = economy["total_points_at_level_20"] / economy["mean_raw_baseline"]
    assert 1.5 <= ratio <= 2.0
    cumulative = [economy["cumulative_points_by_level"][str(l)] for l in range(1, 21)]
    assert cumulative == sorted(cumulative)
    assert cumulative[-1] == economy["total_points_at_level_20"]


def test_reference_edges_are_kept_but_not_traversable(graph):
    """Review item 1 - the extraction's citations are 'see also', not pathing."""
    references = [edge for edge in graph["edges"] if edge["relation"] == "reference"]
    assert references, "the Work Order 1 cross-references were dropped entirely"
    assert all(edge["traversable"] is False for edge in references)
    assert all(
        edge["traversable"] is True
        for edge in graph["edges"]
        if edge["relation"] != "reference"
    )


def test_pathing_engine_ignores_reference_edges(graph):
    from dnd2024.pathing import PathEngine

    engine = PathEngine(graph)
    for edge in graph["edges"]:
        if edge["relation"] == "reference":
            assert edge["to"] not in engine.adjacency[edge["from"]]


def test_zone_status_matches_what_is_actually_extracted(graph):
    """A zone with no book content is labelled, never silently empty.

    Stated as an invariant rather than as "Artificer is empty": Work Order 7
    broadened the source list precisely so zones can stop being empty, and this
    test has to keep holding on the day one does.
    """
    status = graph["meta"]["zone_status"]
    for zone, entry in status.items():
        extracted = len(
            [
                node
                for node in graph["nodes"]
                if node["zone"] == zone and not node.get("generated")
            ]
        )
        assert entry["extracted_nodes"] == extracted, zone
        expected = "populated" if extracted else "pending official 2024 content"
        assert entry["state"] == expected, zone

    # every zone is a real zone whether or not a book has filled it yet
    ids = {node["id"] for node in graph["nodes"]}
    for zone in config.ZONE_RING:
        assert f"gate_{zone.lower()}" in ids, zone
    assert len(
        [n for n in graph["nodes"] if n["zone"] == "Artificer" and n["type"] == "spell_slot"]
    ) == 5, "Artificer is a half caster whether or not its features are extracted yet"


def test_chassis_is_complete_for_every_zone(graph):
    """Task 2c - the starting zone must fix everything RAW gives before play."""
    chassis = graph["meta"]["chassis_by_zone"]
    for zone in config.ZONE_RING:
        entry = chassis[zone]
        assert entry["hit_die"]["faces"] in (6, 8, 10, 12), zone
        assert len(entry["saving_throw_proficiencies"]) == 2, zone
        assert entry["weapon_proficiencies"]["simple"] is True, zone
        assert entry["weapon_proficiencies"]["summary"] != "none", zone


def test_chassis_matches_classes_meta_exactly(graph):
    """None of it is invented - it is a lookup, not a design decision."""
    with open(GRAPH_PATH.parent.parent / "input" / "classes_meta.json") as handle:
        classes_meta = json.load(handle)
    for zone, entry in graph["meta"]["chassis_by_zone"].items():
        source = classes_meta[zone]
        assert entry["hit_die"] == source["hit_die"]
        assert entry["saving_throw_proficiencies"] == source["saving_throw_proficiencies"]


def test_chassis_is_not_duplicated_as_purchasable_nodes(graph):
    """Saves and weapons are chassis; they must not also appear as tree nodes."""
    generated = [n for n in graph["nodes"] if n.get("generated")]
    assert not [
        n
        for n in generated
        if "saving throw proficiency" in (n.get("effect_summary") or "").lower()
    ]
    assert not [n for n in generated if n["id"].startswith("conn_training_simple")]


def test_the_build_is_byte_reproducible():
    """Two runs of the same input must produce the same graph.

    Epic boons with no owning class used to be placed with `hash(node_id)`,
    which Python salts per process - so an unchanged build produced different
    coordinates on every run, and the web bundle's inlined data changed with it.
    Found by Work Order 7's rebuild; this holds the fix in place.
    """
    from dnd2024.build import GraphBuilder

    first = GraphBuilder().build()
    second = GraphBuilder().build()
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
