/**
 * Work Order 4, Task 6 - phone-class performance, measured rather than assumed.
 *
 * Desktop numbers do not carry over: a phone has a third of the CPU, three times
 * the device pixel ratio and a fraction of the viewport. So this benchmark
 *
 *   * runs at real phone viewports, portrait and landscape, at the device's own
 *     pixel ratio;
 *   * throttles the CPU 4x through CDP, which is roughly a mid-range Android
 *     against this machine;
 *   * drives *real touch events* (CDP Input.dispatchTouchEvent), including
 *     two-finger pinch, rather than calling camera methods directly;
 *   * measures touch-to-frame latency, not just frame time - on touch, latency
 *     is what makes a drag feel attached to your finger.
 *
 *   npm run bench:mobile   ->  bench/bench_results_mobile.json
 */

import { chromium, devices } from 'playwright';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distIndex = join(root, 'dist/index.html');
const CPU_THROTTLE = 4;

if (!existsSync(distIndex)) {
  throw new Error('dist/index.html missing - run npm run build first');
}

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
  const body = await readFile(distIndex);
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: findChromium() });
const phone = devices['Pixel 7'] || devices['Pixel 5'];

/** Instrument the page: frame times, and touch-event-to-frame latency. */
const INSTRUMENT = () => {
  const tree = globalThis.__tree;
  const canvas = document.getElementById('tree');
  const stats = { frames: [], latencies: [] };
  let pendingInput = null;

  canvas.addEventListener(
    'pointermove',
    () => {
      if (pendingInput === null) pendingInput = performance.now();
    },
    true,
  );

  const original = tree.app.renderer.draw.bind(tree.app.renderer);
  tree.app.renderer.draw = () => {
    const started = performance.now();
    original();
    const ended = performance.now();
    stats.frames.push(ended - started);
    if (pendingInput !== null) {
      stats.latencies.push(ended - pendingInput);
      pendingInput = null;
    }
  };

  globalThis.__stats = stats;
  globalThis.__resetStats = () => {
    stats.frames.length = 0;
    stats.latencies.length = 0;
  };
};

function summarise(name, samples, latencies, extra = {}) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const latencySorted = [...latencies].sort((a, b) => a - b);
  const latencyMean =
    latencySorted.reduce((sum, value) => sum + value, 0) / (latencySorted.length || 1);
  const latencyP95 = latencySorted[Math.floor(latencySorted.length * 0.95)] ?? 0;
  return {
    name,
    frames: sorted.length,
    mean_ms: Number(mean.toFixed(2)),
    p95_ms: Number(p95.toFixed(2)),
    mean_fps: Number((1000 / (mean || 1)).toFixed(1)),
    holds_60fps: p95 <= 16.7,
    touch_to_frame_mean_ms: latencySorted.length ? Number(latencyMean.toFixed(2)) : null,
    touch_to_frame_p95_ms: latencySorted.length ? Number(latencyP95.toFixed(2)) : null,
    ...extra,
  };
}

/**
 * A real one-finger drag, dispatched as touch events through CDP.
 * @returns {Promise<void>}
 */
async function touchDrag(cdp, from, to, steps = 24) {
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
}

/** A real two-finger pinch, dispatched as touch events through CDP. */
async function touchPinch(cdp, centre, fromGap, toGap, steps = 24) {
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
}

