/**
 * UI shell: DOM wiring, interaction, panels.
 *
 * Everything that decides *what is true* lives in ../core (engine, character
 * state, storage). This file only decides what is on screen. That boundary is
 * the point of Work Order 3's decision 4 - a Foundry wrapper replaces this file
 * and keeps the rest.
 *
 * Work Order 4 changed the interaction primitive: selecting a node and then
 * confirming, rather than hover-preview plus click-to-allocate. One model on
 * both touch and desktop - a tap on a phone and a click on a laptop do the same
 * thing, and neither of them spends points by accident.
 */

import {
  BuildStore,
  GraphIndex,
  PathEngine,
  PlayerState,
  canDeallocate,
  characterSummary,
  deallocate,
} from '../core/index.js';
import { Camera } from './camera.js';
import { Renderer } from './renderer.js';
import { PointerInput } from './input.js';
import { ACCENT, nodeShape, typeLabel, zoneColour } from './style.js';
import { graphDataUrl, loadGraph } from './data.js';

const el = (id) => document.getElementById(id);
const PHONE_BREAKPOINT = 760;
const SHORT_BREAKPOINT = 560;

const dom = {
  canvas: el('tree'),
  stats: el('graph-stats'),
  search: el('search'),
  searchCount: el('search-count'),
  searchMobile: el('search-mobile'),
  searchCountMobile: el('search-count-mobile'),
  searchResults: el('search-results'),
  references: el('toggle-references'),
  referencesMobile: el('toggle-references-mobile'),
  fit: el('btn-fit'),
  fitMobile: el('btn-fit-mobile'),
  respec: el('btn-respec'),
  respecMobile: el('btn-respec-mobile'),
  chassis: el('chassis-body'),
  buildName: el('build-name'),
  buildList: el('build-list'),
  buildStatus: el('build-status'),
  save: el('btn-save'),
  load: el('btn-load'),
  del: el('btn-delete'),
  detailBody: el('detail-body'),
  detailActions: el('detail-actions'),
  allocate: el('btn-allocate'),
  deallocate: el('btn-deallocate'),
  onboarding: el('onboarding'),
  zoneGrid: el('zone-grid'),
  zoneDetail: el('zone-detail'),
  statusLeft: el('status-left'),
  statusRight: el('status-right'),
  legend: el('legend-canvas'),
  tabbar: el('tabbar'),
  pointsPill: el('points-pill'),
  pointsPillValue: el('points-pill-value'),
  panels: {
    character: el('panel-character'),
    detail: el('panel-detail'),
    search: el('panel-search'),
  },
};

const app = {
  /** @type {GraphIndex} */ index: null,
  /** @type {PathEngine} */ engine: null,
  /** @type {Renderer} */ renderer: null,
  /** @type {Camera} */ camera: new Camera(),
  /** @type {PlayerState} */ state: null,
  /** @type {PointerInput} */ input: null,
  store: new BuildStore(globalThis.localStorage),
  /** @type {any} the selected node - the whole interaction hangs off this */
  selected: null,
  /** @type {any} */ selectionResult: null,
  openSheet: 'none',
  dirty: true,
};

/**
 * Compact layout: panels are bottom sheets, not sidebars. Height matters as
 * much as width - a phone in landscape is 915x412, wider than any width-only
 * breakpoint would catch but with no room for side panels at all.
 */
const isPhone = () =>
  window.innerWidth <= PHONE_BREAKPOINT || window.innerHeight <= SHORT_BREAKPOINT;

// -- boot -----------------------------------------------------------------

async function boot() {
  const graph = await loadGraph();
  app.index = new GraphIndex(graph);
  app.engine = new PathEngine(graph);
  app.renderer = new Renderer(dom.canvas, app.index, app.engine, app.camera);

  dom.stats.textContent = `${graph.nodes.length} nodes · ${app.index.structuralEdges.length} edges · ${app.index.budget} points at level 20`;

  app.renderer.resize();
  app.camera.fit(app.index.bounds);
  drawLegend();
  buildZonePicker();
  refreshBuildList();
  wireEvents();
  loop();
}

