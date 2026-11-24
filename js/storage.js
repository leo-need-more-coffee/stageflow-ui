/**
 * Keeping the editor's state across reloads: the pipeline, the view (pan,
 * zoom, current subpipeline) and the panel layout.
 *
 * Storage may be unavailable or full (private mode, quota, site policy); a
 * failed write is ignored and the editor keeps working.
 *
 * Writes are debounced: an edit is often dozens of events in a row.
 */
const VERSION = 1;

/**
 * Read JSON from `localStorage`, returning null if storage is unavailable or
 * the value is malformed. Shared by the editor state and the secret store.
 */
export function readJson(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // unavailable or corrupted — start from a clean slate
  }
}

export function writeJson(key, value) {
  if (!key) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota or a write ban: carry on silently without saving
  }
}

export function removeKey(key) {
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // see readJson
  }
}

export class EditorStore {
  #timer = null;

  /** @param key the localStorage key; without one, nothing is stored */
  constructor(key, { delay = 400 } = {}) {
    this.key = key || null;
    this.delay = delay;
  }

  get enabled() { return Boolean(this.key); }

  /** The saved state, or null. A record of another version is ignored. */
  load() {
    if (!this.enabled) return null;
    const state = readJson(this.key);
    return state?.version === VERSION && state.pipeline ? state : null;
  }

  /** A debounced write: frequent edits become one. */
  save(getState) {
    if (!this.enabled) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#write(getState), this.delay);
  }

  /** An immediate write, for page unload. */
  flush(getState) {
    if (!this.enabled) return;
    clearTimeout(this.#timer);
    this.#write(getState);
  }

  #write(getState) {
    writeJson(this.key, { version: VERSION, ...getState() });
  }

  clear() {
    if (!this.enabled) return;
    clearTimeout(this.#timer);
    removeKey(this.key);
  }
}
