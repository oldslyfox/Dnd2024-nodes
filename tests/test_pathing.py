"""Task 5 acceptance - hand-checked `can_afford()` cases.

Each case below states, in the docstring, the route a human traced by hand
through the layout rules, and then asserts the engine agrees. Cases span
same-zone, cross-zone, gated, prerequisite-blocked and budget-limited targets.
"""

from __future__ import annotations

import time

import pytest

from dnd2024.pathing import PathEngine, PlayerState


@pytest.fixture(scope="module")
def engine() -> PathEngine:
    return PathEngine.load()


@pytest.fixture(scope="module")
def budget(engine) -> int:
    return engine.graph["meta"]["point_economy"]["total_points_at_level_20"]


def _spend_in_zone(engine: PathEngine, state: PlayerState, zone: str, target_spend: int) -> None:
    """Buy notable nodes in a zone until the player has spent `target_spend`."""
    for node in engine.graph["nodes"]:
        if state.points_spent >= target_spend:
            return
        if node["zone"] == zone and node["type"] in ("class_feature", "subclass_feature"):
            engine.allocate(state, node["id"])


# -- case 1: same zone, straight up your own spine ------------------------
def test_same_zone_capstone_costs_only_the_node(engine, budget):
    """Wizard start -> Spell Mastery (Wizard, level 18).

    Hand trace: hub -> gate_wizard (owned at creation, free) -> the Wizard
    ladder rungs 1..17 (own-zone spine, free by Task 2b) -> Spell Mastery.
    Only the notable node itself is billed, so the trip costs exactly 1.
    """
    state = engine.start_state("Wizard", budget)
    result = engine.can_afford(state, "cf_wizard_spell_mastery_18")

    assert result["affordable"] is True
    assert result["total_cost"] == 1
    assert result["path"][0] == "gate_wizard"
    assert result["path"][-1] == "cf_wizard_spell_mastery_18"
    assert all(engine.nodes[n]["zone"] == "Wizard" for n in result["path"])


# -- case 2: same zone, along the slot spine ------------------------------
def test_slot_spine_bills_every_tier(engine, budget):
    """Cleric start -> 9th-level slots.

    The spine is payload, not filler: each of the nine tiers is its own node, so
    the trip costs 9 even though it never leaves the home zone.
    """
    state = engine.start_state("Cleric", budget)
    result = engine.can_afford(state, "slot_cleric_t9")

    assert result["affordable"] is True
    assert result["total_cost"] == 9
    assert [n for n in result["path"] if n.startswith("slot_cleric")] == [
        f"slot_cleric_t{tier}" for tier in range(1, 10)
    ]


# -- case 3: cross zone, gate must be paid --------------------------------
def test_cross_zone_pays_the_gate_and_the_foreign_connectors(engine, budget):
    """Wizard start -> Fighter's Extra Attack (level 5).

    Hand trace: hub (owned, free) -> gate_fighter (1, foreign gate) -> Fighter
    ladder rungs 1 and 4 (1 each, foreign spine; the ladder carries a rung every
    three levels, and a level 5 feature hangs off rung 4) -> Extra Attack (1).
    Four points, and the Fighter gate has to be on the path because every node
    inside a zone requires it.
    """
    state = engine.start_state("Wizard", budget)
    result = engine.can_afford(state, "cf_fighter_extra_attack_5")

    assert result["affordable"] is True
    assert result["path"] == [
        "conn_core_hub",
        "gate_fighter",
        "conn_fighter_rung_1",
        "conn_fighter_rung_4",
        "cf_fighter_extra_attack_5",
    ]
    assert result["total_cost"] == 4
    assert result["total_cost"] > 1  # strictly worse than the same trip at home

    home = engine.start_state("Fighter", budget)
    assert engine.can_afford(home, "cf_fighter_extra_attack_5")["total_cost"] == 1


# -- case 4: cross zone to shared content on a boundary -------------------
def test_weapon_mastery_is_cheaper_from_a_martial_zone(engine, budget):
    """Cleave sits on the Barbarian|Fighter drill ground at depth 2.

    A Barbarian reaches it over their own free spine plus the shared drill
    ground; a Wizard has to cross into a martial zone first, so it costs more.
    """
    barbarian = engine.can_afford(engine.start_state("Barbarian", budget), "mastery_cleave_xphb")
    wizard = engine.can_afford(engine.start_state("Wizard", budget), "mastery_cleave_xphb")

    assert barbarian["affordable"] and wizard["affordable"]
    assert barbarian["total_cost"] < wizard["total_cost"]
    assert engine.nodes["mastery_cleave_xphb"]["boundary"] == ["Barbarian", "Fighter"]


