/**
 * PathEngine - a faithful port of src/dnd2024/pathing.py.
 *
 * Cost model (Work Order 2, Tasks 2b/4/5):
 *   already owned                             -> 0
 *   connector on your home zone's own spine   -> 0
 *   your home zone's gate                     -> 0
 *   anything else                             -> its point_cost
 *
 * Gating is points + connectivity + normalized prerequisites. Level is never
 * consulted; `reference` edges (traversable: false) are excluded from the graph
 * the search walks.
 *
 * Determinism note: the Python engine uses heapq over (cost, node_id) tuples, so
 * ties break on node id. The heap here compares the same way, which is what lets
 * the two implementations return byte-identical paths - asserted over 2,340
 * generated cases in tests/engine.test.mjs.
 *
 * Zero UI dependencies by construction: this file imports nothing but prereqs.js.
 */

import { satisfied, unmetReasons, EMPTY_PREREQS } from './prereqs.js';

export const HUB_ID = 'conn_core_hub';

/** Binary min-heap ordered by (cost, id), matching Python's heapq on tuples. */
class MinHeap {
  constructor() {
    /** @type {{cost: number, id: string}[]} */
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  /** @param {{cost: number, id: string}} a @param {{cost: number, id: string}} b */
  static before(a, b) {
    if (a.cost !== b.cost) return a.cost < b.cost;
    return a.id < b.id;
  }

  push(cost, id) {
    const items = this.items;
    items.push({ cost, id });
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (MinHeap.before(items[index], items[parent])) {
        [items[index], items[parent]] = [items[parent], items[index]];
        index = parent;
      } else break;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && MinHeap.before(items[left], items[smallest])) smallest = left;
        if (right < items.length && MinHeap.before(items[right], items[smallest])) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest], items[index]];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * Everything the engine needs to know about a character.
 * `homeZone` is chosen at creation: it fixes the chassis and is the only zone
 * whose connector spine is free to walk.
 */
export class PlayerState {
  /**
   * @param {{homeZone: string, pointsTotal: number, owned?: Iterable<string>,
   *          pointsSpent?: number}} options
   */
  constructor({ homeZone, pointsTotal, owned = [HUB_ID], pointsSpent = 0 }) {
    this.homeZone = homeZone;
    this.pointsTotal = pointsTotal;
    /** @type {Set<string>} */
    this.owned = new Set(owned);
    this.pointsSpent = pointsSpent;
    this.version = 0; // bumped on every mutation; drives the search cache
  }

  get pointsRemaining() {
    return this.pointsTotal - this.pointsSpent;
  }

  touch() {
    this.version += 1;
  }

  clone() {
    return new PlayerState({
      homeZone: this.homeZone,
      pointsTotal: this.pointsTotal,
      owned: this.owned,
      pointsSpent: this.pointsSpent,
    });
  }

  toJSON() {
    return {
      homeZone: this.homeZone,
      pointsTotal: this.pointsTotal,
      owned: [...this.owned].sort(),
      pointsSpent: this.pointsSpent,
    };
  }

  /** @param {ReturnType<PlayerState['toJSON']>} data */
  static fromJSON(data) {
    return new PlayerState({
      homeZone: data.homeZone,
      pointsTotal: data.pointsTotal,
      owned: data.owned,
      pointsSpent: data.pointsSpent,
    });
  }
}

