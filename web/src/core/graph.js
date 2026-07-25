/**
 * Graph indexing for the renderer: bounds, zone grouping, spatial buckets for
 * hit-testing and viewport culling, and search.
 *
 * Lives in core (not app) because it is pure data work with no DOM in it - a
 * Foundry wrapper needs exactly the same indexes.
 */

const BUCKET_SIZE = 12; // graph units; ~4 depth rings

export class GraphIndex {
  /** @param {any} graph parsed graph.v2.json */
  constructor(graph) {
    this.graph = graph;
    this.nodes = graph.nodes;
    /** @type {Map<string, any>} */
    this.byId = new Map(this.nodes.map((node) => [node.id, node]));

    this.bounds = this._bounds();
    this.zones = graph.meta.zones || [];
    this.zoneStatus = graph.meta.zone_status || {};
    this.chassisByZone = graph.meta.chassis_by_zone || {};
    this.budget = graph.meta.point_economy.total_points_at_level_20;

    /** Edges split by whether the pathing engine walks them. */
    this.structuralEdges = graph.edges.filter((edge) => edge.traversable !== false);
    this.referenceEdges = graph.edges.filter((edge) => edge.traversable === false);

    // Node positions are immutable, so resolve every edge's endpoints once here
    // rather than doing two Map lookups per edge per frame. At 1,433 edges and
    // 60fps that is 172,000 lookups a second reclaimed.
    this.structuralEdgeGeometry = this._edgeGeometry(this.structuralEdges);
    this.referenceEdgeGeometry = this._edgeGeometry(this.referenceEdges);

    this.buckets = this._buckets();
    // Structured fields only - name, zone, sub-region, tags, type and role.
    // `role` matters: the ten Metamagic options are named "Careful Spell",
    // "Distant Spell" and so on, so searching "metamagic" finds nothing without
    // it. Effect prose is deliberately excluded; it turns every query into a
    // hundred loose matches.
    this._searchCorpus = this.nodes.map((node) => ({
      id: node.id,
      haystack: [
        node.name,
        node.zone,
        node.subregion || '',
        (node.tags || []).join(' '),
        (node.feature_type_labels || []).join(' '),
        node.type,
        node.role || '',
      ]
        .join(' ')
        .replace(/_/g, ' ')
        .toLowerCase(),
    }));
  }

  /** @param {any[]} edges */
  _edgeGeometry(edges) {
    return edges.map((edge) => {
      const a = this.byId.get(edge.from);
      const b = this.byId.get(edge.to);
      return {
        from: edge.from,
        to: edge.to,
        ax: a ? a.position_x : 0,
        ay: a ? a.position_y : 0,
        bx: b ? b.position_x : 0,
        by: b ? b.position_y : 0,
      };
    });
  }

  _bounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes) {
      if (node.position_x < minX) minX = node.position_x;
      if (node.position_y < minY) minY = node.position_y;
      if (node.position_x > maxX) maxX = node.position_x;
      if (node.position_y > maxY) maxY = node.position_y;
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  _buckets() {
    /** @type {Map<string, any[]>} */
    const buckets = new Map();
    for (const node of this.nodes) {
      const key = GraphIndex.bucketKey(node.position_x, node.position_y);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(node);
      else buckets.set(key, [node]);
    }
    return buckets;
  }

  static bucketKey(x, y) {
    return `${Math.floor(x / BUCKET_SIZE)}:${Math.floor(y / BUCKET_SIZE)}`;
  }

  /**
   * Nodes whose position falls inside a world-space rectangle. This is the
   * viewport cull - at full zoom-out it returns everything, zoomed in it returns
   * a few dozen.
   */
  nodesInRect(minX, minY, maxX, maxY) {
    const out = [];
    const bx0 = Math.floor(minX / BUCKET_SIZE);
    const by0 = Math.floor(minY / BUCKET_SIZE);
    const bx1 = Math.floor(maxX / BUCKET_SIZE);
    const by1 = Math.floor(maxY / BUCKET_SIZE);
    for (let bx = bx0; bx <= bx1; bx += 1) {
      for (let by = by0; by <= by1; by += 1) {
        const bucket = this.buckets.get(`${bx}:${by}`);
        if (!bucket) continue;
        for (const node of bucket) {
          if (
            node.position_x >= minX &&
            node.position_x <= maxX &&
            node.position_y >= minY &&
            node.position_y <= maxY
          ) {
            out.push(node);
          }
        }
      }
    }
    return out;
  }

  /**
   * Nearest node to a world-space point, within `radius`.
   *
   * `preferNotable` biases the pick towards real content: a tap that lands
   * between a class feature and the connector beside it should select the
   * feature. Connectors are only chosen when nothing notable is in range, or
   * when the connector is clearly the closer of the two.
   */
  nodeAt(x, y, radius = 2.2, { preferNotable = false } = {}) {
    const candidates = this.nodesInRect(x - radius, y - radius, x + radius, y + radius);
    let best = null;
    let bestScore = radius * radius;
    for (const node of candidates) {
      const dx = node.position_x - x;
      const dy = node.position_y - y;
      const distance = dx * dx + dy * dy;
      if (distance > radius * radius) continue;
      const filler = node.type === 'connector' && !node.is_gate;
      const score = preferNotable && filler ? distance * 2.4 : distance;
      if (score <= bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return best;
  }

  /** @param {string} query @param {number} [limit] */
  search(query, limit = 60) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits = [];
    for (const entry of this._searchCorpus) {
      const at = entry.haystack.indexOf(needle);
      if (at !== -1) hits.push({ node: this.byId.get(entry.id), score: at });
    }
    hits.sort((a, b) => a.score - b.score || a.node.name.localeCompare(b.node.name));
    return hits.slice(0, limit).map((hit) => hit.node);
  }

  /** Class zones only, in ring order, ignoring core/commons. */
  classZones() {
    return this.zones.filter((zone) => zone !== 'core' && zone !== 'commons');
  }

  /** Geometric centroid of a zone's nodes, used for label placement. */
  zoneCentroid(zone) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const node of this.nodes) {
      if (node.zone !== zone) continue;
      sumX += node.position_x;
      sumY += node.position_y;
      count += 1;
    }
    return count ? { x: sumX / count, y: sumY / count, count } : null;
  }
}
