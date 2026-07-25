"""Task 2c chassis - what the starting zone fixes at character creation.

Hit die was the first of these: in a free-build tree there is no class to hang
it on, so it is looked up from whichever zone the player starts in and locked
once. The Work Order 2 proficiency audit found two more things in exactly that
position - saving throw proficiencies and weapon proficiencies. Every RAW class
grants two saves and at least simple weapons before play starts, and nothing in
the tree can sell either, so a character built purely from nodes had neither.

They are chassis, not tree nodes: derived from the starting zone, locked at
creation, unaffected by pathing into other zones later. All of it is read
straight out of `classes_meta.json` - nothing here is invented.

Armor deliberately stays *purchasable* (the training connectors) rather than
joining this list. Armor is a build choice the tree already sells from several
sources, and five extracted feats gate on it; saves and simple weapons are not
choices at all in RAW, they are what you start with.
"""

from __future__ import annotations

import re

FILTER_LABEL = re.compile(r"\{@filter ([^|}]+)")


def _weapon_proficiencies(starting: dict) -> dict:
    """Normalize the messy RAW weapon strings into something a UI can read."""
    entries = starting.get("weapons") or []
    simple = False
    martial = False
    subset = None

    for entry in entries:
        text = str(entry)
        lowered = text.strip().lower()
        if lowered == "simple":
            simple = True
        elif lowered == "martial":
            martial = True
        elif "martial" in lowered:
            # e.g. "Martial weapons that have the {@filter Finesse or Light|...} property"
            match = FILTER_LABEL.search(text)
            subset = match.group(1) if match else text
        elif lowered.startswith("simple"):
            simple = True

    return {
        "simple": simple,
        "martial": martial,
        "martial_subset": subset,
        "summary": _weapon_summary(simple, martial, subset),
    }


def _weapon_summary(simple: bool, martial: bool, subset: str | None) -> str:
    parts = []
    if simple:
        parts.append("Simple weapons")
    if martial:
        parts.append("Martial weapons")
    elif subset:
        parts.append(f"Martial weapons with the {subset} property")
    return ", ".join(parts) if parts else "none"


def build_table(classes_meta: dict) -> dict:
    """zone -> everything the starting zone locks in at creation."""
    table = {}
    for class_name, meta in classes_meta.items():
        starting = meta.get("starting_proficiencies") or {}
        table[class_name] = {
            "hit_die": meta["hit_die"],
            "saving_throw_proficiencies": list(meta.get("saving_throw_proficiencies") or []),
            "weapon_proficiencies": _weapon_proficiencies(starting),
            "source": meta.get("source"),
            "note": (
                "Locked at character creation by the starting zone, exactly as RAW "
                "fixes hit die and starting proficiencies to your original class. "
                "Pathing into other zones later does not change any of it."
            ),
        }
    return table
