"""Task 6 - guardrails. Flag, do not auto-solve.

Each detector answers one question: "if pathing is genuinely free, what does
this graph now let a player hold at the same time that RAW never could?"

Nothing here changes the graph. Every flag carries the node ids involved and a
measured cost - the number of points a character actually has to spend, from a
fresh start, to own the whole combination - so a human can judge whether the
combination is priced far enough away or not. Compare that number against
`total_points_at_level_20` in the point economy; a combo that costs a third of
the career budget is cheap, one that costs most of it is self-limiting.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import CORE_ZONE, ZONE_RING
from .pathing import PathEngine, PlayerState

ROOT = Path(__file__).resolve().parents[2]
BIG_BUDGET = 10_000


def _has(node: dict, *needles: str) -> bool:
    haystack = f"{node['name']} {node.get('effect_summary') or ''}".lower()
    return any(needle.lower() in haystack for needle in needles)


def prereq_closure(engine: PathEngine, node_ids: list[str]) -> list[str]:
    """Add the node prerequisites a combination implicitly drags along.

    AND groups pull in every member; OR groups pull in one representative (the
    first, which for the generated OR sets is the cheap connector rather than a
    feat). Point thresholds are not expanded - they are paid, not owned.
    """
    ordered = list(dict.fromkeys(node_ids))
    queue = list(ordered)
    while queue:
        node = engine.nodes.get(queue.pop())
        if node is None:
            continue
        requirements = node.get("prereqs") or {}
        groups = requirements.get("groups") or []
        for group in groups:
            members = group.get("nodes") or []
            if not members:
                continue
            picks = members if group.get("logic") != "OR" else [members[0]]
            for pick in picks:
                if pick not in ordered:
                    ordered.append(pick)
                    queue.append(pick)
    return ordered


def min_cost_to_own(engine: PathEngine, node_ids: list[str], home_zone: str) -> dict:
    """Greedy nearest-first allocation of every node in the set."""
    state = PlayerState(home_zone=home_zone, points_total=BIG_BUDGET)
    gate = f"gate_{home_zone.lower()}"
    if gate in engine.nodes:
        state.owned.add(gate)

    requested = [n for n in node_ids if n in engine.nodes]
    closure = prereq_closure(engine, requested)
    extras = [n for n in closure if n not in requested]
    remaining = list(closure)
    blocked: dict[str, list[str]] = {}
    while remaining:
        options = []
        for node_id in remaining:
            result = engine.can_afford(state, node_id)
            if result["affordable"]:
                options.append((result["total_cost"], node_id))
            else:
                blocked[node_id] = result.get("blocking_prereqs") or [result["reason"]]
        if not options:
            break
        options.sort()
        _, chosen = options[0]
        engine.allocate(state, chosen)
        blocked.pop(chosen, None)
        remaining.remove(chosen)

    return {
        "points_to_own_all": state.points_spent,
        "nodes_owned": len(state.owned) - 1,
        "pulled_in_as_prerequisites": extras,
        "not_ownable_from_this_start": {n: blocked[n] for n in remaining if n in blocked},
    }


def _flag(
    engine,
    flag_id,
    title,
    severity,
    concern,
    node_ids,
    home_zone,
    raw_position,
) -> dict:
    node_ids = [n for n in dict.fromkeys(node_ids) if n in engine.nodes]
    cost = min_cost_to_own(engine, node_ids, home_zone)
    budget = engine.graph["meta"]["point_economy"]["total_points_at_level_20"]
    return {
        "id": flag_id,
        "title": title,
        "severity": severity,
        "raw_position": raw_position,
        "concern": concern,
        "nodes": node_ids,
        "node_names": [engine.nodes[n]["name"] for n in node_ids],
        "measured": {
            **cost,
            "career_budget": budget,
            "share_of_career_budget": round(cost["points_to_own_all"] / budget, 2),
        },
        "suggested_review": (
            "Compare share_of_career_budget against how much of a build this "
            "combination actually is. If it is cheap, push the nodes deeper "
            "(Task 4 says depth, not price, is the lever)."
        ),
    }


def detect(engine: PathEngine) -> list[dict]:
    nodes = engine.nodes
    flags: list[dict] = []

    # 1 - Extra Attack stacking -------------------------------------------
    extra_attack = sorted(
        n["id"]
        for n in nodes.values()
        if _has(n, "extra attack") and n["type"] in ("class_feature", "optional_feature")
    )
    flags.append(
        _flag(
            engine,
            "extra_attack_stacking",
            "Multiple Extra Attack sources reachable by one character",
            "high",
            "RAW, Extra Attack from different classes explicitly does not stack, "
            "and multiclassing gates it behind class levels. Here every source is "
            "a node, and nothing in the data says they are mutually exclusive. A "
            "character that walks Fighter and Warlock can hold Two Extra Attacks "
            "and Thirsting Blade/Devouring Blade at once.",
            extra_attack,
            "Fighter",
            "Extra Attack features from different classes do not stack (2024 PHB, "
            "multiclassing).",
        )
    )

    # 2 - Two full spell slot progressions --------------------------------
    full_spines = sorted(
        n["id"]
        for n in nodes.values()
        if n["type"] == "spell_slot" and n.get("caster_chassis") == "full" and n.get("slot_tier") == 9
    )
    flags.append(
        _flag(
            engine,
            "double_full_caster_spine",
            "Two full-caster slot spines reachable by one character",
            "high",
            "RAW pools multiclass spell slots into one progression; two separate "
            "9th-level slot tracks is strictly more resource than any RAW "
            "character has. The spines are cheap to walk once you are inside a "
            "zone, so the only thing stopping this is cross-zone distance.",
            [full_spines[0], full_spines[1]] if len(full_spines) >= 2 else full_spines,
            "Wizard",
            "Multiclass casters share one pooled slot progression (2024 PHB, "
            "multiclass spellcasting).",
        )
    )

    # 3 - Heavy armor plus high-end mobility ------------------------------
    mobility = [
        n["id"]
        for n in nodes.values()
        if n["id"]
        in {
            "cf_monk_unarmored_movement_2",
            "feat_boon_of_speed_xphb",
            "cf_monk_step_of_the_wind_2",
            "cf_barbarian_fast_movement_5",
        }
    ]
    flags.append(
        _flag(
            engine,
            "heavy_armor_high_mobility",
            "Heavy armor training combined with monk/barbarian mobility",
            "medium",
            "Monk and Barbarian movement bonuses are RAW-conditional on wearing no "
            "armor (Monk) or no Heavy armor (Barbarian Rage). Armor training is now "
            "a purchasable core connector, so the conditionality has to be enforced "
            "in the rules layer - the tree cannot express it.",
            ["conn_training_heavy_armor", "feat_heavy_armor_master_xphb", *mobility],
            "Monk",
            "Unarmored Movement requires no armor; Rage requires no Heavy armor.",
        )
    )

    # 4 - Unarmored Defense stacking --------------------------------------
    unarmored = sorted(n["id"] for n in nodes.values() if _has(n, "unarmored defense"))
    flags.append(
        _flag(
            engine,
            "unarmored_defense_stacking",
            "Multiple Unarmored Defense calculations available at once",
            "medium",
            "Barbarian, Monk and College of Dance each define their own AC formula. "
            "Owning several does not stack in RAW, but nothing in the node data "
            "encodes 'pick the best, not the sum'.",
            unarmored,
            "Barbarian",
            "Only one Unarmored Defense formula applies at a time.",
        )
    )

    # 5 - Sneak Attack next to heavy multiattack --------------------------
    flags.append(
        _flag(
            engine,
            "sneak_attack_with_multiattack",
            "Full Sneak Attack progression alongside Extra Attack",
            "medium",
            "RAW this costs a rogue their whole level progression; here Sneak "
            "Attack scaling lives on the Rogue ladder and Extra Attack on the "
            "Fighter ladder, and both are reachable within one career budget.",
            [
                "cf_rogue_sneak_attack_1",
                "cf_rogue_cunning_strike_5",
                "cf_fighter_extra_attack_5",
                "cf_fighter_action_surge_2",
            ],
            "Rogue",
            "Sneak Attack dice scale with Rogue level only.",
        )
    )

    # 6 - Rage with spellcasting -------------------------------------------
    flags.append(
        _flag(
            engine,
            "rage_plus_spellcasting",
            "Rage held together with a full slot progression",
            "low",
            "RAW forbids casting or concentrating while Raging, which is a rules "
            "restriction rather than an acquisition restriction. Worth confirming "
            "the rules layer still enforces it once the tree stops caring about "
            "class identity.",
            ["cf_barbarian_rage_1", "slot_druid_t1", "slot_druid_t5"],
            "Barbarian",
            "You cannot cast or concentrate on spells while Raging.",
        )
    )

    # 7 - Expertise pile ---------------------------------------------------
    expertise = sorted(n["id"] for n in nodes.values() if _has(n, "expertise"))
    flags.append(
        _flag(
            engine,
            "expertise_pile",
            "Expertise grants from several zones plus Boon of Skill",
            "low",
            "The extraction already cross-links every Expertise feature to every "
            "other, so these sit unusually close together in the graph. Skill DCs "
            "are the softest part of the maths and the least likely to be checked.",
            expertise,
            "Rogue",
            "Expertise is granted a fixed number of times per class.",
        )
    )

    # 8 - Full ASI chain ---------------------------------------------------
    asi_chain = sorted(
        n["id"] for n in nodes.values() if n.get("repeat_chain") == "feat_ability_score_improvement_xphb"
    ) + ["feat_ability_score_improvement_xphb"]
    flags.append(
        _flag(
            engine,
            "asi_chain_available_to_all",
            "Every character can buy the Fighter-sized ASI chain",
            "medium",
            "The repeat chain is sized to the RAW ceiling (Fighter's seven slots), "
            "so a character in any zone can now reach seven ASIs. The 20-point cap "
            "per ability still applies, but the spread does not.",
            asi_chain,
            "Wizard",
            "ASI slot count varies by class (4 for most, 5 Rogue, 7 Fighter).",
        )
    )

    # 9 - Capstone collection ---------------------------------------------
    capstones = sorted(
        n["id"] for n in nodes.values() if n["type"] == "class_feature" and n.get("level") == 20
    )
    flags.append(
        _flag(
            engine,
            "multiple_capstones",
            "More than one level-20 capstone reachable in a career",
            "medium",
            "Capstones are designed as the single reward for never multiclassing. "
            "Depth is the only thing keeping a player from collecting two, so this "
            "is the clearest test of whether RING_STEP and the point budget are "
            "tuned correctly.",
            capstones[:3],
            "Fighter",
            "A character reaches exactly one level-20 class feature.",
        )
    )

    return flags


def resolved(engine: PathEngine) -> list[dict]:
    """Concerns raised in review and since settled. Kept for traceability."""
    nodes = engine.nodes
    shortcuts = []
    for edge in engine.graph["edges"]:
        if edge["relation"] != "reference":
            continue
        zone_a, zone_b = nodes[edge["from"]]["zone"], nodes[edge["to"]]["zone"]
        if zone_a == zone_b:
            continue
        if CORE_ZONE in (zone_a, zone_b) or "commons" in (zone_a, zone_b):
            continue
        if zone_a in ZONE_RING and zone_b in ZONE_RING:
            shortcuts.append(f"{edge['from']} -> {edge['to']}")

    return [
        {
            "id": "cross_zone_reference_shortcuts",
            "title": "Work Order 1 reference edges bypassed the depth ladder",
            "resolution": (
                "Marked non-traversable (Work Order 2 review, item 1). edges.json was "
                "a citation registry from the extraction, not designed connectivity. "
                "The edges stay in the data tagged relation=\"reference\" for future "
                "'see also' UI, and the pathing engine excludes them, so depth remains "
                "the sole balance lever under flat costing."
            ),
            "cross_zone_reference_edges": len(shortcuts),
            "examples": sorted(shortcuts)[:15],
        },
        {
            "id": "warlock_short_rest_recovery",
            "title": "Pact Magic short-rest recovery is not represented",
            "resolution": (
                "Out of scope (review, item 3). Recovery timing is character-state "
                "tracking, not tree structure; it belongs to a later work order. The "
                "Pact Magic chain models acquisition only, deliberately."
            ),
        },
        {
            "id": "slot_spine_cost_at_home",
            "title": "Slot spine nodes cost a point even in your own zone",
            "resolution": (
                "Correct as implemented (review, item 2). The own-zone exemption skips "
                "the connector toll, not the destination node's own price."
            ),
        },
    ]


def write_flags(engine: PathEngine | None = None) -> list[dict]:
    engine = engine or PathEngine.load()
    flags = detect(engine)
    out = ROOT / "data" / "output" / "balance_flags.json"
    payload = {
        "generated_for": "Work Order 2, Task 6",
        "policy": "flag only - no fixes are applied anywhere in this pipeline",
        "career_budget": engine.graph["meta"]["point_economy"]["total_points_at_level_20"],
        "how_to_read": (
            "measured.points_to_own_all is the real cost of the combination from a "
            "fresh character in the named home zone, using the same engine the UI "
            "calls. share_of_career_budget is that cost over the level-20 budget."
        ),
        "flags": flags,
        "resolved_in_review": resolved(engine),
        "see_also": "proficiency_gap_audit.json - the review's item 4 follow-up",
    }
    with open(out, "w") as handle:
        json.dump(payload, handle, indent=2)
    return flags


if __name__ == "__main__":  # pragma: no cover
    for flag in write_flags():
        print(f"[{flag['severity']:>6}] {flag['id']}: {flag['measured']}")
