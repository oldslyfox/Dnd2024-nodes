"""Task 5 - the pathing cost engine.

`can_afford(player_state, target_node_id) -> {affordable, path, total_cost, ...}`

Cost model
----------
Every node costs a flat 1 point (Task 4). What a node actually costs *you*
depends on one thing only - whether you are walking your own zone's spine:

  * already owned                                  -> 0
  * connector on your home zone's own spine        -> 0   (Task 2b)
  * your home zone's gate                          -> 0   (you start inside it)
  * anything else, connector or not                -> its point_cost

So distance costs the sum of the point costs of every node you must newly
allocate to reach the target - not a flat multiplier - and straying out of your
own zone is what actually bills you.

Gating at runtime is points + connectivity + normalized prerequisites. Level is
never consulted; it only ever influenced where nodes were placed.

Interactivity
-------------
Every query runs one multi-source Dijkstra from the owned set to *all* nodes and
caches it against a fingerprint of the player state, so a hover storm over a
thousand nodes costs one search, not a thousand.
"""

from __future__ import annotations

import heapq
import json
from dataclasses import dataclass, field
from pathlib import Path

from . import prereqs as prereq_mod
from .config import CORE_ZONE

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_GRAPH = ROOT / "data" / "output" / "graph.v2.json"

HUB_ID = "conn_core_hub"


@dataclass
class PlayerState:
    """Everything the engine needs to know about a character.

    `home_zone` is the zone chosen at character creation. It fixes the hit die
    (Task 2c) and it is the only zone whose connector spine is free to walk.
    """

    home_zone: str
    points_total: int
    owned: set[str] = field(default_factory=lambda: {HUB_ID})
    points_spent: int = 0

    def fingerprint(self) -> tuple:
        return (self.home_zone, self.points_spent, frozenset(self.owned))

    def copy(self) -> "PlayerState":
        return PlayerState(
            home_zone=self.home_zone,
            points_total=self.points_total,
            owned=set(self.owned),
            points_spent=self.points_spent,
        )


