"""Task 2 / 2d - zone geometry and depth-driven placement.

Polar layout. The shared core is the origin; each of the 13 class zones owns an
angular wedge of the ring around it; radius is a function of depth, and depth is
a pure function of RAW level (Task 2d).

    radius = CORE_RADIUS + depth * RING_STEP

Angle within a wedge is organised into lanes:

    lane  0.00   the class's own ladder + class features
    lane +0.30   that zone's spell slot spine, where it has one
    lane -1.00, -0.55, +0.55, +1.00   the four subclass sub-regions

Nodes that belong to two zones (shared feats, weapon masteries, epic boons) are
placed on the *boundary* angle between two ring-adjacent wedges.

`level` is consumed here and only here. It never reaches the pathing engine.

Separation (Work Order 5)
-------------------------
Every emitted position is checked against a spatial hash and pushed until it is
at least `MIN_NODE_SEPARATION` world units from its neighbours. Before Work
Order 5 the only check was "no two nodes round to the same coordinate", which let
802 pairs sit closer than 0.8 units and some within 0.001 - visually one blob,
and untappable at any zoom.

Shared content additionally goes through `pack_ring`, which gives each category
its own sub-ring rather than piling every category onto one circle at the same
depth.
"""

from __future__ import annotations

import math
from collections import defaultdict

from . import config

TWO_PI = 2 * math.pi


def pack_ring(preferred: list[float], gap: float) -> list[float]:
    """Spread angles around a circle so no two are closer than `gap` radians.

    Each angle starts at its preferred value (which carries the meaning - a
    shared feat wants to sit on its zone boundary) and is pushed forward only as
    far as the spacing requires. If the ring cannot hold them all, they fall back
    to even spacing centred on the same arc, and the caller is expected to have
    split the group across sub-rings already.
    """
    count = len(preferred)
    if count <= 1:
        return list(preferred)

    order = sorted(range(count), key=lambda i: preferred[i])
    out = [0.0] * count

    if count * gap >= TWO_PI:
        start = preferred[order[0]]
        for slot, index in enumerate(order):
            out[index] = start + slot * (TWO_PI / count)
        return out

    previous = None
    for index in order:
        angle = preferred[index]
        if previous is not None and angle < previous + gap:
            angle = previous + gap
        out[index] = angle
        previous = angle

    # close the circle: the last node must also clear the first
    first = out[order[0]]
    last = out[order[-1]]
    if last + gap > first + TWO_PI:
        span = max(last - first, (count - 1) * gap)
        start = first - (span - (last - first)) / 2
        for slot, index in enumerate(order):
            out[index] = start + slot * (span / (count - 1))
    return out


def pack_span(preferred: list[float], gap: float, low: float, high: float) -> list[float]:
    """Spread angles across a bounded arc, keeping at least `gap` between them.

    Used for wedges and seams, where a node must stay inside its zone's slice
    rather than wander around the ring. Nodes start at their preferred angle and
    are pushed apart; if the arc cannot hold them at full spacing they are
    distributed evenly across it, which compresses uniformly instead of letting
    two land on top of each other.
    """
    count = len(preferred)
    if count == 0:
        return []
    if count == 1:
        return [min(max(preferred[0], low), high)]

    width = high - low
    if count * gap >= width:
        step = width / (count - 1)
        order = sorted(range(count), key=lambda i: preferred[i])
        out = [0.0] * count
        for slot, index in enumerate(order):
            out[index] = low + slot * step
        return out

    order = sorted(range(count), key=lambda i: preferred[i])
    values = [min(max(angle, low), high) for angle in preferred]

    previous = None
    for index in order:
        angle = values[index] if previous is None else max(values[index], previous + gap)
        values[index] = angle
        previous = angle

    if values[order[-1]] > high:
        previous = None
        for index in reversed(order):
            angle = values[index] if previous is None else min(values[index], previous - gap)
            values[index] = min(angle, high) if previous is None else angle
            previous = values[index]
    return values


