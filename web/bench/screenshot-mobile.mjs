/**
 * Capture phone-viewport screenshots of the built app (Work Order 4).
 *
 *   node bench/screenshot-mobile.mjs [outdir]
 */

import { chromium, devices } from 'playwright';
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
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: findChromium() });

async function shoot(name, contextOptions, script) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`${name} page error:`, error.message));
  await page.goto(url);
  await page.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());
  if (script) await script(page);
  await page.waitForTimeout(320);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  await context.close();
}

const phone = devices['Pixel 7'] || devices['Pixel 5'];
const landscape = {
  ...phone,
  viewport: { width: phone.viewport.height, height: phone.viewport.width },
};

await shoot('10-mobile-onboarding', phone);

await shoot('11-mobile-tree', phone, async (page) => {
  await page.tap('#zone-grid button:has-text("Wizard")');
  await page.waitForTimeout(200);
});

await shoot('12-mobile-detail', phone, async (page) => {
  await page.tap('#zone-grid button:has-text("Wizard")');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const tree = globalThis.__tree;
    const node = tree.app.index.byId.get('cf_fighter_extra_attack_5');
    tree.app.camera.centreOn(node.position_x, node.position_y, 10);
    tree.select(node, { openSheet: true });
  });
});

await shoot('13-mobile-character-sheet', phone, async (page) => {
  await page.tap('#zone-grid button:has-text("Monk")');
  await page.waitForTimeout(200);
  await page.tap('#tabbar button[data-tab="character"]');
});

await shoot('14-mobile-landscape', landscape, async (page) => {
  await page.tap('#zone-grid button:has-text("Bard")');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const tree = globalThis.__tree;
    const node = tree.app.index.byId.get('slot_bard_t5');
    tree.app.camera.centreOn(node.position_x, node.position_y, 9);
    tree.select(node, { openSheet: true });
  });
});

await browser.close();
server.close();
console.log(`mobile screenshots in ${outDir}`);
