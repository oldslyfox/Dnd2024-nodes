/**
 * Named build persistence.
 *
 * The storage backend is injected, so core stays free of browser globals: the
 * web shell passes `window.localStorage`, tests pass a Map-backed stub, and a
 * future Foundry wrapper can pass an adapter over Foundry's own settings API
 * without touching this file.
 */

const KEY = 'dnd2024.tree.builds.v1';

/** @typedef {{name: string, saved_at: string, state: any}} SavedBuild */

/** In-memory backend with the localStorage shape, for tests and headless use. */
export class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

export class BuildStore {
  /** @param {{getItem: Function, setItem: Function, removeItem: Function}} backend */
  constructor(backend) {
    this.backend = backend || new MemoryStorage();
  }

  /** @returns {SavedBuild[]} */
  list() {
    try {
      const raw = this.backend.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** @param {string} name @param {any} stateJson */
  save(name, stateJson) {
    const builds = this.list().filter((build) => build.name !== name);
    builds.push({ name, saved_at: new Date().toISOString(), state: stateJson });
    builds.sort((a, b) => a.name.localeCompare(b.name));
    this.backend.setItem(KEY, JSON.stringify(builds));
    return builds;
  }

  /** @param {string} name */
  load(name) {
    const build = this.list().find((entry) => entry.name === name);
    return build ? build.state : null;
  }

  /** @param {string} name */
  remove(name) {
    const builds = this.list().filter((build) => build.name !== name);
    this.backend.setItem(KEY, JSON.stringify(builds));
    return builds;
  }

  clear() {
    this.backend.removeItem(KEY);
  }
}
