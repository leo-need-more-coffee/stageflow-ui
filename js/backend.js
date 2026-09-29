/**
 * The backend the editor talks to.
 *
 * The editor holds no stage registry and executes nothing: the stage specs,
 * the secret names and the run API all live on a StageFlow backend, and which
 * one that is the user says on the connection screen (`connect.js`). So the
 * address is not a build-time constant but a value — this class is where it
 * turns into the URLs of the endpoints.
 *
 * An example backend lives in a repository of its own
 * (github.com/leo-need-more-coffee/stageflow-example); anything answering the
 * same seven endpoints will do. An eighth, `/api/meta`, is optional: it says
 * which node types that backend's core can run, and without it the editor
 * simply knows less (see `capabilities.js`).
 *
 * Two things travel with every request and both are settings, not constants:
 *
 *   - **headers**. A backend serving more than one tenant wants to know who
 *     is calling, and the editor has no opinion about how: the header NAME is
 *     configurable alongside its value, because `Authorization: Bearer …`,
 *     `X-Api-Key: …` and whatever a gateway put there are all real. The
 *     editor authenticates nothing itself — it carries what it was given.
 *   - **plan**. What the editor should draw and validate against, sent as
 *     `?plan=` on the two questions asked before a run. A backend that serves
 *     plans answers about that one instead of the caller's own, which is what
 *     makes "what would this graph look like on the cheaper tier" a question
 *     the editor can ask. It is a request to be SHOWN something: what a run
 *     is actually allowed is the backend's business and is decided there.
 */

/**
 * Brings a typed address to a shape that can be pasted into a URL.
 *
 * People type `localhost:8765`, `http://localhost:8765/` and
 * `http://localhost:8765/api` interchangeably, and all three mean the same
 * backend. Without a scheme `http://` is added — an editor served over plain
 * http cannot fetch https from localhost anyway, and a bare host is what gets
 * typed; a trailing slash and a trailing `/api` are cut off, or the endpoints
 * would come out as `…/api/api/stages`.
 *
 * @returns {string} the normalised address, or "" if there is nothing to normalise
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
   * @param url     the address of the backend; normalised on the way in
   * @param auth    `{header, value}` — the credential, editable in the UI
   * @param headers anything else to send (an embedding with its own ideas)
   * @param plan    which plan to be shown, or null for the caller's own
   */
  constructor(url, { auth = null, headers = {}, plan = null } = {}) {
    this.url = normalizeBackendUrl(url);
    if (!this.url) throw new Error(`Not a usable backend address: ${url}`);
    this.extraHeaders = cleanHeaders(headers);
    this.setAuth(auth);
    this.plan = plan || null;
  }

  /**
   * The credential as the interface edits it: one header, name and value.
   *
   * A pair rather than a free-form header map because that is what a person
   * types into two fields, and because the thing that has to be changeable
   * at any moment — a token that expired halfway through an afternoon — is
   * exactly this one. Anything more elaborate goes in as `headers` by an
   * embedder and is not the user's to edit.
   */
  setAuth(auth) {
    const header = String(auth?.header ?? "").trim() || DEFAULT_AUTH_HEADER;
    const value = String(auth?.value ?? "").trim();
    this.auth = { header, value };
    return this;
  }

  /** Whether there is a credential at all — for "the editor sends nothing". */
  get authenticated() { return Boolean(this.auth.value); }

  get headers() {
    return { ...this.extraHeaders, ...cleanHeaders({ [this.auth.header]: this.auth.value }) };
  }

  /** The same backend seen as another plan — the editor swaps this in live. */
  setPlan(plan) {
    this.plan = plan || null;
    return this;
  }

  /** `?plan=` goes on the two questions asked BEFORE a run and on no others:
   * a run takes its plan from the credential, and sending it one would be
   * offering the tenant a say in its own ceiling. */
  #shown(path) {
    return this.plan ? `${path}?plan=${encodeURIComponent(this.plan)}` : path;
  }

  get stagesUrl() { return this.#shown(`${this.url}/api/stages`); }

  get runUrl() { return `${this.url}/api/run`; }

  get secretsUrl() { return `${this.url}/api/secrets`; }

  get metaUrl() { return this.#shown(`${this.url}/api/meta`); }

  /**
   * `fetch` with the headers of this backend on it.
   *
   * Everything that talks to the backend goes through here — the stage
   * registry, the secret names, the run API, the event stream — so that
   * "where does the credential get attached" has one answer. Anything that
   * reaches for the global `fetch` with a URL from this object is a request
   * that will start failing the day the backend wants a token.
   */
  fetch(url, init = {}) {
    return fetch(url, { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } });
  }

  /**
   * What the backend can run: `{api, stageflow, node_types, stages}`.
   *
   * Optional by design. A backend older than the endpoint answers 404, and a
   * backend written by someone else may never have had it — neither is an
   * error, both simply mean the editor knows nothing about that end and will
   * not mark anything as unsupported (see `capabilities.js`).
   *
   * @returns the meta object, or null when the backend does not serve one
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
   * An absolute path from a stage spec (`icon: "/icons/globe.svg"`) points at
   * the backend, not at the page: it is the backend that serves the icons of
   * its own stages. A full URL and a data URI are left alone.
   */
  asset(path) {
    const raw = String(path ?? "");
    return raw.startsWith("/") ? `${this.url}${raw}` : raw;
  }

  /**
   * Checks that there is a StageFlow backend at the address — and checks it by
   * the very request the editor cannot work without. Returns the number of
   * stages; throws with a message fit for showing to the user.
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
      // fetch tells a refused connection, a DNS failure and a CORS block apart
      // only in the console; the user gets the one thing worth acting on
      throw new Error(abort.signal.aborted
        ? "the backend did not answer in time"
        : "the backend is not reachable (is it running, and does it allow CORS?)");
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      // the one HTTP code with a cure the user can act on from this screen
      const said = await response.json().catch(() => null);
      throw new Error(said?.error
        ? `${said.error} (HTTP ${response.status})`
        : `the backend wants credentials (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`the backend answered HTTP ${response.status}`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("the answer is not JSON — is this a StageFlow backend?");
    }
    const stages = data?.stages ?? data;
    if (!stages || typeof stages !== "object") {
      throw new Error("the answer has no stages — is this a StageFlow backend?");
    }
    return { stages, count: Object.keys(stages).length };
  }
}

/**
 * Why a page served over https cannot reach this address, or "".
 *
 * The one failure mode of using the hosted editor against your own backend,
 * and the one the browser reports worst: a request from an https page to an
 * http address is not refused by the backend, it never leaves the page.
 * `fetch` rejects with the same opaque TypeError it gives for a refused
 * connection, so without this the screen says "the backend is not reachable
 * (is it running?)" about a backend that is running perfectly well.
 *
 * Loopback is the exception the browsers make and the reason the hosted
 * editor is usable at all: `http://localhost` and `http://127.0.0.1` count
 * as trustworthy origins and are not blocked as mixed content.
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
 * Headers fit to send: named, non-empty, and without the characters that
 * would make `fetch` throw on the whole request rather than skip the header.
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

/** Where the address of the backend is remembered between sessions. */
export function backendStorageKey(storageKey) {
  return storageKey ? `${storageKey}:backend` : null;
}
