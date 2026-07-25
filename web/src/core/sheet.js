/**
 * Character sheet: what the build actually *is* (Work Order 6, Tasks 3 & 4).
 *
 * The playtest could build a character but could not read one back, which also
 * meant the Work Order 2 budget-generosity question had nothing to look at. This
 * module turns a `PlayerState` into a structured summary, and renders that
 * summary to Markdown and to JSON.
 *
 * Everything here is derived from data already on the nodes - `engine.chassis()`
 * for the chassis, `slot_tier` for spellcasting, `role`/`category` for the
 * groupings. Nothing is recomputed and nothing is invented.
 *
 * Core module: no DOM, no framework, no imports beyond the engine's own helpers,
 * so the Foundry wrapper gets the sheet and the export for free.
 */

import { HUB_ID } from './engine.js';
import { characterSummary } from './character.js';

const TYPE_LABELS = {
  class_feature: 'Class feature',
  subclass_feature: 'Subclass feature',
  feat: 'Feat',
  optional_feature: 'Optional feature',
  spell_slot: 'Spell slots',
  weapon_mastery: 'Weapon mastery',
  connector: 'Connector',
};

/** Shared content is grouped by what it *is*; class content by which zone it came from. */
const SHARED_GROUPS = [
  { key: 'feat_origin', title: 'Origin feats' },
  { key: 'feat_general', title: 'General feats' },
  { key: 'feat_fighting_style', title: 'Fighting styles' },
  { key: 'weapon_mastery', title: 'Weapon masteries' },
  { key: 'feat_epic_boon', title: 'Epic boons' },
  { key: 'training', title: 'Training' },
  { key: 'core', title: 'Core' },
  { key: 'commons', title: 'Shared' },
];

const CASTER_LABEL = {
  full: 'full caster',
  half: 'half caster',
  third: 'third caster',
  pact: 'pact magic',
};

const ORDINAL = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/** @param {any} node */
export function typeLabelOf(node) {
  if (node.is_gate) return 'Zone gate';
  return TYPE_LABELS[node.type] || node.type;
}

/** Fighting-style roles carry a class suffix (`feat_fighting_style_paladin`). */
function sharedKey(node) {
  const role = node.role || '';
  if (role.startsWith('feat_fighting_style')) return 'feat_fighting_style';
  if (SHARED_GROUPS.some((group) => group.key === role)) return role;
  if (node.type === 'weapon_mastery') return 'weapon_mastery';
  if (node.type === 'feat') return 'feat_general';
  return 'commons';
}

/** The one line under a node's name: what it is, where it came from, when. */
function detailOf(node) {
  const parts = [typeLabelOf(node)];
  if (node.subclass) parts.push(node.subclass);
  else if (node.subregion) parts.push(node.subregion);
  if (node.feature_type_labels && node.feature_type_labels.length) {
    parts.push(node.feature_type_labels.join(', ').replace(/_/g, ' '));
  }
  if (node.level) parts.push(`level ${node.level}`);
  else if (node.depth) parts.push(`depth ${node.depth}`);
  return parts.join(' · ');
}

/**
 * A complete, readable summary of a built character.
 *
 * @param {import('./engine.js').PathEngine} engine
 * @param {import('./engine.js').PlayerState} state
 */
