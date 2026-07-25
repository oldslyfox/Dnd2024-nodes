#!/usr/bin/env python3
"""Export PathEngine results as fixtures for the JavaScript port to match.

Work Order 3, Task 3: the JS engine must produce identical results to the Python
one. Porting the seven hand-checked cases from tests/test_pathing.py is the floor;
this goes further and records the Python engine's answer for a wide sweep of
queries, so any drift in the port shows up as a failing case rather than as a
subtly different path somewhere nobody looks.

    python3 scripts/export_engine_fixtures.py -> web/tests/fixtures/engine_cases.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dnd2024 import config  # noqa: E402
from dnd2024.pathing import PathEngine  # noqa: E402

OUT = ROOT / "web" / "tests" / "fixtures" / "engine_cases.json"

# The hand-traced cases from tests/test_pathing.py, by name, so the JS side can
# report them the same way a reviewer would recognise.
NAMED_CASES = [
    ("same_zone_capstone", "Wizard", "cf_wizard_spell_mastery_18"),
    ("slot_spine_full", "Cleric", "slot_cleric_t9"),
    ("cross_zone_extra_attack", "Wizard", "cf_fighter_extra_attack_5"),
    ("weapon_mastery_from_martial", "Barbarian", "mastery_cleave_xphb"),
    ("weapon_mastery_from_caster", "Wizard", "mastery_cleave_xphb"),
    ("threshold_blocked", "Warlock", "of_agonizing_blast_xphb"),
    ("prereq_chain_blocked", "Warlock", "of_devouring_blade_xphb"),
    ("gate_required", "Bard", "cf_monk_martial_arts_1"),
    ("epic_boon_deep", "Druid", "cf_druid_epic_boon_19"),
    ("unknown_node", "Bard", "nope"),
]


def _result(engine, state, target):
    result = engine.can_afford(state, target)
    return {
        "affordable": result["affordable"],
        "total_cost": result["total_cost"],
        "path": result["path"],
        "reason": result["reason"],
        "blocking_prereqs": result.get("blocking_prereqs", []),
    }


def sweep_targets(engine) -> list[str]:
    """A deterministic spread of targets across every zone and node type."""
    targets: list[str] = []
    by_zone: dict[str, list[str]] = {}
    for node in engine.graph["nodes"]:
        by_zone.setdefault(node["zone"], []).append(node["id"])
    for zone in sorted(by_zone):
        ids = sorted(by_zone[zone])
        step = max(1, len(ids) // 12)
        targets.extend(ids[::step][:12])
    return targets


def main() -> int:
    engine = PathEngine.load()
    budget = engine.graph["meta"]["point_economy"]["total_points_at_level_20"]

    cases = []
    for name, home_zone, target in NAMED_CASES:
        state = engine.start_state(home_zone, budget)
        cases.append(
            {
                "name": name,
                "home_zone": home_zone,
                "budget": budget,
                "owned_before": sorted(state.owned),
                "target": target,
                "expected": _result(engine, state, target),
            }
        )

    # broad sweep: every zone as a home zone, against a spread of targets
    sweep = []
    targets = sweep_targets(engine)
    for home_zone in config.ZONE_RING:
        state = engine.start_state(home_zone, budget)
        for target in targets:
            sweep.append(
                {
                    "home_zone": home_zone,
                    "target": target,
                    "expected": _result(engine, state, target),
                }
            )

    # allocation traces: state evolves, so this catches cache-invalidation drift
    traces = []
    for home_zone, buys in [
        ("Wizard", ["slot_wizard_t3", "cf_wizard_spell_mastery_18", "cf_fighter_extra_attack_5"]),
        ("Warlock", ["of_pact_of_the_blade_xphb", "slot_warlock_arcanum_9", "of_thirsting_blade_xphb"]),
        ("Rogue", ["cf_rogue_sneak_attack_1", "feat_ability_score_improvement_xphb", "mastery_vex_xphb"]),
        ("Barbarian", ["cf_barbarian_rage_1", "cf_barbarian_epic_boon_19", "slot_druid_t1"]),
    ]:
        state = engine.start_state(home_zone, budget)
        steps = []
        for target in buys:
            preview = _result(engine, state, target)
            engine.allocate(state, target)
            steps.append(
                {
                    "target": target,
                    "preview": preview,
                    "points_spent_after": state.points_spent,
                    "owned_after": sorted(state.owned),
                }
            )
        traces.append({"home_zone": home_zone, "steps": steps})

    chassis = {
        zone: {
            "chassis": engine.chassis(engine.start_state(zone, budget)),
            "hit_die": engine.hit_die(engine.start_state(zone, budget)),
            "saving_throws": engine.saving_throw_proficiencies(engine.start_state(zone, budget)),
            "weapons": engine.weapon_proficiencies(engine.start_state(zone, budget)),
        }
        for zone in config.ZONE_RING
    }

    payload = {
        "generated_by": "scripts/export_engine_fixtures.py",
        "purpose": (
            "Work Order 3 Task 3 - the JS PathEngine must reproduce every one of "
            "these exactly. Regenerate whenever graph.v2.json changes."
        ),
        "budget": budget,
        "graph_node_count": len(engine.graph["nodes"]),
        "named_cases": cases,
        "sweep": sweep,
        "allocation_traces": traces,
        "chassis_by_zone": chassis,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as handle:
        json.dump(payload, handle, indent=1)
    print(
        f"wrote {OUT.relative_to(ROOT)}: {len(cases)} named, {len(sweep)} sweep, "
        f"{len(traces)} traces, {len(chassis)} chassis"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
