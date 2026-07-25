/**
 * UI shell: DOM wiring, interaction, panels.
 *
 * Everything that decides *what is true* lives in ../core (engine, character
 * state, storage). This file only decides what is on screen. That boundary is
 * the point of Work Order 3's decision 4 - a Foundry wrapper replaces this file
 * and keeps the rest.
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
import { ACCENT, nodeRadius, nodeShape, typeLabel, zoneColour } from './style.js';
import { graphDataUrl, loadGraph } from './data.js';

const el = (id) => document.getElementById(id);

const dom = {
  canvas: el('tree'),
  tooltip: el('tooltip'),
  stats: el('graph-stats'),
  search: el('search'),
  searchCount: el('search-count'),
  references: el('toggle-references'),
  fit: el('btn-fit'),
  respec: el('btn-respec'),
  chassis: el('chassis-body'),
  buildName: el('build-name'),
  buildList: el('build-list'),
  buildStatus: el('build-status'),
  save: el('btn-save'),
  load: el('btn-load'),
  del: el('btn-delete'),
  selection: el('selection-body'),
  onboarding: el('onboarding'),
  zoneGrid: el('zone-grid'),
  zoneDetail: el('zone-detail'),
  statusLeft: el('status-left'),
  statusRight: el('status-right'),
  legend: el('legend-canvas'),
};

const app = {
  /** @type {GraphIndex} */ index: null,
  /** @type {PathEngine} */ engine: null,
  /** @type {Renderer} */ renderer: null,
  /** @type {Camera} */ camera: new Camera(),
  /** @type {PlayerState} */ state: null,
  store: new BuildStore(globalThis.localStorage),
  hover: null,
  preview: null,
  dirty: true,
  frameTimes: [],
};

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

// -- starting zone (Task 7) ----------------------------------------------

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
    button.addEventListener('mouseenter', () => {
      dom.zoneDetail.textContent = `${zone}: d${chassis.hit_die.faces} hit die, ${(
        chassis.saving_throw_proficiencies || []
      )
        .join(' and ')
        .toUpperCase()} saves, ${chassis.weapon_proficiencies.summary}.`;
    });
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
  refreshChassis();
  markDirty();
}

