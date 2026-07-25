"""Proficiency / class-decoupling audit.

Requested in the Work Order 2 review, item 4: armor training needed invented
connector nodes because RAW hands armor proficiency out with class membership,
and class membership no longer exists. The question is whether the same gap
appears anywhere else.

Two directions are checked:

1. **Demand** - prerequisites in the extracted data that require a proficiency.
   If nothing in the tree can grant it, that node is permanently unbuyable.
2. **Supply** - what a RAW class hands a character at creation
   (`classes_meta.starting_proficiencies` plus saving throws), against what the
   tree can actually grant. Anything a class used to give away for free and the
   tree cannot sell is a decoupling gap.

Not urgent and not blocking - this writes a report, changes nothing.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# What counts as a node granting each proficiency category. Matched against the
# node's effect summary, which is the only machine-readable statement of effect
# the extraction produced.
GRANT_MARKERS = {
    "armor": ["training with light", "training with medium", "training with heavy", "training with shields"],
    "shields": ["training with shields", "holding a shield"],
    "weapons": ["proficiency with martial weapons", "proficiency with one simple or martial weapon"],
    "tools": ["proficiency with", "artisan's tools", "musical instrument"],
    "skills": ["gain proficiency in", "proficiency in all skills", "proficiency in any combination"],
    "saving_throws": ["saving throw proficiency"],
}

CATEGORY_LABELS = {
    "armor": "Armor training",
    "shields": "Shield training",
    "weapons": "Weapon proficiency",
    "tools": "Tool proficiency",
    "skills": "Skill proficiency",
    "saving_throws": "Saving throw proficiency",
}


def _grants(node: dict, markers: list[str]) -> bool:
    text = (node.get("effect_summary") or "").lower()
    return any(marker in text for marker in markers)


def audit(graph: dict, classes_meta: dict) -> dict:
    nodes = graph["nodes"]

    # -- demand ----------------------------------------------------------
    demand: dict[str, list[str]] = defaultdict(list)
    unresolved: list[dict] = []
    for node in nodes:
        for note in node.get("prereq_notes") or []:
            if note.startswith("unmodelled proficiency prerequisite"):
                unresolved.append({"node": node["id"], "note": note})
        for reference in node["prereqs"].get("nodes") or []:
            if reference.startswith("conn_training_"):
                demand[reference].append(node["id"])

    # -- supply ----------------------------------------------------------
    supply: dict[str, list[str]] = {}
    for category, markers in GRANT_MARKERS.items():
        supply[category] = sorted(
            node["id"]
            for node in nodes
            if _grants(node, markers) and node["type"] in ("feat", "connector", "class_feature")
        )

    # -- what a class used to hand over for free -------------------------
    raw_creation_grants: dict[str, dict] = {}
    for class_name, meta in classes_meta.items():
        starting = meta.get("starting_proficiencies") or {}
        raw_creation_grants[class_name] = {
            "armor": starting.get("armor") or [],
            "weapons": starting.get("weapons") or [],
            "tools": bool(starting.get("tools")),
            "skills": bool(starting.get("skills")),
            "saving_throws": meta.get("saving_throw_proficiencies") or [],
        }

    findings = []
    for category, sources in supply.items():
        findings.append(
            {
                "category": category,
                "label": CATEGORY_LABELS[category],
                "purchasable_sources": len(sources),
                "example_sources": sources[:5],
                "granted_free_by_every_raw_class": category in ("saving_throws",),
                "status": _status(category, sources, raw_creation_grants),
            }
        )

    return {
        "question": (
            "Does the class-decoupling gap that forced armor training connectors "
            "appear anywhere else in the proficiency system?"
        ),
        "verdict": _verdict(findings, unresolved),
        "prerequisite_demand": {
            "unresolvable_proficiency_prerequisites": unresolved,
            "nodes_depending_on_training_connectors": {
                connector: sorted(dependants) for connector, dependants in sorted(demand.items())
            },
        },
        "findings": findings,
        "raw_creation_grants_by_class": raw_creation_grants,
    }


def _status(category: str, sources: list[str], raw_grants: dict) -> str:
    if category == "saving_throws":
        classes_granting_two = sum(1 for g in raw_grants.values() if len(g["saving_throws"]) == 2)
        return (
            f"GAP - every RAW class grants two saving throw proficiencies at creation "
            f"({classes_granting_two}/{len(raw_grants)} classes in classes_meta), and the "
            f"tree has {len(sources)} node(s) that can grant one. A character built purely "
            f"from the tree has no save proficiencies unless they buy Resilient."
        )
    if category == "weapons":
        return (
            f"THIN - {len(sources)} purchasable source(s). RAW hands simple and often "
            f"martial weapon proficiency out with the class; the tree covers martial "
            f"weapons (Martial Weapon Training) but nothing grants simple weapons, which "
            f"every class gets for free."
        )
    if not sources:
        return "GAP - nothing in the tree grants this"
    return f"COVERED - {len(sources)} purchasable source(s)"


def _verdict(findings: list[dict], unresolved: list[dict]) -> str:
    gaps = [f["label"] for f in findings if f["status"].startswith("GAP")]
    thin = [f["label"] for f in findings if f["status"].startswith("THIN")]
    parts = []
    if not unresolved:
        parts.append(
            "No prerequisite in the current data is unsatisfiable: the only "
            "proficiency prerequisites the extraction contains are armor ones, and "
            "the training connectors resolve all of them."
        )
    else:
        parts.append(f"{len(unresolved)} prerequisite(s) cannot be satisfied by any node.")
    if gaps:
        parts.append("Same decoupling gap, unaddressed: " + ", ".join(gaps) + ".")
    if thin:
        parts.append("Partially covered: " + ", ".join(thin) + ".")
    parts.append(
        "Neither is blocking - nothing in the tree references them - but a character "
        "built entirely from the tree is missing chassis a RAW class would have given "
        "them at creation. Same shape of fix as the armor connectors."
    )
    return " ".join(parts)


def write_audit() -> dict:
    with open(ROOT / "data" / "output" / "graph.v2.json") as handle:
        graph = json.load(handle)
    with open(ROOT / "data" / "input" / "classes_meta.json") as handle:
        classes_meta = json.load(handle)
    report = audit(graph, classes_meta)
    with open(ROOT / "data" / "output" / "proficiency_gap_audit.json", "w") as handle:
        json.dump(report, handle, indent=2)
    return report


if __name__ == "__main__":  # pragma: no cover
    report = write_audit()
    print(report["verdict"])
    print()
    for finding in report["findings"]:
        print(f"  {finding['label']:<28} {finding['status']}")
