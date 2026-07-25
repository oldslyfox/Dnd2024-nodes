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
  }

  /** @param {import('../core/engine.js').PlayerState} state */
  setState(state) {
    this.state = state;
    this._reachVersion = -1;
  }

  _reachability() {
    if (!this.state) return this._reach;
    const version = `${this.state.homeZone}:${this.state.version}:${this.state.pointsSpent}`;
    if (version !== this._reachVersion) {
      this._reach = this.engine.reachability(this.state);
      this._reachVersion = version;
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
    if (this.state.owned.has(node.id)) return 'owned';
    const { dist } = this._reachability();
    if (!dist.has(node.id)) return 'unreachable';
    return dist.get(node.id) <= this.state.pointsRemaining ? 'affordable' : 'reachable';
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.dpr = dpr;
    this.camera.resize(this.canvas.width, this.canvas.height);
  }

  draw() {
    const started = performance.now();
    const ctx = this.ctx;
    const camera = this.camera;
    const lod = camera.lod();

    ctx.fillStyle = ACCENT.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this._reachability();
    const rect = camera.visibleRect(6);
    const visible = this.index.nodesInRect(rect.minX, rect.minY, rect.maxX, rect.maxY);
    const visibleIds = new Set(visible.map((node) => node.id));

    if (lod === 'far') this._drawZoneShapes(ctx);
    this._drawEdges(ctx, visibleIds, lod);
    if (this.showReferences) this._drawReferenceEdges(ctx, visibleIds);
    this._drawPreviewPath(ctx);
    this._drawNodes(ctx, visible, lod);
    if (lod === 'near') this._drawNodeLabels(ctx, visible);
    this._drawZoneLabels(ctx);

    this.lastFrameMs = performance.now() - started;
    this.lastDrawnNodes = visible.length;
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

  _drawEdges(ctx, visibleIds, lod) {
    if (lod === 'far') return;
    const camera = this.camera;
    const owned = this.state ? this.state.owned : new Set();

    ctx.lineWidth = Math.max(0.5, 0.09 * camera.scale);
    ctx.strokeStyle = ACCENT.edge;
    ctx.beginPath();
    for (const edge of this.index.structuralEdges) {
      if (!visibleIds.has(edge.from) && !visibleIds.has(edge.to)) continue;
      if (owned.has(edge.from) && owned.has(edge.to)) continue;
      const a = this.index.byId.get(edge.from);
      const b = this.index.byId.get(edge.to);
      const from = camera.worldToScreen(a.position_x, a.position_y);
      const to = camera.worldToScreen(b.position_x, b.position_y);
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();

    // owned edges brighter, drawn second so they sit on top
    ctx.strokeStyle = ACCENT.edgeOwned;
    ctx.lineWidth = Math.max(0.8, 0.13 * camera.scale);
    ctx.beginPath();
    for (const edge of this.index.structuralEdges) {
      if (!owned.has(edge.from) || !owned.has(edge.to)) continue;
      if (!visibleIds.has(edge.from) && !visibleIds.has(edge.to)) continue;
      const a = this.index.byId.get(edge.from);
      const b = this.index.byId.get(edge.to);
      const from = camera.worldToScreen(a.position_x, a.position_y);
      const to = camera.worldToScreen(b.position_x, b.position_y);
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
  }

  _drawReferenceEdges(ctx, visibleIds) {
    // The 268 "see also" citations. Never a traversable path - drawn dashed and
    // only when the overlay is toggled on.
    const camera = this.camera;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = ACCENT.reference;
    ctx.lineWidth = Math.max(0.5, 0.07 * camera.scale);
    ctx.beginPath();
    for (const edge of this.index.referenceEdges) {
      if (!visibleIds.has(edge.from) && !visibleIds.has(edge.to)) continue;
      const a = this.index.byId.get(edge.from);
      const b = this.index.byId.get(edge.to);
      const from = camera.worldToScreen(a.position_x, a.position_y);
      const to = camera.worldToScreen(b.position_x, b.position_y);
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    ctx.restore();
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

  _drawNodes(ctx, visible, lod) {
    const camera = this.camera;
    const batches = this._batches;
    batches.clear();

    for (const node of visible) {
      if (lod === 'far' && !(this.state && this.state.owned.has(node.id))) {
        if (node.type === 'connector') continue;
      }
      const state = this.nodeState(node);
      const style = STATE_STYLE[state];
      const fill = shade(zoneColour(node.zone), style.dim);
      let batch = batches.get(fill);
      if (!batch) {
        batch = [];
        batches.set(fill, batch);
      }
      batch.push({ node, state, style });
    }

    for (const [fill, entries] of batches) {
      ctx.fillStyle = fill;
      for (const entry of entries) {
        const { node, style } = entry;
        const point = camera.worldToScreen(node.position_x, node.position_y);
        const radius = Math.max(1.1, nodeRadius(node) * camera.scale * 0.36);
        ctx.globalAlpha = style.alpha;
        this._shapePath(ctx, nodeShape(node), point.x, point.y, radius, lod);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    if (lod !== 'far') {
      for (const entries of batches.values()) {
        for (const entry of entries) {
          const { node, style } = entry;
          if (!style.strokeWidth) continue;
          const point = camera.worldToScreen(node.position_x, node.position_y);
          const radius = Math.max(1.1, nodeRadius(node) * camera.scale * 0.36);
          ctx.strokeStyle = style.stroke;
          ctx.lineWidth = Math.max(0.6, style.strokeWidth * camera.scale * 0.3);
          this._shapePath(ctx, nodeShape(node), point.x, point.y, radius, lod);
          ctx.stroke();
        }
      }
    }

    this._drawAccents(ctx, visible);
  }

  _drawAccents(ctx, visible) {
    const camera = this.camera;
    const preview = new Set(this.previewPath);

    for (const node of visible) {
      const isHover = node.id === this.hoverId;
      const isSearch = this.searchHits.has(node.id);
      const isPreview = preview.has(node.id);
      if (!isHover && !isSearch && !isPreview) continue;

      const point = camera.worldToScreen(node.position_x, node.position_y);
      const radius = Math.max(1.1, nodeRadius(node) * camera.scale * 0.36);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = isHover ? ACCENT.hover : isPreview ? ACCENT.preview : ACCENT.search;
      ctx.lineWidth = isHover ? 2.2 : 1.6;
      ctx.stroke();
    }
  }

  _shapePath(ctx, shape, x, y, radius, lod) {
    ctx.beginPath();
    if (lod === 'far' || shape === 'dot' || radius < 2.4) {
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      return;
    }
    switch (shape) {
      case 'circle':
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

    const size = Math.round(Math.min(14, Math.max(10, camera.scale * 0.62)));
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
      const radius = Math.max(1.1, nodeRadius(node) * camera.scale * 0.36);
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
    const size = Math.round(Math.max(13, Math.min(24, camera.scale * 1.6)));
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

    // keep labels clear of the side panels and the top/bottom bars
    const dpr = this.dpr || 1;
    const safeRect = {
      minX: 300 * dpr,
      minY: 64 * dpr,
      maxX: this.canvas.width - 300 * dpr,
      maxY: this.canvas.height - 40 * dpr,
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