// -- starting zone --------------------------------------------------------

function buildZonePicker() {
  dom.zoneGrid.innerHTML = '';
  for (const zone of app.index.classZones()) {
    const chassis = app.index.chassisByZone[zone] || {};
    const status = app.index.zoneStatus[zone] || {};
    const button = document.createElement('button');
    button.className = `zone-card${status.extracted_nodes === 0 ? ' empty' : ''}`;
    button.style.color = zoneColour(zone);
    button.innerHTML = `<strong>${zone}</strong><span>d${
      chassis.hit_die ? chassis.hit_die.faces : '?'
    } · ${(chassis.saving_throw_proficiencies || []).join(', ').toUpperCase()}</span>`;
    const describe = () => {
      dom.zoneDetail.textContent = `${zone}: d${chassis.hit_die.faces} hit die, ${(
        chassis.saving_throw_proficiencies || []
      )
        .join(' and ')
        .toUpperCase()} saves, ${chassis.weapon_proficiencies.summary}.`;
    };
    button.addEventListener('mouseenter', describe);
    button.addEventListener('focus', describe);
    button.addEventListener('click', () => startIn(zone));
    dom.zoneGrid.appendChild(button);
  }
}

/** @param {string} zone */
function startIn(zone) {
  app.state = app.engine.startState(zone, app.index.budget);
  app.renderer.setState(app.state);
  dom.onboarding.hidden = true;
  focusZone(zone);
  select(null);
  refreshChassis();
  markDirty();
}

function focusZone(zone) {
  const gate = app.index.byId.get(`gate_${zone.toLowerCase()}`);
  if (!gate) return;
  const angle = Math.atan2(gate.position_y, gate.position_x);
  app.camera.centreOn(Math.cos(angle) * 24, Math.sin(angle) * 24, isPhone() ? 7 : 9);
}

// -- selection: the one interaction primitive -----------------------------

/**
 * Select a node (or clear with null). Selecting never spends points - it fills
 * the detail panel and highlights the path the Allocate button would buy.
 * @param {any} node
 * @param {{openSheet?: boolean}} [options]
 */
function select(node, { openSheet = false } = {}) {
  app.selected = node;
  app.renderer.selectedId = node ? node.id : null;

  if (!node || !app.state) {
    app.selectionResult = null;
    app.renderer.previewPath = [];
    dom.detailBody.innerHTML = '<p class="muted small">Tap or click a node to select it.</p>';
    dom.detailActions.hidden = true;
    markDirty();
    return;
  }

  const result = app.engine.canAfford(app.state, node.id);
  app.selectionResult = result;
  app.renderer.previewPath = result.path || [];

  const owned = app.state.owned.has(node.id);
  const refund = owned ? canDeallocate(app.engine, app.state, node.id) : null;
  const newNodes = (result.new_nodes || []).filter((id) => id !== node.id);

  const costLine = owned
    ? `<div class="cost ok">Owned${
        refund && !refund.ok ? ` · cannot refund: ${refund.reason}` : ''
      }</div>`
    : result.affordable
      ? `<div class="cost ok">${result.total_cost} point${
          result.total_cost === 1 ? '' : 's'
        } · allocates ${newNodes.length} node${
          newNodes.length === 1 ? '' : 's'
        } on the way · ${result.points_remaining_after} left after</div>`
      : `<div class="cost blocked">${
          result.reason === 'insufficient_points'
            ? `needs ${result.total_cost} points, you have ${app.state.pointsRemaining}`
            : (result.blocking_prereqs || []).join('<br />') || 'no path from what you own'
        }</div>`;

  const pathList = newNodes.length
    ? `<ol class="path-list">${newNodes
        .map((id) => `<li>${app.index.byId.get(id).name}</li>`)
        .join('')}</ol>`
    : '';

  dom.detailBody.innerHTML = `
    <div class="detail-name">${node.name}</div>
    <div class="stat"><span>${typeLabel(node)}</span><b style="color:${zoneColour(
      node.zone,
    )}">${node.zone}${node.subregion ? ` · ${node.subregion}` : ''}</b></div>
    <div class="detail-summary small">${node.effect_summary || ''}</div>
    ${costLine}
    ${pathList}
  `;

  dom.detailActions.hidden = false;
  dom.allocate.disabled = owned || !result.affordable;
  dom.allocate.textContent = owned ? 'Allocated' : 'Allocate';
  dom.deallocate.disabled = !owned || !(refund && refund.ok);

  if (openSheet && isPhone()) openTab('detail');
  markDirty();
}

