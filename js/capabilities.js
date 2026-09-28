/**
 * What the backend on the other end can actually run.
 *
 * The editor is built against one version of the core and then pointed at
 * whatever backend the user has. `kinds.js` mirrors the core's node registry
 * as it stood when the editor was built, so an editor newer than its backend
 * offers a node type the run will refuse — the mismatch used to surface as
 * `Unknown node type: 'map'` halfway through a run, which names neither the
 * cause nor the cure.
 *
 * A version range would not fix it: a backend with a node type of its own
 * belongs to no range. So the backend is asked what it has —
 * `GET /api/meta` answers with the registry itself — and the editor marks
 * what it cannot offer instead of guessing.
 *
 * An older backend has no such endpoint. Then nothing is known, and nothing
 * is marked: a false "unsupported" on a perfectly good backend is worse than
 * the error we are avoiding. `known` says which of the two situations this is.
 */

export class BackendCapabilities extends EventTarget {
  /** null — nothing is known (no /api/meta); otherwise the Set of node types. */
  #nodeTypes = null;
  #version = null;
  #api = null;
  #probed = false;

  get known() { return this.#nodeTypes !== null; }

  get probed() { return this.#probed; }

  /** The core's version, or null when the backend did not say. */
  get version() { return this.#version; }

  /** The version of the backend's HTTP contract, or null. */
  get api() { return this.#api; }

  get nodeTypes() { return this.#nodeTypes ? [...this.#nodeTypes].sort() : null; }

  /** Unknown means "do not get in the way": only a listed absence is a no. */
  supports(type) {
    return this.#nodeTypes === null || this.#nodeTypes.has(type);
  }

  /** Why a node type is not on offer, in words fit for a tooltip. */
  reason(type) {
    if (this.supports(type)) return "";
    const which = this.#version ? `the backend (core ${this.#version})` : "the backend";
    return `${which} cannot run a '${type}' node — it needs a newer StageFlow`;
  }

  /** One line about the backend for the status bar and the connection screen. */
  summary() {
    if (!this.#probed) return "";
    if (!this.known) return "backend version unknown (it serves no /api/meta)";
    return `core ${this.#version}, api v${this.#api}, ${this.#nodeTypes.size} node types`;
  }

  setMeta(meta) {
    const types = meta?.node_types;
    this.#nodeTypes = Array.isArray(types) && types.length ? new Set(types) : null;
    this.#version = meta?.stageflow ?? null;
    this.#api = meta?.api ?? null;
    this.#probed = true;
    this.dispatchEvent(new Event("change"));
  }

  /** Nothing was learned — an old backend, or one that answered with rubbish. */
  setUnknown() {
    this.#nodeTypes = null;
    this.#version = null;
    this.#api = null;
    this.#probed = true;
    this.dispatchEvent(new Event("change"));
  }

  /**
   * Asks the backend. Never throws and never blocks the editor: a backend
   * that does not answer this is simply one the editor knows nothing about.
   */
  async load(backend) {
    try {
      const meta = await backend.fetchMeta();
      meta ? this.setMeta(meta) : this.setUnknown();
    } catch {
      this.setUnknown();
    }
    return this;
  }
}
