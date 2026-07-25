/**
 * Build a single self-contained page.
 *
 * dist/index.html carries the bundled JS, the CSS and the whole graph inline, so
 * it satisfies the work order's first locked decision at its strictest reading:
 * open the file from disk, no server, no network, nothing else to install.
 *
 *   node scripts/build.mjs
 */

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');

mkdirSync(dist, { recursive: true });

const graphPath = join(root, 'public/data/graph.v2.json');
if (!existsSync(graphPath)) {
  throw new Error('public/data/graph.v2.json missing - run npm run sync-data first');
}
const graph = readFileSync(graphPath, 'utf8');

const result = await build({
  entryPoints: [join(root, 'src/app/main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome100', 'firefox100', 'safari15'],
  minify: true,
  write: false,
  logLevel: 'warning',
});
const js = result.outputFiles[0].text;
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');

const html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="./src/styles.css" />', `<style>\n${css}\n</style>`)
  .replace(
    '<script type="module" src="./src/app/main.js"></script>',
    `<script id="graph-data" type="application/json">${graph}</script>\n` +
      '<script>globalThis.__GRAPH_DATA__ = JSON.parse(document.getElementById("graph-data").textContent);</script>\n' +
      `<script>${js}</script>`,
  );

// One file, deliberately: the data is inlined, so there is nothing beside it to
// serve, copy or lose.
writeFileSync(join(dist, 'index.html'), html);

const kb = (text) => `${Math.round(Buffer.byteLength(text) / 1024)} KB`;
console.log(`dist/index.html  ${kb(html)}  (js ${kb(js)}, css ${kb(css)}, data ${kb(graph)})`);
console.log('open it directly in a browser - no server needed');
