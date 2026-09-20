/**
 * Keeping the editor state between reloads.
 *
 * The canvas is a workplace, not a demonstration: close the tab, come back —
 * the graph, the zoom and the viewport are where you left them. So it is not
 * only the pipeline that goes into `localStorage`, but also the view (pan and
 * zoom, the current subpipeline) and the panel layout: a restored graph at
 * someone else's zoom still reads as "it reset itself".
 *
 * The storage can be unavailable or full (private mode, quota, site policy) —
 * which is no reason to bring the editor down, so every access is wrapped: if
 * it did not save, it did not save, and work goes on.
 *
 * Writes are deferred: editing a graph is dozens of events in a row (dragging
 * a node, typing a name), and there is no point writing on every one of them.
 */
const VERSION = 1;

/**
 * Reading and writing JSON in `localStorage` in a way that does not bring the
 * editor down.
 *
 * The storage can be unavailable or full (private mode, quota, site policy),
 * and touching it throws. Shared wrappers are there so that this "not a reason
 * to crash" is written once rather than in everything that remembers something
 * between reloads (the editor state, the secret store).
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
    // see above
  }
}

export class EditorStore {
  #timer = null;

  /** @param key the localStorage key; without it the storage is off */
  constructor(key, { delay = 400 } = {}) {
    this.key = key || null;
    this.delay = delay;
  }

  get enabled() { return Boolean(this.key); }

  /** The saved state or null. A foreign or outdated record is ignored. */
  load() {
    if (!this.enabled) return null;
    const state = readJson(this.key);
    return state?.version === VERSION && state.pipeline ? state : null;
  }

  /** A deferred write: frequent edits collapse into one. */
  save(getState) {
    if (!this.enabled) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#write(getState), this.delay);
  }

  /** An immediate write — for page unload, when there is nothing left to wait for. */
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