export function buildSheet(engine, state) {
  const summary = characterSummary(engine, state);
  const zoneOrder = (engine.graph.meta && engine.graph.meta.zones) || [];
  const owned = [...state.owned].map((id) => engine.node(id)).filter(Boolean);

  const real = owned.filter((node) => node.type !== 'connector' && node.id !== HUB_ID);
  const connectors = owned.filter((node) => node.type === 'connector' || node.id === HUB_ID);
  const gates = connectors.filter((node) => node.is_gate);

  // -- groups: class zones first (home zone leading), shared content after ---
  /** @type {Map<string, {key: string, title: string, zone: string|null, entries: any[]}>} */
  const groups = new Map();
  const push = (key, title, zone, node) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, title, zone, entries: [] };
      groups.set(key, group);
    }
    group.entries.push({
      id: node.id,
      name: node.name,
      type: node.type,
      typeLabel: typeLabelOf(node),
      detail: detailOf(node),
      zone: node.zone,
      subclass: node.subclass || node.subregion || null,
      level: node.level || null,
      depth: node.depth,
      summary: node.effect_summary || '',
    });
  };

  for (const node of real) {
    if (node.zone === 'core' || node.zone === 'commons') {
      const key = sharedKey(node);
      const meta = SHARED_GROUPS.find((group) => group.key === key);
      push(`shared:${key}`, meta ? meta.title : 'Shared', null, node);
    } else {
      push(`zone:${node.zone}`, node.zone, node.zone, node);
    }
  }

  const rank = (group) => {
    if (group.zone === state.homeZone) return [0, 0];
    if (group.zone) return [1, zoneOrder.indexOf(group.zone)];
    return [2, SHARED_GROUPS.findIndex((entry) => `shared:${entry.key}` === group.key)];
  };
  const orderedGroups = [...groups.values()].sort((a, b) => {
    const [aTier, aIndex] = rank(a);
    const [bTier, bIndex] = rank(b);
    return aTier - bTier || aIndex - bIndex || a.title.localeCompare(b.title);
  });
  for (const group of orderedGroups) {
    group.entries.sort(
      (a, b) => (a.depth || 0) - (b.depth || 0) || a.name.localeCompare(b.name),
    );
    if (group.zone === state.homeZone) group.subtitle = 'starting zone';
  }

  // -- aggregates, all read off nodes the character already owns -------------
  const spellcasting = [];
  const byZone = new Map();
  for (const node of real) {
    if (node.type !== 'spell_slot') continue;
    const zone = node.zone;
    if (!byZone.has(zone)) {
      byZone.set(zone, { zone, chassis: node.caster_chassis || null, tiers: [], warlock: [] });
    }
    const entry = byZone.get(zone);
    if (typeof node.slot_tier === 'number') entry.tiers.push(node.slot_tier);
    else entry.warlock.push(node.name);
  }
  for (const entry of byZone.values()) {
    entry.tiers.sort((a, b) => a - b);
    entry.maxTier = entry.tiers.length ? entry.tiers[entry.tiers.length - 1] : null;
    entry.label = CASTER_LABEL[entry.chassis] || entry.chassis || 'caster';
    spellcasting.push(entry);
  }
  spellcasting.sort((a, b) => a.zone.localeCompare(b.zone));

  const namesOf = (predicate) =>
    real
      .filter(predicate)
      .map((node) => node.name)
      .sort((a, b) => a.localeCompare(b));

  const subclasses = [];
  const seenSubclass = new Set();
  for (const node of real) {
    const name = node.subclass || (node.type === 'subclass_feature' ? node.subregion : null);
    if (!name) continue;
    const key = `${node.zone}|${name}`;
    if (seenSubclass.has(key)) continue;
    seenSubclass.add(key);
    subclasses.push({
      zone: node.zone,
      subclass: name,
      count: real.filter((other) => other.zone === node.zone && other.subclass === name).length,
    });
  }
  subclasses.sort((a, b) => a.zone.localeCompare(b.zone) || a.subclass.localeCompare(b.subclass));

  const zonesEntered = gates
    .map((gate) => gate.zone)
    .sort((a, b) => {
      if (a === state.homeZone) return -1;
      if (b === state.homeZone) return 1;
      return zoneOrder.indexOf(a) - zoneOrder.indexOf(b);
    });

  return {
    homeZone: state.homeZone,
    chassis: {
      hitDie: summary.hitDie,
      savingThrows: summary.savingThrows,
      weapons: summary.weapons,
      note: summary.chassisNote,
    },
    points: {
      spent: summary.pointsSpent,
      total: summary.pointsTotal,
      remaining: summary.pointsRemaining,
    },
    counts: {
      owned: owned.length,
      features: real.length,
      connectors: connectors.length,
      gates: gates.length,
    },
    groups: orderedGroups,
    highlights: {
      zonesEntered,
      spellcasting,
      weaponMasteries: namesOf((node) => node.type === 'weapon_mastery'),
      fightingStyles: namesOf((node) => (node.role || '').startsWith('feat_fighting_style')),
      epicBoons: namesOf((node) => node.role === 'feat_epic_boon'),
      originFeats: namesOf((node) => node.role === 'feat_origin'),
      generalFeats: namesOf((node) => node.role === 'feat_general'),
      subclasses,
      abilityScoreImprovements: real.filter((node) => (node.ability_grants || []).length).length,
    },
  };
}

/** `1st`, `2nd`, … for slot tiers. */
function ordinal(tier) {
  return ORDINAL[tier] || `${tier}th`;
}

/**
 * The "at a glance" block, as lines. Shared by the Markdown export and the
 * in-app sheet so the two can never drift apart.
 * @param {ReturnType<typeof buildSheet>} sheet
 */