async function runProfile(label, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

  await page.goto(url);
  await page.waitForFunction(() => globalThis.__tree && globalThis.__tree.ready());
  await page.evaluate(INSTRUMENT);
  await page.tap('#zone-grid button:has-text("Wizard")');
  await page.waitForTimeout(300);

  const { width, height } = contextOptions.viewport;
  const centre = { x: Math.round(width / 2), y: Math.round(height / 2) };
  const results = [];

  const collect = async (name, action, extra = {}) => {
    await page.evaluate(() => globalThis.__resetStats());
    await action();
    await page.waitForTimeout(120);
    const stats = await page.evaluate(() => ({
      frames: globalThis.__stats.frames,
      latencies: globalThis.__stats.latencies,
    }));
    results.push(summarise(name, stats.frames, stats.latencies, extra));
  };

  await collect('one-finger pan', () =>
    touchDrag(cdp, { x: centre.x - 90, y: centre.y - 60 }, { x: centre.x + 90, y: centre.y + 80 }),
  );

  const zoomBefore = await page.evaluate(() => globalThis.__tree.app.camera.scale);
  await collect('two-finger pinch zoom', () => touchPinch(cdp, centre, 90, 320));
  const zoomAfter = await page.evaluate(() => globalThis.__tree.app.camera.scale);
  results[results.length - 1].zoom_changed = Number((zoomAfter / zoomBefore).toFixed(2));

  await page.evaluate(() => {
    globalThis.__tree.app.camera.fit(globalThis.__tree.app.index.bounds);
    globalThis.__tree.markDirty();
  });
  await collect(
    'pan with the whole graph in view',
    () => touchDrag(cdp, { x: centre.x - 70, y: centre.y }, { x: centre.x + 70, y: centre.y }),
    { nodes_drawn: await page.evaluate(() => globalThis.__tree.app.renderer.lastDrawnNodes) },
  );

  await page.evaluate(() => {
    globalThis.__tree.app.renderer.showReferences = true;
    globalThis.__tree.markDirty();
  });
  await collect('pan with the “see also” overlay on', () =>
    touchDrag(cdp, { x: centre.x, y: centre.y - 60 }, { x: centre.x, y: centre.y + 60 }),
  );

  const dpr = await page.evaluate(() => globalThis.devicePixelRatio);
  await context.close();
  return { profile: label, viewport: `${width}x${height}`, device_pixel_ratio: dpr, results };
}

const portrait = await runProfile('phone portrait', {
  ...phone,
  viewport: phone.viewport,
});
const landscape = await runProfile('phone landscape', {
  ...phone,
  viewport: { width: phone.viewport.height, height: phone.viewport.width },
});

await browser.close();
server.close();

const profiles = [portrait, landscape];
const worst = Math.max(
  ...profiles.flatMap((profile) => profile.results.map((entry) => entry.p95_ms)),
);
const worstLatency = Math.max(
  ...profiles.flatMap((profile) =>
    profile.results.map((entry) => entry.touch_to_frame_p95_ms || 0),
  ),
);

const summary = {
  measured_at: new Date().toISOString(),
  renderer: 'Canvas 2D',
  device_profile: phone.userAgent.includes('Pixel') ? 'Pixel 7 (Playwright device profile)' : 'phone',
  cpu_throttling: `${CPU_THROTTLE}x`,
  note:
    'Real touch events dispatched through CDP, including two-finger pinch. ' +
    'Frame times are the renderer’s own; touch-to-frame is from the pointer ' +
    'event arriving to that frame finishing.',
  profiles,
  worst_p95_frame_ms: Number(worst.toFixed(2)),
  worst_p95_touch_to_frame_ms: Number(worstLatency.toFixed(2)),
  verdict:
    worst <= 16.7
      ? `Holds 60fps on a ${CPU_THROTTLE}x-throttled phone profile in both orientations; Canvas 2D stays sufficient.`
      : `Worst p95 frame is ${worst.toFixed(1)}ms on a ${CPU_THROTTLE}x-throttled phone - below 60fps, see results.`,
};

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'bench_results_mobile.json'), JSON.stringify(summary, null, 2));

console.log(summary.verdict);
for (const profile of profiles) {
  console.log(`\n${profile.profile} (${profile.viewport} @ ${profile.device_pixel_ratio}x)`);
  for (const entry of profile.results) {
    console.log(
      `  ${entry.name.padEnd(34)} frame mean ${String(entry.mean_ms).padStart(6)}ms  ` +
        `p95 ${String(entry.p95_ms).padStart(6)}ms  ` +
        `touch→frame p95 ${String(entry.touch_to_frame_p95_ms ?? '—').padStart(6)}ms`,
    );
  }
}
