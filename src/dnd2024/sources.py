"""Which books count as 2024 player content (Work Order 7, Task 1).

Work Order 1 hardcoded `TWENTY24_SOURCES = {"XPHB", "XDMG"}`. That was wrong the
day it was written and gets wronger with every release: Artificer's 2024 rewrite
lives in EFA, Ravenloft adds an Artificer subclass, and the Forgotten Realms
books may add more to any class. A hand-picked list cannot keep up.

The rule here is derived from `books.json` metadata instead, so a future data
refresh brings new books into scope with no code change:

    accepted = XPHB itself
             + every book published on or after XPHB's own release date
               whose `group` is player-facing content
             - explicitly excluded groups (DM screens, errata, merchandise)
             - anything that looks like Unearthed Arcana / playtest material

Every decision is recorded with a reason, because "why is this book in scope"
is exactly the question someone will ask in six months.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
import json
import re

#: Groups that carry player-facing rules content. Confirmed against the
#: post-XPHB book list; re-check when a new group string appears (the report
#: lists unknown groups explicitly rather than silently dropping them).
PLAYER_CONTENT_GROUPS = frozenset(
    {"core", "setting", "setting-alt", "supplement", "supplement-alt"}
)

#: Groups excluded even when they pass the date filter.
#:   screen         - DM screens, no player content
#:   other          - errata/FAQ format (Sage Advice); verified per-book below
#:   homecraft      - merchandise (one of them is a crochet pattern book)
#:   recipe         - cookbooks
#:   organized-play - adventure league packets
#: Adventures are deliberately *not* listed here. If one ever ships with a group
#: string we do not recognise, it should surface in
#: `unknown_groups_needing_review` rather than be silently dropped.
EXCLUDED_GROUPS = frozenset({"screen", "other", "homecraft", "recipe", "organized-play"})

#: Playtest material must never enter the tree. This dump contains none, but
#: "it happens to be absent" is not a safeguard - these are.
PLAYTEST_GROUPS = frozenset({"ua", "playtest", "prerelease", "unearthed-arcana"})
PLAYTEST_SOURCE_PATTERN = re.compile(r"^(ua|uab|ptr|pt)[a-z0-9]*$", re.IGNORECASE)
PLAYTEST_NAME_PATTERN = re.compile(r"unearthed\s+arcana|playtest", re.IGNORECASE)

#: The 2024 core itself. It is published *on* the cutoff date, not after it, and
#: it is the baseline the whole tree is built from, so it is always in scope.
BASELINE_SOURCE = "XPHB"
BASELINE_RELEASE = date(2024, 9, 17)


def load_books(path: str | Path) -> list[dict]:
    """Read `books.json` (5etools shape: `{"book": [...]}`) into a flat list."""
    with open(path) as handle:
        document = json.load(handle)
    if isinstance(document, dict):
        return list(document.get("book") or [])
    return list(document)


def _published(book: dict) -> date | None:
    raw = book.get("published") or book.get("publishedDate")
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def is_playtest(book: dict) -> bool:
    """Unearthed Arcana / playtest safeguard - three independent signals."""
    group = (book.get("group") or "").lower()
    source = book.get("source") or ""
    name = book.get("name") or ""
    return (
        group in PLAYTEST_GROUPS
        or bool(PLAYTEST_SOURCE_PATTERN.match(source))
        or bool(PLAYTEST_NAME_PATTERN.search(name))
    )


def baseline_release(books: list[dict]) -> date:
    """XPHB's own publication date, read from the data rather than assumed."""
    for book in books:
        if book.get("source") == BASELINE_SOURCE:
            published = _published(book)
            if published:
                return published
    return BASELINE_RELEASE


def classify(book: dict, cutoff: date) -> tuple[bool, str]:
    """(accepted, reason) for one book."""
    source = book.get("source") or "?"
    group = (book.get("group") or "").lower()
    published = _published(book)

    if is_playtest(book):
        return False, "playtest/unearthed arcana material"
    if source == BASELINE_SOURCE:
        return True, "the 2024 core rulebook this tree is built from"
    if group in EXCLUDED_GROUPS:
        return False, f"group '{group}' carries no player-facing rules content"
    if published is None:
        return False, "no publication date in books.json"
    if published < cutoff:
        return False, f"published {published.isoformat()}, before the 2024 rules reset"
    if group not in PLAYER_CONTENT_GROUPS:
        return False, f"unrecognised group '{group}' - review before including"
    return True, f"{group}, published {published.isoformat()}"


def derive_allowlist(books: list[dict]) -> dict:
    """Full report: the accepted source set plus why every book landed where it did.

    The report is written to `data/output/source_allowlist.json` so the decision
    is auditable, and so a future data refresh shows up as a diff.
    """
    cutoff = baseline_release(books)
    accepted: list[dict] = []
    rejected: list[dict] = []
    unknown_groups: set[str] = set()

    for book in sorted(books, key=lambda entry: entry.get("source") or ""):
        ok, reason = classify(book, cutoff)
        published = _published(book)
        record = {
            "source": book.get("source"),
            "name": book.get("name"),
            "group": book.get("group"),
            "published": published.isoformat() if published else None,
            "reason": reason,
        }
        if ok:
            accepted.append(record)
        else:
            rejected.append(record)
            group = (book.get("group") or "").lower()
            if (
                published
                and published >= cutoff
                and group
                and group not in PLAYER_CONTENT_GROUPS
                and group not in EXCLUDED_GROUPS
                and not is_playtest(book)
            ):
                unknown_groups.add(group)

    return {
        "rule": (
            "XPHB, plus books published on or after XPHB whose group is player-facing "
            "content, minus non-content groups and anything playtest-flagged"
        ),
        "cutoff": cutoff.isoformat(),
        "player_content_groups": sorted(PLAYER_CONTENT_GROUPS),
        "excluded_groups": sorted(EXCLUDED_GROUPS),
        "sources": sorted(entry["source"] for entry in accepted if entry["source"]),
        "accepted": accepted,
        "rejected": rejected,
        "unknown_groups_needing_review": sorted(unknown_groups),
        "playtest_excluded": [
            entry["source"] for entry in rejected if entry["reason"].startswith("playtest")
        ],
    }


def allowlist_from_file(path: str | Path) -> set[str]:
    """Convenience for the extractor: just the accepted source codes."""
    return set(derive_allowlist(load_books(path))["sources"])
