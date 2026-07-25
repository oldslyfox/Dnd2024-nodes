"""Task 3 - prerequisite normalization, checked against the real conversions."""

from __future__ import annotations

import json

import pytest

from dnd2024 import prereqs
from dnd2024.point_economy import compute_economy
from dnd2024.validate import GRAPH_PATH


@pytest.fixture(scope="module")
def graph() -> dict:
    with open(GRAPH_PATH) as handle:
        return json.load(handle)


@pytest.fixture(scope="module")
def by_id(graph) -> dict:
    return {node["id"]: node for node in graph["nodes"]}


@pytest.fixture(scope="module")
def economy(graph):
    with open(GRAPH_PATH.parent.parent / "input" / "graph.json") as handle:
        source = json.load(handle)
    with open(GRAPH_PATH.parent.parent / "input" / "classes_meta.json") as handle:
        classes_meta = json.load(handle)
    return compute_economy(source["nodes"], classes_meta)


def test_no_raw_prereqs_survive(graph):
    for node in graph["nodes"]:
        assert "prereqs_raw" not in node, node["id"]
        assert isinstance(node["prereqs"], dict)


def test_level_gates_became_point_thresholds(by_id, economy):
    """Ability Score Improvement was `level 4`; it is now a spend threshold."""
    node = by_id["feat_ability_score_improvement_xphb"]
    assert node["prereqs"]["logic"] == "THRESHOLD"
    assert node["prereqs"]["threshold_count"] == economy.threshold_for_level(4)
    assert node["prereqs"]["threshold_count"] == economy.points_at_level(3)


def test_thresholds_are_monotonic_in_the_original_level(economy):
    thresholds = [economy.threshold_for_level(level) for level in range(1, 21)]
    assert thresholds == sorted(thresholds)
    assert thresholds[0] == 0  # a level 1 gate is no gate at all


def test_ability_prereqs_are_kept_out_of_tree_logic(by_id):
    node = by_id["feat_actor_xphb"]
    assert node["ability_prereqs"] == [{"cha": 13}]
    assert "cha" not in json_dump(node["prereqs"])

    athlete = by_id["feat_athlete_xphb"]
    # RAW offers Strength 13 OR Dexterity 13 - both alternatives survive
    assert {"str": 13} in athlete["ability_prereqs"]
    assert {"dex": 13} in athlete["ability_prereqs"]


def json_dump(value) -> str:
    return json.dumps(value)


def test_optional_feature_prereq_resolved_to_a_node(by_id):
    node = by_id["of_eldritch_smite_xphb"]
    assert "of_pact_of_the_blade_xphb" in node["prereqs"]["nodes"]


def test_feature_prereq_resolved_to_every_matching_feature(by_id):
    """`Fighting Style` is a feature on three class tables, so it is an OR."""
    node = by_id["feat_archery_xphb"]
    group = [g for g in node["prereqs"]["groups"] if g["logic"] == "OR"]
    assert group, node["prereqs"]
    assert {"cf_fighter_fighting_style_1", "cf_paladin_fighting_style_2"} <= set(
        node["prereqs"]["nodes"]
    )


def test_armor_proficiency_prereq_has_a_purchasable_source(by_id):
    node = by_id["feat_heavily_armored_xphb"]
    assert "conn_training_medium_armor" in node["prereqs"]["nodes"]


def test_spell_prereqs_are_deferred_not_dropped_silently(by_id):
    node = by_id["of_agonizing_blast_xphb"]
    assert any("Phase 3" in note for note in node["prereq_notes"])


def test_zone_gate_is_a_prerequisite_of_zone_interiors(by_id):
    assert "gate_wizard" in by_id["cf_wizard_arcane_recovery_1"]["prereqs"]["nodes"]
    # ...but not of the gate itself, nor of shared content
    assert by_id["gate_wizard"]["prereqs"]["nodes"] == []
    assert "gate_wizard" not in by_id["feat_lucky_xphb"]["prereqs"]["nodes"]


# -- satisfied() ---------------------------------------------------------


def test_satisfied_and():
    requirements = {"logic": "AND", "nodes": ["a", "b"], "threshold_count": None}
    assert prereqs.satisfied(requirements, {"a", "b"}, 0)
    assert not prereqs.satisfied(requirements, {"a"}, 0)


def test_satisfied_or():
    requirements = {"logic": "OR", "nodes": ["a", "b"], "threshold_count": None}
    assert prereqs.satisfied(requirements, {"b"}, 0)
    assert not prereqs.satisfied(requirements, {"c"}, 0)


def test_satisfied_threshold_needs_points_and_nodes():
    requirements = {
        "logic": "THRESHOLD",
        "nodes": ["a"],
        "threshold_count": 10,
        "groups": [{"logic": "AND", "nodes": ["a"]}],
    }
    assert not prereqs.satisfied(requirements, {"a"}, 9)
    assert not prereqs.satisfied(requirements, set(), 20)
    assert prereqs.satisfied(requirements, {"a"}, 10)


def test_satisfied_groups_are_and_of_ors():
    requirements = {
        "logic": "AND",
        "nodes": ["a", "b", "c"],
        "threshold_count": None,
        "groups": [
            {"logic": "OR", "nodes": ["a", "b"]},
            {"logic": "AND", "nodes": ["c"]},
        ],
    }
    assert prereqs.satisfied(requirements, {"b", "c"}, 0)
    assert not prereqs.satisfied(requirements, {"a", "b"}, 0)
