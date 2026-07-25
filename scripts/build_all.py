#!/usr/bin/env python3
"""Run the whole Work Order 2 pipeline: build -> validate -> flag.

    python3 scripts/build_all.py

Writes everything into data/output and exits non-zero if validation fails.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dnd2024 import balance, build, validate  # noqa: E402
from dnd2024.pathing import PathEngine  # noqa: E402


def main() -> int:
    graph = build.write_outputs()
    print(
        f"built graph v2: {graph['meta']['node_count']} nodes, "
        f"{graph['meta']['edge_count']} edges"
    )
    for node_type, count in graph["meta"]["node_counts_by_type"].items():
        print(f"  {node_type:<18} {count}")

    report = validate.validate(graph)
    with open(build.OUTPUT / "validation_report.json", "w") as handle:
        json.dump(report, handle, indent=2)
    print(f"\nvalidation: {'PASS' if report['ok'] else 'FAIL'}")
    for warning in report["warnings"]:
        print(f"  warning: {warning}")
    for error in report["errors"][:20]:
        print(f"  error: {error}")

    density = report["connector_density"]
    print(
        f"  connectors crossed, same zone: "
        f"{density['same_zone']['mean_connectors_crossed']} (target 2-4)"
    )
    print(
        f"  points to reach a node, home zone vs abroad: "
        f"{report['traversal_cost']['mean_points_same_zone']} vs "
        f"{report['traversal_cost']['mean_points_cross_zone']}"
    )

    flags = balance.write_flags(PathEngine(graph))
    print(f"\nbalance flags: {len(flags)}")
    for flag in flags:
        share = flag["measured"].get("share_of_career_budget")
        suffix = f" ({share:.0%} of the career budget)" if share is not None else ""
        print(f"  [{flag['severity']:>6}] {flag['id']}{suffix}")

    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
