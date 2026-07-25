"""Work Order 7, Task 1: the source allowlist is derived, not hardcoded.

The books here mirror the real `books.json` shape and cover every branch the
rule has: the 2024 core itself, post-XPHB player content, pre-XPHB books,
non-content groups, an unrecognised group, and playtest material.
"""

from __future__ import annotations

import json

import pytest

from dnd2024 import sources


BOOKS = [
    {"source": "XPHB", "name": "Player's Handbook (2024)", "group": "core", "published": "2024-09-17"},
    {"source": "XDMG", "name": "Dungeon Master's Guide (2024)", "group": "core", "published": "2024-11-12"},
    {"source": "XMM", "name": "Monster Manual (2025)", "group": "core", "published": "2025-02-18"},
    {"source": "EFA", "name": "Eberron: Forge of the Artificer", "group": "setting", "published": "2025-08-19"},
    {"source": "RHW", "name": "Ravenloft: The Horrors Within", "group": "setting", "published": "2025-11-18"},
    {"source": "FRHoF", "name": "Forgotten Realms: Heroes of Faerun", "group": "setting", "published": "2025-11-11"},
    {"source": "ABH", "name": "Astarion's Book of Hungers", "group": "supplement", "published": "2025-09-30"},
    # published before the 2024 reset
    {"source": "PHB", "name": "Player's Handbook", "group": "core", "published": "2014-08-19"},
    {"source": "TCE", "name": "Tasha's Cauldron of Everything", "group": "supplement", "published": "2020-11-17"},
    # post-XPHB, but not player content
    {"source": "XDMS", "name": "Dungeon Master's Screen (2024)", "group": "screen", "published": "2024-11-12"},
    {"source": "SAC", "name": "Sage Advice Compendium", "group": "other", "published": "2025-01-06"},
    {"source": "DDCR", "name": "Dungeons & Dragons Crochet", "group": "homecraft", "published": "2025-06-03"},
    {"source": "HFDD", "name": "Heroes' Feast", "group": "recipe", "published": "2025-03-11"},
    {"source": "AL", "name": "Adventurers League Player's Guide", "group": "organized-play", "published": "2025-04-01"},
    # a group nobody has seen before: must surface for review, not slip in
    {"source": "NEWG", "name": "Some Future Format", "group": "compendium", "published": "2026-01-01"},
    # playtest material, in three disguises
    {"source": "UA2025PC", "name": "Unearthed Arcana 2025: Player Characters", "group": "supplement", "published": "2025-05-01"},
    {"source": "PTR", "name": "Playtest Rules", "group": "prerelease", "published": "2025-05-01"},
    {"source": "WEIRD", "name": "Unearthed Arcana: Something", "group": "setting", "published": "2025-05-02"},
]


@pytest.fixture(scope="module")
def report() -> dict:
    return sources.derive_allowlist(BOOKS)


def test_cutoff_is_read_from_the_data(report):
    assert report["cutoff"] == "2024-09-17"


def test_the_2024_core_and_later_player_content_are_accepted(report):
    assert set(report["sources"]) == {"XPHB", "XDMG", "XMM", "EFA", "RHW", "FRHoF", "ABH"}


def test_pre_2024_books_are_rejected_however_player_facing(report):
    rejected = {entry["source"]: entry["reason"] for entry in report["rejected"]}
    assert "before the 2024 rules reset" in rejected["PHB"]
    assert "before the 2024 rules reset" in rejected["TCE"]


def test_non_content_groups_are_rejected_even_when_recent(report):
    rejected = {entry["source"]: entry["reason"] for entry in report["rejected"]}
    for source in ("XDMS", "SAC", "DDCR", "HFDD", "AL"):
        assert "no player-facing rules content" in rejected[source], source


def test_unknown_groups_surface_for_review_rather_than_slipping_in(report):
    assert report["unknown_groups_needing_review"] == ["compendium"]
    assert "NEWG" not in report["sources"]


def test_unearthed_arcana_is_excluded_three_ways(report):
    """The dump has none today; the safeguard must not depend on that."""
    assert set(report["playtest_excluded"]) == {"UA2025PC", "PTR", "WEIRD"}
    for source in ("UA2025PC", "PTR", "WEIRD"):
        assert source not in report["sources"]


def test_a_future_book_needs_no_code_change():
    """The acceptance criterion: extensible by data alone."""
    future = BOOKS + [
        {
            "source": "ZZZ",
            "name": "Some 2027 Setting Book",
            "group": "setting",
            "published": "2027-07-01",
        }
    ]
    assert "ZZZ" in sources.derive_allowlist(future)["sources"]


def test_books_without_a_date_are_rejected_with_a_reason():
    report = sources.derive_allowlist([{"source": "MYSTERY", "name": "?", "group": "supplement"}])
    assert report["sources"] == []
    assert report["rejected"][0]["reason"] == "no publication date in books.json"


def test_load_books_accepts_the_5etools_document_shape(tmp_path):
    path = tmp_path / "books.json"
    path.write_text(json.dumps({"book": BOOKS}))
    assert sources.allowlist_from_file(path) == {
        "XPHB",
        "XDMG",
        "XMM",
        "EFA",
        "RHW",
        "FRHoF",
        "ABH",
    }