export class PathEngine {
  /** @param {any} graph parsed graph.v2.json */
  constructor(graph) {
    this.graph = graph;
    /** @type {Map<string, any>} */
    this.nodes = new Map();
    for (const node of graph.nodes) this.nodes.set(node.id, node);

    /** @type {Map<string, string[]>} */
    this.adjacency = new Map();
    for (const node of graph.nodes) this.adjacency.set(node.id, []);
    for (const edge of graph.edges) {
      // `reference` edges are the extraction's citation registry, not designed
      // connectivity - excluded here exactly as the Python engine excludes them.
      if (edge.traversable === false) continue;
      const from = this.adjacency.get(edge.from);
      const to = this.adjacency.get(edge.to);
      if (from && to) {
        if (!from.includes(edge.to)) from.push(edge.to);
        if (!to.includes(edge.from)) to.push(edge.from);
      }
    }

    this.chassisByZone = (graph.meta && graph.meta.chassis_by_zone) || {};
    this.budget =
      (graph.meta &&
        graph.meta.point_economy &&
        graph.meta.point_economy.total_points_at_level_20) ||
      0;

    this._cacheKey = null;
    /** @type {Map<string, number>} */
    this._dist = new Map();
    /** @type {Map<string, string|null>} */
    this._prev = new Map();
    /** @type {Map<string, string[]>} */
    this._blocked = new Map();
  }

  /** @param {string} id */
  node(id) {
    return this.nodes.get(id);
  }

  // -- cost model ---------------------------------------------------------

  /**
   * @param {string} nodeId
   * @param {PlayerState} state
   * @returns {number}
   */
  nodeCost(nodeId, state) {
    if (state.owned.has(nodeId)) return 0;
    const node = this.nodes.get(nodeId);
    if (!node) return 0;
    if (node.type === 'connector' && node.is_spine && node.zone === state.homeZone) return 0;
    if (node.is_gate && node.zone === state.homeZone) return 0;
    return node.point_cost || 0;
  }

  // -- Task 2c chassis ----------------------------------------------------

  /** @param {PlayerState} state */
  chassis(state) {
    return this.chassisByZone[state.homeZone] || null;
  }

  /** @param {PlayerState} state */
  hitDie(state) {
    const entry = this.chassisByZone[state.homeZone];
    return entry ? entry.hit_die : null;
  }

  /** @param {PlayerState} state */
  savingThrowProficiencies(state) {
    const entry = this.chassisByZone[state.homeZone];
    return entry ? [...(entry.saving_throw_proficiencies || [])] : [];
  }

  /** @param {PlayerState} state */
  weaponProficiencies(state) {
    const entry = this.chassisByZone[state.homeZone];
    return entry ? { ...(entry.weapon_proficiencies || {}) } : {};
  }

  // -- search -------------------------------------------------------------

  /** @param {PlayerState} state */
  _fingerprint(state) {
    return `${state.homeZone}|${state.pointsSpent}|${state.owned.size}|${state.version}`;
  }

  /** @param {string} nodeId */
  _pathTo(nodeId) {
    const path = [];
    let cursor = nodeId;
    while (cursor !== null && cursor !== undefined) {
      path.push(cursor);
      cursor = this._prev.get(cursor) ?? null;
    }
    return path.reverse();
  }

  /** @param {PathEngine} _ @param {PlayerState} state */
  _ensureSearch(state) {
    const key = this._fingerprint(state);
    if (key === this._cacheKey) return;

    /** @type {Map<string, number>} */
    const dist = new Map();
    /** @type {Map<string, string|null>} */
    const prev = new Map();
    /** @type {Map<string, string[]>} */
    const blocked = new Map();

    const heap = new MinHeap();
    let sources = [...state.owned].filter((id) => this.nodes.has(id));
    if (!sources.length) sources = [HUB_ID];
    for (const id of sources) {
      dist.set(id, 0);
      prev.set(id, null);
      heap.push(0, id);
    }

    while (heap.size) {
      const { cost, id } = heap.pop();
      const known = dist.has(id) ? dist.get(id) : Infinity;
      if (cost > known) continue;

      for (const neighbour of this.adjacency.get(id) || []) {
        const step = this.nodeCost(neighbour, state);
        const newCost = cost + step;
        const currentBest = dist.has(neighbour) ? dist.get(neighbour) : Infinity;
        if (newCost >= currentBest) continue;

        if (!state.owned.has(neighbour)) {
          // walk the candidate path so prerequisites are checked against
          // everything the player would own on arrival
          const acquired = new Set();
          let cursor = id;
          while (cursor !== null && cursor !== undefined) {
            acquired.add(cursor);
            cursor = prev.get(cursor) ?? null;
          }
          const ownedThen = new Set(state.owned);
          for (const owned of acquired) ownedThen.add(owned);
          const spentThen = state.pointsSpent + newCost;
          const node = this.nodes.get(neighbour);
          const requirements = (node && node.prereqs) || EMPTY_PREREQS;
          if (!satisfied(requirements, ownedThen, spentThen)) {
            if (!blocked.has(neighbour)) {
              blocked.set(neighbour, unmetReasons(node, ownedThen, spentThen));
            }
            continue;
          }
          blocked.delete(neighbour);
        }

        dist.set(neighbour, newCost);
        prev.set(neighbour, id);
        heap.push(newCost, neighbour);
      }
    }

    this._cacheKey = key;
    this._dist = dist;
    this._prev = prev;
    this._blocked = blocked;
  }

