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


def test_no_2014_content(graph):
    allowed = {"XPHB", "XDMG", "EFA", None}
    assert {node.get("source_book") for node in graph["nodes"]} <= allowed


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
        if node.get("chassis") in ("full", "half", "third"):
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
    pact = [n for n in graph["nodes"] if n.get("chassis") == "pact"]
    assert pact, "Warlock has no Pact Magic chain"
    assert all(n["zone"] == "Warlock" for n in pact)
    branches = {n["mechanical_data"].get("branch") for n in pact}
    assert branches == {None, "slot_level", "slot_count", "arcanum"}
    # and no full/half spine was generated for Warlock
    assert not [
        n for n in graph["nodes"] if n["zone"] == "Warlock" and n.get("chassis") == "full"
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


def test_hit_die_table_is_present_for_every_zone(graph):
    hit_dice = graph["meta"]["hit_die_by_zone"]
    for zone in config.ZONE_RING:
        assert hit_dice[zone]["faces"] in (6, 8, 10, 12)
