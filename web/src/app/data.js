/**
 * Data loading (Work Order 3, Task 2).
 *
 * Two modes, no server either way:
 *   * dev - the graph is a static asset next to the page, loaded same-origin
 *     relative to this module;
 *   * built - `npm run build` inlines it into dist/index.html as
 *     `globalThis.__GRAPH_DATA__`, so the file opens straight off disk with no
 *     fetch at all.
 *
 * There is no code path that talks to an external host.
 */

/** Resolved lazily: the bundled build has no import.meta and never needs it. */
export function graphDataUrl() {
  if (globalThis.__GRAPH_DATA__) return 'inline';
  try {
    return new URL('../../public/data/graph.v2.json', import.meta.url).href;
  } catch {
    return './data/graph.v2.json';
  }
}

export async function loadGraph() {
  if (globalThis.__GRAPH_DATA__) return globalThis.__GRAPH_DATA__;
  const url = graphDataUrl();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not load graph.v2.json from ${url} (${response.status})`);
  }
  return response.json();
}
