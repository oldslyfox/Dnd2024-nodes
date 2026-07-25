# Visual tree renderer — Work Orders 3 & 4

A static, client-side renderer for the Work Order 2 skill tree, responsive from
desktop down to a phone. No backend, no runtime fetch to anything external:
`npm run build` produces a single `dist/index.html` with the graph, the JS and
the CSS inlined, and it runs from `file://` with **zero network requests**
(asserted by a test).

```bash
npm install
npm run sync-data     # copy ../data/output/*.json into public/data
npm run build         # -> dist/index.html (1.7 MB, self-contained)
npm test              # 66 tests: engine cross-validation, core, desktop + touch UI
npm run bench         # desktop FPS  -> bench/bench_results.json
npm run bench:mobile  # phone FPS + touch latency -> bench/bench_results_mobile.json
npm run shots         # regenerate bench/shots/
npm run serve         # optional dev server for the unbundled source
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
  main.js        wiring, selection, panels and sheets
  renderer.js    Canvas 2D drawing, culling, level of detail
  camera.js      pan/zoom
  input.js       unified pointer/touch gestures (pan, pinch, tap)
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

## Interaction: select, then confirm

One primitive on both input types (Work Order 4, decision 2). A tap or a click
**selects** a node - it never spends points. Selecting fills the detail panel
(name, effect, cost, the path it would buy) and highlights that path on canvas;
allocation happens through an explicit button. On a phone that is the difference
between a build and a mis-tap; on a desktop it is the same code, so there is only
one behaviour to reason about.

| action | result |
|---|---|
| tap / click a node | select it - detail panel opens, path previews, nothing is spent |
| **Allocate** | buy the node and everything on the cheapest path |
| **Deallocate** | refund the node, enabled only when it is refundable |
| one-finger drag / mouse drag | pan |
| pinch / wheel | zoom about the gesture midpoint or cursor |
| tab bar (phone) | Character · Search · Node · Hide |
| `/` | focus search; `Esc` clears search, then closes the sheet, then clears the selection |
| Respec | full reset to a fresh character in the same starting zone |
| Save / Load | named builds in `localStorage` |

A drag that happens to end on a node does not select it (12px of slop, then it is
a pan), and a pinch never selects whatever was under a finger. Both are tested.

**Deallocate was in scope for Work Order 3's pass**, not deferred. It is
deliberately conservative: a node can only be refunded if removing it leaves
every other owned node still connected to the hub *and* still satisfying its
prerequisites (including point thresholds, which drop when the refund lands). So
a leaf comes back, but the gate holding up your whole excursion does not.

## Responsive layout

One codebase, one stylesheet, one `dist/index.html` - the layout adapts, it does
not fork (Work Order 4, decision 1).

The compact breakpoint is `max-width: 760px` **or** `max-height: 560px`. Height
matters: a phone in landscape is 915x412, wider than any width-only breakpoint
would catch and with no room for side panels at all. Below it:

- the three panels become bottom sheets driven by a tab bar, so the canvas keeps
  the entire viewport and panels only overlay it on demand;
- the desktop toolbar collapses to a points pill, with its controls moved into
  the Character sheet;
- every control in a sheet is at least 44px tall;
- the detail sheet is a flex column - body scrolls, action buttons pinned - so
  Allocate is always reachable without scrolling;
- `touch-action: none` on the canvas stops the browser claiming pan and pinch
  before the app sees them, and safe-area insets keep content clear of notches.

**Tap targets** (Task 4) are decoupled from drawn size: the hit radius is the
larger of the node's own radius and a fixed screen target - 26px for touch, 14px
for a mouse - converted into world units. Notable nodes outrank connectors when
both are in range, so a fat tap near a feature does not select the filler beside
it. A test measures the reach on the most isolated node in the graph and asserts
touch beats mouse.

**Legibility** (Task 5) scales with the device pixel ratio rather than assuming
one: everything is drawn in device pixels, so a 12px font on a 3x screen is 4 CSS
px. The floor is `13 * dpr` on compact screens, `11 * dpr` otherwise, and node
radii get a level-of-detail boost on phones so shapes stay distinguishable.

## Performance

### Desktop (`npm run bench`)

Headless Chromium at 1600×950, scripted camera, timing the renderer's own frames.

| motion | mean | p95 |
|---|---|---|
| pan at readable zoom | 1.60 ms | 2.0 ms |
| pan at mid zoom | 0.18 ms | 0.3 ms |
| zoom sweep, whole graph → one zone | 1.11 ms | 3.0 ms |
| pan with the "see also" overlay on | 1.25 ms | 1.9 ms |
| worst case: all 1,133 nodes in view | 0.31 ms | 0.4 ms |
| worst case + overlay + labels | 1.08 ms | 1.7 ms |

### Phone (`npm run bench:mobile`)

Real touch events through CDP - including two-finger pinch - at phone viewports,
in both orientations, with the **CPU throttled 4×**, which is roughly a low-end
Android against this machine. Touch-to-frame is measured from the pointer event
arriving to that frame finishing, because on touch it is latency, not framerate,
that makes a drag feel attached to your finger.

| motion (portrait / landscape) | frame p95 | touch→frame p95 |
|---|---|---|
| one-finger pan | 3.6 / 4.6 ms | 4.4 / 5.8 ms |
| two-finger pinch zoom | 10.2 / 11.9 ms | 11.2 / 12.0 ms |
| pan with the whole graph in view | 3.0 / 2.9 ms | 3.1 / 3.1 ms |
| pan with the "see also" overlay on | 3.6 / 3.0 ms | 3.0 / 3.6 ms |

Every motion holds 60fps on a 4×-throttled phone in both orientations. **Canvas
2D remains sufficient; no case for WebGL.**

### How it got there

The first honest phone measurement was **20 ms mean, 41 ms p95** - a clear miss.
Profiling the draw phases (rather than guessing) put 37 ms of a 42 ms frame in
one place: node drawing, at one `fill()` per node for ~940 nodes. Three changes,
each measured:

1. **Batch shapes into one `Path2D` per (colour, state)** - 32 fills instead of
   1,800 fills and strokes. 37 ms → 17 ms.
2. **Skip outlines that are sub-pixel anyway** - full outlines close in, and only
   owned nodes further out, where their white ring is load-bearing. 17 ms → 10 ms.
3. **Build geometry in world space and pan with a canvas transform** - a drag is
   a transform change, not a rebuild of a few thousand sub-paths. The node radius
   was made genuinely zoom-independent (the "don't let nodes become specks" floor
   moved into the level-of-detail step, which is already part of the cache key),
   so a pinch does not invalidate the cache either. 10 ms → 2 ms.

Also: reachability is recomputed only when the character state changes, node
allocation states and text widths are memoised, edges carry precomputed endpoint
coordinates, and the device pixel ratio is capped at 1.5 on phones - a dark
canvas of flat shapes does not need 3× supersampling.

## Screenshots

`bench/shots/` — regenerate with `npm run shots`. Desktop shots are `02`/`04`;
phone shots are `10`–`14`, including landscape.

## Known and deferred

- **Pictorial icons** are out of scope by instruction: they need a licensed glyph
  set and a populated `tags` field, which Work Order 1/2 deferred.
- **Hover** on desktop now only highlights the node under the cursor; the tooltip
  it used to open is gone, because the detail panel replaced it. That is the
  select-then-confirm model applying uniformly, as Work Order 4 Task 3 asked.
- **The commons rings.** Shared content (general feats, fighting styles, epic
  boons, ASI repeats) fans along the arc at its depth, which reads as concentric
  rings near the hub. That is the Work Order 2 layout being displayed faithfully,
  not a rendering artefact — worth a look if the layout is ever revisited.