function allocateSelected() {
  if (!app.state || !app.selected) return;
  const node = app.selected;
  const result = app.engine.allocate(app.state, node.id);
  dom.buildStatus.textContent = result.affordable
    ? `Allocated ${node.name} (${result.total_cost} point${
        result.total_cost === 1 ? '' : 's'
      }).`
    : `${node.name}: ${(result.blocking_prereqs || []).join('; ') || 'not affordable'}.`;
  app.renderer.setState(app.state);
  refreshChassis();
  select(node);
}

function deallocateSelected() {
  if (!app.state || !app.selected) return;
  const node = app.selected;
  const check = deallocate(app.engine, app.state, node.id);
  dom.buildStatus.textContent = check.ok
    ? `Refunded ${node.name} (+${check.refund}).`
    : `Cannot refund ${node.name}: ${check.reason}.`;
  app.renderer.setState(app.state);
  refreshChassis();
  select(node);
}

// -- panels ---------------------------------------------------------------

function refreshChassis() {
  if (!app.state) return;
  const summary = characterSummary(app.engine, app.state);
  const weapons = summary.weapons.summary || '—';
  dom.chassis.innerHTML = `
    <div class="points">${summary.pointsRemaining}<span class="muted" style="font-size:14px"> / ${
      summary.pointsTotal
    } points left</span></div>
    <div class="stat"><span>Starting zone</span><b style="color:${zoneColour(
      summary.homeZone,
    )}">${summary.homeZone}</b></div>
    <div class="stat"><span>Hit die</span><b>d${summary.hitDie.faces}</b></div>
    <div class="stat"><span>Saving throws</span><b>${summary.savingThrows
      .join(', ')
      .toUpperCase()}</b></div>
    <div class="stat"><span>Weapons</span><b>${weapons}</b></div>
    <div class="stat"><span>Points spent</span><b>${summary.pointsSpent}</b></div>
    <div class="stat"><span>Nodes owned</span><b>${summary.ownedCount} <span class="muted">(${
      summary.notableCount
    } notable)</span></b></div>
  `;
  dom.statusLeft.textContent = `${summary.homeZone} · ${summary.pointsSpent}/${summary.pointsTotal} points spent`;
  dom.pointsPill.hidden = false;
  dom.pointsPillValue.textContent = String(summary.pointsRemaining);
}

function refreshBuildList(selected) {
  const builds = app.store.list();
  dom.buildList.innerHTML = '';
  for (const build of builds) {
    const option = document.createElement('option');
    option.value = build.name;
    option.textContent = `${build.name} — ${build.state.homeZone}, ${build.state.pointsSpent}pt`;
    if (build.name === selected) option.selected = true;
    dom.buildList.appendChild(option);
  }
  if (!builds.length) {
    const option = document.createElement('option');
    option.disabled = true;
    option.textContent = 'no saved builds';
    dom.buildList.appendChild(option);
  }
}

function drawLegend() {
  const ctx = dom.legend.getContext('2d');
  const types = [
    { label: 'Class feature', node: { type: 'class_feature' } },
    { label: 'Subclass feature', node: { type: 'subclass_feature' } },
    { label: 'Feat', node: { type: 'feat' } },
    { label: 'Optional feature', node: { type: 'optional_feature' } },
    { label: 'Spell slots', node: { type: 'spell_slot' } },
    { label: 'Weapon mastery', node: { type: 'weapon_mastery' } },
    { label: 'Zone gate', node: { type: 'connector', is_gate: true } },
    { label: 'Connector', node: { type: 'connector' } },
  ];
  ctx.clearRect(0, 0, dom.legend.width, dom.legend.height);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const renderer = new Renderer(dom.legend, app.index, app.engine, new Camera());
  types.forEach((entry, i) => {
    const y = 14 + i * 23;
    ctx.fillStyle = '#8fa2c8';
    renderer._shapePath(ctx, nodeShape(entry.node), 16, y, entry.node.is_gate ? 8 : 7, 'near');
    ctx.fill();
    ctx.fillStyle = '#c9cfdb';
    ctx.fillText(entry.label, 34, y);
  });
}