  // -- public API ---------------------------------------------------------

  /**
   * @param {PlayerState} state
   * @param {string} targetId
   * @returns {{affordable: boolean, path: string[], total_cost: number|null,
   *            reason: string, blocking_prereqs: string[], new_nodes?: string[],
   *            points_remaining_after?: number}}
   */
  canAfford(state, targetId) {
    if (!this.nodes.has(targetId)) {
      return {
        affordable: false,
        path: [],
        total_cost: null,
        reason: 'unknown_node',
        blocking_prereqs: [],
      };
    }

    if (state.owned.has(targetId)) {
      return {
        affordable: true,
        path: [targetId],
        total_cost: 0,
        reason: 'already_owned',
        blocking_prereqs: [],
        new_nodes: [],
      };
    }

    this._ensureSearch(state);

    if (!this._dist.has(targetId)) {
      const blocked = this._blocked.get(targetId) || [];
      return {
        affordable: false,
        path: [],
        total_cost: null,
        reason: blocked.length ? 'unmet_prerequisites' : 'unreachable',
        blocking_prereqs: blocked,
      };
    }

    const totalCost = this._dist.get(targetId);
    const path = this._pathTo(targetId);
    const budget = state.pointsTotal - state.pointsSpent;
    const newNodes = path.filter((id) => !state.owned.has(id));
    return {
      affordable: totalCost <= budget,
      path,
      total_cost: totalCost,
      reason: totalCost <= budget ? 'ok' : 'insufficient_points',
      blocking_prereqs: [],
      new_nodes: newNodes,
      points_remaining_after: budget - totalCost,
    };
  }

  /**
   * Buy the target and everything on the cheapest path to it.
   * @param {PlayerState} state
   * @param {string} targetId
   */
  allocate(state, targetId) {
    const result = this.canAfford(state, targetId);
    if (!result.affordable) return result;
    for (const id of result.path) {
      if (state.owned.has(id)) continue;
      state.pointsSpent += this.nodeCost(id, state);
      state.owned.add(id);
    }
    state.touch();
    return result;
  }

  /**
   * A fresh character: standing on the hub, inside their home zone's gate.
   * @param {string} homeZone
   * @param {number} [pointsTotal]
   */
  startState(homeZone, pointsTotal = this.budget) {
    const state = new PlayerState({ homeZone, pointsTotal });
    const gate = `gate_${homeZone.toLowerCase()}`;
    if (this.nodes.has(gate)) state.owned.add(gate);
    return state;
  }

  /**
   * Distances to every node under the current state, for bulk UI colouring.
   * @param {PlayerState} state
   * @returns {{dist: Map<string, number>, blocked: Map<string, string[]>}}
   */
  reachability(state) {
    this._ensureSearch(state);
    return { dist: this._dist, blocked: this._blocked };
  }
}