class PathEngine:
    def __init__(self, graph: dict):
        self.graph = graph
        self.nodes: dict[str, dict] = {n["id"]: n for n in graph["nodes"]}
        self.adjacency: dict[str, set[str]] = {node_id: set() for node_id in self.nodes}
        for edge in graph["edges"]:
            # `reference` edges are the extraction's citation registry, not
            # designed connectivity: they are carried in the data for "see also"
            # UI and deliberately excluded from pathing, because a cross-zone
            # citation would otherwise let a player skip the depth ladder.
            if not edge.get("traversable", True):
                continue
            source, target = edge["from"], edge["to"]
            if source in self.adjacency and target in self.adjacency:
                self.adjacency[source].add(target)
                self.adjacency[target].add(source)
        self.hit_die_by_zone = graph["meta"].get("hit_die_by_zone", {})
        self._cache_key = None
        self._dist: dict[str, int] = {}
        self._prev: dict[str, str | None] = {}
        self._blocked: dict[str, list[str]] = {}

    # -- classmethods ----------------------------------------------------

    @classmethod
    def load(cls, path: Path | str = DEFAULT_GRAPH) -> "PathEngine":
        with open(path) as handle:
            return cls(json.load(handle))

    # -- cost model ------------------------------------------------------

    def node_cost(self, node_id: str, state: PlayerState) -> int:
        if node_id in state.owned:
            return 0
        node = self.nodes[node_id]
        if node["type"] == "connector" and node.get("is_spine"):
            if node["zone"] == state.home_zone:
                return 0  # your own zone's spine is not "straying"
        if node.get("is_gate") and node["zone"] == state.home_zone:
            return 0
        return int(node.get("point_cost") or 0)

    def hit_die(self, state: PlayerState) -> dict | None:
        """Task 2c - hit die is looked up from the starting zone, nothing else."""
        return self.hit_die_by_zone.get(state.home_zone)

    # -- search ----------------------------------------------------------

    def _path_to(self, node_id: str) -> list[str]:
        path: list[str] = []
        cursor: str | None = node_id
        while cursor is not None:
            path.append(cursor)
            cursor = self._prev.get(cursor)
        return list(reversed(path))

    def _ensure_search(self, state: PlayerState) -> None:
        key = state.fingerprint()
        if key == self._cache_key:
            return

        dist: dict[str, int] = {}
        prev: dict[str, str | None] = {}
        blocked: dict[str, list[str]] = {}

        heap: list[tuple[int, str]] = []
        sources = state.owned & self.nodes.keys()
        if not sources:
            sources = {HUB_ID}
        for node_id in sources:
            dist[node_id] = 0
            prev[node_id] = None
            heapq.heappush(heap, (0, node_id))

        while heap:
            cost, node_id = heapq.heappop(heap)
            if cost > dist.get(node_id, float("inf")):
                continue
            for neighbour in self.adjacency[node_id]:
                step = self.node_cost(neighbour, state)
                new_cost = cost + step
                if new_cost >= dist.get(neighbour, float("inf")):
                    continue
                if neighbour not in state.owned:
                    # walk the candidate path so prerequisites can be checked
                    # against everything the player would own on arrival
                    acquired = set()
                    cursor: str | None = node_id
                    while cursor is not None:
                        acquired.add(cursor)
                        cursor = prev.get(cursor)
                    owned_then = state.owned | acquired
                    spent_then = state.points_spent + new_cost
                    unmet = self._unmet(neighbour, owned_then, spent_then)
                    if unmet:
                        blocked.setdefault(neighbour, unmet)
                        continue
                    blocked.pop(neighbour, None)
                dist[neighbour] = new_cost
                prev[neighbour] = node_id
                heapq.heappush(heap, (new_cost, neighbour))

        self._cache_key = key
        self._dist, self._prev, self._blocked = dist, prev, blocked

    def _unmet(self, node_id: str, owned: set[str], points_spent: int) -> list[str]:
        node = self.nodes[node_id]
        requirements = node.get("prereqs") or prereq_mod.empty_prereqs()
        if prereq_mod.satisfied(requirements, owned, points_spent):
            return []
        reasons = []
        threshold = requirements.get("threshold_count")
        if threshold is not None and points_spent < threshold:
            reasons.append(f"needs {threshold} points spent (has {points_spent})")
        groups = requirements.get("groups") or (
            [{"logic": requirements.get("logic", "AND"), "nodes": requirements.get("nodes", [])}]
            if requirements.get("nodes")
            else []
        )
        for group in groups:
            nodes = group.get("nodes") or []
            if not nodes:
                continue
            if group.get("logic") == "OR":
                if not any(n in owned for n in nodes):
                    reasons.append("needs one of: " + ", ".join(nodes))
            else:
                missing = [n for n in nodes if n not in owned]
                if missing:
                    reasons.append("needs: " + ", ".join(missing))
        return reasons

    # -- public API ------------------------------------------------------

    def can_afford(self, player_state: PlayerState, target_node_id: str) -> dict:
        if target_node_id not in self.nodes:
            return {
                "affordable": False,
                "path": [],
                "total_cost": None,
                "reason": "unknown_node",
                "blocking_prereqs": [],
            }

        if target_node_id in player_state.owned:
            return {
                "affordable": True,
                "path": [target_node_id],
                "total_cost": 0,
                "reason": "already_owned",
                "blocking_prereqs": [],
                "new_nodes": [],
            }

        self._ensure_search(player_state)

        if target_node_id not in self._dist:
            blocked = self._blocked.get(target_node_id, [])
            return {
                "affordable": False,
                "path": [],
                "total_cost": None,
                "reason": "unmet_prerequisites" if blocked else "unreachable",
                "blocking_prereqs": blocked,
            }

        total_cost = self._dist[target_node_id]
        path = self._path_to(target_node_id)
        budget = player_state.points_total - player_state.points_spent
        new_nodes = [n for n in path if n not in player_state.owned]
        return {
            "affordable": total_cost <= budget,
            "path": path,
            "total_cost": total_cost,
            "reason": "ok" if total_cost <= budget else "insufficient_points",
            "blocking_prereqs": [],
            "new_nodes": new_nodes,
            "points_remaining_after": budget - total_cost,
        }

    def allocate(self, player_state: PlayerState, target_node_id: str) -> dict:
        """Buy the target and everything on the cheapest path to it."""
        result = self.can_afford(player_state, target_node_id)
        if not result["affordable"]:
            return result
        for node_id in result["path"]:
            if node_id in player_state.owned:
                continue
            player_state.points_spent += self.node_cost(node_id, player_state)
            player_state.owned.add(node_id)
        return result

    def start_state(self, home_zone: str, points_total: int) -> PlayerState:
        """A fresh character: standing on the hub, inside their home zone's gate."""
        state = PlayerState(home_zone=home_zone, points_total=points_total)
        gate = f"gate_{home_zone.lower()}"
        if gate in self.nodes:
            state.owned.add(gate)
        return state


def can_afford(player_state: PlayerState, target_node_id: str, engine: PathEngine) -> dict:
    """Module-level convenience wrapper matching the work order's signature."""
    return engine.can_afford(player_state, target_node_id)