// -- bottom sheets (phone) ------------------------------------------------

/** @param {'character'|'detail'|'search'|'none'} name */
function openTab(name) {
  app.openSheet = app.openSheet === name ? 'none' : name;
  for (const [key, panel] of Object.entries(dom.panels)) {
    panel.dataset.open = String(app.openSheet === key);
  }
  for (const button of dom.tabbar.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.tab === app.openSheet));
  }
}

// -- search ---------------------------------------------------------------

function runSearch(query, { list = false } = {}) {
  const hits = app.index.search(query);
  app.renderer.searchHits = new Set(hits.map((node) => node.id));
  const label = query.trim() ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : '';
  dom.searchCount.textContent = label;
  dom.searchCountMobile.textContent = label;

  if (list) {
    dom.searchResults.innerHTML = '';
    for (const node of hits.slice(0, 40)) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = `<span>${node.name}</span><span class="result-meta">${typeLabel(
        node,
      )} · ${node.zone}</span>`;
      button.addEventListener('click', () => {
        app.camera.centreOn(node.position_x, node.position_y, Math.max(app.camera.scale, 12));
        select(node, { openSheet: true });
      });
      item.appendChild(button);
      dom.searchResults.appendChild(item);
    }
  } else if (hits.length) {
    const first = hits[0];
    app.camera.centreOn(first.position_x, first.position_y, Math.max(app.camera.scale, 11));
  }
  markDirty();
}

// -- frame loop -----------------------------------------------------------

function markDirty() {
  app.dirty = true;
}

function loop() {
  if (app.dirty) {
    app.dirty = false;
    app.renderer.draw();
    dom.statusRight.textContent = `${app.renderer.lastDrawnNodes} nodes drawn · ${app.renderer.lastFrameMs.toFixed(
      1,
    )} ms/frame · ${app.camera.lod()} detail`;
  }
  requestAnimationFrame(loop);
}

// -- input ----------------------------------------------------------------

/**
 * Tap targets: a connector is a 2px dot when zoomed out, and a finger is not.
 * The hit radius is whichever is larger - the node's own drawn radius, or a
 * fixed screen-space target (44px on touch, 14px for a mouse) converted into
 * world units. Notable nodes win ties so a fat tap near a feature does not
 * select the connector next to it.
 */
function pickNodeAt(clientX, clientY, pointerType = 'mouse') {
  const rect = dom.canvas.getBoundingClientRect();
  const dpr = app.renderer.dpr || 1;
  const world = app.camera.screenToWorld(
    (clientX - rect.left) * dpr,
    (clientY - rect.top) * dpr,
  );
  const targetPx = pointerType === 'mouse' ? 14 : 26;
  const slack = Math.max(1.6, (targetPx * dpr) / app.camera.scale);
  return app.index.nodeAt(world.x, world.y, slack, { preferNotable: true });
}

