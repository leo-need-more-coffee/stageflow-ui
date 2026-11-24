/**
 * The backend the editor talks to.
 *
 * Stage specs, secret names and the run API all live on a StageFlow backend
 * chosen on the connection screen (`connect.js`); this class turns its address
 * into endpoint URLs. The example backend is
 * github.com/leo-need-more-coffee/stageflow-example; any server with the same
 * endpoints works. `/api/meta` is optional (see `capabilities.js`).
 *
 * Sent with every request:
 *   - a credential header, name and value both configurable, since backends
 *     differ (`Authorization: Bearer …`, `X-Api-Key`, ...); the editor only
 *     carries it;
 *   - `Accept-Language`, so a backend can translate its stage specs;
 *   - `?plan=` on the two pre-run questions, to see what another plan allows.
 *     It only changes what is shown; what a run may do is decided by the
 *     backend.
 */
import { FALLBACK, locale, t } from "./i18n.js";

/**
 * Normalise a typed address. `localhost:8765`, `http://localhost:8765/` and
 * `http://localhost:8765/api` are the same backend: `http://` is added when
 * there is no scheme, and a trailing slash or `/api` is removed.
 *
 * @returns {string} the normalised address, or "" for empty input
 */
export function normalizeBackendUrl(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(url.protocol)) return "";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}`;
}

export const DEFAULT_AUTH_HEADER = "Authorization";

export class Backend {
  /**
   * @param url  the backend's address, normalised here
   * @param auth `{header, value}`: the credential, editable in the UI
   * @param plan the plan to view, or null for the caller's own
   */
  constructor(url, { auth = null, plan = null } = {}) {
    this.url = normalizeBackendUrl(url);
    if (!this.url) throw new Error(t("backend.badAddress", { url }));
    this.setAuth(auth);
    this.plan = plan || null;
  }

  /**
   * The credential as one header, name and value: what a person types into
   * two fields, and changeable at any time (tokens expire).
   */
  setAuth(auth) {
    const header = String(auth?.header ?? "").trim() || DEFAULT_AUTH_HEADER;
    const value = String(auth?.value ?? "").trim();
    this.auth = { header, value };
    return this;
  }

  /** Whether a credential is set. */
  get authenticated() { return Boolean(this.auth.value); }

  get headers() {
    return cleanHeaders({ [this.auth.header]: this.auth.value });
  }

  /** View the same backend as another plan; swapped in live. */
  setPlan(plan) {
    this.plan = plan || null;
    return this;
  }

  /** `?plan=` is added only to the pre-run questions. A run takes its plan
   * from the credential; letting a tenant send one would let it pick its own
   * limits. */
  #shown(path) {
    return this.plan ? `${path}?plan=${encodeURIComponent(this.plan)}` : path;
  }

  get stagesUrl() { return this.#shown(`${this.url}/api/stages`); }

  get runUrl() { return `${this.url}/api/run`; }

  get secretsUrl() { return `${this.url}/api/secrets`; }

  get metaUrl() { return this.#shown(`${this.url}/api/meta`); }

  /**
   * `fetch` with this backend's headers. Every request to the backend (stages,
   * secrets, runs, the event stream) goes through here, so the credential is
   * attached in one place.
   */
  fetch(url, init = {}) {
    return fetch(url, {
      ...init,
      headers: {
        "Accept-Language": acceptLanguage(),
        ...this.headers,
        ...(init.headers ?? {}),
      },
    });
  }

  /**
   * What the backend can run: `{api, stageflow, node_types, stages}`.
   * Optional: a backend without it answers 404, which is not an error; the
   * editor then marks nothing as unsupported (see `capabilities.js`).
   *
   * @returns the meta object, or null
   */
  async fetchMeta(timeout = 5000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await this.fetch(this.metaUrl, { signal: abort.signal });
      if (!response.ok) return null;
      const meta = await response.json();
      return meta && typeof meta === "object" ? meta : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve an absolute path from a stage spec (`/icons/globe.svg`) against
   * the backend, which serves its stages' icons. Full URLs and data URIs are
   * kept.
   */
  asset(path) {
    const raw = String(path ?? "");
    return raw.startsWith("/") ? `${this.url}${raw}` : raw;
  }

  /**
   * Check there is a StageFlow backend at the address, with the request the
   * editor needs anyway (`/api/stages`). Returns the stage count; throws with
   * a message fit for the user.
   */
  async probe(timeout = 8000) {
    const blocked = mixedContentProblem(this.url);
    if (blocked) throw new Error(blocked);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    let response;
    try {
      response = await this.fetch(this.stagesUrl, { signal: abort.signal });
    } catch (err) {
      // fetch does not tell a refused connection from DNS or CORS failures;
      // give the user the one message worth acting on
      throw new Error(abort.signal.aborted
        ? t("backend.timeout")
        : t("backend.unreachable"));
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      // 401/403 can be fixed on this screen
      const said = await response.json().catch(() => null);
      throw new Error(said?.error
        ? `${said.error} (HTTP ${response.status})`
        : t("backend.needsAuth", { status: response.status }));
    }
    if (!response.ok) throw new Error(t("backend.http", { status: response.status }));

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(t("backend.notJson"));
    }
    const stages = data?.stages ?? data;
    if (!stages || typeof stages !== "object") {
      throw new Error(t("backend.noStages"));
    }
    return { stages, count: Object.keys(stages).length };
  }
}

/**
 * Why an https page cannot reach this address, or "".
 *
 * A request from an https page to an http address never leaves the page, and
 * `fetch` fails with the same error as for a refused connection, so without
 * this the editor would call a running backend unreachable. Loopback
 * (`localhost`, `127.0.0.1`) is exempt in browsers, which is what makes the
 * hosted editor usable with a local backend.
 */
export function mixedContentProblem(url) {
  if (typeof location === "undefined" || location.protocol !== "https:") return "";
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return "";
    host = parsed.hostname;
  } catch {
    return "";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]"
      || host.endsWith(".localhost")) {
    return "";
  }
  return "this page is served over https, and the browser will not let it "
    + "reach an http address. Serve the backend over https, or open the "
    + "editor over http from the same machine.";
}

/**
 * The editor's language as `Accept-Language`: the chosen language, then the
 * fallback. A safelisted header, so it adds no CORS preflight.
 */
export function acceptLanguage() {
  const chosen = locale();
  return chosen === FALLBACK ? chosen : `${chosen}, ${FALLBACK};q=0.8`;
}

/**
 * Headers that can be sent: named, non-empty, and free of characters that
 * would make `fetch` reject the whole request.
 */
export function cleanHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = String(name ?? "").trim();
    const text = String(value ?? "").trim();
    if (key && text && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) && !/[\r\n]/.test(text)) {
      out[key] = text;
    }
  }
  return out;
}

/** Where the backend address is remembered between sessions. */
export function backendStorageKey(storageKey) {
  return storageKey ? `${storageKey}:backend` : null;
}
