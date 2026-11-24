/**
 * The secret store: API keys and other values a run needs that must not be in
 * the pipeline JSON or on screen.
 *
 * A pipeline is a document that gets exported, shared and committed, so a key
 * typed into `entry.variables` would travel with it. Instead keys are kept
 * apart and the graph refers to them by name: a stage's `arguments.vars` reads
 * `OPENAI_API_KEY` like any variable, and the value is supplied at start.
 *
 * Two sources:
 *   - `local`: typed into the editor and kept in this browser's
 *     `localStorage`; the value is sent to the backend in the starting frame.
 *   - `env`: the backend's own environment (`SF_SECRETS`, `SF_SECRET_*`); the
 *     browser only gets the names and the backend substitutes the values.
 *
 * This is not encryption: `localStorage` is readable by extensions and
 * devtools. It keeps keys out of documents, screenshots and logs, which is why
 * a saved value is never shown again, only replaced or deleted. Real secrets
 * belong in `env`.
 *
 * Every value is masked the same way, so the mask does not reveal its length.
 */
import { readJson, removeKey, writeJson } from "./storage.js";

export const SECRET_MASK = "••••••••";

/** A secret name is a variable name: letters, digits and underscores. */
export function validSecretName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export class SecretStore extends EventTarget {
  #local = new Map(); // name -> value (known to this tab only)
  #env = [];          // names from the server environment; no values here

  /** @param key the editor's storage key; secrets are stored under their own
   * key so that exporting the editor state does not include them */
  constructor(key) {
    super();
    this.storageKey = key ? `${key}:secrets` : null;
    const saved = readJson(this.storageKey);
    if (saved?.secrets && typeof saved.secrets === "object") {
      for (const [name, value] of Object.entries(saved.secrets)) {
        if (validSecretName(name) && typeof value === "string") this.#local.set(name, value);
      }
    }
  }

  /** Every known name, local and server-side. */
  names() {
    return [...new Set([...this.#local.keys(), ...this.#env])].sort();
  }

  get size() { return this.names().length; }

  has(name) { return this.#local.has(name) || this.#env.includes(name); }

  /** "local" | "env" | null: where the value comes from. */
  sourceOf(name) {
    if (this.#local.has(name)) return "local";
    return this.#env.includes(name) ? "env" : null;
  }

  set(name, value) {
    if (!validSecretName(name)) return false;
    this.#local.set(name, String(value));
    this.#persist();
    return true;
  }

  remove(name) {
    if (!this.#local.delete(name)) return false;
    this.#persist();
    return true;
  }

  /**
   * What to send with a run of this pipeline.
   *
   * A key is included only if its name occurs in the pipeline JSON (in
   * `arguments.vars`, in a CEL expression, anywhere), so a run does not carry
   * every key into its frame. Crude, but it never leaves out a key the graph
   * uses.
   *
   * @returns {{vars, env, names}}: `vars` the local values, `env` the names the
   * backend substitutes, `names` every secret name, which the backend uses to
   * mask values in the events.
   */
  forRun(pipeline) {
    const text = JSON.stringify(pipeline ?? {});
    const mentioned = (name) => text.includes(name);
    const vars = {};
    for (const [name, value] of this.#local) {
      if (mentioned(name)) vars[name] = value;
    }
    return { vars, env: this.#env.filter(mentioned), names: this.names() };
  }

  /**
   * Load the names of the backend's environment secrets (`GET
   * /api/secrets`). Does nothing if the backend has no such endpoint.
   */
  async loadEnv(url = "/api/secrets", fetcher = fetch) {
    try {
      const response = await fetcher(url);
      if (!response.ok) return [];
      const data = await response.json();
      const names = (data?.names ?? []).filter((n) => typeof n === "string" && validSecretName(n));
      this.#env = [...names].sort();
      this.dispatchEvent(new Event("change"));
      return this.#env;
    } catch {
      return [];
    }
  }

  /** Mask secret values in frame data. Nobody needs to see them, and someone
   * may be looking over your shoulder. */
  maskVars(vars) {
    const out = {};
    for (const [name, value] of Object.entries(vars ?? {})) {
      out[name] = this.has(name) ? SECRET_MASK : value;
    }
    return out;
  }

  #persist() {
    if (!this.storageKey) {
      this.dispatchEvent(new Event("change"));
      return;
    }
    if (this.#local.size) writeJson(this.storageKey, { secrets: Object.fromEntries(this.#local) });
    else removeKey(this.storageKey); // an empty store must leave no traces
    this.dispatchEvent(new Event("change"));
  }
}
