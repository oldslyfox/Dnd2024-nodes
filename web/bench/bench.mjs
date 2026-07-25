/**
 * Work Order 3, Task 8 - measure the real thing, not a synthetic scene.
 *
 * Drives the built dist/index.html in headless Chromium: a scripted pan sweep, a
 * zoom sweep, and a worst-case full-graph frame (everything visible, no cull
 * benefit), recording frame times from the renderer itself. Writes
 * bench/bench_results.json.
 *
 *   npm run bench
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distIndex = join(root, 'dist/index.html');

if (!existsSync(distIndex)) {
  throw new Error('dist/index.html missing - run npm run build first');
}

// A throwaway loopback server keeps the benchmark honest about how the page is
// normally served. The app itself works from file:// too, since the data is
// inlined.
const server = createServer(async (request, response) => {
  try {
    const body = await readFile(distIndex);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// Use whatever Chromium is on the machine. CHROMIUM_PATH wins; otherwise fall
// back to the common preinstalled locations before letting Playwright resolve
// its own download (which may not match the pinned build).
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const entry of readdirSync(root)) {
      const guess = join(root, entry, 'chrome-linux', 'chrome');
      if (entry.startsWith('chromium-') && existsSync(guess)) return guess;
    }
  }
  return undefined;
}

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());

// start a character so the renderer is doing its full job (reachability
// colouring, owned edges, the lot) rather than an inert graph
await page.evaluate(() => {
  document.querySelector('#zone-grid button').click();
});

/** Run `frames` frames of a scripted camera motion, return frame times in ms. */
async function measure(name, script, frames = 120) {
  const samples = await page.evaluate(
    async ({ script, frames }) => {
      const tree = globalThis.__tree;
      const step = new Function('tree', 'i', script);
      const times = [];
      for (let i = 0; i < frames; i += 1) {
        step(tree, i);
        const started = performance.now();
        tree.drawOnce();
        times.push(performance.now() - started);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return times;
    },
    { script, frames },
  );

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const worst = samples[samples.length - 1];
  return {
    name,
    frames: samples.length,
    mean_ms: Number(mean.toFixed(2)),
    p95_ms: Number(p95.toFixed(2)),
    worst_ms: Number(worst.toFixed(2)),
    mean_fps: Number((1000 / mean).toFixed(1)),
    p95_fps: Number((1000 / p95).toFixed(1)),
    holds_60fps: p95 <= 16.7,
  };
}

const results = [];
results.push(
  await measure(
    'pan at readable zoom (near LOD)',
    'tree.setZoom(12); tree.panBy(Math.sin(i / 8) * 26, Math.cos(i / 11) * 22);',
  ),
);
results.push(
  await measure(
    'pan at mid zoom',
    'tree.setZoom(6.5); tree.panBy(Math.sin(i / 7) * 30, Math.cos(i / 9) * 26);',
  ),
);
results.push(
  await measure(
    'zoom sweep, whole graph to a single zone',
    'tree.setZoom(2.6 + (Math.sin(i / 15) + 1) * 8);',
  ),
);
results.push(
  await measure(
    'pan with the “see also” overlay on',
    'tree.app.renderer.showReferences = true; tree.setZoom(12); tree.panBy(Math.sin(i / 8) * 24, Math.cos(i / 10) * 20);',
  ),
);
results.push(
  await measure(
    'worst case: entire graph in view, every node drawn',
    'tree.app.renderer.showReferences = false; tree.app.camera.fit(tree.app.index.bounds);',
  ),
);
results.push(
  await measure(
    'worst case with overlay and labels',
    'tree.app.renderer.showReferences = true; tree.setZoom(11.5); tree.panBy(Math.sin(i / 6) * 18, 0);',
  ),
);

const nodeCount = await page.evaluate(() => globalThis.__tree.app.index.nodes.length);
const drawn = await page.evaluate(() => globalThis.__tree.app.renderer.lastDrawnNodes);
const userAgent = await page.evaluate(() => navigator.userAgent);

await browser.close();
server.close();

const summary = {
  measured_at: new Date().toISOString(),
  renderer: 'Canvas 2D',
  viewport: '1600x950',
  device_pixel_ratio_cap: 2,
  node_count: nodeCount,
  nodes_drawn_in_worst_case: drawn,
  user_agent: userAgent,
  results,
  verdict: results.every((entry) => entry.holds_60fps)
    ? 'Canvas 2D holds 60fps across every measured motion; no reason to escalate to WebGL.'
    : 'At least one motion missed the 16.7ms budget - see results before considering WebGL.',
};

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'bench_results.json'), JSON.stringify(summary, null, 2));

console.log(summary.verdict);
for (const entry of results) {
  console.log(
    `  ${entry.name.padEnd(46)} mean ${entry.mean_ms.toFixed(2)}ms (${entry.mean_fps} fps), ` +
      `p95 ${entry.p95_ms.toFixed(2)}ms`,
  );
}