# -- case 5: a converted level gate blocks, then opens --------------------
def test_level_gate_became_a_point_threshold(engine, budget):
    """Agonizing Blast was `Warlock level 2`; it is now `6 points spent`.

    A brand-new character cannot take it - not because of level, but because
    they have not spent enough. After spending elsewhere, the same node opens.
    """
    node = engine.nodes["of_agonizing_blast_xphb"]
    assert node["prereqs"]["logic"] == "THRESHOLD"
    threshold = node["prereqs"]["threshold_count"]

    state = engine.start_state("Warlock", budget)
    blocked = engine.can_afford(state, "of_agonizing_blast_xphb")
    assert blocked["affordable"] is False
    assert blocked["reason"] == "unmet_prerequisites"
    assert any("points spent" in reason for reason in blocked["blocking_prereqs"])

    _spend_in_zone(engine, state, "Warlock", threshold)
    assert state.points_spent >= threshold

    opened = engine.can_afford(state, "of_agonizing_blast_xphb")
    assert opened["affordable"] is True


# -- case 6: node prerequisites are honoured ------------------------------
def test_node_prerequisite_must_be_owned_first(engine):
    """Devouring Blade needs Thirsting Blade, which needs Pact of the Blade.

    Both of those also carry converted level gates, so the chain has to be
    acquired in order and with enough points already spent - exactly the RAW
    dependency, expressed without ever mentioning a level.
    """
    state = engine.start_state("Warlock", 500)
    assert engine.can_afford(state, "of_devouring_blade_xphb")["affordable"] is False

    engine.allocate(state, "of_pact_of_the_blade_xphb")
    _spend_in_zone(engine, state, "Warlock", 20)
    engine.allocate(state, "of_thirsting_blade_xphb")
    assert "of_thirsting_blade_xphb" in state.owned

    still_blocked = engine.can_afford(state, "of_devouring_blade_xphb")
    assert still_blocked["affordable"] is False
    assert not any(
        "of_thirsting_blade_xphb" in reason for reason in still_blocked["blocking_prereqs"]
    )

    _spend_in_zone(engine, state, "Warlock", 40)
    assert engine.can_afford(state, "of_devouring_blade_xphb")["affordable"] is True


# -- case 7: budget is what stops you, not level --------------------------
def test_budget_limits_cross_zone_shopping(engine):
    """A five-point character cannot buy their way into a far zone."""
    poor = engine.start_state("Bard", 5)
    result = engine.can_afford(poor, "cf_fighter_three_extra_attacks_20")
    assert result["affordable"] is False
    assert result["reason"] in ("insufficient_points", "unmet_prerequisites")

    rich = engine.start_state("Bard", 500)
    assert engine.can_afford(rich, "cf_fighter_three_extra_attacks_20")["affordable"] is True


# -- engine behaviour -----------------------------------------------------
def test_zone_gate_is_required_for_zone_interiors(engine, budget):
    state = engine.start_state("Bard", budget)
    for node in engine.nodes.values():
        if node["zone"] == "Monk" and not node.get("is_gate"):
            assert "gate_monk" in node["prereqs"]["nodes"]
            break
    result = engine.can_afford(state, "cf_monk_martial_arts_1")
    assert "gate_monk" in result["path"]


def test_allocate_applies_the_whole_path(engine, budget):
    state = engine.start_state("Druid", budget)
    result = engine.allocate(state, "cf_druid_epic_boon_19")
    assert set(result["path"]).issubset(state.owned)
    assert state.points_spent == result["total_cost"]
    # buying it again is free and returns the trivial path
    again = engine.can_afford(state, "cf_druid_epic_boon_19")
    assert again["total_cost"] == 0 and again["reason"] == "already_owned"


def test_hit_die_comes_from_the_starting_zone(engine, budget):
    """Task 2c - hit die is a one-time lock, read straight off classes_meta."""
    assert engine.hit_die(engine.start_state("Barbarian", budget)) == {"number": 1, "faces": 12}
    assert engine.hit_die(engine.start_state("Wizard", budget)) == {"number": 1, "faces": 6}
    # pathing into another zone never changes it
    state = engine.start_state("Wizard", budget)
    engine.allocate(state, "cf_barbarian_rage_1")
    assert engine.hit_die(state) == {"number": 1, "faces": 6}


def test_unknown_node_is_reported_not_raised(engine, budget):
    result = engine.can_afford(engine.start_state("Bard", budget), "nope")
    assert result == {
        "affordable": False,
        "path": [],
        "total_cost": None,
        "reason": "unknown_node",
        "blocking_prereqs": [],
    }


def test_queries_are_fast_enough_for_hover(engine, budget):
    """One search serves the whole board; a thousand hovers must stay cheap."""
    state = engine.start_state("Sorcerer", budget)
    targets = list(engine.nodes)[:1000]
    engine.can_afford(state, targets[0])  # warm the cache

    started = time.perf_counter()
    for target in targets:
        engine.can_afford(state, target)
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, f"1000 cached queries took {elapsed:.3f}s"


def test_level_is_never_consulted_at_runtime(engine, budget):
    """Locked decision 1: level positions nodes, it does not gate them."""
    state = engine.start_state("Monk", budget)
    capstone = engine.can_afford(state, "cf_monk_body_and_mind_20")
    assert capstone["affordable"] is True
    assert engine.nodes["cf_monk_body_and_mind_20"]["level"] == 20
