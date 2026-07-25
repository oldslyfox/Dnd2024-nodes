/**
 * Core module tests: the UI-independence guarantee (Work Order 3, decision 4)
 * plus character state, storage and indexing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BuildStore,
  GraphIndex,
  MemoryStorage,
  PathEngine,
  PlayerState,
  buildSheet,
  canDeallocate,
  characterSummary,
  createSession,
  deallocate,
  respec,
  sheetToJSON,
  sheetToMarkdown,
} from '../src/core/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const coreDir = join(here, '../src/core');
const graph = JSON.parse(readFileSync(join(here, '../public/data/graph.v2.json'), 'utf8'));

test('core has no UI or browser dependency', () => {
  const banned = [
    /\bdocument\b/,
    /\bwindow\./,
    /\blocalStorage\b/,
    /\bnavigator\b/,
    /\bHTMLCanvas/,
    /from '\.\.\/app\//,
    /require\(/,
  ];
  for (const file of readdirSync(coreDir)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(join(coreDir, file), 'utf8');
    // strip block comments and line comments before scanning
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const pattern of banned) {
      assert.ok(
        !pattern.test(code),
        `src/core/${file} references ${pattern} - core must stay framework-agnostic`,
      );
    }
  }
});

test('core runs headless with nothing but a parsed graph', () => {
  const { index, engine } = createSession(graph);
  assert.ok(index instanceof GraphIndex);
  assert.ok(engine instanceof PathEngine);
  const state = engine.startState('Wizard');
  assert.equal(state.pointsTotal, graph.meta.point_economy.total_points_at_level_20);
});

// -- character state ------------------------------------------------------

test('allocate spends points and takes the whole path', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Wizard');
  const result = engine.allocate(state, 'cf_fighter_extra_attack_5');
  assert.equal(state.pointsSpent, result.total_cost);
  for (const id of result.path) assert.ok(state.owned.has(id));
});

test('deallocate refunds a leaf and refuses a load-bearing node', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Wizard');
  engine.allocate(state, 'cf_fighter_extra_attack_5');
  const spent = state.pointsSpent;

  // the destination is a leaf: nothing else depends on it
  const leaf = deallocate(engine, state, 'cf_fighter_extra_attack_5');
  assert.equal(leaf.ok, true);
  assert.equal(state.pointsSpent, spent - 1);
  assert.ok(!state.owned.has('cf_fighter_extra_attack_5'));

  // the gate is not: the rest of the Fighter path hangs off it
  engine.allocate(state, 'cf_fighter_extra_attack_5');
  const gate = canDeallocate(engine, state, 'gate_fighter');
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /cut off|needs it/);
});

test('deallocate refuses when another owned node still needs it', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Warlock', 500);
  engine.allocate(state, 'of_pact_of_the_blade_xphb');
  for (const node of graph.nodes) {
    if (state.pointsSpent >= 20) break;
    if (node.zone === 'Warlock' && node.type === 'class_feature') {
      engine.allocate(state, node.id);
    }
  }
  engine.allocate(state, 'of_thirsting_blade_xphb');
  assert.ok(state.owned.has('of_thirsting_blade_xphb'));

  const check = canDeallocate(engine, state, 'of_pact_of_the_blade_xphb');
  assert.equal(check.ok, false);
  assert.match(check.reason, /Thirsting Blade/);
});

test('home zone gate and hub cannot be refunded', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Monk');
  assert.equal(canDeallocate(engine, state, 'gate_monk').ok, false);
  assert.equal(canDeallocate(engine, state, 'conn_core_hub').ok, false);
});

test('respec returns a fresh character in the same zone', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Druid');
  engine.allocate(state, 'cf_druid_epic_boon_19');
  assert.ok(state.pointsSpent > 0);

  const fresh = respec(engine, state);
  assert.equal(fresh.homeZone, 'Druid');
  assert.equal(fresh.pointsSpent, 0);
  assert.deepEqual([...fresh.owned].sort(), ['conn_core_hub', 'gate_druid']);
});

test('character summary reports chassis and points', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Barbarian');
  engine.allocate(state, 'cf_barbarian_rage_1');
  const summary = characterSummary(engine, state);
  assert.equal(summary.homeZone, 'Barbarian');
  assert.deepEqual(summary.hitDie, { number: 1, faces: 12 });
  assert.deepEqual(summary.savingThrows, ['str', 'con']);
  assert.equal(summary.weapons.simple, true);
  assert.equal(summary.pointsRemaining, summary.pointsTotal - summary.pointsSpent);
  assert.ok(summary.notableCount >= 1);
});

// -- serialisation and storage -------------------------------------------

test('player state round-trips through JSON', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Bard');
  engine.allocate(state, 'slot_bard_t5');
  const restored = PlayerState.fromJSON(state.toJSON());
  assert.equal(restored.homeZone, state.homeZone);
  assert.equal(restored.pointsSpent, state.pointsSpent);
  assert.deepEqual([...restored.owned].sort(), [...state.owned].sort());
});

test('build store saves, lists, loads and removes', () => {
  const store = new BuildStore(new MemoryStorage());
  const { engine } = createSession(graph);
  const state = engine.startState('Rogue');
  engine.allocate(state, 'cf_rogue_sneak_attack_1');

  store.save('knife guy', state.toJSON());
  store.save('knife guy', state.toJSON()); // same name replaces, not duplicates
  assert.equal(store.list().length, 1);

  const loaded = PlayerState.fromJSON(store.load('knife guy'));
  assert.equal(loaded.homeZone, 'Rogue');
  assert.ok(loaded.owned.has('cf_rogue_sneak_attack_1'));

  store.remove('knife guy');
  assert.equal(store.list().length, 0);
  assert.equal(store.load('knife guy'), null);
});

test('build store survives a corrupt backend value', () => {
  const backend = new MemoryStorage();
  backend.setItem('dnd2024.tree.builds.v1', 'not json');
  assert.deepEqual(new BuildStore(backend).list(), []);
});

// -- indexing -------------------------------------------------------------

test('index splits traversable and reference edges', () => {
  const index = new GraphIndex(graph);
  assert.equal(
    index.structuralEdges.length + index.referenceEdges.length,
    graph.edges.length,
  );
  assert.ok(index.referenceEdges.every((edge) => edge.traversable === false));
});

test('spatial queries find the right nodes', () => {
  const index = new GraphIndex(graph);
  const target = index.byId.get('cf_wizard_spell_mastery_18');
  const hit = index.nodeAt(target.position_x, target.position_y, 1);
  assert.equal(hit.id, target.id);

  const inRect = index.nodesInRect(
    target.position_x - 3,
    target.position_y - 3,
    target.position_x + 3,
    target.position_y + 3,
  );
  assert.ok(inRect.some((node) => node.id === target.id));
  assert.ok(inRect.length < index.nodes.length);
});

test('search matches names, zones and types', () => {
  const index = new GraphIndex(graph);
  assert.ok(index.search('sneak attack').some((node) => node.id === 'cf_rogue_sneak_attack_1'));
  assert.ok(index.search('metamagic').length > 5);
  assert.equal(index.search('').length, 0);
  assert.ok(index.search('zzzznotathing').length === 0);
});

// -- layout separation (Work Order 5) -------------------------------------

/** Smallest gap the layout promises, in world units (config.MIN_NODE_SEPARATION). */
const MIN_SEPARATION = 1.8;

