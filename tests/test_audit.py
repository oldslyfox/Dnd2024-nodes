"""Review item 4 - the proficiency / class-decoupling audit."""

from __future__ import annotations

import json

import pytest

from dnd2024.audit import audit
from dnd2024.validate import GRAPH_PATH


@pytest.fixture(scope="module")
def report() -> dict:
    with open(GRAPH_PATH) as handle:
        graph = json.load(handle)
    with open(GRAPH_PATH.parent.parent / "input" / "classes_meta.json") as handle:
        classes_meta = json.load(handle)
    return audit(graph, classes_meta)


def test_no_prerequisite_is_unsatisfiable(report):
    """Nothing in the tree should require a proficiency nothing can grant."""
    assert report["prerequisite_demand"]["unresolvable_proficiency_prerequisites"] == []


def test_armor_prerequisites_resolve_to_the_training_connectors(report):
    dependants = report["prerequisite_demand"]["nodes_depending_on_training_connectors"]
    assert "conn_training_medium_armor" in dependants
    assert "feat_heavily_armored_xphb" in dependants["conn_training_medium_armor"]


def test_no_category_is_left_uncovered(report):
    """The follow-up work order's close condition: demand and supply both clean."""
    for finding in report["findings"]:
        assert finding["status"].startswith("COVERED"), finding
    assert "Supply is clean" in report["verdict"]
    assert "Demand is clean" in report["verdict"]


def test_saving_throws_are_covered_by_chassis(report):
    """The gap the reviewer found, now closed the same way hit die was."""
    saves = next(f for f in report["findings"] if f["category"] == "saving_throws")
    assert saves["status"].startswith("COVERED - chassis")
    assert saves["granted_by_starting_zone"] == 13
    # still only one tree node grants a save; the chassis is what closed it
    assert saves["purchasable_sources"] == 1


def test_simple_weapons_are_covered_by_chassis(report):
    weapons = next(f for f in report["findings"] if f["category"] == "weapons")
    assert weapons["status"].startswith("COVERED - chassis")
    assert weapons["granted_by_starting_zone"] == 13


def test_chassis_coverage_is_reported(report):
    coverage = report["chassis_coverage"]
    assert coverage["zones_with_chassis"] == 13
    assert coverage["zones_granting_two_saving_throws"] == 13
    assert coverage["zones_granting_simple_weapons"] == 13


def test_skills_and_tools_are_covered(report):
    for category in ("skills", "tools", "armor"):
        finding = next(f for f in report["findings"] if f["category"] == category)
        assert finding["status"].startswith("COVERED")