export function highlightLines(sheet) {
  const high = sheet.highlights;
  const lines = [];
  lines.push({
    label: 'Zones entered',
    value: high.zonesEntered
      .map((zone) => (zone === sheet.homeZone ? `${zone} (home)` : zone))
      .join(', '),
  });
  if (high.subclasses.length) {
    lines.push({
      label: 'Subclasses',
      value: high.subclasses
        .map((entry) => `${entry.subclass} (${entry.zone}, ${entry.count})`)
        .join(', '),
    });
  }
  for (const entry of high.spellcasting) {
    const detail = entry.maxTier
      ? `slots to ${ordinal(entry.maxTier)} level`
      : entry.warlock.join(', ');
    lines.push({ label: `Spellcasting · ${entry.zone}`, value: `${entry.label} — ${detail}` });
  }
  if (high.weaponMasteries.length) {
    lines.push({ label: 'Weapon masteries', value: high.weaponMasteries.join(', ') });
  }
  if (high.fightingStyles.length) {
    lines.push({ label: 'Fighting styles', value: high.fightingStyles.join(', ') });
  }
  if (high.epicBoons.length) {
    lines.push({ label: 'Epic boons', value: high.epicBoons.join(', ') });
  }
  if (high.abilityScoreImprovements) {
    lines.push({
      label: 'Ability Score Improvements',
      value: String(high.abilityScoreImprovements),
    });
  }
  return lines;
}

/**
 * Markdown export (Task 4). Readable as plain text with no renderer, which is
 * the "genuinely usable standalone" bar: it opens in any editor, pastes into a
 * Discord message or a session prep doc, and needs nothing from this app.
 *
 * @param {ReturnType<typeof buildSheet>} sheet
 * @param {{summaries?: boolean, title?: string}} [options]
 */
export function sheetToMarkdown(sheet, { summaries = true, title } = {}) {
  const die = sheet.chassis.hitDie ? `d${sheet.chassis.hitDie.faces}` : '—';
  const saves = (sheet.chassis.savingThrows || []).join(', ').toUpperCase() || '—';
  const weapons = (sheet.chassis.weapons && sheet.chassis.weapons.summary) || '—';
  const out = [];

  out.push(`# ${title || `${sheet.homeZone} build`} — D&D 2024 skill tree`);
  out.push('');
  out.push(`- **Starting zone** ${sheet.homeZone} (locked at creation)`);
  out.push(`- **Hit die** ${die}`);
  out.push(`- **Saving throws** ${saves}`);
  out.push(`- **Weapons** ${weapons}`);
  out.push(
    `- **Points** ${sheet.points.spent} of ${sheet.points.total} spent, ${sheet.points.remaining} left`,
  );
  out.push(
    `- **Nodes** ${sheet.counts.features} features, ${sheet.counts.connectors} connectors and gates`,
  );
  out.push('');

  out.push('## At a glance');
  out.push('');
  for (const line of highlightLines(sheet)) out.push(`- **${line.label}:** ${line.value}`);
  out.push('');

  for (const group of sheet.groups) {
    out.push(`## ${group.title}${group.subtitle ? ` (${group.subtitle})` : ''}`);
    out.push('');
    for (const entry of group.entries) {
      out.push(`- **${entry.name}** — ${entry.detail}`);
      if (summaries && entry.summary) out.push(`  - ${entry.summary.replace(/\s+/g, ' ').trim()}`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    'Generated by the D&D 2024 skill-tree renderer. Every node costs 1 point; a node\'s real cost is the path taken to reach it.',
  );
  return `${out.join('\n')}\n`;
}

/**
 * JSON export: the raw owned-node id list plus enough context to reload it.
 *
 * Deliberately the same shape `PlayerState.toJSON()` produces, so this file
 * round-trips straight back into the app (and is honest groundwork for a future
 * Foundry import without being one).
 *
 * @param {import('./engine.js').PlayerState} state
 * @param {ReturnType<typeof buildSheet>} sheet
 * @param {{name?: string}} [options]
 */
export function sheetToJSON(state, sheet, { name } = {}) {
  return {
    format: 'dnd2024-skill-tree-build',
    version: 1,
    name: name || `${sheet.homeZone} build`,
    build: state.toJSON(),
    summary: {
      homeZone: sheet.homeZone,
      hitDie: sheet.chassis.hitDie,
      savingThrows: sheet.chassis.savingThrows,
      weapons: sheet.chassis.weapons,
      points: sheet.points,
      counts: sheet.counts,
      zonesEntered: sheet.highlights.zonesEntered,
      subclasses: sheet.highlights.subclasses,
      spellcasting: sheet.highlights.spellcasting.map((entry) => ({
        zone: entry.zone,
        chassis: entry.chassis,
        maxTier: entry.maxTier,
        tiers: entry.tiers,
      })),
      weaponMasteries: sheet.highlights.weaponMasteries,
      fightingStyles: sheet.highlights.fightingStyles,
    },
    nodes: sheet.groups.flatMap((group) =>
      group.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        zone: entry.zone,
        level: entry.level,
      })),
    ),
  };
}
