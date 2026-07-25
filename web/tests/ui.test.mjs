/**
 * End-to-end UI tests against the built single-file app.
 *
 * Two suites: a desktop browser, and an emulated phone with real touch events
 * dispatched through CDP (including two-finger pinch). Everything is driven
 * through the real UI - clicks, taps and gestures - rather than by calling the
 * app's internals.
 *
 * Work Order 4 replaced click-to-allocate with select-then-confirm, so the
 * interaction assertions here changed with it: a click or tap *selects*, and
 * allocation happens through the detail panel's buttons. That is the same
 * model on both input types, which is why one suite can assert it twice.
 *
 * Skips itself (rather than failing) if no Chromium is available, so the engine
 * suite still runs on a bare machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distIndex = join(root, 'dist/index.html');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsers && existsSync(browsers)) {
    for (const entry of readdirSync(browsers)) {
      const guess = join(browsers, entry, 'chrome-linux', 'chrome');
      if (entry.startsWith('chromium-') && existsSync(guess)) return guess;
    }
  }
  return null;
}

let chromiumPath = null;
let playwright = null;
try {
  chromiumPath = findChromium();
  playwright = await import('playwright');
} catch {
  playwright = null;
}

const canRun = Boolean(chromiumPath && playwright);
const skip = canRun ? false : 'no Chromium available';

function ensureBuild() {
  if (!existsSync(distIndex)) {
    execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
  }
}

async function serve() {
  const server = createServer(async (_request, response) => {
    const body = await readFile(distIndex);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/** Screen position of a node, for real pointer/touch events. */
const nodeAt = (page, id) =>
  page.evaluate((nodeId) => {
    const tree = globalThis.__tree;
    const node = tree.app.index.byId.get(nodeId);
    const point = tree.app.camera.worldToScreen(node.position_x, node.position_y);
    const dpr = tree.app.renderer.dpr || 1;
    const rect = document.getElementById('tree').getBoundingClientRect();
    return { x: rect.left + point.x / dpr, y: rect.top + point.y / dpr };
  }, id);

const centreOn = (page, id, scale = 14) =>
  page.evaluate(
    ({ nodeId, zoom }) => {
      const tree = globalThis.__tree;
      const node = tree.app.index.byId.get(nodeId);
      tree.app.camera.centreOn(node.position_x, node.position_y, zoom);
      tree.markDirty();
    },
    { nodeId: id, zoom: scale },
  );

// =========================================================================
// desktop
// =========================================================================

