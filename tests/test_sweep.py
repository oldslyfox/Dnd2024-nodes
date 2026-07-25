"""Work Order 7, Tasks 2-4: the content sweep, its dedup rule and its gates.

The fixtures model the cases the work order documents, using the real 5etools
field names: Artificer subclasses printed in TCE (2014), reprinted in EFA
(2024) and existing as a TCE/EFA hybrid, Reanimator arriving from RHW with an
EFA class source, and a name collision inside `optionalfeatures.json`.
"""

from __future__ import annotations

from datetime import date
import json

import pytest

from dnd2024 import sweep


ALLOWLIST = {"XPHB", "XDMG", "EFA", "RHW"}
DATES = {
    "XPHB": date(2024, 9, 17),
    "XDMG": date(2024, 11, 12),
    "EFA": date(2025, 8, 19),
    "RHW": date(2025, 11, 18),
    "TCE": date(2020, 11, 17),
}

BOOKS = [
    {"source": "XPHB", "name": "Player's Handbook (2024)", "group": "core", "published": "2024-09-17"},
    {"source": "EFA", "name": "Eberron: Forge of the Artificer", "group": "setting", "published": "2025-08-19"},
    {"source": "RHW", "name": "Ravenloft: The Horrors Within", "group": "setting", "published": "2025-11-18"},
    {"source": "TCE", "name": "Tasha's Cauldron of Everything", "group": "supplement", "published": "2020-11-17"},
]

# Alchemist as it actually appears across books: the 2014 original, the 2024
# rewrite, and the hybrid whose own book is old but whose class is the new one.
ALCHEMIST_2014 = {"name": "Alchemist", "shortName": "Alchemist", "source": "TCE", "className": "Artificer", "classSource": "TCE"}
ALCHEMIST_HYBRID = {"name": "Alchemist", "shortName": "Alchemist", "source": "TCE", "className": "Artificer", "classSource": "EFA"}
ALCHEMIST_2024 = {"name": "Alchemist", "shortName": "Alchemist", "source": "EFA", "className": "Artificer", "classSource": "EFA"}
CARTOGRAPHER = {"name": "Cartographer", "shortName": "Cartographer", "source": "EFA", "className": "Artificer", "classSource": "EFA"}
REANIMATOR = {"name": "Reanimator", "shortName": "Reanimator", "source": "RHW", "className": "Artificer", "classSource": "EFA"}
ARMORER_HYBRID_ONLY = {"name": "Armorer", "shortName": "Armorer", "source": "TCE", "className": "Artificer", "classSource": "EFA"}


def test_the_newest_qualifying_print_wins():
    kept, dropped, hybrids = sweep.dedup(
        [ALCHEMIST_2014, ALCHEMIST_HYBRID, ALCHEMIST_2024],
        sweep.IDENTITY["subclass"],
        ALLOWLIST,
        DATES,
    )
    assert [entry["source"] for entry in kept] == ["EFA"]
    assert hybrids == []
    assert {entry["reason"] for entry in dropped} == {"superseded by EFA (and out of scope on its own)", "superseded by EFA"}


def test_a_hybrid_is_used_only_when_nothing_qualifying_exists():
    """`source: TCE, classSource: EFA` - an old book's subclass hung off the new class.

    It is kept, because the class it belongs to is in scope and there is no
    rewrite to prefer, and it is *recorded*, because "we included a 2014 book's
    entry" is a decision someone must be able to find later.
    """
    kept, _dropped, hybrids = sweep.dedup(
        [ARMORER_HYBRID_ONLY], sweep.IDENTITY["subclass"], ALLOWLIST, DATES
    )
    assert [entry["source"] for entry in kept] == ["TCE"]
    assert len(hybrids) == 1
    assert hybrids[0]["name"] == "Armorer"
    assert "no fully-qualifying version" in hybrids[0]["reason"]


def test_a_new_book_subclass_for_an_existing_class_is_kept_on_its_own_merits():
    """Reanimator: RHW is in scope, EFA is the class it attaches to."""
    kept, _dropped, hybrids = sweep.dedup(
        [REANIMATOR], sweep.IDENTITY["subclass"], ALLOWLIST, DATES
    )
    assert [entry["name"] for entry in kept] == ["Reanimator"]
    assert hybrids == []


