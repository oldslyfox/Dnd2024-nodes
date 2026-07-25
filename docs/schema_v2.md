# graph v2 schema

`data/output/graph.v2.json` — `{meta, classes, nodes, edges}`.

## Node

Every node in the file carries all of these. Fields marked ★ are the ones the
acceptance criteria check.

| field | type | notes |
|---|---|---|
| `id` | string | stable; extracted nodes keep their Work Order 1 ids |
| `name` | string | |
| `type` | string | `class_feature`, `subclass_feature`, `feat`, `optional_feature`, `weapon_mastery`, `connector`, `spell_slot` |
| `role` | string | finer grain: `zone_ladder`, `subclass_ladder`, `gate`, `hub`, `core`, `training`, `commons`, `slot_spine`, `feat_general`, `feat_origin`, `feat_epic_boon`, `metamagic`, `eldritch_invocation`, `maneuver_battle_master`, … |
| ★ `zone` | string | one of the 13 class names, `core`, or `commons` |
| `subregion` | string\|null | subclass name, for nodes inside a sub-region |
| `boundary` | [string, string]\|null | the two zones a shared node sits between |
| ★ `depth` | number | 0–20; equals RAW level for extracted content |
| ★ `position_x`, `position_y` | number | cartesian, hub at the origin |
| `polar` | {angle_deg, radius} | the same position in polar form |
| ★ `point_cost` | int | always 1 (the hub is 0) |
| ★ `prereqs` | object | see below |
| `ability_prereqs` | list of {ability: score} | alternatives — satisfy any one |
| `prereq_notes` | list of string | conversions and deferrals, human-readable |
| `is_spine` | bool | connector on a zone's own spine — free to walk at home |
| `is_gate` | bool | zone gate node |
| `generated` | bool | true for invented content (connectors, slot spines, feat repeats) |
| `source_book` | string\|null | `XPHB`/`XDMG`/`EFA`; null for generated content |
| `effect_summary` | string | |
| `level` | int | extracted content only; **positioning metadata, not a runtime gate** |
| `repeat_index`, `repeat_chain` | int, string | repeatable feats |
| `caster_chassis`, `slot_tier` | string, int | `spell_slot` nodes (`full`/`half`/`third`/`pact`) — named to avoid confusion with `meta.chassis_by_zone`, which is the creation lock |

### `prereqs`

```json
{
  "logic": "AND" | "OR" | "THRESHOLD",
  "nodes": ["node_id", ...],
  "threshold_count": null | 14,
  "groups": [{"logic": "AND" | "OR", "nodes": ["node_id", ...]}]
}
```

- **AND** — own every id in `nodes`.
- **OR** — own at least one id in `nodes`.
- **THRESHOLD** — have spent at least `threshold_count` points in total, *and*
  satisfy the nodes. Every converted RAW level gate takes this form; the ratio
  is in `docs/point_economy.md`.
- **`groups`** — an addition to the three fields the work order specifies,
  because a few RAW prerequisites are genuinely an AND of ORs ("14 points spent
  AND medium armor training from any source"). When `groups` is present it is
  authoritative: satisfaction is AND across groups, each group resolved by its
  own logic. `nodes` is always the flattened union of every group, so a consumer
  that reads only `logic`/`nodes`/`threshold_count` still sees the full list.

Ability scores never appear in `prereqs` — they live in `ability_prereqs` and do
not participate in tree logic. Spell-knowledge prerequisites are deferred to
Phase 3 and appear only as `prereq_notes`.

Every node inside a class zone carries that zone's gate as an AND group. That is
what keeps the modular board loading honest (see the layout rationale, §2).

## Edge

```json
{"from": "node_id", "to": "node_id", "relation": "spine", "traversable": true}
```

Edges are undirected. `traversable: false` means the edge is metadata only —
`PathEngine` excludes it when building its adjacency, and `validate` errors if a
`reference` edge is ever marked traversable.

| relation | traversable | meaning |
|---|---|---|
| `gate` | yes | hub ↔ a zone gate |
| `spine` | yes | connector ladder links, sub-region links, slot spine links |
| `attach` | yes | a real node hanging off the rung at its depth |
| `overlap` | yes | a shared node wired into a second zone's ladder |
| `chain` | yes | repeatable feat chains, armor training chain |
| `reference` | **no** | the Work Order 1 citation registry, deduplicated — "this feature's text mentions that one". Kept for "see also" UI; excluded from pathing so cross-zone citations cannot shortcut the depth ladder |

## Meta

`meta.point_economy` is the whole derived economy (baseline per class, the
level → points curve, the level → threshold table).

`meta.chassis_by_zone` is the Task 2c lookup — everything the starting zone
fixes at character creation, read straight from `classes_meta.json` and locked
once. Pathing into other zones never changes it.

```json
"Rogue": {
  "hit_die": {"number": 1, "faces": 8},
  "saving_throw_proficiencies": ["dex", "int"],
  "weapon_proficiencies": {
    "simple": true,
    "martial": false,
    "martial_subset": "Finesse or Light",
    "summary": "Simple weapons, Martial weapons with the Finesse or Light property"
  }
}
```

Armor is **not** here: it stays purchasable in the tree (the training
connectors), because armor is a build choice several nodes sell and five feats
gate on, whereas saves and starting weapons are not choices in RAW at all.
`PathEngine` exposes the lock as `chassis(state)`, `hit_die(state)`,
`saving_throw_proficiencies(state)` and `weapon_proficiencies(state)`.
(`meta.hit_die_by_zone` from the first v2 cut is gone — `chassis_by_zone`
supersedes it.)

`meta.zone_status` marks zones that are structurally complete but hold no book
content, so an empty board is never mistaken for a broken extraction:

```json
"Artificer": {"extracted_nodes": 0, "state": "pending official 2024 content"}
```

## Other output files

| file | contents |
|---|---|
| `nodes_connectors.json` | the generated connectors and gates, same schema, `type: "connector"` |
| `nodes_spell_slots.json` | the generated slot spines and the Warlock Pact Magic chain |
| `point_economy.json` | the economy, standalone |
| `balance_flags.json` | Task 6 guardrails, plus `resolved_in_review` for decisions already taken |
| `proficiency_gap_audit.json` | which proficiencies a class used to grant free that the tree cannot sell |
| `validation_report.json` | acceptance checks and the layout measurements |
