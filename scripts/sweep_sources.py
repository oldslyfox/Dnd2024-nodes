#!/usr/bin/env python3
"""Re-extract 2024 player content from a 5etools dump (Work Order 7).

    python3 scripts/sweep_sources.py --dump /path/to/5etools/data          # dry run
    python3 scripts/sweep_sources.py --dump /path/to/5etools/data --write  # merge it

The dump is the raw 5etools `data/` directory: `books.json`, `class/class-*.json`,
`feats.json`, `optionalfeatures.json`, `items-base.json`. It is *not* in this
repository - only Work Order 1's extracted output is - so this script takes a
path to it.

Order of operations, and why:

1. Derive the source allowlist from `books.json` (date + group), never a
   hardcoded list, and write it to `data/output/source_allowlist.json`.
2. **Fidelity gate.** Re-extract with Work Order 1's old two-book filter and diff
   against the existing `data/input/graph.json`. This script did not produce that
   corpus, so it has to prove it can reproduce it before being allowed to add to
   it. A dirty diff means the extractor is wrong, not that the data changed.
3. Sweep every category with the full allowlist, dedup reprints, and look for
   conflicts dedup cannot resolve.
4. Only with `--write`, and only when steps 2 and 3 are clean, merge the result
   into `data/input/` and leave the rebuild to `scripts/build_all.py`.

Nothing is written without `--write`. `--force` overrides the fidelity gate and
`--accept-conflicts` overrides the conflict gate; both are recorded in the report
so an override cannot be mistaken for a clean run.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dnd2024 import sources, sweep  # noqa: E402

INPUT = ROOT / "data/input"
OUTPUT = ROOT / "data/output"

CATEGORY_FILES = {
    "class_feature": "nodes_class_features.json",
    "subclass_feature": "nodes_subclass_features.json",
    "feat": "nodes_feats.json",
    "optional_feature": "nodes_optional_features.json",
    "weapon_mastery": "nodes_weapon_mastery.json",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump", required=True, help="path to the 5etools data directory")
    parser.add_argument("--write", action="store_true", help="merge the result into data/input")
    parser.add_argument("--force", action="store_true", help="write even if the fidelity gate fails")
    parser.add_argument(
        "--accept-conflicts", action="store_true", help="write even with unresolved conflicts"
    )
    args = parser.parse_args()

    dump_root = Path(args.dump)
    if not (dump_root / "books.json").exists():
        print(f"no books.json under {dump_root} - is that the 5etools data directory?")
        return 2

    # -- 1. the allowlist ---------------------------------------------------
    allowlist_report = sources.derive_allowlist(sources.load_books(dump_root / "books.json"))
    allowed = set(allowlist_report["sources"])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT / "source_allowlist.json", "w") as handle:
        json.dump(allowlist_report, handle, indent=2)

    print(f"source allowlist ({len(allowed)} books, cutoff {allowlist_report['cutoff']}):")
    for entry in allowlist_report["accepted"]:
        print(f"  {entry['source']:<6} {entry['name']} — {entry['reason']}")
    if allowlist_report["playtest_excluded"]:
        print(f"  playtest material excluded: {', '.join(allowlist_report['playtest_excluded'])}")
    else:
        print("  playtest material excluded: none present in this dump")
    if allowlist_report["unknown_groups_needing_review"]:
        print(
            "  UNKNOWN GROUPS, review before trusting this run: "
            + ", ".join(allowlist_report["unknown_groups_needing_review"])
        )

    # -- 2. the fidelity gate ----------------------------------------------
    dump = sweep.load_dump(dump_root)
    with open(INPUT / "graph.json") as handle:
        baseline = json.load(handle)
    check = sweep.self_check(dump, baseline["nodes"])
    print(
        f"\nfidelity check against the Work Order 1 corpus: "
        f"{'PASS' if check['ok'] else 'FAIL'} "
        f"({check['reproduced_nodes']} reproduced vs {check['baseline_nodes']} baseline)"
    )
    if not check["ok"]:
        for node_id in check["missing"]:
            print(f"  missing:    {node_id}")
        for node_id in check["unexpected"]:
            print(f"  unexpected: {node_id}")
        print(
            "  the extractor does not reproduce the existing corpus; fix it before merging "
            "(or pass --force to write anyway and own the difference)"
        )

    # -- 3. the sweep -------------------------------------------------------
    result = sweep.to_nodes(dump, allowed)
    print("\nswept content:")
    for category, count in sorted(result["counts"].items()):
        print(f"  {category:<18} {count}")
    print(f"  reprints resolved  {len(result['reprints_resolved'])}")
    print(f"  hybrids kept       {sum(len(d['hybrids']) for d in result['dedup'].values())}")
    print(f"  conflicts          {len(result['conflicts'])}")
    for conflict in result["conflicts"][:20]:
        print(f"    [{conflict['kind']}] {conflict['name']} — {', '.join(conflict['sources'])}")

    new_ids = {node["id"] for node in result["nodes"]}
    baseline_ids = {node["id"] for node in baseline["nodes"]}
    added = sorted(new_ids - baseline_ids)
    removed = sorted(baseline_ids - new_ids)
    by_zone: dict[str, int] = {}
    for node in result["nodes"]:
        if node["id"] in added:
            zone = node.get("source_class") or node.get("category") or node["type"]
            by_zone[zone] = by_zone.get(zone, 0) + 1
    print(f"\nnew nodes: {len(added)}   no longer extracted: {len(removed)}")
    for zone, count in sorted(by_zone.items(), key=lambda item: (-item[1], item[0])):
        print(f"  +{count:<4} {zone}")

    report = {
        "dump": str(dump_root),
        "allowlist": allowlist_report["sources"],
        "cutoff": allowlist_report["cutoff"],
        "fidelity_check": check,
        "counts": result["counts"],
        "conflicts": result["conflicts"],
        "reprints_resolved": result["reprints_resolved"],
        "hybrids": {
            category: decisions["hybrids"] for category, decisions in result["dedup"].items()
        },
        "added_node_ids": added,
        "removed_node_ids": removed,
        "added_by_class": by_zone,
        "written": False,
        "overrides": {"force": args.force, "accept_conflicts": args.accept_conflicts},
    }

    # -- 4. merge -----------------------------------------------------------
    blocked = (not check["ok"] and not args.force) or (
        result["conflicts"] and not args.accept_conflicts
    )
    if args.write and blocked:
        print("\nrefusing to write: the gates above are not clean")
    elif args.write:
        _write(baseline, result)
        report["written"] = True
        print("\nwrote data/input/graph.json and the per-category node files")
        print("next: python3 scripts/build_all.py && (cd web && npm run sync-data && npm run build)")
    else:
        print("\ndry run - pass --write to merge this into data/input")

    with open(OUTPUT / "source_sweep_report.json", "w") as handle:
        json.dump(report, handle, indent=2)
    print(f"report: {OUTPUT / 'source_sweep_report.json'}")

    return 0 if (check["ok"] and not result["conflicts"]) else 1


def _write(baseline: dict, result: dict) -> None:
    """Replace the extracted corpus, keeping Work Order 1's document shape."""
    document = dict(baseline)
    document["nodes"] = sorted(result["nodes"], key=lambda node: node["id"])
    document["meta"] = dict(baseline.get("meta") or {})
    document["meta"]["scope"] = "D&D 2024 (XPHB and later official books)"
    document["meta"]["node_count"] = len(document["nodes"])
    with open(INPUT / "graph.json", "w") as handle:
        json.dump(document, handle, indent=2)

    for category, filename in CATEGORY_FILES.items():
        subset = [node for node in document["nodes"] if node["type"] == category]
        with open(INPUT / filename, "w") as handle:
            json.dump(subset, handle, indent=2)


if __name__ == "__main__":
    raise SystemExit(main())
