/**
 * Capture screenshots of the built app for review.
 *
 *   node bench/screenshot.mjs [outdir]
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = process.argv[2] || join(root, 'bench/shots');
mkdirSync(outDir, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
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
  return undefined;
}

const server = createServer(async (_request, response) => {
  const body = await readFile(join(root, 'dist/index.html'));
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on('console', (message) => {
  if (message.type() === 'error') console.log('page error:', message.text());
});
page.on('pageerror', (error) => console.log('page exception:', error.message));

await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());
await page.screenshot({ path: join(outDir, '01-onboarding.png') });

// pick Wizard, then frame the whole graph
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('#zone-grid button')];
  buttons.find((button) => button.textContent.startsWith('Wizard')).click();
});
await page.evaluate(() => {
  globalThis.__tree.app.camera.fit(globalThis.__tree.app.index.bounds);
  globalThis.__tree.markDirty();
});
await page.waitForTimeout(250);
await page.screenshot({ path: join(outDir, '02-full-graph.png') });

// allocate something cross-zone, then hover a distant node for the path preview
await page.evaluate(() => {
  const tree = globalThis.__tree;
  tree.app.engine.allocate(tree.app.state, 'cf_fighter_extra_attack_5');
  tree.app.renderer.setState(tree.app.state);
  tree.app.camera.centreOn(0, 0, 7);
  tree.app.renderer.hoverId = 'cf_monk_body_and_mind_20';
  tree.app.renderer.previewPath =
    tree.app.engine.canAfford(tree.app.state, 'cf_monk_body_and_mind_20').path;
  tree.markDirty();
});
await page.waitForTimeout(250);
await page.screenshot({ path: join(outDir, '03-path-preview.png') });

// zoomed in: shapes, labels, states
await page.evaluate(() => {
  const tree = globalThis.__tree;
  const node = tree.app.index.byId.get('cf_wizard_arcane_recovery_1');
  tree.app.camera.centreOn(node.position_x + 6, node.position_y, 15);
  tree.app.renderer.showReferences = true;
  tree.markDirty();
});
await page.waitForTimeout(250);
await page.screenshot({ path: join(outDir, '04-zoomed-in.png') });

// the commons ring at a normal reading zoom - the Work Order 5 acceptance shot
await page.evaluate(() => {
  const tree = globalThis.__tree;
  const node = tree.app.index.byId.get('feat_alert_xphb');
  tree.app.renderer.showReferences = false;
  tree.app.camera.centreOn(0, 0, tree.app.camera.lodNear * 1.15);
  tree.select(node);
  tree.markDirty();
});
await page.waitForTimeout(250);
await page.screenshot({ path: join(outDir, '05-commons-reading-zoom.png') });

// Work Order 6: the playtest build - Fighter with Paladin, Barbarian and Bard
// splashed in - showing owned nodes and edges against a pulsing frontier.
const SPLASH = [
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
await page.evaluate(() => {
  globalThis.__tree.app.renderer.showReferences = false;
  document.getElementById('btn-respec').click();
  [...document.querySelectorAll('#zone-grid button')]
    .find((button) => button.textContent.startsWith('Fighter'))
    ?.click();
});
await page.evaluate((ids) => {
  // through the real UI path: select, then confirm
  for (const id of ids) {
    globalThis.__tree.select(globalThis.__tree.app.index.byId.get(id));
    const allocate = document.getElementById('btn-allocate');
    if (!allocate.disabled) allocate.click();
  }
  globalThis.__tree.select(null);
}, SPLASH);
await page.evaluate(() => {
  const tree = globalThis.__tree;
  const node = tree.app.index.byId.get('gate_fighter');
  tree.app.camera.centreOn(node.position_x + 3, node.position_y, tree.app.camera.lodNear * 3.2);
  tree.markDirty();
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, '06-owned-and-frontier.png') });

// the same build read back as a character sheet, in the left panel
await page.evaluate(() => {
  document.getElementById('sheet-body').scrollTop = 0;
});
await page.waitForTimeout(200);
await page.screenshot({ path: join(outDir, '07-character-sheet.png') });

await browser.close();
server.close();
console.log(`screenshots in ${outDir}`);