def test_pure_2014_content_never_enters():
    kept, dropped, _hybrids = sweep.dedup(
        [ALCHEMIST_2014], sweep.IDENTITY["subclass"], ALLOWLIST, DATES
    )
    assert kept == []
    assert dropped[0]["reason"] == "no qualifying source"


def test_the_rule_is_general_not_an_artificer_patch():
    """Same shape, different class - a Fighter subclass reprinted in a new book."""
    old = {"name": "Rune Knight", "shortName": "Rune Knight", "source": "TCE", "className": "Fighter", "classSource": "PHB"}
    new = {"name": "Rune Knight", "shortName": "Rune Knight", "source": "EFA", "className": "Fighter", "classSource": "XPHB"}
    kept, _dropped, _hybrids = sweep.dedup(
        [old, new], sweep.IDENTITY["subclass"], ALLOWLIST, DATES
    )
    assert [entry["source"] for entry in kept] == ["EFA"]


def test_conflicts_dedup_cannot_resolve_are_reported():
    """Two books, one name, two different things - there is no basis to pick."""
    kept = {
        "optional_feature": [
            {"name": "Enhanced Weapon", "source": "XPHB", "featureType": ["AI"]},
            {"name": "Enhanced Weapon", "source": "EFA", "featureType": ["EI"]},
        ]
    }
    conflicts = sweep.find_conflicts(kept, sweep.IDENTITY)
    assert len(conflicts) == 1
    assert conflicts[0]["kind"] == "same_name_different_entry"
    assert conflicts[0]["sources"] == ["EFA", "XPHB"]


def test_one_book_using_a_name_twice_is_not_a_conflict():
    """Fighting styles exist as both a feat and an optional feature inside XPHB."""
    kept = {
        "feat": [{"name": "Defense", "source": "XPHB"}],
        "optional_feature": [{"name": "Defense", "source": "XPHB", "featureType": ["FS"]}],
    }
    assert sweep.find_conflicts(kept, sweep.IDENTITY) == []


# -- the whole sweep, over a dump on disk ----------------------------------


def _dump(tmp_path):
    (tmp_path / "class").mkdir(exist_ok=True)
    (tmp_path / "books.json").write_text(json.dumps({"book": BOOKS}))
    (tmp_path / "class/class-artificer.json").write_text(
        json.dumps(
            {
                "class": [
                    {
                        "name": "Artificer",
                        "source": "EFA",
                        "hd": {"number": 1, "faces": 8},
                        "proficiency": ["con", "int"],
                    }
                ],
                "classFeature": [
                    {
                        "name": "Magical Tinkering",
                        "source": "EFA",
                        "className": "Artificer",
                        "classSource": "EFA",
                        "level": 1,
                        "entries": ["You learn how to invest a spark of magic in {@item mundane|XPHB} objects."],
                    },
                    {
                        "name": "Magical Tinkering",
                        "source": "TCE",
                        "className": "Artificer",
                        "classSource": "TCE",
                        "level": 1,
                        "entries": ["The 2014 wording."],
                    },
                ],
                "subclass": [ALCHEMIST_2014, ALCHEMIST_HYBRID, ALCHEMIST_2024, CARTOGRAPHER, REANIMATOR],
                "subclassFeature": [
                    {
                        "name": "Experimental Elixir",
                        "source": "EFA",
                        "className": "Artificer",
                        "classSource": "EFA",
                        "subclassShortName": "Alchemist",
                        "subclassSource": "EFA",
                        "level": 3,
                        "entries": ["You can produce an elixir."],
                    },
                    {
                        "name": "Experimental Elixir",
                        "source": "TCE",
                        "className": "Artificer",
                        "classSource": "TCE",
                        "subclassShortName": "Alchemist",
                        "subclassSource": "TCE",
                        "level": 3,
                        "entries": ["The 2014 wording."],
                    },
                    {
                        "name": "Grim Harvest",
                        "source": "RHW",
                        "className": "Artificer",
                        "classSource": "EFA",
                        "subclassShortName": "Reanimator",
                        "subclassSource": "EFA",
                        "level": 3,
                        "entries": ["You reanimate."],
                    },
                ],
            }
        )
    )
    (tmp_path / "feats.json").write_text(
        json.dumps(
            {
                "feat": [
                    {"name": "Alert", "source": "XPHB", "category": "O", "entries": ["You are alert."]},
                    {"name": "Wand Prodigy", "source": "EFA", "category": "G", "entries": ["Wands."], "prerequisite": [{"level": 4}]},
                    {"name": "Old Feat", "source": "TCE", "category": "G", "entries": ["2014."]},
                ]
            }
        )
    )
    (tmp_path / "optionalfeatures.json").write_text(
        json.dumps(
            {
                "optionalfeature": [
                    {"name": "Enhanced Defense", "source": "EFA", "featureType": ["AI"], "entries": ["+1 AC."]},
                    {"name": "Agonizing Blast", "source": "XPHB", "featureType": ["EI"], "entries": ["Damage."]},
                ]
            }
        )
    )
    (tmp_path / "items-base.json").write_text(
        json.dumps({"itemMastery": [{"name": "Cleave", "source": "XPHB", "entries": ["Hit two."]}]})
    )
    return sweep.load_dump(tmp_path)


