"""Static design configuration for the Work Order 2 graph build.

Everything in here is a design decision, not derived data. Anything computed
from the Work Order 1 extraction lives in the module that computes it.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# Zones
# --------------------------------------------------------------------------

CORE_ZONE = "core"

# Ring order (clockwise from angle 0). Ordering is deliberate: thematically
# adjacent classes are ring-adjacent, so that a boundary between two zones is a
# meaningful place to park a shared feat / optional feature.
#
#   martial arc ............ Barbarian -> Fighter -> Paladin
#   divine/primal arc ...... Cleric -> Druid -> Ranger
#   skirmisher arc ......... Rogue -> Artificer
#   arcane arc ............. Wizard -> Sorcerer -> Warlock
#   charisma/monastic arc .. Bard -> Monk  (Monk closes the ring back onto Barbarian)
ZONE_RING = [
    "Barbarian",
    "Fighter",
    "Paladin",
    "Cleric",
    "Druid",
    "Ranger",
    "Rogue",
    "Artificer",
    "Wizard",
    "Sorcerer",
    "Warlock",
    "Bard",
    "Monk",
]

MARTIAL_ZONES = {"Barbarian", "Fighter", "Paladin", "Ranger"}

# --------------------------------------------------------------------------
# Casting chassis (Task 2b)
# --------------------------------------------------------------------------

FULL_CASTERS = ["Wizard", "Cleric", "Druid", "Bard", "Sorcerer"]
HALF_CASTERS = ["Paladin", "Ranger", "Artificer"]
# (class, subclass) -> third-caster spine lives inside that subclass sub-region
THIRD_CASTERS = [("Fighter", "Eldritch Knight"), ("Rogue", "Arcane Trickster")]

FULL_CASTER_SPINE_LEN = 9
HALF_CASTER_SPINE_LEN = 5
THIRD_CASTER_SPINE_LEN = 4

# RAW level at which a caster of each chassis first gains a slot of tier N.
# Used only for positioning depth of spine nodes.
FULL_CASTER_TIER_LEVELS = {1: 1, 2: 3, 3: 5, 4: 7, 5: 9, 6: 11, 7: 13, 8: 15, 9: 17}
HALF_CASTER_TIER_LEVELS = {1: 2, 2: 5, 3: 9, 4: 13, 5: 17}
THIRD_CASTER_TIER_LEVELS = {1: 3, 2: 7, 3: 13, 4: 19}

# Warlock Pact Magic is modelled as its own chain (Task 2b explicitly forbids
# reusing the slot-count spine). Two branches off a shared Pact Magic root:
#   * pact slot LEVEL chain (RAW: slot level rises at 1/3/5/7/9)
#   * pact slot COUNT chain (RAW: 2 slots at 2, 3 at 11, 4 at 17)
#   * Mystic Arcanum chain (6th/7th/8th/9th at 11/13/15/17)
WARLOCK_PACT_SLOT_LEVELS = {1: 1, 2: 3, 3: 5, 4: 7, 5: 9}
WARLOCK_PACT_SLOT_COUNTS = {2: 2, 3: 11, 4: 17}
WARLOCK_ARCANUM_LEVELS = {6: 11, 7: 13, 8: 15, 9: 17}

# --------------------------------------------------------------------------
# Depth (Task 2d)
# --------------------------------------------------------------------------
#
# depth_units == RAW character level, verbatim. Everything non-level-bearing is
# mapped onto that same 0..20 scale so a single number orders the whole graph.
DEPTH_MIN = 0
DEPTH_MAX = 20

# The connector ladder that normalizes depth carries one rung per three levels.
# Granularity is a tuning knob between Task 1's density target (2-4 connectors
# between two notable nodes in the same zone) and Task 2d's normalization, and
# it was retuned once the extraction's reference edges stopped being traversable
# - those had been quietly shortening paths. Measured, same-zone / cross-zone
# mean connectors crossed:
#     every level   6.4 / 9.2   too long
#     every 2       4.1 / 7.4   just over the band
#     every 3       3.7 / 6.6   <- chosen
#     every 4       3.4 / 6.2   band met, but depth resolution starts to blur
# Normalization holds at any of these: "level 10" is the same number of hops
# from the hub in all thirteen zones either way.
LADDER_RUNG_LEVELS = list(range(1, 21, 3))  # 1, 4, 7, 10, 13, 16, 19

DEPTH_ORIGIN_FEAT = 1  # granted at character creation via background
DEPTH_GENERAL_FEAT = 4  # first normally available at level 4
DEPTH_GENERAL_FEAT_HIGH_IMPACT = 6  # see HIGH_IMPACT_GENERAL_FEATS
DEPTH_FIGHTING_STYLE = 2  # Fighter 1 / Paladin 2 / Ranger 2 -> round to 2
DEPTH_EPIC_BOON = 20  # RAW prereq is level 19; boons are the deepest nodes
DEPTH_GATE = 1
DEPTH_WEAPON_MASTERY = 2  # Weapon Mastery is a level 1 martial class feature
DEPTH_HUB = 0

# General feats whose real power is out of line with the rest of the category.
# Task 4 makes positional depth the only balancing lever, so these get pushed
# two rings further out rather than repriced.
HIGH_IMPACT_GENERAL_FEATS = {
    "feat_great_weapon_master_xphb",
    "feat_sharpshooter_xphb",
    "feat_polearm_master_xphb",
    "feat_sentinel_xphb",
    "feat_crossbow_expert_xphb",
    "feat_dual_wielder_xphb",
    "feat_mage_slayer_xphb",
    "feat_elemental_adept_xphb",
    "feat_fey_touched_xphb",
    "feat_shadow_touched_xphb",
    "feat_inspiring_leader_xphb",
    "feat_war_caster_xphb",
    "feat_heavy_armor_master_xphb",
    "feat_resilient_xphb",
}

# --------------------------------------------------------------------------
# Repeatable nodes (Task 4)
# --------------------------------------------------------------------------
# Repeatable feats become a short chain of discrete nodes at increasing depth
# instead of one infinitely-purchasable node. Depths are the RAW levels at which
# a character could actually have taken the Nth repeat.
ASI_CHAIN_DEPTHS = [4, 6, 8, 12, 14, 16, 19]  # Fighter's 7 ASI slots = RAW ceiling
REPEATABLE_FEAT_CHAINS = {
    # feat id -> depths of repeat #2, #3, ... (repeat #1 is the base node)
    "feat_ability_score_improvement_xphb": ASI_CHAIN_DEPTHS,
    "feat_magic_initiate_xphb": [1, 8, 14],  # one per spell list (Cleric/Druid/Wizard)
    "feat_skilled_xphb": [1, 8, 14],
    "feat_elemental_adept_xphb": [6, 12, 18],
}

# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------
CORE_RADIUS = 2.0  # radius of the shared core disc
RING_STEP = 3.0  # graph units added per depth unit
ZONE_WEDGE_FILL = 0.78  # fraction of a zone's angular slice its own nodes may use

# --------------------------------------------------------------------------
# Point economy (Task 0 / locked decision 2)
# --------------------------------------------------------------------------
POINT_GENEROSITY = 1.75  # inside the locked 1.5-2.0x band
FLAT_POINT_COST = 1  # Task 4: every node costs exactly 1

# --------------------------------------------------------------------------
# Optional-feature routing (Task 2)
# --------------------------------------------------------------------------
# Optional features are class-owned in RAW but sit on the boundary between the
# owning zone and the ring-neighbour that most plausibly shares the fantasy.
OPTIONAL_FEATURE_HOME = {
    "eldritch_invocation": ("Warlock", "Sorcerer"),
    "metamagic": ("Sorcerer", "Wizard"),
    "maneuver_battle_master": ("Fighter", "Barbarian"),
}

# Fighting-style feats that are locked to one class's Fighting Style feature.
FIGHTING_STYLE_HOME = {
    "fighting_style_paladin": "Paladin",
    "fighting_style_ranger": "Ranger",
}

# Which zone boundary a general/origin feat gravitates to, keyed by the ability
# score it grants. Feats granting no ability score fall back to the core.
ABILITY_AFFINITY = {
    "str": ("Barbarian", "Fighter"),
    "dex": ("Rogue", "Ranger"),
    "con": ("Barbarian", "Fighter"),
    "int": ("Wizard", "Artificer"),
    "wis": ("Druid", "Cleric"),
    "cha": ("Bard", "Warlock"),
}