test('no two nodes are closer than the layout minimum', () => {
  const index = new GraphIndex(graph);
  let worst = Infinity;
  let worstPair = null;

  for (const node of graph.nodes) {
    const near = index.nodesInRect(
      node.position_x - MIN_SEPARATION,
      node.position_y - MIN_SEPARATION,
      node.position_x + MIN_SEPARATION,
      node.position_y + MIN_SEPARATION,
    );
    for (const other of near) {
      if (other === node) continue;
      const gap = Math.hypot(
        other.position_x - node.position_x,
        other.position_y - node.position_y,
      );
      if (gap < worst) {
        worst = gap;
        worstPair = [node.id, other.id];
      }
    }
  }

  assert.ok(
    worst >= MIN_SEPARATION - 0.01,
    `closest pair ${worstPair} is ${worst.toFixed(3)} apart, under the ${MIN_SEPARATION} minimum`,
  );
});

test('every shared node is individually pickable', () => {
  // The crowding that blocked mobile playtesting was in the commons and core:
  // shared content piled onto one ring per depth. Each must now resolve to
  // itself when picked at its own centre, and have room around it.
  const index = new GraphIndex(graph);
  const shared = graph.nodes.filter((node) => node.zone === 'commons' || node.zone === 'core');
  assert.ok(shared.length > 80, 'expected the shared rings to hold real content');

  for (const node of shared) {
    const hit = index.nodeAt(node.position_x, node.position_y, MIN_SEPARATION / 2, {
      preferNotable: true,
    });
    assert.equal(hit && hit.id, node.id, `${node.id} is not pickable at its own centre`);
  }
});

