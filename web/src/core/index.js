/**
 * Public surface of the framework-agnostic core (Work Order 3, decision 4).
 *
 * Nothing under src/core imports a UI framework, the DOM, or any browser global.
 * The only external input is a parsed `graph.v2.json` object; storage is behind
 * an injected backend. A Foundry VTT module can import this file as-is.
 *
 * tests/core.test.mjs asserts the no-UI-dependency property mechanically.
 */

import { PathEngine } from './engine.js';
import { GraphIndex } from './graph.js';

export { PathEngine, PlayerState, HUB_ID } from './engine.js';
export { satisfied, unmetReasons, EMPTY_PREREQS } from './prereqs.js';
export {
  priceOf,
  canDeallocate,
  deallocate,
  respec,
  characterSummary,
} from './character.js';
export { GraphIndex } from './graph.js';
export { BuildStore, MemoryStorage } from './storage.js';

/**
 * Build everything the UI needs from a parsed graph document.
 * @param {any} graph
 * @returns {{index: GraphIndex, engine: PathEngine}}
 */
export function createSession(graph) {
  return { index: new GraphIndex(graph), engine: new PathEngine(graph) };
}
