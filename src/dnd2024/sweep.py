"""Re-extract player content across every in-scope book (Work Order 7, Tasks 2-4).

Work Order 1 read the 5etools dump with a two-book filter. This module reads the
same dump with the derived allowlist from `sources.py`, across every category WO1
covered - class features, subclass features, feats, optional features, weapon
masteries - and emits records in the exact node schema `data/input/graph.json`
already uses, so `build.py` consumes them with no change.

Three things make a re-extraction harder than a wider filter:

**Reprints (Task 3).** Alchemist, Armorer, Artillerist and Battle Smith each
exist in TCE (2014) and again in EFA (2024), plus a hybrid entry whose `source`
is the old book and whose `classSource` is the new class. The rule is general,
not an Artificer patch: for one identity, prefer the newest *qualifying* source;
fall back to a hybrid only when no fully-qualifying version of that identity
exists, and record every hybrid used for review.

**Conflicts (Task 4).** Two books can ship the same feature name. Those are
reported, never silently merged - `find_conflicts` returns them and the CLI
refuses to write when any are unresolved.

**Fidelity.** This extractor did not write the WO1 corpus, so it must prove it
reproduces it: `self_check` re-extracts XPHB-only and diffs against the existing
`data/input/graph.json`. New content is merged only when that diff is clean.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from pathlib import Path
import json
import re

from . import sources

# -- 5etools text -----------------------------------------------------------

_TAG = re.compile(r"\{@(\w+)\s+([^{}]*)\}")


def _detag(text: str) -> str:
    """Flatten 5etools inline tags to the display text a reader would see.

    `{@item Thieves' Tools|XPHB}` -> `Thieves' Tools`, `{@dice 1d8}` -> `1d8`,
    `{@variantrule Difficult Terrain|XPHB|difficult terrain}` -> the last part,
    which is the display override 5etools would render.
    """
    previous = None
    while previous != text:
        previous = text
        text = _TAG.sub(lambda match: _tag_text(match.group(1), match.group(2)), text)
    return text


def _tag_text(tag: str, body: str) -> str:
    parts = body.split("|")
    if tag in {"chance", "recharge"}:
        return parts[0]
    if len(parts) >= 3 and parts[2]:
        return parts[2]
    return parts[0]


def flatten_entries(entries) -> str:
    """Entry tree -> one prose string, matching how the WO1 corpus reads."""
    chunks: list[str] = []

    def walk(node) -> None:
        if node is None:
            return
        if isinstance(node, str):
            chunks.append(_detag(node))
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            if node.get("name"):
                chunks.append(_detag(str(node["name"])))
            for key in ("entries", "items", "entry", "rows"):
                if key in node:
                    walk(node[key])

    walk(entries)
    return re.sub(r"\s+", " ", " ".join(chunk for chunk in chunks if chunk)).strip()


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


# -- dump loading -----------------------------------------------------------

CLASS_GLOB = "class/class-*.json"


def load_dump(root: str | Path) -> dict:
    """Read the categories Work Order 1 covered out of a 5etools dump directory."""
    root = Path(root)
    dump: dict = {
        "books": sources.load_books(root / "books.json"),
        "class": [],
        "classFeature": [],
        "subclass": [],
        "subclassFeature": [],
        "feat": [],
        "optionalfeature": [],
        "itemMastery": [],
        "baseitem": [],
    }

    for path in sorted(root.glob(CLASS_GLOB)):
        with open(path) as handle:
            document = json.load(handle)
        for key in ("class", "classFeature", "subclass", "subclassFeature"):
            dump[key].extend(document.get(key) or [])

    for filename, keys in (
        ("feats.json", ("feat",)),
        ("optionalfeatures.json", ("optionalfeature",)),
        ("items-base.json", ("itemMastery", "baseitem")),
        ("items.json", ("itemMastery",)),
    ):
        path = root / filename
        if not path.exists():
            continue
        with open(path) as handle:
            document = json.load(handle)
        for key in keys:
            dump[key].extend(document.get(key) or [])

    return dump


def published_dates(books: list[dict]) -> dict[str, date]:
    table: dict[str, date] = {}
    for book in books:
        source = book.get("source")
        raw = book.get("published") or book.get("publishedDate")
        if not source or not raw:
            continue
        try:
            table[source] = date.fromisoformat(str(raw)[:10])
        except ValueError:
            continue
    return table


# -- Task 3: reprints and hybrids ------------------------------------------

TIER_QUALIFYING = 0  # both the entry and the class it hangs off are in scope
TIER_HYBRID = 1  # old book, new class (`source: TCE`, `classSource: EFA`)
TIER_REJECTED = 2


def entry_tier(entry: dict, allowlist: set[str]) -> int:
    source = entry.get("source")
    class_source = entry.get("classSource") or entry.get("subclassSource")
    if source in allowlist and (class_source is None or class_source in allowlist):
        return TIER_QUALIFYING
    if class_source in allowlist:
        return TIER_HYBRID
    return TIER_REJECTED


def dedup(entries: list[dict], identity, allowlist: set[str], dates: dict[str, date]):
    """Collapse reprints of one identity down to the newest qualifying entry.

    Returns `(kept, dropped, hybrids)`. `identity` maps an entry to the tuple
    that makes two records "the same thing" - name plus level plus whatever
    context the category needs.

    The rule is deliberately general. Artificer is simply the first class where
    it bites: an EFA Alchemist supersedes the TCE Alchemist and the TCE/EFA
    hybrid, while Reanimator (`source: RHW`, `classSource: EFA`) has no earlier
    version and is kept on its own merits.
    """
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for entry in entries:
        grouped[identity(entry)].append(entry)

    kept: list[dict] = []
    dropped: list[dict] = []
    hybrids: list[dict] = []

    for key in sorted(grouped, key=lambda item: tuple(str(part) for part in item)):
        candidates = grouped[key]
        ranked = sorted(
            candidates,
            key=lambda entry: (
                entry_tier(entry, allowlist),
                # newest first, then a stable tiebreak so runs are reproducible
                -(dates.get(entry.get("source"), date.min).toordinal()),
                entry.get("source") or "",
            ),
        )
        winner = ranked[0]
        tier = entry_tier(winner, allowlist)
        if tier == TIER_REJECTED:
            for entry in candidates:
                dropped.append(_decision(entry, key, "no qualifying source"))
            continue

        kept.append(winner)
        if tier == TIER_HYBRID:
            hybrids.append(
                _decision(
                    winner,
                    key,
                    "kept as a hybrid: its class is in scope but its own book is not, "
                    "and no fully-qualifying version of this entry exists",
                )
            )
        for entry in ranked[1:]:
            dropped.append(
                _decision(
                    entry,
                    key,
                    f"superseded by {winner.get('source')}"
                    + (
                        ""
                        if entry_tier(entry, allowlist) != TIER_REJECTED
                        else " (and out of scope on its own)"
                    ),
                )
            )

    return kept, dropped, hybrids


def _decision(entry: dict, key: tuple, reason: str) -> dict:
    return {
        "name": entry.get("name"),
        "source": entry.get("source"),
        "class_source": entry.get("classSource") or entry.get("subclassSource"),
        "identity": [str(part) for part in key],
        "reason": reason,
    }


# -- Task 4: conflicts ------------------------------------------------------


def find_conflicts(kept_by_category: dict[str, list[dict]], identity_by_category: dict) -> list[dict]:
    """Collisions dedup cannot resolve, in any category.

    Dedup handles the easy case - one identity, several printings, newest wins.
    What it cannot handle is two entries that share a *name* but not an identity,
    because there is no basis for preferring one: they are different things
    wearing the same word.

    The known case is `optionalfeatures.json`, where the Artificer Infusion
    (`AI`) category already carries XPHB-tagged entries from the Work Order 1
    extraction even though Artificer is not XPHB content - so an EFA infusion
    could collide with an XPHB entry of the same name filed under a different
    feature type. Nothing here is Artificer-specific; it runs over every
    category and across category boundaries.
    """
    conflicts: list[dict] = []

    for category, entries in sorted(kept_by_category.items()):
        identity = identity_by_category[category]
        by_name: dict[str, list[dict]] = defaultdict(list)
        for entry in entries:
            by_name[entry.get("name")].append(entry)
        for name, group in sorted(by_name.items(), key=lambda item: str(item[0])):
            identities = {identity(entry) for entry in group}
            books = {entry.get("source") for entry in group}
            if len(identities) > 1 and len(books) > 1:
                conflicts.append(
                    {
                        "kind": "same_name_different_entry",
                        "category": category,
                        "name": name,
                        "sources": sorted(book for book in books if book),
                        "identities": sorted(
                            "/".join(str(part) for part in key) for key in identities
                        ),
                        "detail": "two books ship different entries under one name - resolve before merging",
                    }
                )

    # cross-category: a feat and an optional feature can legitimately share a
    # name within one book (the fighting styles do), so only different books count
    names: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for category in ("feat", "optional_feature", "weapon_mastery"):
        for entry in kept_by_category.get(category, []):
            names[entry.get("name")].add((category, entry.get("source")))
    for name, pairs in sorted(names.items(), key=lambda item: str(item[0])):
        categories = {category for category, _ in pairs}
        books = {source for _, source in pairs}
        if len(categories) > 1 and len(books) > 1:
            conflicts.append(
                {
                    "kind": "same_name_across_categories",
                    "name": name,
                    "categories": sorted(categories),
                    "sources": sorted(book for book in books if book),
                    "detail": "one name used by two categories from two books - resolve before merging",
                }
            )

    return conflicts


# -- Task 2: the categories -------------------------------------------------


def _class_feature_identity(entry: dict) -> tuple:
    return (entry.get("className"), entry.get("name"), entry.get("level"))


def _subclass_feature_identity(entry: dict) -> tuple:
    return (
        entry.get("className"),
        entry.get("subclassShortName"),
        entry.get("name"),
        entry.get("level"),
    )


def _subclass_identity(entry: dict) -> tuple:
    return (entry.get("className"), entry.get("shortName") or entry.get("name"))


def _feat_identity(entry: dict) -> tuple:
    return (entry.get("name"),)


def _optional_feature_identity(entry: dict) -> tuple:
    return (entry.get("name"), tuple(entry.get("featureType") or ()))


def _mastery_identity(entry: dict) -> tuple:
    return (entry.get("name"),)


IDENTITY = {
    "class_feature": _class_feature_identity,
    "subclass_feature": _subclass_feature_identity,
    "subclass": _subclass_identity,
    "feat": _feat_identity,
    "optional_feature": _optional_feature_identity,
    "weapon_mastery": _mastery_identity,
}

FEAT_CATEGORY = {
    "G": "general",
    "O": "origin",
    "FS": "fighting_style",
    "EB": "epic_boon",
}


def _feat_category(entry: dict) -> tuple[str, str]:
    code = (entry.get("category") or "G").upper()
    label = FEAT_CATEGORY.get(code, "general")
    if label == "fighting_style":
        # WO1 split the class-locked styles out; the suffix comes off the
        # prerequisite, not off a list of class names.
        for prereq in entry.get("prerequisite") or []:
            other = (prereq.get("otherSummary") or {}).get("entry", "")
            for class_name in ("Paladin", "Ranger", "Bard"):
                if class_name.lower() in str(other).lower():
                    return code, f"fighting_style_{class_name.lower()}"
    return code, label


def to_nodes(dump: dict, allowlist: set[str]) -> dict:
    """Run every category through the allowlist and the dedup rule.

    Returns `{"nodes": [...], "dedup": {...}, "conflicts": [...], "counts": {...}}`
    with nodes in the `data/input/graph.json` schema.
    """
    dates = published_dates(dump["books"])

    in_scope = lambda entries: [  # noqa: E731 - a filter, not a function worth naming
        entry for entry in entries if entry_tier(entry, allowlist) != TIER_REJECTED
    ]

    kept: dict[str, list[dict]] = {}
    decisions: dict[str, dict] = {}
    for category, key in (
        ("class_feature", "classFeature"),
        ("subclass_feature", "subclassFeature"),
        ("subclass", "subclass"),
        ("feat", "feat"),
        ("optional_feature", "optionalfeature"),
    ):
        chosen, dropped, hybrids = dedup(
            in_scope(dump[key]), IDENTITY[category], allowlist, dates
        )
        kept[category] = chosen
        decisions[category] = {"dropped": dropped, "hybrids": hybrids}

    masteries = [entry for entry in dump["itemMastery"] if entry.get("source") in allowlist]
    chosen, dropped, hybrids = dedup(masteries, IDENTITY["weapon_mastery"], allowlist, dates)
    kept["weapon_mastery"] = chosen
    decisions["weapon_mastery"] = {"dropped": dropped, "hybrids": hybrids}

    conflicts = find_conflicts(
        {category: entries for category, entries in kept.items() if category != "subclass"},
        IDENTITY,
    )
    reprints = [
        decision
        for category in decisions
        for decision in decisions[category]["dropped"]
        if decision["reason"].startswith("superseded")
    ]

    subclass_titles = {
        (entry.get("className"), entry.get("shortName") or entry.get("name")): entry.get("name")
        for entry in kept["subclass"]
    }

    nodes: list[dict] = []
    for entry in kept["class_feature"]:
        class_name = entry.get("className")
        nodes.append(
            {
                "id": f"cf_{_slug(class_name)}_{_slug(entry['name'])}_{entry.get('level')}",
                "name": entry["name"],
                "type": "class_feature",
                "source_class": class_name,
                "class_source": entry.get("classSource"),
                "source_book": entry.get("source"),
                "level": entry.get("level"),
                "point_cost": None,
                "prereqs": [],
                "tags": [],
                "effect_summary": flatten_entries(entry.get("entries")),
            }
        )

    for entry in kept["subclass_feature"]:
        class_name = entry.get("className")
        short = entry.get("subclassShortName")
        nodes.append(
            {
                "id": f"scf_{_slug(class_name)}_{_slug(short)}_{_slug(entry['name'])}_{entry.get('level')}",
                "name": entry["name"],
                "type": "subclass_feature",
                "source_class": class_name,
                "subclass": subclass_titles.get((class_name, short), short),
                "subclass_source": entry.get("subclassSource") or entry.get("source"),
                "source_book": entry.get("source"),
                "level": entry.get("level"),
                "point_cost": None,
                "prereqs": [],
                "tags": [],
                "effect_summary": flatten_entries(entry.get("entries")),
            }
        )

    for entry in kept["feat"]:
        code, category = _feat_category(entry)
        nodes.append(
            {
                "id": f"feat_{_slug(entry['name'])}_{_slug(entry.get('source'))}",
                "name": entry["name"],
                "type": "feat",
                "category_code": code,
                "category": category,
                "source_book": entry.get("source"),
                "point_cost": None,
                "prereqs_raw": entry.get("prerequisite") or [],
                "repeatable": bool(entry.get("repeatable")),
                "ability_grants": entry.get("ability") or [],
                "tags": [],
                "effect_summary": flatten_entries(entry.get("entries")),
            }
        )

    for entry in kept["optional_feature"]:
        types = list(entry.get("featureType") or [])
        nodes.append(
            {
                "id": f"of_{_slug(entry['name'])}_{_slug(entry.get('source'))}",
                "name": entry["name"],
                "type": "optional_feature",
                "feature_types": types,
                "feature_type_labels": [OPTIONAL_FEATURE_LABELS.get(code, code) for code in types],
                "source_book": entry.get("source"),
                "point_cost": None,
                "prereqs_raw": entry.get("prerequisite") or [],
                "tags": [],
                "effect_summary": flatten_entries(entry.get("entries")),
            }
        )

    for entry in kept["weapon_mastery"]:
        nodes.append(
            {
                "id": f"mastery_{_slug(entry['name'])}_{_slug(entry.get('source'))}",
                "name": entry["name"],
                "type": "weapon_mastery",
                "source_book": entry.get("source"),
                "point_cost": None,
                "tags": [],
                "effect_summary": flatten_entries(entry.get("entries")),
            }
        )

    return {
        "nodes": nodes,
        "subclasses": kept["subclass"],
        "dedup": decisions,
        "reprints_resolved": reprints,
        "conflicts": conflicts,
        "counts": {category: len(entries) for category, entries in kept.items()},
    }


OPTIONAL_FEATURE_LABELS = {
    "EI": "eldritch_invocation",
    "MM": "metamagic",
    "MV:B": "maneuver_battle_master",
    "AI": "artificer_infusion",
    "AT": "artificer_infusion",
    "FS": "fighting_style",
}


# -- fidelity gate ----------------------------------------------------------


def self_check(dump: dict, baseline_nodes: list[dict]) -> dict:
    """Prove this extractor reproduces the Work Order 1 corpus before trusting it.

    Re-extracts with the *old* filter and diffs node ids against the existing
    `data/input/graph.json`. A clean diff means the differences a full sweep
    produces are new content rather than extractor drift; a dirty one means this
    module is wrong and must be fixed before any merge.
    """
    baseline_ids = {node["id"] for node in baseline_nodes}
    reproduced = to_nodes(dump, {"XPHB", "XDMG"})
    ids = {node["id"] for node in reproduced["nodes"]}
    missing = sorted(baseline_ids - ids)
    extra = sorted(ids - baseline_ids)
    return {
        "ok": not missing and not extra,
        "baseline_nodes": len(baseline_ids),
        "reproduced_nodes": len(ids),
        "missing": missing[:40],
        "missing_count": len(missing),
        "unexpected": extra[:40],
        "unexpected_count": len(extra),
    }
