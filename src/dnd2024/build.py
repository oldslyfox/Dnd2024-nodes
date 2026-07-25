"""Graph v2 builder - orchestrates Tasks 1, 2, 2b, 2c, 2d, 3 and 4.

Reads the Work Order 1 extraction from data/input and writes graph v2 plus the
generated node files to data/output.
"""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from . import chassis, config, connectors, layout as layout_module, prereqs, spines
from .layout import Layout
from .point_economy import compute_economy

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "data" / "input"
OUTPUT = ROOT / "data" / "output"

COMMONS_ZONE = "commons"

# Which martial boundary each weapon mastery is drilled at. Barbarian, Fighter,
# Paladin and Ranger are the zones the work order names; Rogue and Monk join two
# of those boundaries because they are the other two classes whose RAW class
# table grants Weapon Mastery / light-weapon fighting.
MASTERY_BOUNDARIES = {
    "mastery_cleave_xphb": ("Barbarian", "Fighter"),
    "mastery_graze_xphb": ("Barbarian", "Fighter"),
    "mastery_push_xphb": ("Fighter", "Paladin"),
    "mastery_topple_xphb": ("Fighter", "Paladin"),
    "mastery_slow_xphb": ("Ranger", "Rogue"),
    "mastery_vex_xphb": ("Ranger", "Rogue"),
    "mastery_nick_xphb": ("Monk", "Barbarian"),
    "mastery_sap_xphb": ("Monk", "Barbarian"),
}

OPTIONAL_FEATURE_DEFAULT_DEPTH = {
    "eldritch_invocation": 1,
    "metamagic": 2,
    "maneuver_battle_master": 3,
}

ARMOR_TRAINING_SOURCES = {
    "light": ["conn_training_light_armor", "feat_lightly_armored_xphb"],
    "medium": ["conn_training_medium_armor", "feat_moderately_armored_xphb"],
    "heavy": ["conn_training_heavy_armor", "feat_heavily_armored_xphb"],
    "shield": ["conn_training_shields", "feat_lightly_armored_xphb"],
}


def _load(name: str):
    with open(INPUT / name) as handle:
        return json.load(handle)


def _clamp_level(depth: float) -> int:
    return max(1, min(20, int(round(depth))))


