"""Task 3 - prerequisite normalization.

Every node ends up with:

    "prereqs": {
        "logic": "AND" | "OR" | "THRESHOLD",
        "nodes": ["node_id", ...],
        "threshold_count": null | int,
        "groups": [{"logic": "AND"|"OR", "nodes": [...]}, ...]
    }

`logic` / `nodes` / `threshold_count` are exactly the fields the work order
specifies. `groups` is an additional refinement, and it exists because a
handful of RAW prerequisites are genuinely an AND of ORs ("level 4 AND
[Medium armor training from any source]"). `nodes` is always the flattened
union of every group, so a consumer that reads only the three specified fields
still sees the complete node list.

Semantics:

  AND        every id in `nodes` must be owned.
  OR         at least one id in `nodes` must be owned.
  THRESHOLD  the player must have spent at least `threshold_count` points in
             total, and `nodes`/`groups` must also be satisfied. Every RAW
             *character level* gate converts into this form - the conversion
             ratio is `PointEconomy.threshold_for_level` and is documented in
             docs/point_economy.md.
  groups     when present, satisfaction is AND across groups and each group is
             resolved by its own logic. This is the authoritative form.

Ability-score requirements never enter tree logic; they land in a sibling
`ability_prereqs` field holding a list of alternatives (satisfy any one).
Requirements referencing content this project has not modelled yet (spell
knowledge - Phase 3) land in `prereq_notes` and gate nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field


def empty_prereqs() -> dict:
    return {"logic": "AND", "nodes": [], "threshold_count": None, "groups": []}


@dataclass
class PrereqIndex:
    """Lookup tables needed to turn RAW references into node ids."""

    class_feature_by_name: dict[str, list[str]] = field(default_factory=dict)
    optional_feature_ids: dict[str, str] = field(default_factory=dict)
    armor_training_nodes: dict[str, list[str]] = field(default_factory=dict)
    spellcasting_entry_nodes: list[str] = field(default_factory=list)

    @classmethod
    def build(cls, nodes: list[dict]) -> "PrereqIndex":
        index = cls()
        for node in nodes:
            key = node["name"].strip().lower()
            if node["type"] == "class_feature":
                index.class_feature_by_name.setdefault(key, []).append(node["id"])
            if node["type"] == "optional_feature":
                index.optional_feature_ids[key] = node["id"]
        return index

    def resolve_optional_feature(self, ref: str) -> str | None:
        """`"pact of the blade|xphb"` -> node id."""
        return self.optional_feature_ids.get(ref.split("|")[0].strip().lower())

    def resolve_feature(self, name: str) -> list[str]:
        return list(self.class_feature_by_name.get(name.strip().lower(), []))


def _dedupe(items) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _group(nodes: list[str]) -> dict:
    return {"logic": "AND" if len(nodes) == 1 else "OR", "nodes": nodes}


def _resolve_other_summary(entry: str, index: PrereqIndex) -> list[str]:
    """The two `otherSummary` prereqs in the data (Paladin/Ranger fighting styles)."""
    text = entry.lower()
    if "fighting style" not in text:
        return []
    for class_name in ("paladin", "ranger", "fighter"):
        if class_name in text:
            scoped = [
                node_id
                for node_id in index.resolve_feature("Fighting Style")
                if f"_{class_name}_" in node_id
            ]
            if scoped:
                return scoped
    return index.resolve_feature("Fighting Style")


def _block(block: dict, index: PrereqIndex, economy) -> dict:
    """Convert one RAW requirement block into groups/threshold/abilities/notes."""
    groups: list[dict] = []
    threshold: int | None = None
    abilities: dict[str, int] = {}
    notes: list[str] = []

    for key, value in block.items():
        if key == "level":
            level = value["level"] if isinstance(value, dict) else value
            klass = value.get("class", {}).get("name") if isinstance(value, dict) else None
            converted = economy.threshold_for_level(int(level))
            if converted > 0:
                threshold = max(threshold or 0, converted)
            notes.append(
                f"RAW level {level}{f' ({klass})' if klass else ''} -> "
                f"{converted} points spent"
            )
        elif key == "ability":
            for entry in value:
                for ability, score in entry.items():
                    abilities[ability] = max(abilities.get(ability, 0), int(score))
        elif key == "feature":
            for feature_name in value:
                resolved = index.resolve_feature(feature_name)
                if resolved:
                    groups.append(_group(_dedupe(resolved)))
                else:
                    notes.append(f"unresolved feature prerequisite: {feature_name}")
        elif key == "optionalfeature":
            for ref in value:
                resolved = index.resolve_optional_feature(ref)
                if resolved:
                    groups.append(_group([resolved]))
                else:
                    notes.append(f"unresolved optional feature prerequisite: {ref}")
        elif key == "proficiency":
            for entry in value:
                for kind, what in entry.items():
                    resolved = (
                        index.armor_training_nodes.get(what, []) if kind == "armor" else []
                    )
                    if resolved:
                        groups.append(_group(_dedupe(resolved)))
                    else:
                        notes.append(f"unmodelled proficiency prerequisite: {kind}={what}")
        elif key == "spellcasting2020":
            if index.spellcasting_entry_nodes:
                groups.append(_group(_dedupe(index.spellcasting_entry_nodes)))
            else:
                notes.append("spellcasting prerequisite could not be resolved")
        elif key == "spell":
            for entry in value:
                summary = (
                    (entry.get("entrySummary") or entry.get("entry"))
                    if isinstance(entry, dict)
                    else str(entry)
                )
                notes.append(f"spell prerequisite deferred to Phase 3: {summary}")
        elif key == "otherSummary":
            entry = value.get("entry", "") if isinstance(value, dict) else str(value)
            resolved = _resolve_other_summary(entry, index)
            if resolved:
                groups.append(_group(_dedupe(resolved)))
            else:
                notes.append(f"unresolved special prerequisite: {entry}")
        else:
            notes.append(f"unhandled prerequisite key: {key}")

    return {
        "groups": groups,
        "threshold": threshold,
        "abilities": abilities,
        "notes": notes,
    }


def _signature(block: dict) -> tuple:
    return (
        tuple((g["logic"], tuple(g["nodes"])) for g in block["groups"]),
        block["threshold"],
    )


def normalize(node: dict, index: PrereqIndex, economy) -> dict:
    """Return {prereqs, ability_prereqs, prereq_notes} for one node."""
    raw = node.get("prereqs_raw")
    if raw is None:
        raw = node.get("prereqs") or []
    if isinstance(raw, dict):
        raw = [raw]
    blocks = [_block(b, index, economy) for b in raw if b]

    ability_alternatives = [b["abilities"] for b in blocks if b["abilities"]]
    notes = [note for b in blocks for note in b["notes"]]

    if not blocks:
        return {
            "prereqs": empty_prereqs(),
            "ability_prereqs": ability_alternatives,
            "prereq_notes": notes,
        }

    signatures = {_signature(b) for b in blocks}
    if len(signatures) == 1:
        # Alternatives that differ only in ability scores (the common case).
        groups = blocks[0]["groups"]
        threshold = blocks[0]["threshold"]
    else:
        # Genuinely different alternatives: OR the whole thing together, and
        # take the cheapest threshold since satisfying any one branch suffices.
        merged = _dedupe([n for b in blocks for g in b["groups"] for n in g["nodes"]])
        groups = [{"logic": "OR", "nodes": merged}] if merged else []
        thresholds = [b["threshold"] for b in blocks if b["threshold"] is not None]
        threshold = min(thresholds) if thresholds else None
        notes.append("alternative prerequisite branches collapsed to OR")

    flattened = _dedupe([n for g in groups for n in g["nodes"]])
    if threshold is not None:
        logic = "THRESHOLD"
    elif len(groups) == 1 and groups[0]["logic"] == "OR":
        logic = "OR"
    else:
        logic = "AND"

    return {
        "prereqs": {
            "logic": logic,
            "nodes": flattened,
            "threshold_count": threshold,
            "groups": groups,
        },
        "ability_prereqs": ability_alternatives,
        "prereq_notes": notes,
    }


def satisfied(prereqs: dict, owned: set[str], points_spent: int) -> bool:
    """Runtime check. Level never appears here - only points and connectivity."""
    if prereqs.get("threshold_count") is not None:
        if points_spent < prereqs["threshold_count"]:
            return False

    groups = prereqs.get("groups")
    if groups:
        for group in groups:
            nodes = group.get("nodes") or []
            if not nodes:
                continue
            if group.get("logic") == "OR":
                if not any(n in owned for n in nodes):
                    return False
            elif not all(n in owned for n in nodes):
                return False
        return True

    nodes = prereqs.get("nodes") or []
    if not nodes:
        return True
    if prereqs.get("logic") == "OR":
        return any(n in owned for n in nodes)
    return all(n in owned for n in nodes)