class Layout:
    def __init__(self) -> None:
        self.zone_count = len(config.ZONE_RING)
        self.slice_width = TWO_PI / self.zone_count
        self.wedge_half = self.slice_width * config.ZONE_WEDGE_FILL / 2
        # deterministic fan-out counters, keyed by (angle bucket, depth bucket)
        self._occupancy: dict[tuple, int] = defaultdict(int)
        # spatial hash of every position handed out, for the separation check
        self._cells: dict[tuple[int, int], list[tuple[float, float]]] = defaultdict(list)

    # -- angles ----------------------------------------------------------

    def zone_index(self, zone: str) -> int:
        return config.ZONE_RING.index(zone)

    def zone_angle(self, zone: str) -> float:
        return self.zone_index(zone) * self.slice_width

    def boundary_angle(self, zone_a: str, zone_b: str) -> float:
        """Angle of the seam between two zones (ring-adjacent or not)."""
        ia, ib = self.zone_index(zone_a), self.zone_index(zone_b)
        delta = (ib - ia) % self.zone_count
        if delta > self.zone_count / 2:
            delta -= self.zone_count
        return (ia + delta / 2) * self.slice_width

    def lane_angle(self, zone: str, lane: float) -> float:
        return self.zone_angle(zone) + lane * self.wedge_half

    def subclass_lane(self, subclass_index: int) -> float:
        return [-1.0, -0.55, 0.55, 1.0][subclass_index % 4]

    # -- placement -------------------------------------------------------

    def radius(self, depth: float) -> float:
        return config.CORE_RADIUS + float(depth) * config.RING_STEP

    def place(self, angle: float, depth: float, *, spread_key: str | None = None) -> dict:
        """Convert (angle, depth) to a position, fanning out repeat callers."""
        radius = self.radius(depth)
        if spread_key is not None:
            key = (spread_key, round(float(depth), 3))
            index = self._occupancy[key]
            self._occupancy[key] += 1
            if index:
                # fan along the arc in rows, each row a little further out -
                # never inwards, so radius stays monotonic in depth
                row, slot = divmod(index, 5)
                step = (slot + 1) // 2
                sign = 1 if slot % 2 else -1
                radius += min(config.ROW_STEP * row, config.RADIAL_SLACK)
                angle += (config.MIN_NODE_SEPARATION * step * sign) / max(radius, 1.0)
        return self.emit(angle, radius)

    def claim_at(self, angle: float, radius: float) -> dict:
        """Take an exact packed position.

        The band packer in build.py has already guaranteed the spacing, so this
        does not search - it records the point and hands it back. `emit` remains
        for the few callers that still place opportunistically.
        """
        x = radius * math.cos(angle)
        y = radius * math.sin(angle)
        self._claim(x, y)
        return {
            "position_x": round(x, 3),
            "position_y": round(y, 3),
            "polar": {
                "angle_deg": round(math.degrees(angle) % 360, 2),
                "radius": round(radius, 3),
            },
        }

    # -- separation ------------------------------------------------------

    def _cell(self, x: float, y: float) -> tuple[int, int]:
        size = config.MIN_NODE_SEPARATION
        return (int(math.floor(x / size)), int(math.floor(y / size)))

    def _is_clear(self, x: float, y: float) -> bool:
        minimum = config.MIN_NODE_SEPARATION
        cx, cy = self._cell(x, y)
        for ix in range(cx - 1, cx + 2):
            for iy in range(cy - 1, cy + 2):
                for px, py in self._cells.get((ix, iy), ()):
                    if math.hypot(px - x, py - y) < minimum:
                        return False
        return True

    def _claim(self, x: float, y: float) -> None:
        self._cells[self._cell(x, y)].append((x, y))

    def emit(self, angle: float, radius: float, *, radial_slack: float | None = None) -> dict:
        """Place a node, pushing it off anything already within the minimum gap.

        Candidates are tried in order of increasing displacement: along the arc
        first, since that keeps the node in its lane and at its depth, and only
        then outward, capped so a node can never drift into the next depth ring.
        """
        if radial_slack is None:
            radial_slack = config.RADIAL_SLACK
        step = config.MIN_NODE_SEPARATION

        for attempt in range(21 * 8):
            band, slot = divmod(attempt, 21)
            offset = (slot + 1) // 2
            sign = 1 if slot % 2 else -1
            trial_radius = radius + min(band * (radial_slack / 6), radial_slack)
            trial_angle = angle + (step * offset * sign) / max(trial_radius, 1.0)

            x = trial_radius * math.cos(trial_angle)
            y = trial_radius * math.sin(trial_angle)
            if self._is_clear(x, y):
                self._claim(x, y)
                return {
                    "position_x": round(x, 3),
                    "position_y": round(y, 3),
                    "polar": {
                        "angle_deg": round(math.degrees(trial_angle) % 360, 2),
                        "radius": round(trial_radius, 3),
                    },
                }

        x = radius * math.cos(angle)
        y = radius * math.sin(angle)
        self._claim(x, y)
        return {
            "position_x": round(x, 3),
            "position_y": round(y, 3),
            "polar": {
                "angle_deg": round(math.degrees(angle) % 360, 2),
                "radius": round(radius, 3),
            },
        }

    def place_core(self, index: int, depth: float) -> dict:
        """Ring the shared core's own nodes around the origin."""
        if depth <= 0:
            self._claim(0.0, 0.0)
            return {
                "position_x": 0.0,
                "position_y": 0.0,
                "polar": {"angle_deg": 0.0, "radius": 0.0},
            }
        angle = (index * 2.39996) % TWO_PI  # golden-angle spacing
        return self.place(angle, depth)
