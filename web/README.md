# Visual tree renderer — Work Orders 3–6

A static, client-side renderer for the Work Order 2 skill tree, responsive from
desktop down to a phone, with a readable character sheet and standalone export. No backend, no runtime fetch to anything external:
`npm run build` produces a single `dist/index.html` with the graph, the JS and
the CSS inlined, and it runs from `file://` with **zero network requests**
(asserted by a test).

```bash
npm install
npm run sync-data     # copy ../data/output/*.json into public/data
npm run build         # -> dist/index.html (1.7 MB, self-contained)
npm test              # 81 tests: engine cross-validation, core, sheet, desktop + touch UI
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
  sheet.js       the character sheet, and its Markdown / JSON exports
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
outline), affordable now, reachable but too expensive, prerequisites unmet. Work
Order 6 widened the gaps between them after a playtest found them correct but too
subtle to read while playing: owned keeps its full hue behind a thick white ring
and a halo, owned edges are drawn twice (a soft wide underlay plus a bright core
line) so the route you have walked reads as a lit path, and the two states you
cannot act on drop back to 0.5 and 0.22 alpha.

**The frontier pulses.** Every node you could buy *next* - affordable, and one
step out from something you own - carries a slowly breathing ring. That is the
answer to "where can I go from here" without tracing edges by eye. Filler
connectors are excluded (allocating anything buys the whole path to it, so a
pulsing rung would be pointing at plumbing); zone gates are not, because entering
a new zone is a real choice. The pulse runs at ~25fps, only while a frontier
exists and the tab is visible, and holds still under `prefers-reduced-motion`.

**The whole graph is always present.** Gates are cost mechanics, not fog of war —
nothing is hidden at any zoom. Level of detail changes what is *legible*: zone
wedges when far out, plain shapes at mid zoom, full shapes plus labels close in.

**Zoom goes as far as you need.** The maximum zoom used to be capped at 40×,
which was an arbitrary number rather than a performance limit — inspecting a
crowded ring ran out of magnification before it ran out of detail. The cap is now
derived from the fit scale (`max(fitScale * 90, 120)`, currently ~400×), and the
LOD thresholds are derived from it too rather than being absolute constants, so
they survive the layout's world size changing. Fit view is deliberately *mid*
detail — edges and connectors visible — not the sparse *far* view.

**Reference edges** (the 24 cross-zone "see also" citations from Work Order 1,
268 in total) render only behind the toggle, dashed, and never as a path. A test
asserts they stay out of the pathing adjacency even while the overlay is on.

**Labels.** Zone labels anchor on the zone's angular centre and its own outer rim,
clamp inside a safe rect so rim zones are not clipped by the panels, and run a
separation pass along the ring — this is the fix for the Rogue/Artificer/Wizard
crowding flagged in Work Order 2's review. They fade out above zoom 10 as node
labels take over — above `lodNear * 1.25` they are gone entirely, fading from
`lodNear * 0.95`, so on a phone they never compete with the node labels. Node
labels are placed greedily against an occupancy grid, ranked hovered → search hit
→ owned → real content → connector, so they never pile up into mush.

**Node spacing.** Work Order 5 rebuilt the layout around a guaranteed minimum
separation of 1.8 world units (2.9 in the commons) after playtesting found nodes
sitting effectively on top of each other — the closest pair was 0.001 apart. Node
radii are sized as a fraction of that minimum, so shapes stay visibly separate
however the layout scales. Shared content is split into per-category sub-rings
rather than sharing one crowded circle per depth. See
`docs/layout_depth_rationale.md` §11; four tests in `tests/core.test.mjs` hold
the separation, pickability, sub-ring and depth-ordering guarantees permanently.

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
| search (either surface) | typing jumps to and **selects** the best match; the result list selects directly |
| Respec | full reset to a fresh character in the same starting zone |
| Save / Load | named builds in `localStorage` |

A drag that happens to end on a node does not select it (12px of slop, then it is
a pan), and a pinch never selects whatever was under a finger. Both are tested.

**Deallocate was in scope for Work Order 3's pass**, not deferred. It is
deliberately conservative: a node can only be refunded if removing it leaves
every other owned node still connected to the hub *and* still satisfying its
prerequisites (including point thresholds, which drop when the refund lands). So
a leaf comes back, but the gate holding up your whole excursion does not.

## The character sheet, and export

The Character panel is the build read back to you: an "at a glance" block, then
every owned real node grouped by where it came from.

**Grouping is by zone, with shared content grouped by what it is.** A build's
story is which classes it dipped, so class content groups by zone with the
starting zone first; a general feat has no class to belong to, so feats,
masteries, fighting styles and epic boons group by category instead. Connectors
and gates are counted but not listed - they are plumbing, and the gates show up
as the "Zones entered" line instead.

**Aggregates are derived, not invented.** Spellcasting comes from the `slot_tier`
and `caster_chassis` on the slot-spine nodes actually owned, subclasses from
`subclass`, masteries and fighting styles from `type`/`role`. The chassis (hit
die, saves, weapons) is the same `engine.chassis()` derivation as everywhere else.

**Two exports, no server** - a Blob and an object URL, consistent with a page
that runs from `file://`:

| | |
|---|---|
| **Copy sheet** | the Markdown sheet on the clipboard, with a hidden-textarea fallback for `file://` pages where the async clipboard API is unavailable |
| **.md** | the same sheet as a download, including each node's effect text so it is readable with no renderer at all |
| **.json** | the raw owned-node id list, in exactly the shape `PlayerState.toJSON()` produces, so it loads straight back into the app — honest groundwork for a future Foundry import without being one |

The panel and both exports render from the same `buildSheet()` structure in
`src/core/sheet.js`, so what you read on screen and what you export cannot
disagree. Being in `core` means the Foundry wrapper gets the sheet for free.

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
| pan at readable zoom | 1.38 ms | 1.7 ms |
| pan at mid zoom | 1.27 ms | 1.7 ms |
| zoom sweep, whole graph → one zone | 1.01 ms | 3.8 ms |
| pan with the "see also" overlay on | 0.90 ms | 1.3 ms |
| worst case: all 1,133 nodes in view | 0.33 ms | 0.5 ms |
| worst case + overlay + labels | 0.99 ms | 1.3 ms |

### Phone (`npm run bench:mobile`)

Real touch events through CDP - including two-finger pinch - at phone viewports,
in both orientations, with the **CPU throttled 4×**, which is roughly a low-end
Android against this machine. Touch-to-frame is measured from the pointer event
arriving to that frame finishing, because on touch it is latency, not framerate,
that makes a drag feel attached to your finger.

| motion (portrait / landscape) | frame p95 | touch→frame p95 |
|---|---|---|
| one-finger pan | 10.4 / 9.9 ms | 9.5 / 11.3 ms |
| two-finger pinch zoom | 7.7 / 6.3 ms | 8.9 / 9.1 ms |
| pan with the whole graph in view | 2.7 / 4.8 ms | 3.2 / 3.9 ms |
| pan with the "see also" overlay on | 3.3 / 3.1 ms | 3.8 / 3.9 ms |

These are re-measured against the Work Order 5 layout (four times larger in world
units, so more nodes are in view at any given zoom) and the Work Order 6 render
passes (owned halos, owned-edge underlay, the frontier ring layer). Frame cost
moved within a millisecond or two either way and every motion still clears 60fps
with room to spare. The frontier pass is bounded by the number of *choices* you
have, not by graph size, and is skipped entirely when zoomed out.

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

`bench/shots/` — regenerate with `npm run shots` (desktop and phone in one go).
Desktop shots are `01`–`07`; phone shots are `10`–`17`, including landscape.
`05` and `15` are the Work Order 5 acceptance shots: the commons at a normal
reading zoom on desktop and on a phone, where nodes must be individually
distinguishable without zooming to the maximum. `16` is search-to-select. `06`,
`07` and `17` are Work Order 6, all showing the playtest build (Fighter with
Paladin, Barbarian and Bard splashed in): owned nodes and edges against the
pulsing frontier, and the same build read back as a character sheet on both
screen sizes.

## Known and deferred

- **Pictorial icons** are out of scope by instruction: they need a licensed glyph
  set and a populated `tags` field, which Work Order 1/2 deferred.
- **Hover** on desktop now only highlights the node under the cursor; the tooltip
  it used to open is gone, because the detail panel replaced it. That is the
  select-then-confirm model applying uniformly, as Work Order 4 Task 3 asked.
- **Selecting a second node used to close the phone detail sheet** — the tab bar's
  toggle behaviour was being reused for something that is not a tab press. Fixed
  in Work Order 6: tapping the same tab still closes the sheet, selecting a node
  always opens it.
- **The commons rings** — *fixed in Work Order 5, was worse than "cosmetic".*
  Shared content sharing one circle per depth was not just visually busy: nodes
  overlapped to the point of being untappable on a phone, which blocked character
  creation. Each category now has its own sub-ring and every node is guaranteed
  1.8 units of clearance. Flagging it as a display quirk in Work Orders 3 and 4
  under-read it; a real device would have caught it immediately.
- **Foundry import** is deliberately *not* built. The JSON export is the shape a
  future importer would read, and that is where Work Order 6 stopped, per its own
  "don't scope-creep into building that integration itself".
- **Budget generosity** now has something to look at. The sheet exists so a build
  can be judged as a whole, which is what the Work Order 2 balance question was
  waiting on — but no numbers have been changed on the strength of it yet.
