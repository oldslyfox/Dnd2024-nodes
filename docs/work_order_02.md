# Work Order 2 — Point Economy, Prereq Normalization & Pathing Cost Engine

**Scope:** D&D 2024 (XPHB/XDMG) only. Input = `graph.json` from Work Order 1
(735 nodes: class_feature, subclass_feature, feat, optional_feature, weapon_mastery).

**Locked design decisions (do not relitigate):**
1. Node unlocking is gated by Points + Prerequisites only. Character Level is decoupled —
   it exists solely to grant Points on a curve, and to drive chassis stats (HP, proficiency
   bonus) which are OUT OF SCOPE for this work order.
2. Point budget is "generous": target ~1.5–2x the number of meaningful build choices RAW
   offers over a 20-level career. Compute the RAW baseline from `graph.json` counts
   (class features + feat/ASI slots per class table) rather than guessing a flat number.
3. Pathing is fully free but must be paid for via connectivity: a node is purchasable only
   if there exists a path of already-owned nodes back to the player's starting zone.
   Distance cost = sum of point costs of every node on that path, not a flat multiplier.

**Implementation latitude:** the numbered tasks below are the default, fallback path —
follow them exactly if no better approach presents itself. But Claude Code has explicit
liberty to adapt *how* any task is executed (algorithms, data structures, generation order,
tooling) if it finds a cleaner, simpler, or lighter way to reach the same end state defined
by the Acceptance Criteria. This liberty covers **implementation only** — it does not
extend to the three Locked design decisions above, or to the specific design calls baked
into each task (flat cost of 1, connectivity-based distance, the Warlock two-track
exception, level-derived depth, hit die locked to starting zone, etc.). Those were reached
through explicit back-and-forth and are not open for Code to silently reinterpret. If a
locked decision looks wrong once implementation starts, flag it back rather than deviating
around it.

---

## Task 1 — Generate connector nodes
Real book content (735 nodes) is all "notable"-tier — there is no cheap filler to path
through, unlike PoE's small stat nodes. Generate a new node type `connector` to fill this
role:
- Small numeric/flavor bonuses only (skill proficiency, +1 to a single check type, minor
  resistance, cantrip-equivalent utility) — invented content, not copied from any book.
- Target density: enough connectors that the average path between two same-zone notable
  nodes crosses 2–4 connectors, and cross-zone paths cross meaningfully more.
- Cost: fixed low cost (e.g. 1 point flat) — these exist to be walked through, not agonized
  over.
- Output as `nodes_connectors.json`, same schema as other node files, `type: "connector"`.

## Task 2 — Zone / coredom layout
- One zone per class (13), positioned as a ring or hub-and-spoke around a small **shared
  core** containing universally-relevant nodes (if any exist in the data — otherwise the
  core can be purely connector nodes as the literal shared starting point).
- Each class zone's own `class_feature`/`subclass_feature` nodes anchor that zone;
  `feat` and `optional_feature` nodes should sit at natural overlap points between the
  zones whose classes reference them (e.g. Metamagic nodes near Sorcerer/Wizard boundary).
- Weapon mastery nodes: place near martial zones (Fighter/Ranger/Paladin/Barbarian),
  reachable by anyone at higher connector cost.
- Output: add `zone`, `position_x`, `position_y` (or graph-relative coordinates — your
  call on layout algorithm, e.g. force-directed) to every node.
- **Modular loading (Diablo 4 Paragon-style):** each zone is its own board/module. A zone's
  interior nodes only need to be loaded/rendered client-side once the player has purchased
  the **gate node** at that zone's boundary. The underlying `graph.json` stays one fully
  connected structure — this is a rendering/loading strategy for the UI layer, not a change
  to the data model. Gate nodes sit at zone perimeters (analogous to Diablo 4's Board
  Attachment Gates) and are themselves purchasable connector-tier nodes.

## Task 2b — Spell slot spines
- For each of the 5 full-caster classes (Wizard, Cleric, Druid, Bard, Sorcerer): generate a
  linear spine of 9 nodes (Cantrips/1st slot through 9th slot) running from that zone's
  edge (near the shared core) outward to its rim. Higher tiers = further from center.
- Half-casters (Paladin, Ranger, Artificer): same pattern, capped at a 5-node spine (up to
  5th-level slots).
- Third-casters (Eldritch Knight, Arcane Trickster subclass nodes): capped at a 4-node
  spine, positioned within their subclass's sub-region of the Fighter/Rogue zone.
- Warlock: do NOT reuse the slot-count spine model — Pact Magic scales by slot *level* and
  short-rest recovery, not slot count. Model as its own distinct node chain (flag for
  design review if the shape isn't obvious from the data).
- **Connector cost rule:** moving along a caster's own slot spine, or along any class's own
  core feature chain, within that class's zone, does NOT incur connector/filler cost —
  these are that zone's main spine, not "straying." Connector cost only applies (a) when
  crossing a zone's gate node from outside, or (b) pathing between two unrelated zones.
  Implement this as a zone-membership check in the pathing cost engine (Task 5), not a
  blanket per-node toll.

## Task 2c — Hit die resolution
Hit die is chassis (HP), explicitly out of the point-spend tree — but in a free-build system
"which class am I" no longer exists by default, so it needs an anchor:
- A character's hit die is fixed by whichever **zone they start in** (the zone adjacent to
  the hub they begin allocating from), looked up directly from `hit_die` in
  `classes_meta.json` — no new node type needed.
