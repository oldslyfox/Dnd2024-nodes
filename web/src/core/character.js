/**
 * Character state operations on top of the engine: allocate, deallocate, respec.
 *
 * Deallocate was a stretch goal in Work Order 3 Task 5. It is implemented, and
 * deliberately conservative: a node can only be removed if the build still holds
 * together without it. "Leaf-only" in the work order's sense means exactly this -
 * removing it must not orphan another owned node from the hub, and must not
 * invalidate another owned node's prerequisites (including point thresholds,
 * which drop when the refund lands).
 *
 * No UI dependencies.
 */

import { PathEngine, PlayerState, HUB_ID } from './engine.js';
import { satisfied } from './prereqs.js';

/**
 * What a node costs this character right now, ignoring the fact they own it.
 * @param {PathEngine} engine
 * @param {PlayerState} state
 * @param {string} nodeId
 */
export function priceOf(engine, state, nodeId) {
  const owned = state.owned.has(nodeId);
  if (owned) state.owned.delete(nodeId);
  const cost = engine.nodeCost(nodeId, state);
  if (owned) state.owned.add(nodeId);
  return cost;
}

/**
 * Can this node be given back without breaking the rest of the build?
 * @param {PathEngine} engine
 * @param {PlayerState} state
 * @param {string} nodeId
 * @returns {{ok: boolean, reason: string, refund: number}}
 */
export function canDeallocate(engine, state, nodeId) {
  if (!state.owned.has(nodeId)) {
    return { ok: false, reason: 'not owned', refund: 0 };
  }
  if (nodeId === HUB_ID) {
    return { ok: false, reason: 'the hub is where you stand', refund: 0 };
  }
  const node = engine.node(nodeId);
  if (node && node.is_gate && node.zone === state.homeZone) {
    return { ok: false, reason: 'your starting zone gate is part of your chassis', refund: 0 };
  }

  const refund = priceOf(engine, state, nodeId);
  const remaining = new Set(state.owned);
  remaining.delete(nodeId);
  const spentAfter = state.pointsSpent - refund;

  // still connected: every remaining owned node reachable from the hub through
  // owned nodes only
  const seen = new Set();
  const queue = [HUB_ID];
  if (remaining.has(HUB_ID)) seen.add(HUB_ID);
  while (queue.length) {
    const current = queue.pop();
    for (const neighbour of engine.adjacency.get(current) || []) {
      if (remaining.has(neighbour) && !seen.has(neighbour)) {
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
  }
  for (const id of remaining) {
    if (!seen.has(id)) {
      return {
        ok: false,
        reason: `${engine.node(id)?.name || id} would be cut off from the hub`,
        refund,
      };
    }
  }

  // still legal: every remaining owned node's prerequisites still hold
  for (const id of remaining) {
    const other = engine.node(id);
    if (!other || !other.prereqs) continue;
    if (!satisfied(other.prereqs, remaining, spentAfter)) {
      return {
        ok: false,
        reason: `${other.name} needs it`,
        refund,
      };
    }
  }

  return { ok: true, reason: '', refund };
}

/**
 * @param {PathEngine} engine
 * @param {PlayerState} state
 * @param {string} nodeId
 */
export function deallocate(engine, state, nodeId) {
  const check = canDeallocate(engine, state, nodeId);
  if (!check.ok) return check;
  state.owned.delete(nodeId);
  state.pointsSpent -= check.refund;
  state.touch();
  return check;
}

/**
 * Full reset to a fresh character in the same starting zone.
 * @param {PathEngine} engine
 * @param {PlayerState} state
 */
export function respec(engine, state) {
  return engine.startState(state.homeZone, state.pointsTotal);
}

/**
 * A summary for the chassis panel - everything the starting zone locked in,
 * plus the running point count.
 * @param {PathEngine} engine
 * @param {PlayerState} state
 */
export function characterSummary(engine, state) {
  const chassis = engine.chassis(state);
  const ownedNodes = [...state.owned]
    .map((id) => engine.node(id))
    .filter(Boolean);
  const notable = ownedNodes.filter(
    (node) => node.type !== 'connector' && node.id !== HUB_ID,
  );
  return {
    homeZone: state.homeZone,
    hitDie: engine.hitDie(state),
    savingThrows: engine.savingThrowProficiencies(state),
    weapons: engine.weaponProficiencies(state),
    pointsSpent: state.pointsSpent,
    pointsTotal: state.pointsTotal,
    pointsRemaining: state.pointsRemaining,
    ownedCount: ownedNodes.length,
    notableCount: notable.length,
    chassisNote: chassis ? chassis.note : '',
  };
}
