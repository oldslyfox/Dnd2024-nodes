/**
 * Visual identity: colour by zone, shape by node type (Work Order 3, Task 4).
 *
 * Procedural only - no pictorial icons. That was explicitly deferred to a future
 * content/art task, since it needs a licensed glyph set and a populated `tags`
 * field. Shape + colour is the complete visual vocabulary for this pass.
 */

/** Ring order colours: martial reds/oranges, primal greens, arcane blues/purples. */
export const ZONE_COLOURS = {
  Barbarian: '#c2453c',
  Fighter: '#d4703a',
  Paladin: '#d8a33c',
  Cleric: '#c9c15a',
  Druid: '#77b544',
  Ranger: '#3fa564',
  Rogue: '#37a08c',
  Artificer: '#3c93b0',
  Wizard: '#4478c8',
  Sorcerer: '#6a5fd0',
  Warlock: '#9250c8',
  Bard: '#c04fa8',
  Monk: '#c9486f',
  core: '#9aa3b2',
  commons: '#7e8796',
};

export const ZONE_FALLBACK = '#8d93a0';

/** @param {string} zone */
export function zoneColour(zone) {
  return ZONE_COLOURS[zone] || ZONE_FALLBACK;
}

/**
 * Shape vocabulary. Gates are checked before type because a gate is a connector
 * that must not read as filler.
 * @param {any} node
 * @returns {'dot'|'octagon'|'circle'|'diamond'|'hexagon'|'triangle'|'square'|'star'}
 */
export function nodeShape(node) {
  if (node.is_gate) return 'octagon';
  switch (node.type) {
    case 'class_feature':
      return 'circle';
    case 'subclass_feature':
      return 'diamond';
    case 'feat':
      return 'hexagon';
    case 'optional_feature':
      return 'triangle';
    case 'spell_slot':
      return 'square';
    case 'weapon_mastery':
      return 'star';
    case 'connector':
    default:
      return 'dot';
  }
}

/** World-space radius per node type. Connectors are deliberately small. */
export function nodeRadius(node) {
  if (node.is_gate) return 1.9;
  switch (node.type) {
    case 'connector':
      return 0.75;
    case 'class_feature':
      return 1.6;
    case 'subclass_feature':
      return 1.45;
    case 'feat':
      return 1.7;
    case 'optional_feature':
      return 1.35;
    case 'spell_slot':
      return 1.5;
    case 'weapon_mastery':
      return 1.7;
    default:
      return 1.3;
  }
}

/** The four allocation states from Task 4, plus the search/preview accents. */
export const STATE_STYLE = {
  owned: { alpha: 1, stroke: '#ffffff', strokeWidth: 0.42, dim: 0 },
  affordable: { alpha: 0.95, stroke: '#f2f5ff', strokeWidth: 0.22, dim: 0.15 },
  reachable: { alpha: 0.6, stroke: 'rgba(255,255,255,0.35)', strokeWidth: 0.14, dim: 0.45 },
  unreachable: { alpha: 0.28, stroke: 'rgba(255,255,255,0.12)', strokeWidth: 0, dim: 0.72 },
};

export const ACCENT = {
  preview: '#ffd166',
  previewEdge: 'rgba(255, 209, 102, 0.9)',
  search: '#7ef2c8',
  hover: '#ffffff',
  reference: 'rgba(255, 107, 107, 0.55)',
  edge: 'rgba(150, 162, 185, 0.30)',
  edgeOwned: 'rgba(255, 255, 255, 0.55)',
  background: '#0d0f15',
};

const shadeCache = new Map();

/**
 * Mix a colour toward the background by `amount`, so the four allocation states
 * read as one hue at different strengths rather than as four different hues.
 * @param {string} hex
 * @param {number} amount 0..1
 */
export function shade(hex, amount) {
  const key = `${hex}:${amount.toFixed(2)}`;
  const cached = shadeCache.get(key);
  if (cached) return cached;

  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const bg = { r: 13, g: 15, b: 21 };
  const mix = (channel, target) => Math.round(channel + (target - channel) * amount);
  const out = `rgb(${mix(r, bg.r)}, ${mix(g, bg.g)}, ${mix(b, bg.b)})`;
  shadeCache.set(key, out);
  return out;
}

/** Human-readable type label for the tooltip and legend. */
export function typeLabel(node) {
  if (node.is_gate) return 'Zone gate';
  return (
    {
      class_feature: 'Class feature',
      subclass_feature: 'Subclass feature',
      feat: 'Feat',
      optional_feature: 'Optional feature',
      spell_slot: 'Spell slots',
      weapon_mastery: 'Weapon mastery',
      connector: 'Connector',
    }[node.type] || node.type
  );
}