- This is a one-time lock at character creation, same as RAW already treats hit die as
  fixed to your original class even after multiclassing into others. Pathing into other
  zones later does not change it.

## Task 2d — Depth-from-level mapping (the actual layout algorithm)
Positional depth (distance from hub) is **derived from RAW character level**, not hand-
placed. This is the concrete rule Task 2's "power-proportional depth" and Task 4's
depth-driven balancing both depend on:

- **Class/subclass features:** depth = a function of the `level` field already present on
  every extracted node (e.g. depth_units = level). Level 1 features sit near the hub/zone
  entrance, level 20 capstones sit at the zone's outer rim.
- **Spell slot spines (Task 2b):** already follows this rule by construction — cantrip/1st
  slot near center, 9th slot at the rim. No change needed, just confirms the same principle.
- **Feats without an intrinsic level** (General, Origin): derive depth from the **earliest
  level at which any class can normally access that feat category** — Origin feats (granted
  at character creation via background) sit near the hub; General feats (typically first
  available around level 4, earlier for Fighter/Rogue) sit a bit further out; Epic Boons
  (level 19 requirement) sit at the extreme rim, deepest nodes in the graph.
- **Connector normalization:** different zones have uneven real-node density per level (a
  class with 4 features at level 5-10 vs. one with 1). Use connector node count/spacing
  between real nodes to even out the depth scale, so "level 10" lands at roughly the same
  graph-distance from hub across every zone, regardless of how sparse or dense that zone's
  real content is at that level. This is the actual purpose connectors serve beyond pathing
  cost — they're the normalization mechanism, not just filler.

**Important — do not reintroduce level as a runtime gate.** This mapping is used once, at
graph-generation time, to decide node *position*. It must not leak into the pathing/cost
engine (Task 5) as an actual prerequisite check — the only real gates at runtime are
points spent + connectivity, per the earlier locked decision. `level` becomes purely
historical/positioning metadata on the node once layout is generated.

## Task 3 — Normalize prerequisites
Current `prereqs_raw` / `prerequisite` fields are un-normalized source data. Convert to:
```json
"prereqs": {
  "logic": "AND | OR | THRESHOLD",
  "nodes": ["node_id", ...],
  "threshold_count": null
}
```
- Level-based RAW prereqs (e.g. "requires character level 4") convert to a **point-spend
  threshold** instead ("must have spent N points total" or "must own N nodes in this zone")
  — pick one convention and apply consistently, document the mapping ratio used.
- Ability score prereqs stay as a separate `ability_prereqs` field (unaffected by tree
  logic).

## Task 4 — Point costs: flat, not tiered
Every node (feature, feat, connector, gate, mastery, slot-track node) costs a flat **1
point**. No tiered pricing by node type or power level.

This is a deliberate choice, not a placeholder: balancing power happens entirely through
**positional depth** (Task 2 layout), not price tags. A node's "cost" is the sum of every
node you must own along the path to reach it — the same mechanic Path of Exile and Diablo 4
Paragon both use. This means:
- **Layout constraint (binds Task 2):** place nodes at a distance-from-hub roughly
  proportional to their actual power, not just their thematic zone position. An Epic Boon
  must sit meaningfully deeper than a General feat, even within the same zone — depth is
  now the only balancing lever, so it has to be used deliberately, not just for thematic
  layout.
- **Repeatable nodes** (e.g. ASI, which RAW allows taking multiple times): model as a short
  repeatable chain (ASI-1 → ASI-2 → ASI-3...) rather than a single infinitely-purchasable
  node, so each repeat still costs a real point and sits at increasing depth like
  everything else.
- Drop `cost_methodology.md` as a deliverable — replace with a short
  `layout_depth_rationale.md` explaining the depth-placement logic per zone instead, since
  that's now where the actual balance reasoning lives.

## Task 5 — Pathing cost engine (implementation, not just data)
Write a function `can_afford(player_state, target_node_id) -> {affordable, path, total_cost}`
that:
- Finds shortest point-cost path from any currently-owned node to the target using the
  `edges.json` + new connector edges as the graph.
- Returns the full path (so the UI can show "you'll also allocate these N connectors").
- This is the core mechanic the tree-visualizer UI will call on every hover/click — needs
  to be fast enough for interactive use (memoize/cache as needed).

## Task 6 — Guardrails (flag, don't auto-solve)
Produce a `balance_flags.json` list of node combinations that look like known D&D power
issues if freely reachable (e.g. Extra Attack stacking, multiple full-caster slot
progressions, heavy armor + high burst mobility). Don't hardcode fixes — just surface them
for a manual review pass before Phase 3 (spellcasting economy) begins.

---

## Acceptance criteria
- `graph.json` v2 validates: every node has zone, position, depth, normalized prereqs,
  non-null point_cost.
- `can_afford()` returns correct paths on at least 5 manually-checked test cases spanning
  same-zone and cross-zone targets.
- `layout_depth_rationale.md` and `balance_flags.json` are reviewable by a human, not
  opaque.
- No 2014 (classic) content anywhere in output.
