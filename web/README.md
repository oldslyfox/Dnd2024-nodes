# Visual tree renderer — Work Order 3

A static, client-side renderer for the Work Order 2 skill tree. No backend, no
runtime fetch to anything external: `npm run build` produces a single
`dist/index.html` with the graph, the JS and the CSS inlined, and it runs from
`file://` with **zero network requests** (asserted by a test).

```bash
npm install
npm run sync-data   # copy ../data/output/*.json into public/data
npm run build       # -> dist/index.html (1.7 MB, self-contained)
npm test            # 49 tests: engine cross-validation, core, end-to-end UI
npm run bench       # Playwright FPS measurement -> bench/bench_results.json
npm run serve       # optional dev server for the unbundled source
```

## Architecture

The locked decision that shapes everything: core logic is framework-agnostic and
importable on its own, so a Foundry VTT module can reuse it without a rewrite.

```
src/core/     no DOM, no framework, no browser globals
  engine.js      PathEngine - port of src/dnd2024/pathing.py
  prereqs.js     prerequisite evaluation, port of src/dnd2024/prereqs.py
  character.js   allocate / deallocate / respec / summary
  graph.js       GraphIndex - bounds, spatial buckets, search
  storage.js     named builds over an injected storage backend
  index.js       the public surface

src/app/      the web shell - the only part that knows what a canvas is
  main.js        wiring, interaction, panels
  renderer.js    Canvas 2D drawing, culling, level of detail
  camera.js      pan/zoom
  labels.js      zone label placement and collision resolution
  style.js       colour-by-zone, shape-by-type
  data.js        build-time asset loading
```

`tests/core.test.mjs` enforces the boundary mechanically: it scans every file in
`src/core` and fails if any of them mentions `document`, `window`,
`localStorage`, `navigator`, an `HTMLCanvas*` type, or imports from `../app/`.
Storage is injected (`new BuildStore(localStorage)` in the browser, a Map-backed
stub in tests), so persistence never reaches for a global.

**For the future Foundry module:** import `src/core/index.js`, pass it the parsed
`graph.v2.json`, and hand `BuildStore` an adapter over Foundry's settings API.
Nothing else in core needs to change.

## The engine port is verified, not assumed

Logic drift between the Python and JS engines would be silent and dangerous, so
it is checked against generated fixtures rather than hand-written expectations.
`scripts/export_engine_fixtures.py` (in the repo root) runs the **Python** engine
and records its answers; `tests/engine.test.mjs` replays them:

| fixture | count | what it catches |
|---|---|---|
| named cases | 10 | the hand-traced cases from `tests/test_pathing.py` |
| sweep | 2,340 | every zone as a home zone × a spread of targets across all types |
| allocation traces | 4 builds | state evolution and cache invalidation |
| chassis | 13 zones | hit die, saves, weapons |

All of it matches exactly, including path node ordering — the JS heap breaks
ties on `(cost, node id)` the same way Python's `heapq` does on tuples, which is
what makes the paths byte-identical rather than merely equal-cost.

Regenerate after any change to `graph.v2.json`:

```bash
python3 scripts/export_engine_fixtures.py && (cd web && npm run sync-data && npm test)
```

## What you see

**Colour is zone, shape is type** — procedural coding only. Pictorial icons were
explicitly out of scope for this work order.

| shape | type | | shape | type |
|---|---|---|---|---|
| circle | class feature | | square | spell slots |
| diamond | subclass feature | | 8-point star | weapon mastery |
| hexagon | feat | | octagon | zone gate |
| triangle | optional feature | | small dot | connector |

**Four allocation states**, all one hue at different strengths: owned (full, white
outline), affordable now, reachable but too expensive, prerequisites unmet.

**The whole graph is always present.** Gates are cost mechanics, not fog of war —
nothing is hidden at any zoom. Level of detail changes what is *legible*: zone
wedges when far out, plain shapes at mid zoom, full shapes plus labels close in.

**Reference edges** (the 24 cross-zone "see also" citations from Work Order 1,
268 in total) render only behind the toggle, dashed, and never as a path. A test
asserts they stay out of the pathing adjacency even while the overlay is on.

**Labels.** Zone labels anchor on the zone's angular centre and its own outer rim,
clamp inside a safe rect so rim zones are not clipped by the panels, and run a
separation pass along the ring — this is the fix for the Rogue/Artificer/Wizard
crowding flagged in Work Order 2's review. They fade out above zoom 10 as node
labels take over. Node labels are placed greedily against an occupancy grid,
ranked hovered → search hit → owned → real content → connector, so they never
pile up into mush.

## Interaction

| action | result |
|---|---|
| hover | tooltip with name, effect, cost, and the path highlighted on canvas |
| click | allocate the node and everything on the cheapest path |
| alt-click an owned node | refund it, if nothing depends on it |
| drag / wheel | pan / zoom about the cursor |
| `/` | focus search; `Esc` clears it |
| Respec | full reset to a fresh character in the same starting zone |
| Save / Load | named builds in `localStorage` |

**Deallocate was in scope for this pass**, not deferred. It is deliberately
conservative: a node can only be refunded if removing it leaves every other owned
node still connected to the hub *and* still satisfying its prerequisites
(including point thresholds, which drop when the refund lands). So a leaf comes
back, but the gate holding up your whole excursion does not.

## Performance (Task 8)

Measured by `npm run bench`, driving the built page in headless Chromium at
1600×950 with a scripted camera, timing the renderer's own frames. Full results
in `bench/bench_results.json`.

| motion | mean | p95 | mean fps |
|---|---|---|---|
| pan at readable zoom | 2.66 ms | 3.2 ms | 376 |
| pan at mid zoom | 1.99 ms | 2.5 ms | 501 |
| zoom sweep, whole graph → one zone | 1.81 ms | 3.4 ms | 552 |
| pan with the "see also" overlay on | 1.89 ms | 2.7 ms | 529 |
| worst case: all 1,133 nodes in view | 2.17 ms | 2.7 ms | 461 |
| worst case + overlay + labels | 2.71 ms | 3.7 ms | 369 |

Every motion sits comfortably inside the 16.7 ms frame budget with roughly 5×
headroom, including the worst case where culling saves nothing. **Canvas 2D is
sufficient; there is no case for escalating to WebGL** at this node count.

The two things that keep it there: viewport culling via spatial buckets, and
caching. Reachability is recomputed only when the character state version
changes (not per frame), text widths are memoised, and node draws are batched by
fill colour.

## Screenshots

`bench/shots/` — regenerate with `node bench/screenshot.mjs`.

## Known and deferred

- **Pictorial icons** are out of scope by instruction: they need a licensed glyph
  set and a populated `tags` field, which Work Order 1/2 deferred.
- **The commons rings.** Shared content (general feats, fighting styles, epic
  boons, ASI repeats) fans along the arc at its depth, which reads as concentric
  rings near the hub. That is the Work Order 2 layout being displayed faithfully,
  not a rendering artefact — worth a look if the layout is ever revisited.
