"""Point budget derivation (locked design decision 2).

Level is decoupled from unlocking: it exists only to hand out points on a curve.
The curve is derived from the RAW baseline measured off the Work Order 1
extraction, not guessed.

RAW baseline for one 20-level career
------------------------------------
A RAW single-class character acquires, over levels 1-20:
  * every class feature of its class                     (counted from graph.json)
  * every feature of the one subclass it picked          (counted from graph.json,
    averaged over that class's four subclasses)
  * a pick for every optional-feature slot the class table grants
    (Warlock invocations, Sorcerer metamagic, Battle Master maneuvers) - taken
    from `optionalfeature_progression` in classes_meta.json where present
  * the weapon masteries its class table grants
Each of those is one "meaningful build choice". ASI/feat slots are already in
the class-feature counts (they are extracted as `Ability Score Improvement`
nodes), so they are not added twice.

The point total at level 20 is POINT_GENEROSITY x the mean baseline across
classes, and the per-level grant follows the RAW acquisition distribution so
that levels which are busy in RAW stay busy here.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from . import config

# Optional-feature picks a class table grants across levels 1-20. Warlock and
# Sorcerer come straight out of classes_meta.optionalfeature_progression; the
# Battle Master maneuver count is a subclass table (Fighter 3 -> 9 maneuvers
# known) that Work Order 1 did not extract, so it is stated here explicitly.
SUBCLASS_OPTIONAL_PICKS = {("Fighter", "Battle Master"): 9}

# Weapon masteries known at level 20 per class table (2024 PHB).
WEAPON_MASTERY_PICKS = {
    "Barbarian": 3,
    "Fighter": 4,
    "Paladin": 3,
    "Ranger": 3,
    "Rogue": 3,
}


@dataclass
class PointEconomy:
    """The full derived economy: baseline, total, and the level -> points curve."""

    per_class_baseline: dict[str, int]
    mean_baseline: float
    total_points_at_20: int
    grants_per_level: dict[int, int]  # level -> points granted on reaching it
    cumulative: dict[int, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        running = 0
        for level in range(1, 21):
            running += self.grants_per_level[level]
            self.cumulative[level] = running

    def points_at_level(self, level: int) -> int:
        return self.cumulative[max(1, min(20, int(level)))]

    def threshold_for_level(self, level: int) -> int:
        """Points-spent threshold that replaces a RAW `character level N` gate.

        Convention (Task 3): a level-N gate becomes "you must have spent at
        least as many points as a RAW character has banked by the *end of level
        N-1*". Level 1 gates become 0 (no gate at all).
        """
        level = int(level)
        if level <= 1:
            return 0
        return self.points_at_level(level - 1)

    def to_dict(self) -> dict:
        return {
            "generosity_multiplier": config.POINT_GENEROSITY,
            "per_class_raw_baseline": self.per_class_baseline,
            "mean_raw_baseline": round(self.mean_baseline, 2),
            "total_points_at_level_20": self.total_points_at_20,
            "grants_per_level": {str(k): v for k, v in self.grants_per_level.items()},
            "cumulative_points_by_level": {str(k): v for k, v in self.cumulative.items()},
            "level_to_threshold": {
                str(lvl): self.threshold_for_level(lvl) for lvl in range(1, 21)
            },
        }


def _optional_picks_for_class(class_name: str, classes_meta: dict) -> int:
    meta = classes_meta.get(class_name) or {}
    total = 0
    for entry in meta.get("optionalfeature_progression") or []:
        progression = entry.get("progression")
        if isinstance(progression, list):  # per-level counts, index 0 == level 1
            total += max(progression) if progression else 0
        elif isinstance(progression, dict):  # {level: count}
            total += max(int(v) for v in progression.values()) if progression else 0
    for (cls, _subclass), count in SUBCLASS_OPTIONAL_PICKS.items():
        if cls == class_name:
            total += count
    return total


def compute_economy(nodes: list[dict], classes_meta: dict) -> PointEconomy:
    class_features = Counter()
    subclass_features: dict[str, Counter] = defaultdict(Counter)
    level_acquisitions = Counter()

    for node in nodes:
        if node["type"] == "class_feature":
            class_features[node["source_class"]] += 1
            level_acquisitions[int(node["level"])] += 1
        elif node["type"] == "subclass_feature":
            subclass_features[node["source_class"]][node["subclass"]] += 1

    per_class: dict[str, int] = {}
    for class_name in classes_meta:
        cf = class_features.get(class_name, 0)
        if not cf:
            continue  # no extracted content (Artificer): cannot form a baseline
        subs = subclass_features.get(class_name)
        mean_sub = statistics.mean(subs.values()) if subs else 0.0
        per_class[class_name] = round(
            cf
            + mean_sub
            + _optional_picks_for_class(class_name, classes_meta)
            + WEAPON_MASTERY_PICKS.get(class_name, 0)
        )

    mean_baseline = statistics.mean(per_class.values())
    total = round(mean_baseline * config.POINT_GENEROSITY)

    # Shape the curve like RAW acquisition: levels that hand out a lot of class
    # features in RAW hand out a lot of points here. Every level grants >= 1.
    weights = {lvl: level_acquisitions.get(lvl, 0) for lvl in range(1, 21)}
    weight_sum = sum(weights.values())
    grants = {lvl: 1 for lvl in range(1, 21)}
    remaining = total - 20
    if remaining > 0 and weight_sum:
        exact = {lvl: remaining * w / weight_sum for lvl, w in weights.items()}
        floors = {lvl: int(v) for lvl, v in exact.items()}
        leftover = remaining - sum(floors.values())
        # hand the rounding remainder to the levels with the largest fraction
        order = sorted(range(1, 21), key=lambda lvl: exact[lvl] - floors[lvl], reverse=True)
        for lvl in order[:leftover]:
            floors[lvl] += 1
        for lvl in range(1, 21):
            grants[lvl] += floors[lvl]

    return PointEconomy(
        per_class_baseline=per_class,
        mean_baseline=mean_baseline,
        total_points_at_20=sum(grants.values()),
        grants_per_level=grants,
    )
