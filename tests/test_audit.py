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


def test_the_audit_finds_the_saving_throw_gap(report):
    """The gap the reviewer suspected: saves came free with a class, and don't now."""
    saves = next(f for f in report["findings"] if f["category"] == "saving_throws")
    assert saves["status"].startswith("GAP")
    assert saves["purchasable_sources"] == 1  # Resilient, and nothing else


def test_skills_and_tools_are_covered(report):
    for category in ("skills", "tools", "armor"):
        finding = next(f for f in report["findings"] if f["category"] == category)
        assert finding["status"].startswith("COVERED")
