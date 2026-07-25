/**
 * End-to-end UI tests against the built single-file app.
 *
 * The acceptance criteria say search, hover-preview, allocate, respec and
 * save/load must all work end to end, so these drive the real page in headless
 * Chromium with real pointer events - no calling the app's internals to fake it.
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

test('browser UI', { skip: canRun ? false : 'no Chromium available' }, async (t) => {
  if (!existsSync(distIndex)) {
    execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
  }

  const server = createServer(async (_request, response) => {
    const body = await readFile(distIndex);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await playwright.chromium.launch({ executablePath: chromiumPath });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(url);
  await page.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());

  /** Screen position of a node, for real pointer events. */
  const nodeAt = (id) =>
    page.evaluate((nodeId) => {
      const tree = globalThis.__tree;
      const node = tree.app.index.byId.get(nodeId);
      const point = tree.app.camera.worldToScreen(node.position_x, node.position_y);
      const dpr = tree.app.renderer.dpr || 1;
      const rect = document.getElementById('tree').getBoundingClientRect();
      return { x: rect.left + point.x / dpr, y: rect.top + point.y / dpr };
    }, id);

  const centreOn = (id, scale = 14) =>
    page.evaluate(
      ({ nodeId, zoom }) => {
        const tree = globalThis.__tree;
        const node = tree.app.index.byId.get(nodeId);
        tree.app.camera.centreOn(node.position_x, node.position_y, zoom);
        tree.markDirty();
      },
      { nodeId: id, zoom: scale },
    );

  await t.test('onboarding blocks allocation until a zone is chosen', async () => {
    assert.equal(await page.isVisible('#onboarding'), true);
    const state = await page.evaluate(() => globalThis.__tree.app.state);
    assert.equal(state, null);
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

  await t.test('hover previews the path the click would allocate', async () => {
    await centreOn('cf_fighter_extra_attack_5');
    const point = await nodeAt('cf_fighter_extra_attack_5');
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(80);

    assert.equal(await page.isVisible('#tooltip'), true);
    const tooltip = await page.textContent('#tooltip');
    assert.match(tooltip, /Extra Attack/);
    assert.match(tooltip, /4 points/);

    const preview = await page.evaluate(() => globalThis.__tree.app.renderer.previewPath);
    assert.deepEqual(preview, [
      'conn_core_hub',
      'gate_fighter',
      'conn_fighter_rung_1',
      'conn_fighter_rung_4',
      'cf_fighter_extra_attack_5',
    ]);
  });

  await t.test('clicking allocates the whole path and spends points', async () => {
    const point = await nodeAt('cf_fighter_extra_attack_5');
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(80);

    const state = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(state.pointsSpent, 4);
    assert.ok(state.owned.includes('cf_fighter_extra_attack_5'));
    assert.ok(state.owned.includes('gate_fighter'));
    assert.match(await page.textContent('#chassis-body'), /54 \/ 58 points left/);
  });

  await t.test('alt-click refunds a leaf node', async () => {
    const point = await nodeAt('cf_fighter_extra_attack_5');
    await page.keyboard.down('Alt');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Alt');
    await page.waitForTimeout(80);

    const state = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(state.pointsSpent, 3);
    assert.ok(!state.owned.includes('cf_fighter_extra_attack_5'));
    assert.match(await page.textContent('#build-status'), /Refunded/);
  });

  await t.test('search highlights matches and frames the first hit', async () => {
    await page.fill('#search', 'metamagic');
    await page.waitForTimeout(120);
    // the ten Metamagic options plus the four Sorcerer features that grant them
    assert.match(await page.textContent('#search-count'), /14 matches/);
    const hits = await page.evaluate(() => [...globalThis.__tree.app.renderer.searchHits]);
    assert.equal(hits.length, 14);
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
    assert.equal(stored[0].name, 'test build');
    const savedSpend = stored[0].state.pointsSpent;

    // spend more, then load the save back and check it reverts
    await centreOn('cf_wizard_spell_mastery_18');
    const point = await nodeAt('cf_wizard_spell_mastery_18');
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(80);
    const after = await page.evaluate(() => globalThis.__tree.app.state.pointsSpent);
    assert.ok(after > savedSpend);

    await page.selectOption('#build-list', 'test build');
    await page.click('#btn-load');
    await page.waitForTimeout(80);
    const reloaded = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(reloaded.pointsSpent, savedSpend);
    assert.match(await page.textContent('#build-status'), /Loaded/);
  });

  await t.test('respec resets to a fresh character in the same zone', async () => {
    await page.click('#btn-respec');
    await page.waitForTimeout(80);
    const state = await page.evaluate(() => globalThis.__tree.app.state.toJSON());
    assert.equal(state.pointsSpent, 0);
    assert.equal(state.homeZone, 'Wizard');
    assert.deepEqual(state.owned.sort(), ['conn_core_hub', 'gate_wizard']);
    assert.match(await page.textContent('#chassis-body'), /58 \/ 58 points left/);
  });

  await t.test('the reference overlay toggles without becoming pathable', async () => {
    await page.check('#toggle-references');
    assert.equal(
      await page.evaluate(() => globalThis.__tree.app.renderer.showReferences),
      true,
    );
    const leaked = await page.evaluate(() => {
      const tree = globalThis.__tree;
      return tree.app.index.referenceEdges.some((edge) =>
        tree.app.engine.adjacency.get(edge.from).includes(edge.to),
      );
    });
    assert.equal(leaked, false);
    await page.uncheck('#toggle-references');
  });

  await t.test('pan and zoom move the camera', async () => {
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
