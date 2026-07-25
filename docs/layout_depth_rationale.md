# Layout & depth rationale

This file replaces `cost_methodology.md` (Task 4). There is no cost methodology
to write down any more: **every node costs exactly 1 point**. All balance
reasoning lives in *where a node sits*, because depth is now the only lever.

Read this alongside `data/output/validation_report.json`, which measures the
properties claimed here, and `data/output/balance_flags.json`, which lists the
combinations this layout does not price out.

---

## 1. The one rule everything else follows

> **depth = RAW character level.**

A node's `depth` is the level at which a RAW character would first have got it,
and its distance from the hub is a linear function of that:

```
radius = CORE_RADIUS (2.0) + depth * RING_STEP (3.0)
```

Level 1 features sit next to the hub, level 20 capstones sit on the rim at
radius 62. Depth is computed once, at generation time, and then `level` becomes
inert historical metadata. The pathing engine never reads it — the only runtime
gates are points spent, connectivity, and normalized prerequisites (locked
decision 1). `tests/test_pathing.py::test_level_is_never_consulted_at_runtime`
holds that line.

For content with no intrinsic level, depth is derived:

| content | depth | why |
|---|---|---|
| Origin feats | 1 | granted at character creation via background |
| Fighting-style feats | 2 | Fighter 1 / Paladin 2 / Ranger 2 |
| Weapon masteries | 2 | Weapon Mastery is a level 1 martial class feature |
| General feats | 4 | first normally available at level 4 |
| High-impact general feats | 6 | see §5 |
| Eldritch invocations | their RAW invocation prerequisite level (1–15) | already level-bearing |
| Metamagic | 2 | Sorcerer gains Metamagic at level 2 |
| Battle Master maneuvers | 3 | subclass entry level |
| Epic boons | 20 | RAW prerequisite is level 19; boons are the deepest nodes in the graph |
| Slot spines | the level that chassis first gains that slot tier | §4 |

## 2. Zones, and the ring they sit on

Thirteen class zones around a shared core. Ring order is not alphabetical — it
is chosen so that adjacent zones share a fantasy, because a *boundary* is where
shared content gets parked:

```
Barbarian – Fighter – Paladin – Cleric – Druid – Ranger – Rogue –
Artificer – Wizard – Sorcerer – Warlock – Bard – Monk – (back to Barbarian)
```

- **martial arc** Barbarian → Fighter → Paladin
- **divine/primal arc** Cleric → Druid → Ranger
- **skill arc** Rogue → Artificer
- **arcane arc** Wizard → Sorcerer → Warlock
- **charisma/monastic arc** Bard → Monk, closing back onto Barbarian

That ordering is what makes the work order's own example land correctly:
Metamagic sits on the Sorcerer|Wizard seam.

Each zone owns an angular wedge (`ZONE_WEDGE_FILL = 0.78` of its slice, leaving
gutters between zones). Within a wedge:

| lane | contents |
|---|---|
| 0.00 | the class ladder and the class's own features |
| +0.30 | that zone's spell slot spine |
| ±0.55, ±1.00 | the four subclass sub-regions |

**Gates.** Every zone's perimeter carries a `gate_<class>` node at depth 1. It is
a purchasable connector-tier node (Task 2), and it is also written into the data
as an AND prerequisite of every node inside that zone. That last part matters:
shared feats on a zone boundary connect two zones' ladders, so without the gate
requirement a player could step through a boundary feat straight into a zone's
interior and the Diablo-4-style modular loading would be a lie. With it, the
client can load a zone's board exactly when its gate is bought, and no earlier.

**The core.** The hub (`conn_core_hub`) is free — it is where every character
stands at creation. Around it sit the origin feats (universal by definition —
they come from backgrounds, not classes), four core connectors, and the armor
training connectors described in §6.

**The commons.** Content that belongs to two zones at once — general feats,
epic boons, weapon masteries, fighting styles, ASI repeats — is zoned `commons`
and carries a `boundary: [zoneA, zoneB]` pair. It is positioned on the seam
angle between those two wedges and wired to both zones' ladders at its depth.

## 3. Connectors as the normalization mechanism

Real content is unevenly distributed. Monk has 34 class features, Wizard has 16;
Barbarian has nothing at all between levels 15 and 18. Without filler, "how far
out is level 10" would mean something different in every zone.

