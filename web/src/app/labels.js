/**
 * Zone label placement with collision resolution.
 *
 * Work Order 2's review flagged the preview SVG for crowding Rogue/Artificer/
 * Wizard labels together - Artificer's near-empty zone dragged its centroid into
 * its neighbours. Two fixes, both here:
 *
 *   1. anchor on the zone's angular centre and its own outer rim radius, so a
 *      sparse zone is placed by where its wedge *is*, not by where its handful
 *      of nodes happen to average out;
 *   2. a separation pass that pushes overlapping labels apart along the ring
 *      until no two screen rectangles intersect.
 */

const LABEL_MARGIN = 6; // world units beyond the zone's outermost node
const SEPARATION_PASSES = 24;

/**
 * @param {import('../core/graph.js').GraphIndex} index
 * @returns {{zone: string, angle: number, radius: number, empty: boolean}[]}
 */
export function zoneAnchors(index) {
  /** @type {Map<string, {sin: number, cos: number, maxRadius: number, count: number}>} */
  const accumulator = new Map();

  for (const node of index.nodes) {
    if (node.zone === 'core' || node.zone === 'commons') continue;
    const entry = accumulator.get(node.zone) || { sin: 0, cos: 0, maxRadius: 0, count: 0 };
    // average the *direction* rather than the position, so a zone with all its
    // content bunched near the hub still points down its own wedge
    const angle = Math.atan2(node.position_y, node.position_x);
    const radius = Math.hypot(node.position_x, node.position_y);
    entry.sin += Math.sin(angle);
    entry.cos += Math.cos(angle);
    entry.maxRadius = Math.max(entry.maxRadius, radius);
    entry.count += 1;
    accumulator.set(node.zone, entry);
  }

  const anchors = [];
  for (const [zone, entry] of accumulator) {
    const extracted = (index.zoneStatus[zone] || {}).extracted_nodes;
    anchors.push({
      zone,
      angle: Math.atan2(entry.sin / entry.count, entry.cos / entry.count),
      radius: entry.maxRadius + LABEL_MARGIN,
      empty: extracted === 0,
    });
  }
  anchors.sort((a, b) => a.angle - b.angle);
  return anchors;
}

/**
 * Resolve label overlaps in screen space by nudging labels along the ring.
 *
 * @param {{zone: string, angle: number, radius: number, empty: boolean}[]} anchors
 * @param {import('./camera.js').Camera} camera
 * @param {(zone: string) => number} measure text width in screen px
 * @param {number} lineHeight
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} [safeRect]
 *   screen-space area labels must stay inside - keeps them off the side panels
 *   and stops rim zones from being clipped when the whole graph is framed.
 */
export function placeLabels(anchors, camera, measure, lineHeight, safeRect) {
  const placed = anchors.map((anchor) => {
    const world = {
      x: Math.cos(anchor.angle) * anchor.radius,
      y: Math.sin(anchor.angle) * anchor.radius,
    };
    const screen = camera.worldToScreen(world.x, world.y);
    const halfWidth = measure(anchor.zone) / 2 + 6;
    const halfHeight = lineHeight / 2 + 3;
    let { x, y } = screen;
    if (safeRect) {
      x = Math.min(Math.max(x, safeRect.minX + halfWidth), safeRect.maxX - halfWidth);
      y = Math.min(Math.max(y, safeRect.minY + halfHeight), safeRect.maxY - halfHeight);
    }
    return {
      zone: anchor.zone,
      empty: anchor.empty,
      angle: anchor.angle,
      radius: anchor.radius,
      x,
      y,
      halfWidth,
      halfHeight,
      safeRect,
    };
  });

  // Separation: labels sit on a ring, so pushing them apart *along* the ring
  // keeps every label pointing at its own zone. Radial nudging is the fallback
  // for the rare pair that is angularly adjacent and still overlapping.
  for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
    let moved = false;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const overlapX = a.halfWidth + b.halfWidth - Math.abs(a.x - b.x);
        const overlapY = a.halfHeight + b.halfHeight - Math.abs(a.y - b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        const direction = a.angle <= b.angle ? -1 : 1;
        const nudge = 0.012 + overlapX / 8000;
        a.angle += direction * nudge;
        b.angle -= direction * nudge;
        if (overlapX > a.halfWidth) {
          a.radius += 1.2;
          b.radius -= 1.2;
        }
        for (const label of [a, b]) {
          const screen = camera.worldToScreen(
            Math.cos(label.angle) * label.radius,
            Math.sin(label.angle) * label.radius,
          );
          label.x = screen.x;
          label.y = screen.y;
          if (label.safeRect) {
            label.x = Math.min(
              Math.max(label.x, label.safeRect.minX + label.halfWidth),
              label.safeRect.maxX - label.halfWidth,
            );
            label.y = Math.min(
              Math.max(label.y, label.safeRect.minY + label.halfHeight),
              label.safeRect.maxY - label.halfHeight,
            );
          }
        }
      }
    }
    if (!moved) break;
  }

  return placed;
}
