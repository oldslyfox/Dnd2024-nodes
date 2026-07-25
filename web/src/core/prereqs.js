/**
 * Prerequisite evaluation - a faithful port of src/dnd2024/prereqs.py.
 *
 * Semantics, unchanged from Work Order 2:
 *   AND        own every id in `nodes`
 *   OR         own at least one id in `nodes`
 *   THRESHOLD  have spent at least `threshold_count` points, and satisfy the nodes
 *   groups     when present, authoritative: AND across groups, each group by its
 *              own logic
 *
 * @typedef {{logic: string, nodes: string[], threshold_count: number|null,
 *            groups?: {logic: string, nodes: string[]}[]}} Prereqs
 */

/** @type {Prereqs} */
export const EMPTY_PREREQS = {
  logic: 'AND',
  nodes: [],
  threshold_count: null,
  groups: [],
};

/**
 * @param {Prereqs} prereqs
 * @param {Set<string>} owned
 * @param {number} pointsSpent
 * @returns {boolean}
 */
export function satisfied(prereqs, owned, pointsSpent) {
  if (!prereqs) return true;

  if (prereqs.threshold_count !== null && prereqs.threshold_count !== undefined) {
    if (pointsSpent < prereqs.threshold_count) return false;
  }

  const groups = prereqs.groups;
  if (groups && groups.length) {
    for (const group of groups) {
      const nodes = group.nodes || [];
      if (!nodes.length) continue;
      if (group.logic === 'OR') {
        if (!nodes.some((id) => owned.has(id))) return false;
      } else if (!nodes.every((id) => owned.has(id))) {
        return false;
      }
    }
    return true;
  }

  const nodes = prereqs.nodes || [];
  if (!nodes.length) return true;
  if (prereqs.logic === 'OR') return nodes.some((id) => owned.has(id));
  return nodes.every((id) => owned.has(id));
}

/**
 * Human-readable reasons a node cannot be taken yet. Mirrors PathEngine._unmet.
 *
 * @param {{prereqs?: Prereqs}} node
 * @param {Set<string>} owned
 * @param {number} pointsSpent
 * @returns {string[]}
 */
export function unmetReasons(node, owned, pointsSpent) {
  const prereqs = node.prereqs || EMPTY_PREREQS;
  if (satisfied(prereqs, owned, pointsSpent)) return [];

  const reasons = [];
  const threshold = prereqs.threshold_count;
  if (threshold !== null && threshold !== undefined && pointsSpent < threshold) {
    reasons.push(`needs ${threshold} points spent (has ${pointsSpent})`);
  }

  let groups = prereqs.groups;
  if (!groups || !groups.length) {
    groups = (prereqs.nodes || []).length
      ? [{ logic: prereqs.logic || 'AND', nodes: prereqs.nodes }]
      : [];
  }

  for (const group of groups) {
    const nodes = group.nodes || [];
    if (!nodes.length) continue;
    if (group.logic === 'OR') {
      if (!nodes.some((id) => owned.has(id))) {
        reasons.push('needs one of: ' + nodes.join(', '));
      }
    } else {
      const missing = nodes.filter((id) => !owned.has(id));
      if (missing.length) reasons.push('needs: ' + missing.join(', '));
    }
  }
  return reasons;
}