class GraphBuilder:
    def __init__(self) -> None:
        self.source = _load("graph.json")
        self.classes_meta = _load("classes_meta.json")
        self.source_edges = _load("edges.json")

        self.layout = Layout()
        self.economy = compute_economy(self.source["nodes"], self.classes_meta)

        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.rung: dict[tuple[str, int], str] = {}  # (zone, level) -> connector id
        self.sub_rung: dict[tuple[str, str, int], str] = {}
        self.subclass_levels: dict[tuple[str, str], list[int]] = {}
        self.notes: list[str] = []
        self._subclass_order: dict[str, list[str]] = {}
        self._ring_offset_cache: dict[tuple[float, str], float] | None = None

    # -- helpers ---------------------------------------------------------

    def add_node(self, node: dict) -> dict:
        if node["id"] in self.nodes:
            raise ValueError(f"duplicate node id: {node['id']}")
        self.nodes[node["id"]] = node
        return node

    def add_edge(
        self, source: str, target: str, relation: str, *, traversable: bool = True
    ) -> None:
        self.edges.append(
            {
                "from": source,
                "to": target,
                "relation": relation,
                "traversable": traversable,
            }
        )

    def ring_neighbour(self, zone: str, step: int = 1) -> str:
        ring = config.ZONE_RING
        return ring[(ring.index(zone) + step) % len(ring)]

    def rung_level_for(self, depth: float) -> int:
        """Nearest ladder rung at or below a depth (the ladder is every 2 levels)."""
        level = _clamp_level(depth)
        candidates = [lvl for lvl in config.LADDER_RUNG_LEVELS if lvl <= level]
        return candidates[-1] if candidates else config.LADDER_RUNG_LEVELS[0]

    def attach_to_zone(self, node_id: str, zone: str, depth: float, relation: str) -> None:
        rung_id = self.rung.get((zone, self.rung_level_for(depth)))
        if rung_id:
            self.add_edge(rung_id, node_id, relation)

    # -- Task 2 / 2d: classify the extracted content ---------------------

    def classify_real_nodes(self) -> None:
        boon_owners = self._epic_boon_owners()
        boundary_cycle = [
            (zone, self.ring_neighbour(zone)) for zone in config.ZONE_RING
        ]

        for raw in self.source["nodes"]:
            node = dict(raw)
            node.setdefault("generated", False)
            node["point_cost"] = config.FLAT_POINT_COST
            node["is_spine"] = False
            node["is_gate"] = False
            node["subregion"] = None
            node["boundary"] = None
            kind = node["type"]

            if kind == "class_feature":
                node["zone"] = node["source_class"]
                node["depth"] = float(node["level"])
                node["role"] = "class_feature"

            elif kind == "subclass_feature":
                node["zone"] = node["source_class"]
                node["subregion"] = node["subclass"]
                node["depth"] = float(node["level"])
                node["role"] = "subclass_feature"

            elif kind == "weapon_mastery":
                pair = MASTERY_BOUNDARIES[node["id"]]
                node["zone"] = COMMONS_ZONE
                node["boundary"] = list(pair)
                node["depth"] = float(config.DEPTH_WEAPON_MASTERY)
                node["role"] = "weapon_mastery"

            elif kind == "optional_feature":
                label = node["feature_type_labels"][0]
                owner, neighbour = config.OPTIONAL_FEATURE_HOME[label]
                node["zone"] = owner
                node["boundary"] = [owner, neighbour]
                node["depth"] = float(
                    self._optional_feature_level(node)
                    or OPTIONAL_FEATURE_DEFAULT_DEPTH[label]
                )
                node["role"] = label
                if label == "maneuver_battle_master":
                    node["subregion"] = "Battle Master"

            elif kind == "feat":
                self._classify_feat(node, boon_owners, boundary_cycle)
            else:
                raise ValueError(f"unknown node type: {kind}")

            self.add_node(node)

    def _optional_feature_level(self, node: dict) -> int | None:
        levels = []
        for block in node.get("prereqs_raw") or []:
            value = block.get("level")
            if isinstance(value, dict):
                levels.append(int(value["level"]))
            elif value is not None:
                levels.append(int(value))
        return min(levels) if levels else None

    def _epic_boon_owners(self) -> dict[str, list[str]]:
        owners: dict[str, list[str]] = defaultdict(list)
        for edge in self.source_edges:
            if edge["to"].startswith("feat_boon_") and edge["from"].startswith("cf_"):
                class_name = edge["from"].split("_")[1].capitalize()
                if class_name in config.ZONE_RING and class_name not in owners[edge["to"]]:
                    owners[edge["to"]].append(class_name)
        return owners

    def _first_ability(self, node: dict) -> str | None:
        for grant in node.get("ability_grants") or []:
            if "choose" in grant:
                options = grant["choose"].get("from") or []
                if options:
                    return options[0]
            else:
                for key in grant:
                    if key in config.ABILITY_AFFINITY:
                        return key
        return None

    def _classify_feat(self, node, boon_owners, boundary_cycle) -> None:
        category = node["category"]
        node["role"] = f"feat_{category}"

        if category == "origin":
            node["zone"] = config.CORE_ZONE
            node["depth"] = float(config.DEPTH_ORIGIN_FEAT)

        elif category == "epic_boon":
            owners = boon_owners.get(node["id"], [])
            if len(owners) >= 2:
                pair = (owners[0], owners[1])
            elif len(owners) == 1:
                pair = (owners[0], self.ring_neighbour(owners[0]))
            else:
                pair = boundary_cycle[hash(node["id"]) % len(boundary_cycle)]
            node["zone"] = COMMONS_ZONE
            node["boundary"] = list(pair)
            node["depth"] = float(config.DEPTH_EPIC_BOON)

        elif category == "fighting_style":
            node["zone"] = COMMONS_ZONE
            node["boundary"] = ["Fighter", "Paladin"]
            node["depth"] = float(config.DEPTH_FIGHTING_STYLE)

        elif category in config.FIGHTING_STYLE_HOME:
            node["zone"] = config.FIGHTING_STYLE_HOME[category]
            node["depth"] = float(config.DEPTH_FIGHTING_STYLE)

        else:  # general
            ability = self._first_ability(node)
            pair = config.ABILITY_AFFINITY.get(ability, ("Fighter", "Rogue"))
            node["zone"] = COMMONS_ZONE
            node["boundary"] = list(pair)
            depth = (
                config.DEPTH_GENERAL_FEAT_HIGH_IMPACT
                if node["id"] in config.HIGH_IMPACT_GENERAL_FEATS
                else config.DEPTH_GENERAL_FEAT
            )
            node["depth"] = float(depth)

        chain = config.REPEATABLE_FEAT_CHAINS.get(node["id"])
        if chain:
            node["depth"] = float(chain[0])

    # -- Task 1 / 2: generated skeleton ----------------------------------

    def build_skeleton(self) -> None:
        hub = self.add_node(connectors.hub_node())
        hub["point_cost"] = 0  # the starting node is free by definition

        core_ring = [self.add_node(node) for node in connectors.core_connectors()]
        for node in core_ring:
            self.add_edge(hub["id"], node["id"], "spine")
        # chain the training connectors so heavier armor sits deeper
        self.add_edge("conn_training_light_armor", "conn_training_medium_armor", "chain")
        self.add_edge("conn_training_medium_armor", "conn_training_heavy_armor", "chain")

        for zone in config.ZONE_RING:
            gate = self.add_node(connectors.gate_node(zone))
            self.add_edge(hub["id"], gate["id"], "gate")
            previous = gate["id"]
            for index, level in enumerate(config.LADDER_RUNG_LEVELS):
                rung = self.add_node(connectors.zone_ladder_rung(zone, level, index))
                self.rung[(zone, level)] = rung["id"]
                self.add_edge(previous, rung["id"], "spine")
                previous = rung["id"]

        # subclass sub-regions branch off the class ladder at their first level
        by_subclass: dict[tuple[str, str], set[int]] = defaultdict(set)
        for node in self.nodes.values():
            if node["type"] == "subclass_feature":
                by_subclass[(node["zone"], node["subregion"])].add(int(node["level"]))
        for (zone, subclass), levels in sorted(by_subclass.items()):
            ordered = sorted(levels)
            self.subclass_levels[(zone, subclass)] = ordered
            previous = self.rung[(zone, self.rung_level_for(ordered[0]))]
            for index, level in enumerate(ordered):
                rung = self.add_node(connectors.subclass_rung(zone, subclass, level, index))
                self.sub_rung[(zone, subclass, level)] = rung["id"]
                self.add_edge(previous, rung["id"], "spine")
                # tie the sub-region back to the class ladder at its own depth,
                # so a sub-region hangs off the spine instead of trailing away
                # from it (and so class <-> subclass paths stay short)
                anchor = self.rung[(zone, self.rung_level_for(level))]
                if anchor != previous:
                    self.add_edge(anchor, rung["id"], "spine")
                previous = rung["id"]

        # martial drill grounds: the shared anchor for weapon mastery nodes
        for index, pair in enumerate(sorted(set(MASTERY_BOUNDARIES.values()))):
            key = f"{pair[0].lower()}_{pair[1].lower()}"
            commons = self.add_node(
                connectors.martial_commons(key, float(config.DEPTH_WEAPON_MASTERY), index)
            )
            commons["boundary"] = list(pair)
            for zone in pair:
                self.attach_to_zone(
                    commons["id"], zone, config.DEPTH_WEAPON_MASTERY, "overlap"
                )

    # -- Task 2b: slot spines --------------------------------------------

    def build_spines(self) -> None:
        for zone in config.FULL_CASTERS:
            self._chain_spine(spines.build_spine(zone, "full"), self.gate_id(zone))
        for zone in config.HALF_CASTERS:
            self._chain_spine(spines.build_spine(zone, "half"), self.gate_id(zone))
        for zone, subclass in config.THIRD_CASTERS:
            anchor = self.sub_rung.get(
                (zone, subclass, self.subclass_levels[(zone, subclass)][0])
            )
            spine = spines.build_spine(zone, "third", subregion=subclass)
            self._chain_spine(spine, anchor)

        warlock_nodes, warlock_edges = spines.build_warlock_chain()
        for node in warlock_nodes:
            self.add_node(node)
        self.add_edge(self.gate_id("Warlock"), "slot_warlock_pact_root", "spine")
        for source, target in warlock_edges:
            self.add_edge(source, target, "spine")
        self.notes.append(
            "Warlock Pact Magic is modelled as a three-branch chain (slot level, "
            "slot count, Mystic Arcanum) rather than a slot-count spine, per Task 2b. "
            "It models acquisition only: short-rest recovery is character-state "
            "tracking and was ruled out of scope in the Work Order 2 review."
        )

    def gate_id(self, zone: str) -> str:
        return f"gate_{zone.lower()}"

    def _chain_spine(self, spine_nodes: list[dict], anchor: str | None) -> None:
        previous = anchor
        for node in spine_nodes:
            self.add_node(node)
            if previous:
                self.add_edge(previous, node["id"], "spine")
            previous = node["id"]

    # -- Task 4: repeatable chains ---------------------------------------

    def build_repeat_chains(self) -> None:
        boundaries = [(zone, self.ring_neighbour(zone)) for zone in config.ZONE_RING]
        for feat_id, depths in config.REPEATABLE_FEAT_CHAINS.items():
            base = self.nodes.get(feat_id)
            if base is None:
                self.notes.append(f"repeatable feat not found in extraction: {feat_id}")
                continue
            base["repeat_index"] = 1
            base["repeat_chain"] = feat_id
            previous = feat_id
            for index, depth in enumerate(depths[1:], start=2):
                repeat = dict(base)
                repeat["id"] = f"{feat_id}_r{index}"
                repeat["name"] = f"{base['name']} ({index})"
                repeat["depth"] = float(depth)
                repeat["generated"] = True
                repeat["repeat_index"] = index
                repeat["prereqs_raw"] = []
                repeat["effect_summary"] = (
                    f"A further application of {base['name']}. "
                    f"{base.get('effect_summary', '')}"
                )
                if base["zone"] == COMMONS_ZONE:
                    repeat["boundary"] = list(boundaries[(index * 2) % len(boundaries)])
                self.add_node(repeat)
                self.add_edge(previous, repeat["id"], "chain")
                previous = repeat["id"]

    # -- edges from the extracted content into the skeleton --------------

    def wire_content(self) -> None:
        for node in list(self.nodes.values()):
            if node.get("generated") and node["type"] in ("connector", "spell_slot"):
                continue
            kind = node["type"]
            depth = node["depth"]

            if kind == "class_feature":
                self.attach_to_zone(node["id"], node["zone"], depth, "attach")

            elif kind == "subclass_feature":
                sub = self.sub_rung.get((node["zone"], node["subregion"], int(depth)))
                if sub:
                    self.add_edge(sub, node["id"], "attach")
                else:
                    self.attach_to_zone(node["id"], node["zone"], depth, "attach")

            elif kind == "weapon_mastery":
                pair = tuple(node["boundary"])
                commons = f"conn_commons_{pair[0].lower()}_{pair[1].lower()}"
                self.add_edge(commons, node["id"], "attach")

            elif kind == "optional_feature":
                owner, neighbour = node["boundary"]
                if node["subregion"]:
                    sub = self.sub_rung.get(
                        (owner, node["subregion"], _clamp_level(depth))
                    )
                    if sub:
                        self.add_edge(sub, node["id"], "attach")
                    else:
                        self.attach_to_zone(node["id"], owner, depth, "attach")
                else:
                    self.attach_to_zone(node["id"], owner, depth, "attach")
                # the overlap costs the neighbouring zone one extra ring
                self.attach_to_zone(node["id"], neighbour, depth + 1, "overlap")

            elif kind == "feat":
                self._wire_feat(node)

    def _wire_feat(self, node: dict) -> None:
        category = node["category"]
        depth = node["depth"]
        if category == "origin":
            self.add_edge("conn_core_hub", node["id"], "attach")
            return
        if category in config.FIGHTING_STYLE_HOME:
            zone = config.FIGHTING_STYLE_HOME[category]
            for feature_id in (
                f"cf_{zone.lower()}_fighting_style_1",
                f"cf_{zone.lower()}_fighting_style_2",
            ):
                if feature_id in self.nodes:
                    self.add_edge(feature_id, node["id"], "attach")
            self.attach_to_zone(node["id"], zone, depth, "attach")
            return
        if category == "fighting_style":
            for feature_id in (
                "cf_fighter_fighting_style_1",
                "cf_paladin_fighting_style_2",
                "cf_ranger_fighting_style_2",
            ):
                if feature_id in self.nodes:
                    self.add_edge(feature_id, node["id"], "attach")
            return
        for zone in node["boundary"] or []:
            self.attach_to_zone(node["id"], zone, depth, "overlap")

    def merge_reference_edges(self) -> None:
        """Carry the Work Order 1 cross-references over as non-traversable edges.

        These are a citation registry from the extraction ("this feature mentions
        that one"), not designed connectivity. Twenty-four of them join two class
        zones directly, which would let a player skip the depth ladder - and under
        flat costing depth is the only balance lever there is. They stay in the
        data, tagged `reference`, for "see also" UI; the pathing engine ignores
        them.
        """
        seen = {(e["from"], e["to"]) for e in self.edges}
        seen |= {(e["to"], e["from"]) for e in self.edges}
        for edge in self.source_edges:
            source, target = edge["from"], edge["to"]
            if source not in self.nodes or target not in self.nodes:
                continue
            if source == target or (source, target) in seen:
                continue
            seen.add((source, target))
            seen.add((target, source))
            self.add_edge(source, target, "reference", traversable=False)

    # -- Task 3 ----------------------------------------------------------

    def normalize_prereqs(self) -> None:
        index = prereqs.PrereqIndex.build(list(self.nodes.values()))
        index.armor_training_nodes = {
            key: [node_id for node_id in ids if node_id in self.nodes]
            for key, ids in ARMOR_TRAINING_SOURCES.items()
        }
        index.spellcasting_entry_nodes = sorted(
            node["id"]
            for node in self.nodes.values()
            if node["type"] == "spell_slot"
            and (node.get("slot_tier") == 1 or node["id"] == "slot_warlock_pact_root")
        )

        for node in self.nodes.values():
            result = prereqs.normalize(node, index, self.economy)
            node["prereqs"] = result["prereqs"]
            node["ability_prereqs"] = result["ability_prereqs"]
            if result["prereq_notes"]:
                node["prereq_notes"] = result["prereq_notes"]
            node.pop("prereqs_raw", None)

        self._apply_gate_requirements()

    def _apply_gate_requirements(self) -> None:
        """Task 2 - a zone's interior is only open once its gate is bought.

        Written into the data rather than hidden in the engine: every node that
        lives inside a class zone gains its zone gate as an AND requirement. That
        keeps the modular-loading rule true no matter which path a player takes
        in - including via a shared feat sitting on a zone boundary, which is
        otherwise a way to step into a zone's ladder without paying its gate.
        """
        for node in self.nodes.values():
            zone = node["zone"]
            if zone not in config.ZONE_RING or node.get("is_gate"):
                continue
            gate = self.gate_id(zone)
            requirements = node["prereqs"]
            groups = requirements.setdefault("groups", [])
            groups.append({"logic": "AND", "nodes": [gate]})
            if gate not in requirements["nodes"]:
                requirements["nodes"].append(gate)

    # -- positions -------------------------------------------------------

    def assign_positions(self) -> None:
        """Place every node, one depth band at a time (Work Order 5).

        Placement used to be greedy: each node asked for a spot and got nudged
        along the arc if something was already there. In dense cells the nudging
        ran out of candidates and gave up, which is how 802 pairs ended up closer
        than 0.8 world units, some exactly coincident - one unreadable, untappable
        blob near the hub.

        Now every node belongs to a *band*, and each band is packed
        deterministically. Within a depth there are three kinds of band, and they
        are stacked into radial lanes because they overlap angularly:

            wedge  one per class zone, angularly disjoint from each other, so
                   every zone's wedge can share the innermost lanes
            seam   shared content anchored to a zone boundary (maneuvers,
                   metamagic, invocations) - overlaps the wedges either side of
                   it, so it starts above the deepest wedge row
            ring   core and commons content, spread over the whole circle, so it
                   starts above the seams

        Every lane is one `MIN_NODE_SEPARATION` from the next, so nodes in
        different lanes cannot collide whatever their angles, and the whole stack
        stays inside `RADIAL_SLACK` of the depth's own radius - the level-derived
        depth ordering from Task 2d is untouched.
        """
        subclass_order: dict[str, list[str]] = defaultdict(list)
        for node in self.nodes.values():
            if node["type"] == "subclass_feature":
                if node["subregion"] not in subclass_order[node["zone"]]:
                    subclass_order[node["zone"]].append(node["subregion"])
        for zone in subclass_order:
            subclass_order[zone].sort()
        self._subclass_order = subclass_order

        bands: dict[float, dict[tuple, list[dict]]] = defaultdict(lambda: defaultdict(list))
        for node in sorted(self.nodes.values(), key=lambda n: (n["depth"], n["id"])):
            if node["id"] == "conn_core_hub":
                node.update(self.layout.place_core(0, 0.0))  # the origin, by definition
                continue
            bands[float(node["depth"])][self._band_key(node)].append(node)

        for depth in sorted(bands):
            self._place_depth(depth, bands[depth])

    def _band_key(self, node: dict) -> tuple:
        """(kind, identity, category) - one packed group per key."""
        if node["zone"] in (config.CORE_ZONE, COMMONS_ZONE):
            return ("ring", "", self._ring_category(node))
        if node.get("boundary"):
            pair = node["boundary"]
            return ("seam", f"{pair[0]}|{pair[1]}", self._ring_category(node))
        return ("wedge", node["zone"], "")

    def _place_depth(self, depth: float, groups: dict[tuple, list[dict]]) -> None:
        base_radius = self.layout.radius(depth)
        separation = config.MIN_NODE_SEPARATION
        lane = 0  # radial lane index, in units of `separation`

        wedges = {key: members for key, members in groups.items() if key[0] == "wedge"}
        seams = {key: members for key, members in groups.items() if key[0] == "seam"}
        rings = {key: members for key, members in groups.items() if key[0] == "ring"}

        used = 0
        for key, members in sorted(wedges.items()):
            span = 2 * self.layout.wedge_half
            centre = self.layout.zone_angle(key[1])
            used = max(used, self._pack(members, base_radius, lane, span, centre, separation))
        lane += used

        used = 0
        for key, members in sorted(seams.items()):
            zone_a, zone_b = key[1].split("|")
            centre = self.layout.boundary_angle(zone_a, zone_b)
            # A seam may spread wider than the gutter between its two wedges:
            # it sits in its own radial lane, so overlapping them angularly
            # cannot collide with anything.
            span = self.layout.slice_width * 1.6
            used = max(used, self._pack(members, base_radius, lane, span, centre, separation))
        lane += used

        for key in sorted(rings, key=lambda k: self._ring_category_order(k[2])):
            lane += self._pack(
                rings[key],
                base_radius,
                lane,
                2 * math.pi,
                0.0,
                config.COMMONS_MIN_SEPARATION,
            )

    def _pack(
        self,
        members: list[dict],
        base_radius: float,
        lane: int,
        span: float,
        centre: float,
        separation: float,
    ) -> int:
        """Lay a group out across `span`, in as many radial rows as it needs.

        Returns how many radial lanes it consumed, so the caller can stack the
        next group clear of it.
        """
        radius0 = base_radius + min(lane * config.MIN_NODE_SEPARATION, config.RADIAL_SLACK)
        preferred = [self._preferred_angle(node, centre) for node in members]
        order = sorted(range(len(members)), key=lambda i: (preferred[i], members[i]["id"]))

        per_row = max(1, int((radius0 * span) // separation))
        rows = max(1, math.ceil(len(members) / per_row))
        # never push a group out of its own depth band
        max_rows = max(1, int(config.RADIAL_SLACK // config.MIN_NODE_SEPARATION) + 1 - lane)
        rows = min(rows, max_rows)

        for row_index in range(rows):
            row = [order[i] for i in range(row_index, len(order), rows)]
            if not row:
                continue
            radius = min(
                radius0 + row_index * config.MIN_NODE_SEPARATION,
                base_radius + config.RADIAL_SLACK,
            )
            gap = separation / max(radius, 1.0)
            prefs = [preferred[i] for i in row]
            if span >= 2 * math.pi - 1e-6:
                angles = layout_module.pack_ring(prefs, gap)
            else:
                angles = layout_module.pack_span(
                    prefs, gap, centre - span / 2, centre + span / 2
                )
            for index, angle in zip(row, angles):
                members[index].update(self.layout.claim_at(angle, radius))
        return rows

    @staticmethod
    def _ring_category(node: dict) -> str:
        """Which sub-ring a shared node belongs on."""
        if node.get("repeat_chain"):
            return "repeat_chain"
        return node.get("role") or node["type"]

    @staticmethod
    def _ring_category_order(category: str) -> tuple[int, str]:
        """Inner-to-outer order of the sub-rings at a given depth (Task 3).

        General Feats, Fighting Styles, Epic Boons, ASI repeats and weapon
        masteries used to share one circle per depth, carrying more content than
        any single class zone's ring at the same depth because they are shared by
        all thirteen zones. Each now gets its own sub-ring.
        """
        order = [
            "core",
            "training",
            "feat_origin",
            "commons",
            "weapon_mastery",
            "feat_fighting_style",
            "repeat_chain",
            "feat_general",
            "feat_epic_boon",
        ]
        return (order.index(category) if category in order else len(order), category)

    def _preferred_angle(self, node: dict, centre: float) -> float:
        """Where a node would like to sit within its band, before spacing."""
        zone = node["zone"]
        if zone in (config.CORE_ZONE, COMMONS_ZONE):
            boundary = node.get("boundary")
            if boundary:
                return self.layout.boundary_angle(boundary[0], boundary[1]) % (2 * math.pi)
            # core content has no boundary: spread it by a stable hash of its id
            # so the ring fills evenly and the order never wobbles between builds
            digest = sum((index + 1) * ord(char) for index, char in enumerate(node["id"]))
            return (digest % 3600) / 3600 * 2 * math.pi
        if node.get("boundary"):
            return centre

        subregion = node.get("subregion")
        if subregion:
            order = self._subclass_order.get(zone, [])
            lane_index = order.index(subregion) if subregion in order else 0
            lane = self.layout.subclass_lane(lane_index)
        elif node["type"] == "spell_slot":
            lane = 0.30
        else:
            lane = 0.0
        return self.layout.lane_angle(zone, lane)

    # -- assembly --------------------------------------------------------

    def build(self) -> dict:
        self.classify_real_nodes()
        self.build_skeleton()
        self.build_spines()
        self.build_repeat_chains()
        self.wire_content()
        self.merge_reference_edges()
        self.normalize_prereqs()
        self.assign_positions()
        return self.to_graph()

    def _zone_status(self, nodes: list[dict]) -> dict:
        """Mark zones that are structurally complete but hold no book content.

        Artificer is the only one today: `classes_meta` lists it (source EFA,
        d8, half-caster) but the Work Order 1 extraction produced no Artificer
        features, because Artificer is not part of the 2024 core PHB. The zone is
        built regardless - gate, ladder, half-caster spine - so the ring stays
        complete and a character can start there and take the d8. This field
        exists so nobody later mistakes an empty board for a broken extraction.
        """
        status = {}
        for zone in config.ZONE_RING:
            extracted = sum(
                1
                for node in nodes
                if node["zone"] == zone and not node.get("generated")
            )
            status[zone] = {
                "extracted_nodes": extracted,
                "state": "populated" if extracted else "pending official 2024 content",
            }
        return status

    def to_graph(self) -> dict:
        nodes = sorted(self.nodes.values(), key=lambda n: n["id"])
        counts = Counter(node["type"] for node in nodes)
        return {
            "meta": {
                "version": 2,
                "scope": self.source["meta"]["scope"],
                "generated_by": "Work Order 2 - point economy, pathing and layout",
                "node_count": len(nodes),
                "edge_count": len(self.edges),
                "node_counts_by_type": dict(sorted(counts.items())),
                "zones": [config.CORE_ZONE, COMMONS_ZONE] + list(config.ZONE_RING),
                "flat_point_cost": config.FLAT_POINT_COST,
                "point_economy": self.economy.to_dict(),
                "chassis_by_zone": chassis.build_table(self.classes_meta),
                "zone_status": self._zone_status(nodes),
                "notes": self.notes,
            },
            "classes": self.source["classes"],
            "nodes": nodes,
            "edges": self.edges,
        }


def write_outputs() -> dict:
    builder = GraphBuilder()
    graph = builder.build()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    with open(OUTPUT / "graph.v2.json", "w") as handle:
        json.dump(graph, handle, indent=2)

    generated = [n for n in graph["nodes"] if n["type"] == "connector"]
    with open(OUTPUT / "nodes_connectors.json", "w") as handle:
        json.dump(generated, handle, indent=2)

    slots = [n for n in graph["nodes"] if n["type"] == "spell_slot"]
    with open(OUTPUT / "nodes_spell_slots.json", "w") as handle:
        json.dump(slots, handle, indent=2)

    with open(OUTPUT / "point_economy.json", "w") as handle:
        json.dump(builder.economy.to_dict(), handle, indent=2)

    return graph


if __name__ == "__main__":  # pragma: no cover
    graph = write_outputs()
    print(json.dumps(graph["meta"], indent=2)[:2000])