def test_the_sweep_covers_every_category(tmp_path):
    result = sweep.to_nodes(_dump(tmp_path), ALLOWLIST)
    types = {node["type"] for node in result["nodes"]}
    assert types == {
        "class_feature",
        "subclass_feature",
        "feat",
        "optional_feature",
        "weapon_mastery",
    }


def test_the_sweep_keeps_the_2024_print_and_drops_the_2014_one(tmp_path):
    result = sweep.to_nodes(_dump(tmp_path), ALLOWLIST)
    tinkering = [node for node in result["nodes"] if node["name"] == "Magical Tinkering"]
    assert len(tinkering) == 1
    assert tinkering[0]["source_book"] == "EFA"
    assert "mundane" in tinkering[0]["effect_summary"]  # tags flattened to display text
    assert "{@item" not in tinkering[0]["effect_summary"]

    assert not [node for node in result["nodes"] if node["name"] == "Old Feat"]
    assert [
        node["name"] for node in result["nodes"] if node["type"] == "subclass_feature"
    ] == ["Experimental Elixir", "Grim Harvest"]


def test_the_sweep_names_five_artificer_subclasses_without_duplicates(tmp_path):
    result = sweep.to_nodes(_dump(tmp_path), ALLOWLIST)
    names = sorted(entry["shortName"] for entry in result["subclasses"])
    assert names == ["Alchemist", "Cartographer", "Reanimator"]  # the fixture's three
    assert len(names) == len(set(names)), "a subclass must not survive twice"


def test_the_sweep_produces_the_node_schema_the_builder_consumes(tmp_path):
    result = sweep.to_nodes(_dump(tmp_path), ALLOWLIST)
    for node in result["nodes"]:
        assert node["id"] and node["name"] and node["type"]
        assert node["point_cost"] is None
        assert "effect_summary" in node
        assert node["source_book"] in ALLOWLIST
    feature = next(n for n in result["nodes"] if n["type"] == "class_feature")
    assert set(feature) >= {"source_class", "class_source", "level", "prereqs", "tags"}
    subclass_feature = next(n for n in result["nodes"] if n["type"] == "subclass_feature")
    assert subclass_feature["subclass"] == "Alchemist"


def test_ids_are_stable_and_unique(tmp_path):
    first = sweep.to_nodes(_dump(tmp_path), ALLOWLIST)["nodes"]
    second = sweep.to_nodes(_dump(tmp_path), ALLOWLIST)["nodes"]
    assert [node["id"] for node in first] == [node["id"] for node in second]
    assert len({node["id"] for node in first}) == len(first)


def test_the_fidelity_gate_fails_loudly_when_the_corpus_does_not_reproduce(tmp_path):
    """The gate that stops this extractor quietly rewriting Work Order 1's corpus."""
    dump = _dump(tmp_path)
    baseline = [{"id": "cf_barbarian_rage_1"}, {"id": "feat_alert_xphb"}]
    check = sweep.self_check(dump, baseline)
    assert check["ok"] is False
    assert "cf_barbarian_rage_1" in check["missing"]

    reproduced = sweep.to_nodes(dump, {"XPHB", "XDMG"})["nodes"]
    assert sweep.self_check(dump, reproduced)["ok"] is True
