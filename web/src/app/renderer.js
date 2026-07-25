/**
 * Canvas 2D renderer (Work Order 3, decision 3 + Task 4).
 *
 * Everything on screen is drawn from the graph every frame, with two cost
 * controls: viewport culling (only what is inside the visible rect), and level
 * of detail (zoomed out draws zone shapes and simplified nodes, zoomed in draws
 * full shapes, outlines and labels). The whole graph remains present and
 * explorable at every zoom - nothing is hidden, per decision 2. Gate nodes are
 * cost mechanics, not fog of war.
 *
 * Hot-loop discipline: no per-frame allocation beyond a couple of reused arrays,
 * node draws batched by fill colour, and reachability recomputed only when the
 * character state version changes.
 */

import { ACCENT, STATE_STYLE, nodeRadius, nodeShape, shade, zoneColour } from './style.js';
import { placeLabels, zoneAnchors } from './labels.js';

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/graph.js').GraphIndex} index
   * @param {import('../core/engine.js').PathEngine} engine
   * @param {import('./camera.js').Camera} camera
   */
  constructor(canvas, index, engine, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.index = index;
    this.engine = engine;
    this.camera = camera;

    this.state = null;
    this.showReferences = false;
    this.hoverId = null;
    /** The selected node drives the detail panel and the path preview. */
    this.selectedId = null;
    /** Legibility floor (Work Order 4, Task 5): text never renders below this. */
    this.minFontPx = 12;
    /** @type {string[]} */
    this.previewPath = [];
    /** @type {Set<string>} */
    this.searchHits = new Set();

    this.anchors = zoneAnchors(index);
    this._reach = { dist: new Map(), blocked: new Map() };
    this._reachVersion = -1;
    this._batches = new Map();
    this.lastFrameMs = 0;
    this.lastDrawnNodes = 0;
    /** @type {Map<string, number>} measureText is the costliest call per frame */
    this._textWidths = new Map();
    /** @type {Map<string, string>} node -> allocation state, per character state */
    this._stateCache = new Map();
    /** World-space geometry, rebuilt only when zoom/state/LOD changes. */
    this._worldCacheKey = null;
    this._worldCache = null;
  }

  /** @param {import('../core/engine.js').PlayerState} state */
  setState(state) {
    this.state = state;
    this._reachVersion = -1;
    this._worldCacheKey = null;
  }

  _reachability() {
    if (!this.state) return this._reach;
    const version = `${this.state.homeZone}:${this.state.version}:${this.state.pointsSpent}`;
    if (version !== this._reachVersion) {
      this._reach = this.engine.reachability(this.state);
      this._reachVersion = version;
      this._stateCache.clear();
    }
    return this._reach;
  }

  /**
   * One of the four Task 4 states.
   * @param {any} node
   * @returns {'owned'|'affordable'|'reachable'|'unreachable'}
   */
  nodeState(node) {
    if (!this.state) return 'unreachable';
    const cached = this._stateCache.get(node.id);
    if (cached !== undefined) return cached;

    let result;
    if (this.state.owned.has(node.id)) {
      result = 'owned';
    } else {
      const { dist } = this._reachability();
      if (!dist.has(node.id)) result = 'unreachable';
      else result = dist.get(node.id) <= this.state.pointsRemaining ? 'affordable' : 'reachable';
    }
    this._stateCache.set(node.id, result);
    return result;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const compact = (rect.width || 1) <= 760 || (rect.height || 1) <= 560;
    // Phones ship 2.6-3x screens; rendering the full ratio costs 3x the fill
    // for a dark canvas of flat shapes nobody inspects at pixel level. 1.5x
    // keeps text and outlines crisp at a third of the pixels.
    const dpr = Math.min(globalThis.devicePixelRatio || 1, compact ? 1.5 : 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.dpr = dpr;
    this.camera.resize(this.canvas.width, this.canvas.height);

    // Everything is drawn in device pixels, so on a 3x phone screen a 12px font
    // is 4 CSS px - illegible. Scale the floor with the ratio, and give phones a
    // slightly bigger floor again because they are held further from the eye
    // than the pixel maths alone suggests.
    this.isCompact = compact;
    this._worldCacheKey = null;
    this.minFontPx = Math.round((this.isCompact ? 13 : 11) * dpr);
    this._textWidths.clear();
  }

  draw() {
    const started = performance.now();
    const ctx = this.ctx;
    const camera = this.camera;
    const lod = camera.lod();

    ctx.fillStyle = ACCENT.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this._reachability();
    const paths = this._worldPaths(lod);

    if (lod === 'far') this._drawZoneShapes(ctx);
    this._drawEdges(ctx, paths, lod);
    if (this.showReferences) this._drawReferenceEdges(ctx, paths);
    this._drawPreviewPath(ctx);
    this._drawNodes(ctx, paths);
    this._drawAccents(ctx);

    // The spatial cull now only serves labels, so only pay for it when labels
    // are actually drawn.
    if (lod === 'near') {
      const rect = camera.visibleRect(6);
      this._drawNodeLabels(ctx, this.index.nodesInRect(rect.minX, rect.minY, rect.maxX, rect.maxY));
    }
    this._drawZoneLabels(ctx);

    this.lastFrameMs = performance.now() - started;
    this.lastDrawnNodes = paths.count;
  }

  /**
   * Node radius in *world* units.
   *
   * Deliberately free of any zoom term: the cached geometry would otherwise be
   * invalidated on every frame of a pinch, which measured at 22ms a frame. The
   * "don't let nodes become specks" adjustment is expressed per level of detail
   * instead, and LOD is already part of the cache key, so zooming is free until
   * it crosses an LOD boundary.
   */
  radiusWorld(node, lod) {
    const base = nodeRadius(node) * 0.36;
    if (lod === 'far') return base * 2.4;
    if (lod === 'mid') return base * (this.isCompact ? 1.7 : 1.25);
    return base;
  }

  /** The same radius in device pixels, for rings and label offsets. */
  radiusOf(node, lod = this.camera.lod()) {
    return this.radiusWorld(node, lod) * this.camera.scale;
  }

  // -- layers -------------------------------------------------------------

  _drawZoneShapes(ctx) {
    // Zoomed out: a soft wedge per zone so the ring reads as structure rather
    // than as 1,100 indistinct dots.
    const camera = this.camera;
    for (const anchor of this.anchors) {
      const inner = camera.worldToScreen(0, 0);
      const outer = camera.worldToScreen(
        Math.cos(anchor.angle) * anchor.radius,
        Math.sin(anchor.angle) * anchor.radius,
      );
      const gradient = ctx.createLinearGradient(inner.x, inner.y, outer.x, outer.y);
      const colour = zoneColour(anchor.zone);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(1, shade(colour, 0.55));
      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(6, 26 * camera.scale * 0.02);
      ctx.globalAlpha = 0.32;
      ctx.beginPath();
      ctx.moveTo(inner.x, inner.y);
      ctx.lineTo(outer.x, outer.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Edges and nodes are built in *world* coordinates and drawn through a canvas
   * transform. Panning is then a transform change rather than a rebuild of a
   * few thousand sub-paths, which is what a one-finger drag actually does most
   * of the time. The paths are rebuilt only when the zoom, the character state
   * or the level of detail changes.
   */
  _worldPaths(lod) {
    const stateVersion = this._reachVersion;
    const key = `${lod}|${stateVersion}|${this.isCompact}|${this.showReferences}`;
    if (this._worldCacheKey === key) return this._worldCache;

    const owned = this.state ? this.state.owned : null;
    const plain = new Path2D();
    const bright = new Path2D();
    let hasBright = false;

    if (lod !== 'far') {
      for (const edge of this.index.structuralEdgeGeometry) {
        const isOwned = owned !== null && owned.has(edge.from) && owned.has(edge.to);
        const target = isOwned ? bright : plain;
        if (isOwned) hasBright = true;
        target.moveTo(edge.ax, edge.ay);
        target.lineTo(edge.bx, edge.by);
      }
    }

    let references = null;
    if (this.showReferences) {
      references = new Path2D();
      for (const edge of this.index.referenceEdgeGeometry) {
        references.moveTo(edge.ax, edge.ay);
        references.lineTo(edge.bx, edge.by);
      }
    }

    /** @type {Map<string, {colour: string, style: any, fill: Path2D, stroke: Path2D|null}>} */
    const batches = new Map();
    let count = 0;
    for (const node of this.index.nodes) {
      if (lod === 'far' && node.type === 'connector') {
        if (!owned || !owned.has(node.id)) continue;
      }
      const state = this.nodeState(node);
      const style = STATE_STYLE[state];
      const colour = shade(zoneColour(node.zone), style.dim);
      const batchKey = `${colour}|${state}`;

      let batch = batches.get(batchKey);
      if (!batch) {
        batch = { colour, style, fill: new Path2D(), stroke: null };
        batches.set(batchKey, batch);
      }

      count += 1;
      const radius = this.radiusWorld(node, lod);
      const shape = nodeShape(node);
      this._addShape(batch.fill, shape, node.position_x, node.position_y, radius, lod);

      // Outlines are the second most expensive thing in the frame, and at mid
      // zoom they are a sub-pixel hairline nobody can see. Draw them close in,
      // and otherwise only for owned nodes, whose white ring is load-bearing.
      if (style.strokeWidth && (lod === 'near' || state === 'owned')) {
        if (!batch.stroke) batch.stroke = new Path2D();
        this._addShape(batch.stroke, shape, node.position_x, node.position_y, radius, lod);
      }
    }

    this._worldCacheKey = key;
    this._worldCache = { plain, bright, hasBright, references, batches, count };
    return this._worldCache;
  }

  /** Apply the world -> screen transform for the cached paths. */
  _withWorldTransform(ctx, draw) {
    const camera = this.camera;
    const scale = camera.scale;
    ctx.save();
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      camera.viewportWidth / 2 - camera.x * scale,
      camera.viewportHeight / 2 - camera.y * scale,
    );
    draw(scale);
    ctx.restore();
  }

  _drawEdges(ctx, paths, lod) {
    if (lod === 'far') return;
    this._withWorldTransform(ctx, (scale) => {
      ctx.strokeStyle = ACCENT.edge;
      ctx.lineWidth = Math.max(0.5, 0.09 * scale) / scale;
      ctx.stroke(paths.plain);
      if (paths.hasBright) {
        ctx.strokeStyle = ACCENT.edgeOwned;
        ctx.lineWidth = Math.max(0.8, 0.13 * scale) / scale;
        ctx.stroke(paths.bright);
      }
    });
  }

  _drawReferenceEdges(ctx, paths) {
    // The 268 "see also" citations. Never a traversable path - drawn dashed and
    // only when the overlay is toggled on.
    if (!paths.references) return;
    this._withWorldTransform(ctx, (scale) => {
      ctx.setLineDash([4 / scale, 4 / scale]);
      ctx.strokeStyle = ACCENT.reference;
      ctx.lineWidth = Math.max(0.5, 0.07 * scale) / scale;
      ctx.stroke(paths.references);
    });
  }

  _drawPreviewPath(ctx) {
    if (this.previewPath.length < 2) return;
    const camera = this.camera;
    ctx.save();
    ctx.strokeStyle = ACCENT.previewEdge;
    ctx.lineWidth = Math.max(1.5, 0.22 * camera.scale);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < this.previewPath.length; i += 1) {
      const node = this.index.byId.get(this.previewPath[i]);
      if (!node) continue;
      const point = camera.worldToScreen(node.position_x, node.position_y);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawNodes(ctx, paths) {
    this._withWorldTransform(ctx, (scale) => {
      for (const batch of paths.batches.values()) {
        ctx.globalAlpha = batch.style.alpha;
        ctx.fillStyle = batch.colour;
        ctx.fill(batch.fill);
      }
      ctx.globalAlpha = 1;
      for (const batch of paths.batches.values()) {
        if (!batch.stroke) continue;
        ctx.strokeStyle = batch.style.stroke;
        ctx.lineWidth = Math.max(0.6, batch.style.strokeWidth * scale * 0.3) / scale;
        ctx.stroke(batch.stroke);
      }
    });
  }

  /**
   * Highlight rings for the selected node, the hovered node, search hits and the
   * previewed path. These are a handful of ids, so they are looked up directly
   * instead of scanning everything in the viewport.
   */
  _drawAccents(ctx) {
    const camera = this.camera;
    const scale = camera.scale;
    const offsetX = camera.viewportWidth / 2 - camera.x * scale;
    const offsetY = camera.viewportHeight / 2 - camera.y * scale;

    /** @type {Map<string, string>} id -> accent kind, strongest wins */
    const marks = new Map();
    for (const id of this.searchHits) marks.set(id, 'search');
    for (const id of this.previewPath) marks.set(id, 'preview');
    if (this.hoverId) marks.set(this.hoverId, 'hover');
    if (this.selectedId) marks.set(this.selectedId, 'selected');
    if (!marks.size) return;

    for (const [id, kind] of marks) {
      const node = this.index.byId.get(id);
      if (!node) continue;
      const x = node.position_x * scale + offsetX;
      const y = node.position_y * scale + offsetY;
      if (x < -40 || y < -40 || x > this.canvas.width + 40 || y > this.canvas.height + 40) {
        continue;
      }
      const radius = this.radiusOf(node);

      if (kind === 'selected') {
        ctx.beginPath();
        ctx.arc(x, y, radius + 9, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = ACCENT.hover;
        ctx.lineWidth = 3;
        ctx.stroke();
        continue;
      }

      ctx.beginPath();
      ctx.arc(x, y, radius + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle =
        kind === 'hover' ? ACCENT.hover : kind === 'preview' ? ACCENT.preview : ACCENT.search;
      ctx.lineWidth = kind === 'hover' ? 2.2 : 1.6;
      ctx.stroke();
    }
  }

  /** Draw straight onto a context (used by the legend). */
  _shapePath(ctx, shape, x, y, radius, lod) {
    ctx.beginPath();
    this._addShape(ctx, shape, x, y, radius, lod);
  }

  /**
   * Append one node's outline to a path. Works with both Path2D and a canvas
   * context, since the sub-path API is identical.
   * @param {Path2D|CanvasRenderingContext2D} ctx
   */
  _addShape(ctx, shape, x, y, radius, lod) {
    if (lod === 'far' || shape === 'dot') {
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      return;
    }
    switch (shape) {
      case 'circle':
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        break;
      case 'square':
        ctx.rect(x - radius * 0.85, y - radius * 0.85, radius * 1.7, radius * 1.7);
        break;
      case 'diamond':
        ctx.moveTo(x, y - radius);
        ctx.lineTo(x + radius, y);
        ctx.lineTo(x, y + radius);
        ctx.lineTo(x - radius, y);
        ctx.closePath();
        break;
      case 'triangle':
        ctx.moveTo(x, y - radius);
        ctx.lineTo(x + radius * 0.92, y + radius * 0.72);
        ctx.lineTo(x - radius * 0.92, y + radius * 0.72);
        ctx.closePath();
        break;
      case 'hexagon':
        for (let i = 0; i < 6; i += 1) {
          const angle = (Math.PI / 3) * i - Math.PI / 6;
          const px = x + Math.cos(angle) * radius;
          const py = y + Math.sin(angle) * radius;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      case 'octagon':
        for (let i = 0; i < 8; i += 1) {
          const angle = (Math.PI / 4) * i + Math.PI / 8;
          const px = x + Math.cos(angle) * radius;
          const py = y + Math.sin(angle) * radius;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      case 'star':
        for (let i = 0; i < 8; i += 1) {
          const angle = (Math.PI / 4) * i - Math.PI / 2;
          const r = i % 2 === 0 ? radius : radius * 0.45;
          const px = x + Math.cos(angle) * r;
          const py = y + Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      default:
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }

  /**
   * Node labels, placed greedily so they never pile up.
   *
   * A thousand names in one viewport is worse than none: labels are ranked
   * (hovered, then owned, then real content, then connectors) and each is only
   * drawn if its box is still clear, so what survives is readable at any zoom.
   */
  _drawNodeLabels(ctx, visible) {
    const camera = this.camera;
    if (camera.scale < 11) return;

    // Task 5: scale with zoom but never below the legibility floor, which is
    // raised on small screens where the device pixel ratio shrinks everything.
    const size = Math.round(Math.min(16, Math.max(this.minFontPx, camera.scale * 0.62)));
    ctx.save();
    ctx.font = `${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = 5;

    const centreX = this.canvas.width / 2;
    const centreY = this.canvas.height / 2;
    const priority = (node) => {
      if (node.id === this.hoverId) return 0;
      if (this.searchHits.has(node.id)) return 1;
      if (this.state && this.state.owned.has(node.id)) return 2;
      if (node.is_gate) return 3;
      if (node.type === 'connector') return 6;
      return 4;
    };

    const candidates = visible
      .filter((node) => node.type !== 'connector' || node.is_gate || camera.scale >= 22)
      .map((node) => {
        const point = camera.worldToScreen(node.position_x, node.position_y);
        return {
          node,
          point,
          rank:
            priority(node) * 1e6 +
            Math.hypot(point.x - centreX, point.y - centreY),
        };
      })
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 140);

    /** @type {Map<string, {x0:number,y0:number,x1:number,y1:number}[]>} */
    const occupancy = new Map();
    const cell = 64;
    const fits = (x0, y0, x1, y1) => {
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx += 1) {
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy += 1) {
          const bucket = occupancy.get(`${cx}:${cy}`);
          if (!bucket) continue;
          for (const rect of bucket) {
            if (x0 < rect.x1 && x1 > rect.x0 && y0 < rect.y1 && y1 > rect.y0) return false;
          }
        }
      }
      return true;
    };
    const occupy = (rect) => {
      for (let cx = Math.floor(rect.x0 / cell); cx <= Math.floor(rect.x1 / cell); cx += 1) {
        for (let cy = Math.floor(rect.y0 / cell); cy <= Math.floor(rect.y1 / cell); cy += 1) {
          const key = `${cx}:${cy}`;
          const bucket = occupancy.get(key);
          if (bucket) bucket.push(rect);
          else occupancy.set(key, [rect]);
        }
      }
    };

    for (const candidate of candidates) {
      const { node, point } = candidate;
      const text = node.name.length > 30 ? `${node.name.slice(0, 28)}…` : node.name;
      const cacheKey = `${size}:${text}`;
      let width = this._textWidths.get(cacheKey);
      if (width === undefined) {
        width = ctx.measureText(text).width;
        this._textWidths.set(cacheKey, width);
      }
      const radius = this.radiusOf(node);
      const x0 = point.x - width / 2 - 3;
      const y0 = point.y + radius + 2;
      const x1 = point.x + width / 2 + 3;
      const y1 = y0 + size + 3;
      if (!fits(x0, y0, x1, y1)) continue;
      occupy({ x0, y0, x1, y1 });

      const owned = this.state && this.state.owned.has(node.id);
      ctx.fillStyle = owned ? 'rgba(255,255,255,0.95)' : 'rgba(226, 231, 241, 0.82)';
      ctx.fillText(text, point.x, y0);
    }
    ctx.restore();
  }

  /**
   * Zone labels. These are orientation furniture: they matter when the whole
   * ring is in view and only get in the way once you are reading one zone's
   * nodes, so they fade out as the node labels take over.
   */
  _drawZoneLabels(ctx) {
    const camera = this.camera;
    if (camera.scale > 13) return;
    const fade = camera.scale > 10 ? Math.max(0, (13 - camera.scale) / 3) : 1;

    ctx.save();
    ctx.globalAlpha = fade;
    const size = Math.round(
      Math.max(this.minFontPx + 2, Math.min(24, camera.scale * 1.6)),
    );
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    const measure = (text) => {
      const cacheKey = `z${size}:${text}`;
      let width = this._textWidths.get(cacheKey);
      if (width === undefined) {
        width = ctx.measureText(text).width;
        this._textWidths.set(cacheKey, width);
      }
      return width;
    };

    // Keep labels clear of the chrome. On desktop that means the two side
    // panels; on a phone there are none (they are bottom sheets), and reserving
    // 300px a side would invert the rectangle on a 412px screen.
    const dpr = this.dpr || 1;
    const sideMargin = (this.isCompact ? 10 : 300) * dpr;
    const bottomMargin = (this.isCompact ? 58 : 40) * dpr;
    const safeRect = {
      minX: Math.min(sideMargin, this.canvas.width * 0.35),
      minY: 64 * dpr,
      maxX: Math.max(this.canvas.width - sideMargin, this.canvas.width * 0.65),
      maxY: this.canvas.height - bottomMargin,
    };
    const labels = placeLabels(this.anchors, camera, measure, size, safeRect);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of labels) {
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = shade(zoneColour(label.zone), label.empty ? 0.45 : 0.05);
      ctx.fillText(label.zone, label.x, label.y);
      if (label.empty) {
        ctx.font = `500 ${Math.round(size * 0.52)}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(200, 205, 215, 0.55)';
        ctx.fillText('pending 2024 content', label.x, label.y + size * 0.85);
        ctx.font = `600 ${size}px system-ui, sans-serif`;
      }
    }
    ctx.restore();
  }
}