function focusZone(zone) {
  const gate = app.index.byId.get(`gate_${zone.toLowerCase()}`);
  if (!gate) return;
  const angle = Math.atan2(gate.position_y, gate.position_x);
  app.camera.centreOn(Math.cos(angle) * 24, Math.sin(angle) * 24, 9);
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

/** @param {any} node @param {any} result */
function describeSelection(node, result) {
  if (!node) {
    dom.selection.innerHTML = '<p class="muted small">Hover a node to preview its path.</p>';
    return;
  }
  const newNodes = (result.new_nodes || []).filter((id) => id !== node.id);
  const list = newNodes
    .map((id) => {
      const other = app.index.byId.get(id);
      return `<li>${other.name}</li>`;
    })
    .join('');
  const status = result.affordable
    ? `<b style="color:${ACCENT.preview}">${result.total_cost} point${
        result.total_cost === 1 ? '' : 's'
      }</b> — allocates ${newNodes.length} node${newNodes.length === 1 ? '' : 's'} on the way`
    : `<b style="color:#ff9a8b">${
        result.reason === 'insufficient_points'
          ? `costs ${result.total_cost}, you have ${app.state.pointsRemaining}`
          : (result.blocking_prereqs || []).join('; ') || 'unreachable'
      }</b>`;
  dom.selection.innerHTML = `
    <div class="stat"><span>${typeLabel(node)}</span><b style="color:${zoneColour(
      node.zone,
    )}">${node.zone}</b></div>
    <p class="small">${status}</p>
    ${list ? `<ol class="path-list">${list}</ol>` : ''}
  `;
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

// -- interaction (Task 5) -------------------------------------------------

function markDirty() {
  app.dirty = true;
}

function loop() {
  if (app.dirty) {
    app.dirty = false;
    app.renderer.draw();
    app.frameTimes.push(app.renderer.lastFrameMs);
    if (app.frameTimes.length > 120) app.frameTimes.shift();
    dom.statusRight.textContent = `${app.renderer.lastDrawnNodes} nodes drawn · ${app.renderer.lastFrameMs.toFixed(
      1,
    )} ms/frame · ${app.camera.lod()} detail`;
  }
  requestAnimationFrame(loop);
}

function pointerWorld(event) {
  const rect = dom.canvas.getBoundingClientRect();
  const dpr = app.renderer.dpr || 1;
  return app.camera.screenToWorld(
    (event.clientX - rect.left) * dpr,
    (event.clientY - rect.top) * dpr,
  );
}

function hitTest(event) {
  const world = pointerWorld(event);
  const slack = Math.max(1.4, 14 / app.camera.scale);
  return app.index.nodeAt(world.x, world.y, slack);
}

function showTooltip(event, node) {
  if (!node || !app.state) {
    dom.tooltip.hidden = true;
    return;
  }
  const result = app.engine.canAfford(app.state, node.id);
  app.preview = result;
  app.renderer.previewPath = result.path || [];

  const owned = app.state.owned.has(node.id);
  const costLine = owned
    ? '<span class="cost">owned</span>'
    : result.affordable
      ? `<div class="cost ok">${result.total_cost} point${
          result.total_cost === 1 ? '' : 's'
        } · ${(result.new_nodes || []).length} node${
          (result.new_nodes || []).length === 1 ? '' : 's'
        } allocated · ${result.points_remaining_after} left after</div>`
      : `<div class="cost blocked">${
          result.reason === 'insufficient_points'
            ? `needs ${result.total_cost} points, you have ${app.state.pointsRemaining}`
            : (result.blocking_prereqs || []).join('<br />') || 'no path from what you own'
        }</div>`;

  dom.tooltip.innerHTML = `
    <h3>${node.name}</h3>
    <div class="meta">${typeLabel(node)} · ${node.zone}${
      node.subregion ? ` · ${node.subregion}` : ''
    } · depth ${node.depth}</div>
    <div class="summary">${node.effect_summary || ''}</div>
    ${costLine}
  `;
  dom.tooltip.hidden = false;

  const rect = dom.tooltip.getBoundingClientRect();
  const x = Math.min(event.clientX + 16, window.innerWidth - rect.width - 12);
  const y = Math.min(event.clientY + 16, window.innerHeight - rect.height - 12);
  dom.tooltip.style.left = `${x}px`;
  dom.tooltip.style.top = `${y}px`;

  describeSelection(node, result);
}

function wireEvents() {
  const canvas = dom.canvas;
  let dragging = false;
  let dragMoved = false;
  let lastX = 0;
  let lastY = 0;

  window.addEventListener('resize', () => {
    app.renderer.resize();
    markDirty();
  });

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    dragMoved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
      const dpr = app.renderer.dpr || 1;
      const dx = (event.clientX - lastX) * dpr;
      const dy = (event.clientY - lastY) * dpr;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      app.camera.panBy(dx, dy);
      lastX = event.clientX;
      lastY = event.clientY;
      markDirty();
      return;
    }
    const node = hitTest(event);
    const id = node ? node.id : null;
    if (id !== app.renderer.hoverId) {
      app.renderer.hoverId = id;
      if (!node) {
        app.renderer.previewPath = [];
        describeSelection(null, null);
      }
      markDirty();
    }
    showTooltip(event, node);
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', (event) => {
    const wasDrag = dragMoved;
    endDrag(event);
    if (wasDrag) return;
    handleClick(event);
  });
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    dom.tooltip.hidden = true;
    app.renderer.hoverId = null;
    app.renderer.previewPath = [];
    markDirty();
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const dpr = app.renderer.dpr || 1;
      const factor = Math.exp(-event.deltaY * 0.0016);
      app.camera.zoomAt(
        (event.clientX - rect.left) * dpr,
        (event.clientY - rect.top) * dpr,
        factor,
      );
      markDirty();
    },
    { passive: false },
  );

  dom.fit.addEventListener('click', () => {
    app.camera.fit(app.index.bounds);
    markDirty();
  });

  dom.respec.addEventListener('click', () => {
    if (!app.state) return;
    app.state = app.engine.startState(app.state.homeZone, app.index.budget);
    app.renderer.setState(app.state);
    refreshChassis();
    dom.buildStatus.textContent = 'Respecced to a fresh character.';
    markDirty();
  });

  dom.references.addEventListener('change', () => {
    app.renderer.showReferences = dom.references.checked;
    markDirty();
  });

  dom.search.addEventListener('input', () => {
    const hits = app.index.search(dom.search.value);
    app.renderer.searchHits = new Set(hits.map((node) => node.id));
    dom.searchCount.textContent = dom.search.value.trim()
      ? `${hits.length} match${hits.length === 1 ? '' : 'es'}`
      : '';
    if (hits.length) {
      const first = hits[0];
      app.camera.centreOn(first.position_x, first.position_y, Math.max(app.camera.scale, 11));
    }
    markDirty();
  });

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
      app.renderer.searchHits = new Set();
      dom.searchCount.textContent = '';
      markDirty();
    }
  });
}

function handleClick(event) {
  if (!app.state) return;
  const node = hitTest(event);
  if (!node) return;

  if (event.altKey && app.state.owned.has(node.id)) {
    const check = deallocate(app.engine, app.state, node.id);
    dom.buildStatus.textContent = check.ok
      ? `Refunded ${node.name} (+${check.refund}).`
      : `Cannot refund ${node.name}: ${check.reason}.`;
  } else {
    const result = app.engine.allocate(app.state, node.id);
    if (!result.affordable) {
      dom.buildStatus.textContent =
        result.reason === 'insufficient_points'
          ? `${node.name} costs ${result.total_cost}; you have ${app.state.pointsRemaining}.`
          : `${node.name}: ${(result.blocking_prereqs || []).join('; ') || 'no path yet'}.`;
    } else {
      dom.buildStatus.textContent = `Allocated ${node.name} (${result.total_cost} point${
        result.total_cost === 1 ? '' : 's'
      }).`;
    }
  }
  app.renderer.setState(app.state);
  refreshChassis();
  showTooltip(event, node);
  markDirty();
}

// -- benchmark hooks (Task 8) --------------------------------------------
// Exposed so bench/bench.mjs can drive real pan/zoom against the real renderer
// instead of measuring a synthetic scene.
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
  ready: () => Boolean(app.renderer),
  graphUrl: graphDataUrl(),
};

boot().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px">Failed to start: ${error.message}\n\n${error.stack}</pre>`;
});
