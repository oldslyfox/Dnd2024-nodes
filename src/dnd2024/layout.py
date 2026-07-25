"""Task 2 / 2d - zone geometry and depth-driven placement.

Polar layout. The shared core is the origin; each of the 13 class zones owns an
angular wedge of the ring around it; radius is a pure function of depth, and
depth is a pure function of RAW level (Task 2d).

    radius = CORE_RADIUS + depth * RING_STEP

Angle within a wedge is organised into lanes:

    lane  0.00   the class's own ladder + class features
    lane +0.30   that zone's spell slot spine, where it has one
    lane -1.00, -0.55, +0.55, +1.00   the four subclass sub-regions

Nodes that belong to two zones (shared feats, weapon masteries, epic boons)
are placed on the *boundary* angle between two ring-adjacent wedges.

`level` is consumed here and only here. It never reaches the pathing engine.
"""

from __future__ import annotations

import math
from collections import defaultdict

from . import config

TWO_PI = 2 * math.pi


class Layout:
    def __init__(self) -> None:
        self.zone_count = len(config.ZONE_RING)
        self.slice_width = TWO_PI / self.zone_count
        self.wedge_half = self.slice_width * config.ZONE_WEDGE_FILL / 2
        # deterministic fan-out counters, keyed by (angle bucket, depth bucket)
        self._occupancy: dict[tuple, int] = defaultdict(int)
        # every position handed out, so two lanes never land on the same point
        self._taken: set[tuple[float, float]] = set()

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
        """Convert (angle, depth) to a position, fanning out repeat callers.

        Nodes that would land on the same spot (same lane, same depth) are
        spread along the arc so a renderer never has to de-overlap them.
        """
        radius = self.radius(depth)
        if spread_key is not None:
            key = (spread_key, round(float(depth), 3))
            index = self._occupancy[key]
            self._occupancy[key] += 1
            if index:
                # fan along the arc in rows of seven, each row a little further
                # out - never inwards, so radius stays monotonic in depth
                row, slot = divmod(index, 7)
                step = (slot + 1) // 2
                sign = 1 if slot % 2 else -1
                radius += 1.1 * row
                angle += (0.9 * step * sign) / max(radius, 1.0)
        return self._emit(angle, radius)

    def _emit(self, angle: float, radius: float) -> dict:
        for nudge in range(64):
            trial = angle + nudge * 0.35 / max(radius, 1.0)
            point = (round(radius * math.cos(trial), 3), round(radius * math.sin(trial), 3))
            if point not in self._taken:
                self._taken.add(point)
                return {
                    "position_x": point[0],
                    "position_y": point[1],
                    "polar": {
                        "angle_deg": round(math.degrees(trial) % 360, 2),
                        "radius": round(radius, 3),
                    },
                }
        return {
            "position_x": round(radius * math.cos(angle), 3),
            "position_y": round(radius * math.sin(angle), 3),
            "polar": {
                "angle_deg": round(math.degrees(angle) % 360, 2),
                "radius": round(radius, 3),
            },
        }

    def place_core(self, index: int, depth: float) -> dict:
        """Ring the shared core's own nodes around the origin."""
        if depth <= 0:
            self._taken.add((0.0, 0.0))
            return {
                "position_x": 0.0,
                "position_y": 0.0,
                "polar": {"angle_deg": 0.0, "radius": 0.0},
            }
        angle = (index * 2.39996) % TWO_PI  # golden-angle spacing
        return self.place(angle, depth)
