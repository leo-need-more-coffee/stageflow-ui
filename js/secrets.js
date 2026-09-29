/**
 * The secret store: API keys and everything else a pipeline needs at run time
 * but that must be neither in the pipeline JSON nor on the screen.
 *
 * Why a separate place rather than an ordinary variable of the `entry` node. A
 * pipeline is a document: it gets exported, shown at a defence, committed to a
 * repository and opened in someone else's editor. A key written as a value into
 * `entry.variables` travels with it to all of those places at once, and
 * "remove it before sending" is exactly the operation people forget. So the key
 * is kept SEPARATELY from the graph, and the graph refers to it by name only:
 * `arguments.vars` of a stage reads `OPENAI_API_KEY` like any other variable —
 * the name goes into the JSON, the value is substituted at start.
 *
 * Two sources, and the difference between them matters:
 *
 *   - `local` — typed into the editor, lives in the `localStorage` of this
 *     browser. The value is known to the tab and goes to the run server in the
 *     starting frame.
 *   - `env` — the environment variables of the server itself (`SF_SECRETS`,
 *     `SF_SECRET_*`). The browser receives NAMES only: the value is substituted
 *     on the server before the start and never reaches the page at all.
 *
 * What this does NOT do — and does not pretend to: it is not encryption.
 * `localStorage` is readable by browser extensions and devtools, and the store
 * protects not against someone who already has access to the machine but
 * against the key spreading through documents, screenshots and logs. That is
 * why a value, once saved, is never shown again (not in the list, not in the
 * debug panel, not in the event log) — it can only be replaced or deleted. For
 * a real secret the place is the `env` source.
 *
 * One mask of one length for all: "••••••••" instead of a value does not even
 * give away whether the key is long or short.
 */
import { readJson, removeKey, writeJson } from "./storage.js";

export const SECRET_MASK = "••••••••";

/** A secret name is a variable name: letters, digits, underscore. */
export function validSecretName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export class SecretStore extends EventTarget {
  #local = new Map(); // name -> value (known to this tab only)
  #env = [];          // names from the server environment; no values here

  /** @param key the editor session key; secrets live next to it but apart —
   * so that exporting and importing the state does not drag them along */
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

  /** Every known name: both local and server-side. */
  names() {
    return [...new Set([...this.#local.keys(), ...this.#env])].sort();
  }

  get size() { return this.names().length; }

  has(name) { return this.#local.has(name) || this.#env.includes(name); }

  /** "local" | "env" | null — the source of the value. */
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
   * What goes to the run of this particular pipeline.
   *
   * A key is substituted ONLY if the graph mentions its name at all: otherwise
   * every run would carry the whole keyring along and put it into the frame,
   * where it would lie in plain view of the debugger. The sign is the name
   * occurring in the pipeline JSON: that catches `arguments.vars`, a name
   * inside a CEL expression (`vars.OPENAI_API_KEY`), and any other reference
   * whatever node introduced it. Crude, but without false "did not send": a key
   * that was not sent is a failed run.
   *
   * @returns {{vars, env, names}} — `vars` the local values, `env` the names to
   * be substituted on the server, `names` every secret name: by them the server
   * scrubs values out of the events, so that a key does not come back to the
   * browser through the debug log.
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
   * The names of the secrets from the server environment (`GET /api/secrets`).
   *
   * Silently does nothing if there is no server or it cannot do that: the
   * editor is also opened over static files, and the store must work there too
   * — just without the server source.
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

  /** Hides secret values in arbitrary frame data: the value of a secret
   * variable is not shown even to its owner — there is no point in showing it,
   * and there may well be someone looking over the shoulder. */
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