test('shared categories sit on their own sub-rings', () => {
  // Task 3: General Feats, Fighting Styles, Epic Boons, ASI repeats and weapon
  // masteries used to share one circle per depth. Each category should now own a
  // distinct radius band at any depth where several of them coexist.
  const byDepth = new Map();
  for (const node of graph.nodes) {
    if (node.zone !== 'commons' && node.zone !== 'core') continue;
    if (node.id === 'conn_core_hub') continue;
    const key = node.depth;
    if (!byDepth.has(key)) byDepth.set(key, new Map());
    const category = node.repeat_chain ? 'repeat_chain' : node.role || node.type;
    const radius = Math.hypot(node.position_x, node.position_y);
    const bucket = byDepth.get(key);
    if (!bucket.has(category)) bucket.set(category, []);
    bucket.get(category).push(radius);
  }

  let checked = 0;
  for (const [depth, categories] of byDepth) {
    if (categories.size < 2) continue;
    const bands = [...categories.entries()]
      .map(([category, radii]) => ({
        category,
        min: Math.min(...radii),
        max: Math.max(...radii),
      }))
      .sort((a, b) => a.min - b.min);

    for (let i = 1; i < bands.length; i += 1) {
      assert.ok(
        bands[i].min > bands[i - 1].min,
        `at depth ${depth}, ${bands[i].category} shares a radius with ${bands[i - 1].category}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 3, 'expected several depths to carry more than one shared category');
});

test('depth ordering survived the spacing fix', () => {
  // Task 2d is the balance mechanism: a depth-4 node must still sit strictly
  // inside every depth-5 node, whatever the packer did to make room.
  const byDepth = new Map();
  for (const node of graph.nodes) {
    const radius = Math.hypot(node.position_x, node.position_y);
    const bucket = byDepth.get(node.depth) || { min: Infinity, max: -Infinity };
    bucket.min = Math.min(bucket.min, radius);
    bucket.max = Math.max(bucket.max, radius);
    byDepth.set(node.depth, bucket);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (let i = 1; i < depths.length; i += 1) {
    const inner = byDepth.get(depths[i - 1]);
    const outer = byDepth.get(depths[i]);
    assert.ok(
      outer.min >= inner.max - 0.01,
      `depth ${depths[i]} starts at ${outer.min.toFixed(1)}, inside depth ${
        depths[i - 1]
      } which reaches ${inner.max.toFixed(1)}`,
    );
  }
});

test('every class zone has a chassis the UI can render', () => {
  const index = new GraphIndex(graph);
  for (const zone of index.classZones()) {
    const chassis = index.chassisByZone[zone];
    assert.ok(chassis.hit_die.faces, zone);
    assert.equal(chassis.saving_throw_proficiencies.length, 2, zone);
    assert.ok(chassis.weapon_proficiencies.summary, zone);
  }
});

// -- Work Order 6: the character sheet and its exports ---------------------

/**
 * The build from the playtest that triggered this work order: a Fighter who
 * splashed Paladin, Barbarian and Bard. Every assertion below runs against it,
 * because a single-zone character would not exercise the grouping at all.
 */
function splashBuild() {
  const { index, engine } = createSession(graph);
  const state = engine.startState('Fighter');
  const ids = [
    'cf_fighter_second_wind_1',
    'cf_fighter_action_surge_2',
    'cf_fighter_extra_attack_5',
    'scf_fighter_champion_improved_critical_3',
    'mastery_cleave_xphb',
    'feat_alert_xphb',
    'cf_paladin_lay_on_hands_1',
    'slot_paladin_t2',
    'cf_barbarian_rage_1',
    'cf_bard_bardic_inspiration_1',
  ];
  for (const id of ids) {
    const result = engine.allocate(state, id);
    assert.ok(result.affordable, `could not build the splash: ${id} (${result.reason})`);
  }
  return { index, engine, state, ids };
}

test('the sheet covers every owned real node', () => {
  const { engine, state } = splashBuild();
  const sheet = buildSheet(engine, state);

  const onSheet = new Set(sheet.groups.flatMap((group) => group.entries.map((e) => e.id)));
  const real = [...state.owned]
    .map((id) => engine.node(id))
    .filter((node) => node.type !== 'connector' && node.id !== 'conn_core_hub');

  assert.equal(onSheet.size, real.length);
  for (const node of real) {
    assert.ok(onSheet.has(node.id), `${node.id} is owned but missing from the sheet`);
  }
  // connectors and gates are counted, but deliberately not listed as content
  assert.ok(sheet.counts.connectors > 0);
  for (const id of onSheet) assert.notEqual(engine.node(id).type, 'connector');
});

test('the sheet groups by zone, home zone first, shared content last', () => {
  const { engine, state } = splashBuild();
  const sheet = buildSheet(engine, state);

  assert.equal(sheet.groups[0].title, 'Fighter');
  assert.equal(sheet.groups[0].subtitle, 'starting zone');

  const titles = sheet.groups.map((group) => group.title);
  for (const zone of ['Barbarian', 'Paladin', 'Bard']) assert.ok(titles.includes(zone));
  assert.ok(titles.includes('Weapon masteries'));
  assert.ok(titles.includes('Origin feats'));

  // every zone group comes before every shared group
  const lastZone = sheet.groups.findLastIndex((group) => group.zone !== null);
  const firstShared = sheet.groups.findIndex((group) => group.zone === null);
  assert.ok(lastZone < firstShared);
});

test('the sheet derives aggregates from the nodes it owns', () => {
  const { engine, state } = splashBuild();
  const sheet = buildSheet(engine, state);

  assert.deepEqual(sheet.highlights.zonesEntered, ['Fighter', 'Barbarian', 'Paladin', 'Bard']);
  assert.deepEqual(sheet.highlights.weaponMasteries, ['Cleave']);
  assert.deepEqual(
    sheet.highlights.subclasses.map((entry) => entry.subclass),
    ['Champion'],
  );

  const paladin = sheet.highlights.spellcasting.find((entry) => entry.zone === 'Paladin');
  assert.ok(paladin, 'the Paladin slot spine should show up as spellcasting');
  assert.equal(paladin.chassis, 'half');
  assert.equal(paladin.maxTier, 2);

  assert.equal(sheet.chassis.hitDie.faces, 10);
  assert.deepEqual(sheet.chassis.savingThrows, ['str', 'con']);
  assert.equal(sheet.points.spent, state.pointsSpent);
  assert.equal(sheet.points.remaining, state.pointsTotal - state.pointsSpent);
});

test('the Markdown export is readable standalone and names every owned node', () => {
  const { engine, state } = splashBuild();
  const sheet = buildSheet(engine, state);
  const markdown = sheetToMarkdown(sheet);

  assert.match(markdown, /^# .*D&D 2024 skill tree/m);
  assert.match(markdown, /\*\*Hit die\*\* d10/);
  assert.match(markdown, /\*\*Saving throws\*\* STR, CON/);
  assert.match(markdown, /## At a glance/);
  assert.match(markdown, /## Fighter \(starting zone\)/);

  for (const group of sheet.groups) {
    for (const entry of group.entries) {
      assert.ok(markdown.includes(entry.name), `${entry.name} is missing from the export`);
    }
  }
  // and it says what the things do, so it stands on its own away from the app
  assert.ok(markdown.includes('Second Wind'));
  assert.match(markdown, /Bonus Action/i);
});

test('the JSON export round-trips back into a playable state', () => {
  const { engine, state } = splashBuild();
  const sheet = buildSheet(engine, state);
  const payload = JSON.parse(JSON.stringify(sheetToJSON(state, sheet)));

  assert.equal(payload.format, 'dnd2024-skill-tree-build');
  assert.equal(payload.summary.points.spent, state.pointsSpent);
  assert.equal(payload.nodes.length, sheet.counts.features);

  const restored = PlayerState.fromJSON(payload.build);
  assert.deepEqual([...restored.owned].sort(), [...state.owned].sort());
  assert.equal(restored.pointsSpent, state.pointsSpent);
  assert.equal(restored.homeZone, 'Fighter');
  // and the restored character behaves identically
  assert.deepEqual(
    engine.canAfford(restored, 'cf_fighter_indomitable_9'),
    engine.canAfford(state, 'cf_fighter_indomitable_9'),
  );
});

test('a fresh character has an empty sheet rather than a broken one', () => {
  const { engine } = createSession(graph);
  const state = engine.startState('Monk');
  const sheet = buildSheet(engine, state);
  assert.equal(sheet.counts.features, 0);
  assert.deepEqual(sheet.groups, []);
  assert.deepEqual(sheet.highlights.zonesEntered, ['Monk']);
  assert.match(sheetToMarkdown(sheet), /Monk/);
});
