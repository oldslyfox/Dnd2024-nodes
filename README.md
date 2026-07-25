# D&D 2024 skill-tree — Work Order 2

Point economy, prerequisite normalization, zone layout and the pathing cost
engine, built on the 735-node Work Order 1 extraction. Scope is D&D 2024
(XPHB/XDMG) only; there is no 2014 content anywhere in the output, and a test
asserts it.

## Run it

```bash
python3 scripts/build_all.py       # build -> validate -> flag, writes data/output
python3 -m pytest                  # 47 tests, incl. the hand-checked path cases
python3 scripts/render_preview.py  # optional: an SVG of the layout, for eyeballing
```

Current output:

```
graph v2: 1133 nodes, 1701 edges
  class_feature 283   subclass_feature 309   connector 305
  spell_slot 81       feat 89                optional_feature 58   weapon_mastery 8
validation: PASS
```

## What is in here

| path | |
|---|---|
| `data/input/` | the Work Order 1 extraction, unmodified |
| `data/output/graph.v2.json` | the deliverable |
| `data/output/nodes_connectors.json` | Task 1 — generated connector and gate nodes |
| `data/output/nodes_spell_slots.json` | Task 2b — slot spines and the Warlock chain |
| `data/output/point_economy.json` | the derived budget and level → points curve |
| `data/output/balance_flags.json` | Task 6 — flagged, not fixed, plus what review resolved |
| `data/output/proficiency_gap_audit.json` | the review's item 4 follow-up |
| `data/output/validation_report.json` | acceptance checks plus layout measurements |
| `data/output/layout_preview.svg` | a review aid — the whole tree, hover for node names |
| `docs/layout_depth_rationale.md` | **the design document** — replaces `cost_methodology.md` per Task 4 |
| `docs/point_economy.md` | RAW baseline, budget, and the level → points-spent mapping |
| `docs/schema_v2.md` | node/edge schema |
| `docs/work_order_02.md` | the work order this implements |
| `src/dnd2024/` | the generator, the pathing engine, the validator |

## The model in one page

**Nothing is gated by level.** Level exists to hand out points on a curve, and
it decided where nodes sit when the graph was generated. At runtime the only
gates are points spent, connectivity, and normalized prerequisites.

**Everything costs 1 point.** Balance is positional: a node's real cost is the
sum of every node you must own along the path to it. Epic boons are expensive
because they are on the rim, not because they are priced.

**Distance is paid for by connectivity.** A node is purchasable only if a path
of owned nodes reaches back to where you started. Your own zone's connector
spine is free to walk; everything else bills. Measured: reaching a notable node
at home costs 1 point on average, abroad 5.12.

**Depth is normalized.** Each of the 13 zones carries an identical connector
ladder, so "level 10" is the same graph distance from the hub in every zone
regardless of how sparse that zone's real content is. Measured: 5 hops, all
thirteen.

**Budget.** RAW offers a mean of 33.3 meaningful build choices over 20 levels
(computed per class from the extraction). At 1.75× that is **58 points** at
level 20.

## Using the pathing engine

```python
from dnd2024.pathing import PathEngine

engine = PathEngine.load()                       # data/output/graph.v2.json
state  = engine.start_state("Wizard", 58)        # home zone fixes the hit die

engine.can_afford(state, "cf_fighter_extra_attack_5")
# {'affordable': True, 'total_cost': 4,
#  'path': ['conn_core_hub', 'gate_fighter', 'conn_fighter_rung_1',
#           'conn_fighter_rung_4', 'cf_fighter_extra_attack_5'],
#  'new_nodes': [...], 'points_remaining_after': 54, ...}

engine.allocate(state, "cf_fighter_extra_attack_5")   # buys the whole path
engine.hit_die(state)                                 # {'number': 1, 'faces': 6}
```

`path` is the full route so the UI can show "you'll also allocate these N
connectors". One multi-source Dijkstra serves the whole board and is cached
against the player state, so hovering a thousand nodes costs one search — a
test holds 1000 cached queries under a second (it runs in ~0.02s).

When a node is blocked, `reason` is `unmet_prerequisites` /
`insufficient_points` / `unreachable`, and `blocking_prereqs` says what in plain
language: `"needs 36 points spent (has 13)"`, `"needs: of_thirsting_blade_xphb"`.

## Settled in review

Recorded in `balance_flags.json` under `resolved_in_review`:

1. **Cross-zone reference shortcuts** — the 24 edges from the extraction that
   joined two class zones are now `relation: "reference"`, `traversable: false`.
   They stay in the data for "see also" UI; the pathing engine skips them, and
   validation fails the build if one becomes traversable again. Removing them
   also sharpened the layout: cross-zone paths now cross 6.6 connectors against
   3.7 at home, where before the wormholes had made the two nearly equal. The
   ladder was retuned from a rung every two levels to every three as a result.
2. **Slot spines cost points at home** — correct as implemented; the own-zone
   exemption skips the connector toll, not the destination's own price.
3. **Warlock short-rest recovery** — out of scope; character-state tracking, not
   tree structure.
4. **Invented armor training / drill ground connectors** — approved, with an
   audit of whether the same gap appears elsewhere (below).

**Artificer** stays a shell zone (gate, ladder, half-caster spine) and is now
labelled in `meta.zone_status` as `"pending official 2024 content"` — not a
broken extraction. A test holds that label.

## Still open, not blocking

- **The nine balance flags**, each with a measured cost as a share of the
  58-point career budget: Extra Attack stacking 41%, expertise pile 43%, two
  full-caster spines 34%, two capstones 34%. First item for a balance-tuning
  pass.
- **The proficiency gap** (`data/output/proficiency_gap_audit.json`). No
  prerequisite in the data is unsatisfiable, but two things a RAW class hands
  over free have no home in the tree: **saving throw proficiencies** (all 13
  classes grant two; the tree has one node that grants one — Resilient) and
  **simple weapon proficiency**. Saves look like chassis in the same sense hit
  die is, and `classes_meta` already carries them per class, so the natural fix
  mirrors the Task 2c hit die rule. Not applied — future systemic pass.
- **`layout_preview.svg` label crowding** around Rogue/Artificer/Wizard.
  Cosmetic; for whenever the real renderer work order starts.