function wireEvents() {
  app.input = new PointerInput(dom.canvas, app.camera, {
    getDpr: () => app.renderer.dpr || 1,
    onChange: markDirty,
    onTap: (clientX, clientY, pointerType) => {
      if (!app.state) return;
      const node = pickNodeAt(clientX, clientY, pointerType);
      select(node, { openSheet: Boolean(node) });
    },
    onHover: (clientX, clientY) => {
      const node = clientX === null ? null : pickNodeAt(clientX, clientY, 'mouse');
      const id = node ? node.id : null;
      if (id !== app.renderer.hoverId) {
        app.renderer.hoverId = id;
        dom.canvas.style.cursor = node ? 'pointer' : '';
        markDirty();
      }
    },
  });

  window.addEventListener('resize', () => {
    app.renderer.resize();
    markDirty();
  });
  window.addEventListener('orientationchange', () => {
    // iOS reports the old size synchronously; wait for the layout to settle
    setTimeout(() => {
      app.renderer.resize();
      markDirty();
    }, 120);
  });

  dom.allocate.addEventListener('click', allocateSelected);
  dom.deallocate.addEventListener('click', deallocateSelected);

  for (const button of dom.tabbar.querySelectorAll('button')) {
    button.addEventListener('click', () => openTab(button.dataset.tab));
  }
  for (const panel of Object.values(dom.panels)) {
    const grip = panel.querySelector('.sheet-grip');
    if (grip) grip.addEventListener('click', () => openTab('none'));
  }

  const fit = () => {
    app.camera.fit(app.index.bounds);
    markDirty();
  };
  dom.fit.addEventListener('click', fit);
  dom.fitMobile.addEventListener('click', fit);

  const respec = () => {
    if (!app.state) return;
    app.state = app.engine.startState(app.state.homeZone, app.index.budget);
    app.renderer.setState(app.state);
    refreshChassis();
    select(app.selected);
    dom.buildStatus.textContent = 'Respecced to a fresh character.';
    markDirty();
  };
  dom.respec.addEventListener('click', respec);
  dom.respecMobile.addEventListener('click', respec);

  const toggleReferences = (checked) => {
    app.renderer.showReferences = checked;
    dom.references.checked = checked;
    dom.referencesMobile.checked = checked;
    markDirty();
  };
  dom.references.addEventListener('change', () => toggleReferences(dom.references.checked));
  dom.referencesMobile.addEventListener('change', () =>
    toggleReferences(dom.referencesMobile.checked),
  );

  dom.search.addEventListener('input', () => runSearch(dom.search.value));
  dom.searchMobile.addEventListener('input', () =>
    runSearch(dom.searchMobile.value, { list: true }),
  );

  dom.save.addEventListener('click', () => {
    if (!app.state) return;
    const name = (dom.buildName.value || '').trim();
    if (!name) {
      dom.buildStatus.textContent = 'Give the build a name first.';
      return;
    }
    app.store.save(name, app.state.toJSON());
    refreshBuildList(name);
    dom.buildStatus.textContent = `Saved “${name}”.`;
  });

  dom.load.addEventListener('click', () => {
    const name = dom.buildList.value;
    if (!name) return;
    const data = app.store.load(name);
    if (!data) return;
    app.state = PlayerState.fromJSON(data);
    app.renderer.setState(app.state);
    dom.onboarding.hidden = true;
    dom.buildName.value = name;
    refreshChassis();
    select(app.selected);
    dom.buildStatus.textContent = `Loaded “${name}”.`;
    markDirty();
  });

  dom.del.addEventListener('click', () => {
    const name = dom.buildList.value;
    if (!name) return;
    app.store.remove(name);
    refreshBuildList();
    dom.buildStatus.textContent = `Deleted “${name}”.`;
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== dom.search) {
      event.preventDefault();
      dom.search.focus();
    }
    if (event.key === 'Escape') {
      dom.search.value = '';
      dom.searchMobile.value = '';
      runSearch('', { list: true });
      if (app.openSheet !== 'none') openTab('none');
      else select(null);
    }
    if ((event.key === 'Enter' || event.key === 'a') && app.selected && !dom.allocate.disabled) {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      allocateSelected();
    }
  });
}

// -- test and benchmark hooks --------------------------------------------
globalThis.__tree = {
  app,
  markDirty,
  drawOnce: () => app.renderer.draw(),
  setZoom: (scale) => {
    app.camera.scale = scale;
    markDirty();
  },
  panBy: (dx, dy) => {
    app.camera.panBy(dx, dy);
    markDirty();
  },
  select,
  openTab,
  isPhone,
  pickNodeAt,
  ready: () => Boolean(app.renderer),
  graphUrl: graphDataUrl(),
};

boot().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px">Failed to start: ${error.message}\n\n${error.stack}</pre>`;
});