Each zone therefore carries an identical connector ladder — one rung every three
levels, at levels 1, 4, 7, 10, 13, 16, 19 — and every real node attaches to the
rung at or below its depth. The result is measured, not asserted:

```
"hops_from_hub": every zone -> 5 hops to the level-10 rung
"uniform": true
```

Same in all thirteen zones, including Artificer, whose zone contains no
extracted content at all (see §7).

Ladder granularity is the tuning knob between Task 1's density target and Task
2d's normalization. Normalization holds at every granularity tried; density does
not. Measured mean connectors crossed, same-zone / cross-zone:

| rung every | same zone | cross zone | |
|---|---|---|---|
| 1 level | 6.4 | 9.2 | ladder too long |
| 2 levels | 4.1 | 7.4 | just over the band |
| **3 levels** | **3.7** | **6.6** | **chosen** |
| 4 levels | 3.4 | 6.2 | in band, but depth resolution blurs |

```
"same_zone": mean 3.72 connectors crossed, median 4, in_band true   (target 2-4)
"cross_zone": mean 6.64
```

This was retuned after the review: while the extraction's reference edges were
traversable they had been quietly shortening paths, and removing them moved both
numbers up (see §9).

Subclass sub-regions branch off the class ladder at their first feature level,
chain outward through their own rungs, and are also tied laterally back to the
class ladder at each of their own depths. That keeps a sub-region hanging off
the spine at the right radius instead of trailing away from it, and it is what
brought same-zone crossings inside the target band.

**Cross-zone distance.** Abroad costs 6.64 connectors crossed against 3.7 at
home, and the gap in points is wider still — see §8.

## 4. Slot spines

Full casters (Wizard, Cleric, Druid, Bard, Sorcerer) get a 9-node spine, half
casters (Paladin, Ranger, Artificer) a 5-node spine, and the two third-caster
subclasses (Eldritch Knight, Arcane Trickster) a 4-node spine inside their
subclass sub-region. Each spine starts at the zone's gate — its edge nearest the
core — and runs outward, each tier placed at the level that chassis first gains
it. Tier 9 for a full caster lands at depth 17, near the rim; a third caster's
tier 4 lands at depth 19, which is exactly how late RAW hands it over.

**Warlock is different, by instruction and by nature.** Pact Magic does not scale
by slot count, so it is not a slot-count spine. It is a `Pact Magic` root with
three branches:

- slot **level** 1 → 5, at depths 1/3/5/7/9
- slot **count** 2 → 4, at depths 2/11/17
- **Mystic Arcanum** 6th → 9th, at depths 11/13/15/17, hanging off the end of
  the slot-level branch

The short-rest recovery that makes Pact Magic what it is has no representation
here — it is a property of the resource, not of any node. Raised for design
review per Task 2b and **ruled out of scope**: recovery timing is character-state
tracking and belongs to a later work order, so this chain models *acquisition*
only, deliberately.

## 5. Depth as the only balance lever

Task 4 removes price as a tool, so a node that is stronger than its neighbours
has to be further out. Two deliberate uses of that:

- **Epic boons at depth 20, not 19.** RAW gates them at level 19; they are put
  one ring beyond the deepest class features so that they are unambiguously the
  last thing anyone reaches. Where a boon sits *angularly* is derived from the
  extraction: the `references` edges from each class's `Epic Boon` feature name
  the boon that class points at, so Boon of Spell Recall sits on the Bard|Wizard
  seam and Boon of Irresistible Offense on the Barbarian|Monk seam.
- **High-impact general feats at depth 6 instead of 4.** Great Weapon Master,
  Sharpshooter, Polearm Master, Sentinel, Crossbow Expert, Dual Wielder, Mage
  Slayer, Elemental Adept, Fey-Touched, Shadow-Touched, Inspiring Leader, Heavy
  Armor Master, Resilient. These are the feats whose real power is out of line
  with the rest of the category; they get two extra rings rather than a price
  tag. The list is a judgement call and is deliberately in one place
  (`config.HIGH_IMPACT_GENERAL_FEATS`) so it is easy to argue with.

**Repeatable nodes** become short chains rather than one infinitely-purchasable
node, each repeat one node deeper:

| feat | depths |
|---|---|
| Ability Score Improvement | 4, 6, 8, 12, 14, 16, 19 (the Fighter's RAW seven slots) |
| Magic Initiate | 1, 8, 14 (one per spell list) |
| Skilled | 1, 8, 14 |
| Elemental Adept | 6, 12, 18 |

ASI repeats are also spread around the ring, each at a different zone boundary,
so nobody's home zone contains the whole chain.

## 6. Two gaps this layout had to fill

Both are invented content, both are flagged here because they are design calls
rather than extraction:

These were approved in review as the same invented-filler pattern as ordinary
connectors, applied to proficiency gating rather than pure pathing. The follow-up
audit the review asked for lives in `data/output/proficiency_gap_audit.json` and
is summarised in §10.

- **Armor training connectors** (`conn_training_light_armor`,
  `…_medium_armor`, `…_heavy_armor`, `conn_training_shields`, at depths
  1/2/3/1 in the core). RAW hands armor proficiency out with class membership.
  There is no class membership any more, and five extracted feats (Heavily
  Armored, Moderately Armored, Medium/Heavy Armor Master, Shield Master) have
  armor-proficiency prerequisites that would otherwise be permanently
  unsatisfiable. The prerequisite resolves to "the training connector **or** the
  feat that grants that training", so either route works.
- **Weapon mastery drill grounds.** The eight mastery nodes sit at depth 2 on
  four martial seams — Barbarian|Fighter (Cleave, Graze), Fighter|Paladin (Push,
  Topple), Ranger|Rogue (Slow, Vex), Monk|Barbarian (Nick, Sap) — each anchored
  to a shared drill-ground connector wired into both zones' ladders. Rogue and
  Monk join two of those seams because Rogue's RAW class table also grants
  Weapon Mastery and Monk's grants light-weapon fighting. Anyone can reach a
  mastery; from a caster zone it costs a gate plus foreign ladder, which is the
  "higher connector cost" Task 2 asked for.

## 7. Per-zone notes

| zone | cf | scf | slots | conn | shared | notes |
|---|---|---|---|---|---|---|
| core | – | – | – | 13 | 14 | hub, origin feats, armor training |
| commons | – | – | – | – | 81 | general feats, epic boons, masteries, ASI chain |
| Barbarian | 26 | 22 | – | 24 | – | no casting; sparse at 15–18, normalized by ladder |
| Fighter | 27 | 33 | 4 | 28 | 20 | densest subclass content; EK third-caster spine; 20 maneuvers on the Barbarian seam |
| Paladin | 24 | 25 | 5 | 24 | 1 | half-caster spine; owns Blessed Warrior |
| Cleric | 22 | 24 | 9 | 20 | – | full spine |
| Druid | 23 | 27 | 9 | 24 | – | full spine |
| Ranger | 23 | 25 | 5 | 24 | 1 | half-caster spine; owns Druidic Warrior |
| Rogue | 32 | 28 | 4 | 24 | – | Arcane Trickster third-caster spine |
| Artificer | – | – | 5 | 8 | – | **pending official 2024 content** — see below |
| Wizard | 16 | 24 | 9 | 24 | – | fewest class features; ladder does the most work here |
| Sorcerer | 19 | 25 | 9 | 24 | 10 | 10 metamagic nodes on the Wizard seam |
| Warlock | 19 | 26 | 13 | 24 | 28 | Pact Magic chain; 28 invocations on the Sorcerer seam |
| Bard | 18 | 24 | 9 | 20 | – | full spine |
| Monk | 34 | 26 | – | 24 | – | most class features of any zone |

**Artificer — pending official 2024 content.** `classes_meta.json` lists it
(source EFA, hit die d8, half-caster) but the Work Order 1 extraction produced
zero Artificer features, because Artificer is not part of the 2024 core PHB. The
zone is built anyway — gate, ladder, half-caster spine — so the ring has all
thirteen zones and a character can start there and take the d8. `meta.zone_status`
in graph v2 labels it explicitly:

```json
"Artificer": {"extracted_nodes": 0, "state": "pending official 2024 content"}
```

It is an empty board awaiting content, not a broken extraction, and a test holds
that label in place.

## 8. What a path actually costs

Flat cost, plus the Task 2b exemption: connectors on **your own** zone's spine
are free to walk, everything else bills. That is the whole cost model, and it is
where the cross-zone premium comes from:

```
mean points to reach a notable node in your home zone:   1.0
mean points to reach a notable node in another zone:     5.12
```

A Wizard reaching their own level-18 capstone pays 1 point — the capstone. A
Wizard reaching Fighter's Extra Attack pays 4: the Fighter gate, two foreign
ladder rungs, and the feature.

**Confirmed in review.** Task 2b's own-zone exemption skips the connector toll,
not the destination node's own price. Slot spine nodes are payload, not filler —
they *are* the spell slots — so they are billed at 1 point each even at home.
That is why `slot_cleric_t9` costs a Cleric 9 rather than 1.

## 9. Reference edges are not pathing (resolved in review)

The Work Order 1 `edges.json` is a citation registry — "this feature's text
mentions that one" — not designed connectivity. Twenty-four of its edges join
two class zones directly (a Barbarian subclass feature to a Monk subclass
feature, for instance), which shortcut the depth ladder; under flat costing
depth is the only balance lever, so anything that bypasses it takes the lever
away.

They are kept in the graph, tagged `relation: "reference"` with
`traversable: false`, so a UI can still offer "see also" links. `PathEngine`
skips them when it builds its adjacency, and `validate` fails the build if one
ever comes back traversable. The full-graph hop counts are still reported in
`validation_report.json` for comparison.

Removing them from pathing is what moved the density numbers in §3, and it also
sharpened the cross-zone premium: cross-zone paths now cross nearly twice as
many connectors as same-zone ones, where before the wormholes had made the two
almost equal.

## 10. The chassis, and the proficiency audit that produced it

Review item 4 asked whether the class-decoupling gap that forced the armor
training connectors shows up anywhere else. `src/dnd2024/audit.py` checks it from
both sides and writes `data/output/proficiency_gap_audit.json`. It found one real
gap and one thin spot, and the follow-up work order closed both.

**Demand — clean.** The only proficiency prerequisites anywhere in the extraction
are armor ones (medium ×2, heavy, light, shield), and the training connectors
resolve all of them. No node in the graph is unbuyable for want of a proficiency.

**Supply — what the audit found.** Every RAW class grants two saving throw
proficiencies and at least simple weapons before play starts. Nothing in the tree
could sell either: the whole graph contained exactly one node granting a save
(Resilient) and none granting simple weapons. A character built purely from nodes
had no saving throw proficiencies at all — not a balance question, a correctness
one.

**The fix: extend the Task 2c chassis.** Hit die was already derived from the
starting zone and locked at creation. Saving throws and weapon proficiencies now
work identically — read from `classes_meta.json` for the zone the character
started in, fixed once, unchanged by pathing anywhere else afterwards. `meta.chassis_by_zone`
carries all three:

```json
"Monk": {
  "hit_die": {"number": 1, "faces": 8},
  "saving_throw_proficiencies": ["str", "dex"],
  "weapon_proficiencies": {
    "simple": true, "martial": false, "martial_subset": "Light",
    "summary": "Simple weapons, Martial weapons with the Light property"
  }
}
```

The martial subsets for Monk and Rogue are parsed out of the RAW filter strings
in `classes_meta`, so a Rogue start gets "Martial weapons with the Finesse or
Light property" rather than a flattened "martial". Nothing here is invented — it
is a lookup, and a test asserts every value matches `classes_meta` exactly.

**Where the line sits.** Armor deliberately stayed *purchasable* rather than
joining the chassis. Armor is a build choice the tree already sells from several
sources, and five extracted feats gate on it; saves and simple weapons are not
choices in RAW at all, they are what you start holding. Validation now fails the
build if any zone's chassis lacks a hit die, exactly two saves, or simple
weapons, and the audit re-runs on every build:

| category | verdict |
|---|---|
| Armor, shields | covered — 9 and 3 purchasable sources |
| Skills | covered — 64 sources |
| Tools | covered — 19 sources |
| Weapons | covered — chassis, all 13 zones; 4 tree nodes extend it |
| Saving throws | covered — chassis, all 13 zones; 1 tree node grants a further one |

Demand and supply both clean.