test('desktop UI', { skip }, async (t) => {
  ensureBuild();
  const { server, url } = await serve();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(url);
  await page.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());

  await t.test('onboarding blocks allocation until a zone is chosen', async () => {
    assert.equal(await page.isVisible('#onboarding'), true);
    assert.equal(await page.evaluate(() => globalThis.__tree.app.state), null);
  });

  await t.test('choosing a starting zone locks the chassis panel', async () => {
    await page.click('#zone-grid button:has-text("Wizard")');
    assert.equal(await page.isVisible('#onboarding'), false);
    const panel = await page.textContent('#chassis-body');
    assert.match(panel, /Wizard/);
    assert.match(panel, /d6/);
    assert.match(panel, /INT, WIS/);
    assert.match(panel, /Simple weapons/);
    assert.match(panel, /58 \/ 58 points left/);
  });

  await t.test('clicking selects a node - it does not allocate it', async () => {
    await centreOn(page, 'cf_fighter_extra_attack_5');
    const point = await nodeAt(page, 'cf_fighter_extra_attack_5');
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(60);

    const detail = await page.textContent('#detail-body');
    assert.match(detail, /Extra Attack/);
    assert.match(detail, /4 points/);
    assert.match(detail, /Fighter Gate/); // the path it would buy is listed

    // nothing spent yet - this is the fat-finger guard
    const state = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(state.pointsSpent, 0);
    assert.equal(await page.isVisible('#detail-actions'), true);
    assert.equal(await page.isDisabled('#btn-allocate'), false);
    assert.equal(await page.isDisabled('#btn-deallocate'), true);
  });

  await t.test('the selection previews the path on canvas', async () => {
    const preview = await page.evaluate(() => globalThis.__tree.app.renderer.previewPath);
    assert.deepEqual(preview, [
      'conn_core_hub',
      'gate_fighter',
      'conn_fighter_rung_1',
      'conn_fighter_rung_4',
      'cf_fighter_extra_attack_5',
    ]);
    assert.equal(
      await page.evaluate(() => globalThis.__tree.app.renderer.selectedId),
      'cf_fighter_extra_attack_5',
    );
  });

  await t.test('Allocate spends the points and takes the whole path', async () => {
    await page.click('#btn-allocate');
    await page.waitForTimeout(60);

    const state = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(state.pointsSpent, 4);
    assert.ok(state.owned.includes('cf_fighter_extra_attack_5'));
    assert.ok(state.owned.includes('gate_fighter'));
    assert.match(await page.textContent('#chassis-body'), /54 \/ 58 points left/);
    assert.equal(await page.isDisabled('#btn-allocate'), true);
    assert.equal(await page.isDisabled('#btn-deallocate'), false);
  });

  await t.test('Deallocate refunds a refundable node', async () => {
    await page.click('#btn-deallocate');
    await page.waitForTimeout(60);

    const state = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(state.pointsSpent, 3);
    assert.ok(!state.owned.includes('cf_fighter_extra_attack_5'));
    assert.match(await page.textContent('#build-status'), /Refunded/);
  });

  await t.test('Deallocate is disabled for a node the build depends on', async () => {
    await centreOn(page, 'gate_fighter');
    const point = await nodeAt(page, 'gate_fighter');
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(60);
    assert.equal(await page.isDisabled('#btn-deallocate'), true);
    assert.match(await page.textContent('#detail-body'), /cannot refund/i);
  });

  await t.test('search highlights matches', async () => {
    await page.fill('#search', 'metamagic');
    await page.waitForTimeout(120);
    assert.match(await page.textContent('#search-count'), /14 matches/);
    const hits = await page.evaluate(() => [...globalThis.__tree.app.renderer.searchHits]);
    assert.equal(hits.filter((id) => id.endsWith('_spell_xphb')).length, 10);
    await page.fill('#search', '');
    await page.waitForTimeout(60);
  });

  await t.test('saving and loading a build round-trips through localStorage', async () => {
    await page.fill('#build-name', 'test build');
    await page.click('#btn-save');
    assert.match(await page.textContent('#build-status'), /Saved/);

    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('dnd2024.tree.builds.v1')),
    );
    assert.equal(stored.length, 1);
    const savedSpend = stored[0].state.pointsSpent;

    await centreOn(page, 'cf_wizard_spell_mastery_18');
    const point = await nodeAt(page, 'cf_wizard_spell_mastery_18');
    await page.mouse.click(point.x, point.y);
    await page.click('#btn-allocate');
    await page.waitForTimeout(60);
    assert.ok(
      (await page.evaluate(() => globalThis.__tree.app.state.pointsSpent)) > savedSpend,
    );

    await page.selectOption('#build-list', 'test build');
    await page.click('#btn-load');
    await page.waitForTimeout(60);
    assert.equal(
      await page.evaluate(() => globalThis.__tree.app.state.pointsSpent),
      savedSpend,
    );
  });

  await t.test('respec resets to a fresh character in the same zone', async () => {
    await page.click('#btn-respec');
    await page.waitForTimeout(60);
    const state = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(state.pointsSpent, 0);
    assert.equal(state.homeZone, 'Wizard');
    assert.deepEqual(state.owned.sort(), ['conn_core_hub', 'gate_wizard']);
  });

  await t.test('the reference overlay toggles without becoming pathable', async () => {
    await page.check('#toggle-references');
    assert.equal(await page.evaluate(() => globalThis.__tree.app.renderer.showReferences), true);
    const leaked = await page.evaluate(() => {
      const tree = globalThis.__tree;
      return tree.app.index.referenceEdges.some((edge) =>
        tree.app.engine.adjacency.get(edge.from).includes(edge.to),
      );
    });
    assert.equal(leaked, false);
    await page.uncheck('#toggle-references');
  });

  await t.test('mouse drag pans and the wheel zooms', async () => {
    const before = await page.evaluate(() => ({
      x: globalThis.__tree.app.camera.x,
      scale: globalThis.__tree.app.camera.scale,
    }));
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(560, 400, { steps: 6 });
    await page.mouse.up();
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(60);
    const after = await page.evaluate(() => ({
      x: globalThis.__tree.app.camera.x,
      scale: globalThis.__tree.app.camera.scale,
    }));
    assert.notEqual(before.x, after.x);
    assert.ok(after.scale > before.scale);
  });

  await t.test('a drag that ends on a node does not select it', async () => {
    await centreOn(page, 'cf_wizard_arcane_recovery_1', 12);
    await page.evaluate(() => globalThis.__tree.select(null));
    const point = await nodeAt(page, 'cf_wizard_arcane_recovery_1');
    await page.mouse.move(point.x + 120, point.y + 90);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(60);
    assert.equal(await page.evaluate(() => globalThis.__tree.app.renderer.selectedId), null);
  });

  // -- Work Order 6 -------------------------------------------------------

  await t.test('the frontier is what you can buy next, and it animates', async () => {
    await page.click('#btn-respec');
    for (const id of ['cf_wizard_arcane_recovery_1', 'feat_alert_xphb']) {
      await page.evaluate((nodeId) => {
        globalThis.__tree.select(globalThis.__tree.app.index.byId.get(nodeId));
      }, id);
      await page.click('#btn-allocate');
    }

    const report = await page.evaluate(() => {
      const tree = globalThis.__tree;
      const frontier = tree.frontier();
      const state = tree.app.state;
      const owned = new Set(state.owned);
      return {
        size: frontier.length,
        allUnowned: frontier.every((id) => !owned.has(id)),
        allAdjacent: frontier.every((id) =>
          [...owned].some((ownedId) => tree.app.engine.adjacency.get(ownedId).includes(id)),
        ),
        allAffordable: frontier.every(
          (id) => tree.app.engine.canAfford(state, id).affordable,
        ),
        noFiller: frontier.every((id) => {
          const node = tree.app.index.byId.get(id);
          return node.type !== 'connector' || node.is_gate;
        }),
      };
    });

    assert.ok(report.size > 0, 'a character with points left has somewhere to go');
    assert.ok(report.allUnowned);
    assert.ok(report.allAdjacent, 'the frontier is one step out, not the whole graph');
    assert.ok(report.allAffordable);
    assert.ok(report.noFiller, 'filler connectors are plumbing, not a choice');

    // the pulse is driven by the frame loop, so the phase must actually move
    const first = await page.evaluate(() => globalThis.__tree.app.renderer.pulsePhase);
    await page.waitForTimeout(320);
    const second = await page.evaluate(() => globalThis.__tree.app.renderer.pulsePhase);
    assert.notEqual(first, second, 'the frontier pulse should be animating');
  });

  await t.test('the sheet lists the build and its entries select the node', async () => {
    const sheet = await page.textContent('#sheet-body');
    assert.match(sheet, /Arcane Recovery/);
    assert.match(sheet, /Alert/);
    assert.match(sheet, /Zones entered/);
    assert.match(sheet, /Wizard/);

    await page.click('#sheet-body button[data-node="feat_alert_xphb"]');
    await page.waitForTimeout(80);
    assert.match(await page.textContent('#detail-body'), /Alert/);
    assert.equal(
      await page.evaluate(() => globalThis.__tree.app.selected.id),
      'feat_alert_xphb',
    );
  });

  await t.test('the sheet exports as Markdown and as JSON', async () => {
    const markdownDownload = page.waitForEvent('download');
    await page.click('#btn-export-md');
    const markdownFile = await markdownDownload;
    assert.match(markdownFile.suggestedFilename(), /\.md$/);
    const markdown = await readFile(await markdownFile.path(), 'utf8');
    assert.match(markdown, /D&D 2024 skill tree/);
    assert.match(markdown, /Arcane Recovery/);
    assert.match(markdown, /\*\*Hit die\*\* d6/);

    const jsonDownload = page.waitForEvent('download');
    await page.click('#btn-export-json');
    const jsonFile = await jsonDownload;
    assert.match(jsonFile.suggestedFilename(), /\.json$/);
    const payload = JSON.parse(await readFile(await jsonFile.path(), 'utf8'));
    assert.equal(payload.format, 'dnd2024-skill-tree-build');
    assert.equal(payload.build.homeZone, 'Wizard');
    assert.ok(payload.build.owned.includes('feat_alert_xphb'));
    assert.ok(payload.nodes.some((entry) => entry.name === 'Alert'));
  });

  await t.test('owned nodes and their edges are drawn distinctly', async () => {
    // Task 1 is a visual claim, so assert the mechanism that produces it: owned
    // nodes get their own batch with a full-strength style and an outline path,
    // and the owned-edge layer is populated.
    const report = await page.evaluate(() => {
      const renderer = globalThis.__tree.app.renderer;
      renderer.draw();
      const paths = renderer._worldCache;
      const owned = [...paths.batches.values()].filter((batch) => batch.state === 'owned');
      const unreachable = [...paths.batches.values()].filter(
        (batch) => batch.state === 'unreachable',
      );
      return {
        ownedBatches: owned.length,
        ownedHaveOutlines: owned.every((batch) => Boolean(batch.stroke)),
        ownedAlpha: owned[0] && owned[0].style.alpha,
        unreachableAlpha: unreachable[0] && unreachable[0].style.alpha,
        ownedEdges: paths.hasBright,
      };
    });
    assert.ok(report.ownedBatches > 0);
    assert.ok(report.ownedHaveOutlines);
    assert.equal(report.ownedEdges, true);
    assert.ok(
      report.ownedAlpha - report.unreachableAlpha > 0.6,
      'owned and unreachable must not read as the same thing',
    );
  });

  await t.test('desktop keeps side panels, not sheets', async () => {
    assert.equal(await page.isVisible('#tabbar'), false);
    assert.equal(await page.evaluate(() => globalThis.__tree.isPhone()), false);
  });

  await t.test('no page errors were raised in any of that', () => {
    assert.deepEqual(errors, []);
  });

  await t.test('the built page runs from file:// with zero network requests', async () => {
    const local = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const localErrors = [];
    local.on('pageerror', (error) => localErrors.push(error.message));
    local.on('requestfailed', (request) => localErrors.push(`failed: ${request.url()}`));

    await local.goto(`file://${distIndex}`);
    await local.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());
    await local.click('#zone-grid button:has-text("Monk")');
    await local.waitForTimeout(120);

    const report = await local.evaluate(() => ({
      nodes: globalThis.__tree.app.index.nodes.length,
      zone: globalThis.__tree.app.state.homeZone,
      requests: performance.getEntriesByType('resource').map((entry) => entry.name),
    }));

    assert.equal(report.nodes, 1133);
    assert.equal(report.zone, 'Monk');
    assert.deepEqual(report.requests, [], 'the offline build must not fetch anything');
    assert.deepEqual(localErrors, []);
    await local.close();
  });

  await browser.close();
  server.close();
});

