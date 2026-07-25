/**
 * Copy the Work Order 2 outputs into the web app's static assets.
 *
 * The renderer never reads ../data/output directly at runtime - it ships its own
 * copy as a build-time asset, per Task 2.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = join(root, '../data/output');
const target = join(root, 'public/data');

mkdirSync(target, { recursive: true });
for (const file of ['graph.v2.json', 'point_economy.json']) {
  copyFileSync(join(source, file), join(target, file));
  console.log(`synced ${file}`);
}
