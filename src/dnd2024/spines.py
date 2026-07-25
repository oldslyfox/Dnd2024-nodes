"""Task 2b - spell slot spines and the Warlock Pact Magic chain.

A spine is a linear chain of `spell_slot` nodes that runs from a zone's edge
(next to the shared core) out to its rim. Tier 1 sits shallow, tier 9 sits at
the outer rim, so the spine follows the same depth-from-level rule as
everything else without needing a special case.

Warlock is deliberately NOT a slot-count spine. Pact Magic scales on slot
*level* and short-rest recovery, so it gets its own shape: a Pact Magic root
with three branches (slot level, slot count, Mystic Arcanum). See
docs/layout_depth_rationale.md for the design-review flag on this.
"""

from __future__ import annotations

from . import config

ORDINALS = {
    1: "1st",
    2: "2nd",
    3: "3rd",
    4: "4th",
    5: "5th",
    6: "6th",
    7: "7th",
    8: "8th",
    9: "9th",
}


def _slot_node(
    node_id: str,
    name: str,
    zone: str,
    depth: float,
    effect: str,
    *,
    chassis: str,
    tier: int,
    subregion: str | None = None,
) -> dict:
    return {
        "id": node_id,
        "name": name,
        "type": "spell_slot",
        "role": "slot_spine",
        "generated": True,
        "source_book": None,
        "is_spine": True,
        "is_gate": False,
        "zone": zone,
        "subregion": subregion,
        "depth": depth,
        "point_cost": config.FLAT_POINT_COST,
        "tags": ["spell_slot", chassis],
        "caster_chassis": chassis,
        "slot_tier": tier,
        "effect_summary": effect,
        "mechanical_data": {"slot_tier": tier, "caster_chassis": chassis},
        "prereqs_raw": [],
    }


def build_spine(zone: str, chassis: str, subregion: str | None = None) -> list[dict]:
    """Return the ordered slot-spine nodes for one zone (or sub-region)."""
    tier_levels = {
        "full": config.FULL_CASTER_TIER_LEVELS,
        "half": config.HALF_CASTER_TIER_LEVELS,
        "third": config.THIRD_CASTER_TIER_LEVELS,
    }[chassis]
    length = {
        "full": config.FULL_CASTER_SPINE_LEN,
        "half": config.HALF_CASTER_SPINE_LEN,
        "third": config.THIRD_CASTER_SPINE_LEN,
    }[chassis]

    slug = zone.lower()
    if subregion:
        slug = f"{slug}_{subregion.lower().replace(' ', '_')}"

    nodes: list[dict] = []
    for tier in range(1, length + 1):
        depth = float(tier_levels[tier])
        if tier == 1:
            name = f"{subregion or zone} Spellcasting: Cantrips and 1st-Level Slots"
            effect = (
                "You gain the ability to prepare and cast spells of 1st level, "
                "along with cantrips, using this zone's spellcasting ability."
            )
        else:
            name = f"{subregion or zone} Spellcasting: {ORDINALS[tier]}-Level Slots"
            effect = f"You gain spell slots of {ORDINALS[tier]} level."
        nodes.append(
            _slot_node(
                f"slot_{slug}_t{tier}",
                name,
                zone,
                depth,
                effect,
                chassis=chassis,
                tier=tier,
                subregion=subregion,
            )
        )
    return nodes


def build_warlock_chain() -> tuple[list[dict], list[tuple[str, str]]]:
    """Pact Magic as its own shape. Returns (nodes, internal edges)."""
    zone = "Warlock"
    root = _slot_node(
        "slot_warlock_pact_root",
        "Pact Magic",
        zone,
        1.0,
        "You gain Pact Magic: a small number of spell slots that all sit at the "
        "same level and that you regain on a Short Rest.",
        chassis="pact",
        tier=0,
    )
    nodes = [root]
    edges: list[tuple[str, str]] = []

    previous = root["id"]
    for tier, level in sorted(config.WARLOCK_PACT_SLOT_LEVELS.items()):
        node = _slot_node(
            f"slot_warlock_pact_level_{tier}",
            f"Pact Slot Level: {ORDINALS[tier]}",
            zone,
            float(level),
            f"Your Pact Magic slots are {ORDINALS[tier]}-level slots.",
            chassis="pact",
            tier=tier,
        )
        node["mechanical_data"]["branch"] = "slot_level"
        nodes.append(node)
        edges.append((previous, node["id"]))
        previous = node["id"]

    previous = root["id"]
    for count, level in sorted(config.WARLOCK_PACT_SLOT_COUNTS.items()):
        node = _slot_node(
            f"slot_warlock_pact_count_{count}",
            f"Pact Slots: {count}",
            zone,
            float(level),
            f"You have {count} Pact Magic slots, regained on a Short Rest.",
            chassis="pact",
            tier=0,
        )
        node["mechanical_data"].update({"branch": "slot_count", "slot_count": count})
        nodes.append(node)
        edges.append((previous, node["id"]))
        previous = node["id"]

    previous = "slot_warlock_pact_level_5"
    for tier, level in sorted(config.WARLOCK_ARCANUM_LEVELS.items()):
        node = _slot_node(
            f"slot_warlock_arcanum_{tier}",
            f"Mystic Arcanum: {ORDINALS[tier]} Level",
            zone,
            float(level),
            f"You gain one {ORDINALS[tier]}-level spell that you can cast once "
            "without a slot, regained on a Long Rest.",
            chassis="pact",
            tier=tier,
        )
        node["mechanical_data"]["branch"] = "arcanum"
        nodes.append(node)
        edges.append((previous, node["id"]))
        previous = node["id"]

    return nodes, edges