// =========================================================================
// phone
// =========================================================================

test('phone UI (touch)', { skip }, async (t) => {
  ensureBuild();
  const { server, url } = await serve();
  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  const phone = playwright.devices['Pixel 7'] || playwright.devices['Pixel 5'];
  const context = await browser.newContext({ ...phone });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(url);
  await page.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());

  const touchDrag = async (from, to, steps = 12) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 },
        ],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  const touchPinch = async (centre, fromGap, toGap, steps = 12) => {
    const points = (gap) => [
      { x: centre.x - gap / 2, y: centre.y, id: 1 },
      { x: centre.x + gap / 2, y: centre.y, id: 2 },
    ];
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: points(fromGap),
    });
    for (let i = 1; i <= steps; i += 1) {
      const gap = fromGap + (toGap - fromGap) * (i / steps);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(gap) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  await t.test('phone layout uses bottom sheets, not side panels', async () => {
    assert.equal(await page.evaluate(() => globalThis.__tree.isPhone()), true);
    await page.tap('#zone-grid button:has-text("Wizard")');
    await page.waitForTimeout(150);

    assert.equal(await page.isVisible('#tabbar'), true);
    // sheets are off-screen until opened, so the canvas has the whole viewport
    const openState = await page.evaluate(() =>
      [...document.querySelectorAll('.panel')].map((panel) => panel.dataset.open || 'false'),
    );
    assert.deepEqual(openState, ['false', 'false', 'false']);

    const canvasBox = await page.locator('#tree').boundingBox();
    const viewport = page.viewportSize();
    assert.equal(Math.round(canvasBox.width), viewport.width);
    assert.equal(Math.round(canvasBox.height), viewport.height);
  });

  await t.test('the points pill replaces the desktop toolbar', async () => {
    assert.equal(await page.isVisible('#points-pill'), true);
    assert.equal(await page.isVisible('.tools'), false);
    assert.equal(await page.textContent('#points-pill-value'), '58');
  });

  await t.test('a tap selects and opens the detail sheet', async () => {
    await centreOn(page, 'cf_fighter_extra_attack_5', 11);
    const point = await nodeAt(page, 'cf_fighter_extra_attack_5');
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForTimeout(150);

    assert.equal(
      await page.evaluate(() => globalThis.__tree.app.renderer.selectedId),
      'cf_fighter_extra_attack_5',
    );
    assert.equal(
      await page.evaluate(() => document.getElementById('panel-detail').dataset.open),
      'true',
    );
    assert.match(await page.textContent('#detail-body'), /Extra Attack/);
    assert.equal(await page.evaluate(() => globalThis.__tree.app.state.pointsSpent), 0);
  });

  await t.test('Allocate and Deallocate work by touch', async () => {
    await page.tap('#btn-allocate');
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => globalThis.__tree.app.state.pointsSpent), 4);
    assert.equal(await page.textContent('#points-pill-value'), '54');

    await page.tap('#btn-deallocate');
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => globalThis.__tree.app.state.pointsSpent), 3);
  });

  await t.test('one-finger drag pans', async () => {
    await page.tap('#tabbar button[data-tab="none"]');
    const before = await page.evaluate(() => globalThis.__tree.app.camera.x);
    await touchDrag({ x: 200, y: 420 }, { x: 320, y: 300 });
    await page.waitForTimeout(80);
    const after = await page.evaluate(() => globalThis.__tree.app.camera.x);
    assert.notEqual(before, after);
  });

  await t.test('two-finger pinch zooms', async () => {
    const before = await page.evaluate(() => globalThis.__tree.app.camera.scale);
    await touchPinch({ x: 206, y: 420 }, 80, 300);
    await page.waitForTimeout(80);
    const after = await page.evaluate(() => globalThis.__tree.app.camera.scale);
    assert.ok(after > before * 1.5, `pinch should zoom in: ${before} -> ${after}`);

    await touchPinch({ x: 206, y: 420 }, 300, 80);
    await page.waitForTimeout(80);
    const back = await page.evaluate(() => globalThis.__tree.app.camera.scale);
    assert.ok(back < after * 0.75, `reverse pinch should zoom out: ${after} -> ${back}`);
  });

  await t.test('a pinch does not select whatever was under a finger', async () => {
    await page.evaluate(() => globalThis.__tree.select(null));
    await touchPinch({ x: 206, y: 420 }, 100, 260);
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => globalThis.__tree.app.renderer.selectedId), null);
  });

  await t.test('touch gets a bigger hit radius than a mouse', async () => {
    // Task 4: a node that draws as a 2px dot still has to be tappable. The
    // measure that matters is how far off-centre a pick still lands, and touch
    // must be more forgiving than a mouse.
    const reach = await page.evaluate(() => {
      const tree = globalThis.__tree;
      // Measure on the most isolated node in the graph: next to a neighbour the
      // limit is the neighbour, not the hit radius, and that is not what this
      // test is about.
      let node = null;
      let bestGap = 0;
      for (const candidate of tree.app.index.nodes) {
        let nearest = Infinity;
        for (const other of tree.app.index.nodesInRect(
          candidate.position_x - 12,
          candidate.position_y - 12,
          candidate.position_x + 12,
          candidate.position_y + 12,
        )) {
          if (other === candidate) continue;
          const gap = Math.hypot(
            other.position_x - candidate.position_x,
            other.position_y - candidate.position_y,
          );
          if (gap < nearest) nearest = gap;
        }
        if (nearest > bestGap && nearest !== Infinity) {
          bestGap = nearest;
          node = candidate;
        }
      }
      const target = node.id;
      tree.app.camera.centreOn(node.position_x, node.position_y, 9);
      const point = tree.app.camera.worldToScreen(node.position_x, node.position_y);
      const dpr = tree.app.renderer.dpr || 1;
      const cssX = point.x / dpr;
      const cssY = point.y / dpr;

      const maxOffset = (pointerType) => {
        let best = 0;
        for (let offset = 0; offset <= 40; offset += 1) {
          const hit = tree.pickNodeAt(cssX, cssY - offset, pointerType);
          if (hit && hit.id === target) best = offset;
          else break;
        }
        return best;
      };

      return {
        target,
        neighbourGap: bestGap,
        touch: maxOffset('touch'),
        mouse: maxOffset('mouse'),
        drawnRadiusPx: tree.app.renderer.radiusOf(node) / dpr,
      };
    });

    assert.ok(
      reach.touch > reach.mouse,
      `touch reach ${reach.touch}px should beat mouse ${reach.mouse}px on ${reach.target}`,
    );
    assert.ok(
      reach.touch >= reach.drawnRadiusPx * 2,
      `hit radius ${reach.touch}px should exceed the drawn radius ${reach.drawnRadiusPx}px`,
    );
  });

  await t.test('the search sheet lists results and selecting one opens the node', async () => {
    await page.tap('#tabbar button[data-tab="search"]');
    await page.fill('#search-mobile', 'rage');
    await page.waitForTimeout(150);
    assert.match(await page.textContent('#search-count-mobile'), /match/);

    const first = page.locator('#search-results button').first();
    await first.tap();
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(() => document.getElementById('panel-detail').dataset.open),
      'true',
    );
    assert.ok(await page.evaluate(() => globalThis.__tree.app.renderer.selectedId));
  });

  await t.test('the character sheet shows the chassis', async () => {
    await page.tap('#tabbar button[data-tab="character"]');
    await page.waitForTimeout(150);
    const panel = await page.textContent('#chassis-body');
    assert.match(panel, /Wizard/);
    assert.match(panel, /d6/);
    assert.match(panel, /INT, WIS/);
    assert.equal(
      await page.evaluate(() => document.getElementById('panel-character').dataset.open),
      'true',
    );
  });

  await t.test('the build sheet and its exports are usable on a phone', async () => {
    // allocate by touch, the way a player would, then read the sheet back.
    // Close whatever sheet the previous test left open first - it covers the
    // bottom of the screen, and a tap there would land on the panel, not the graph.
    await page.tap('#tab-close');
    await page.waitForTimeout(250);
    await centreOn(page, 'cf_fighter_extra_attack_5', 11);
    const point = await nodeAt(page, 'cf_fighter_extra_attack_5');
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForTimeout(150);
    await page.tap('#btn-allocate');
    await page.waitForTimeout(120);
    const owned = 'Extra Attack';
    assert.ok(
      await page.evaluate(() =>
        globalThis.__tree.app.state.owned.has('cf_fighter_extra_attack_5'),
      ),
      'the touch allocation should have landed',
    );

    await page.tap('#tabbar button[data-tab="character"]');
    await page.waitForTimeout(200);
    const sheet = await page.textContent('#sheet-body');
    assert.ok(sheet.includes(owned), `${owned} is owned but missing from the phone sheet`);

    // the export controls are real tap targets, not desktop-only chrome
    for (const id of ['#btn-copy-sheet', '#btn-export-md', '#btn-export-json']) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box, `${id} should be visible in the character sheet`);
      assert.ok(box.height >= 36, `${id} is too small to tap (${box.height}px)`);
    }

    const download = page.waitForEvent('download');
    await page.tap('#btn-export-md');
    const file = await download;
    assert.match(await readFile(await file.path(), 'utf8'), /D&D 2024 skill tree/);
    await page.tap('#tabbar button[data-tab="character"]');
  });

  await t.test('landscape keeps the sheet layout and a usable canvas', async () => {
    await page.setViewportSize({ width: phone.viewport.height, height: phone.viewport.width });
    await page.waitForTimeout(200);

    assert.equal(await page.evaluate(() => globalThis.__tree.isPhone()), true);
    assert.equal(await page.isVisible('#tabbar'), true);

    const canvasBox = await page.locator('#tree').boundingBox();
    assert.equal(Math.round(canvasBox.width), phone.viewport.height);

    // the renderer followed the resize rather than keeping a stale backing store
    const canvas = await page.evaluate(() => ({
      width: document.getElementById('tree').width,
      viewport: globalThis.__tree.app.camera.viewportWidth,
    }));
    assert.equal(canvas.width, canvas.viewport);

    await page.tap('#tabbar button[data-tab="character"]');
    await page.waitForTimeout(200);
    const sheet = await page.locator('#panel-character').boundingBox();
    assert.ok(
      sheet.height <= phone.viewport.width * 0.8,
      'the sheet must not swallow a landscape screen',
    );
  });

  await t.test('no page errors were raised in any of that', () => {
    assert.deepEqual(errors, []);
  });

  await context.close();
  await browser.close();
  server.close();
});
