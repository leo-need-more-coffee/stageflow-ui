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
 * same seven endpoints will do.
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

export class Backend {
  /** @param url the address of the backend; normalised on the way in */
  constructor(url) {
    this.url = normalizeBackendUrl(url);
    if (!this.url) throw new Error(`Not a usable backend address: ${url}`);
  }

  get stagesUrl() { return `${this.url}/api/stages`; }

  get runUrl() { return `${this.url}/api/run`; }

  get secretsUrl() { return `${this.url}/api/secrets`; }

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
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    let response;
    try {
      response = await fetch(this.stagesUrl, { signal: abort.signal });
    } catch (err) {
      // fetch tells a refused connection, a DNS failure and a CORS block apart
      // only in the console; the user gets the one thing worth acting on
      throw new Error(abort.signal.aborted
        ? "the backend did not answer in time"
        : "the backend is not reachable (is it running, and does it allow CORS?)");
    } finally {
      clearTimeout(timer);
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

/** Where the address of the backend is remembered between sessions. */
export function backendStorageKey(storageKey) {
  return storageKey ? `${storageKey}:backend` : null;
}
