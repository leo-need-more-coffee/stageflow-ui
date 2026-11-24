/**
 * The bridge to an agent editing this graph.
 *
 * Without it, working with an agent means copying JSON from a chat into
 * "File → Import". Instead an agent can run a small local server
 * (stageflow-mcp --bridge) and give its address. Then:
 *
 *   - graphs the agent draws arrive here and go through the ordinary
 *     `setPipeline`: nodes without coordinates are laid out, the validator
 *     runs, and the change can be undone;
 *   - changes made here are posted back, so the agent works on the graph on
 *     screen.
 *
 * Off unless the address has `?bridge=`; otherwise nothing here runs.
 *
 * ## The token is in the fragment
 *
 * `?bridge=http://127.0.0.1:7433#bridge-token=…`. A query string would end up
 * in the page host's access logs, in `Referer` headers and in the history; a
 * fragment is never sent to a server.
 */
import { EventStream } from "./sse.js";

/** How long to wait after a burst of edits before posting them. */
const SETTLE_MS = 500;

/**
 * What this tab remembers about a bridge: the token and how far it has read.
 *
 * In `sessionStorage`: the address bar would expose the token in history and
 * bookmarks, and `localStorage` would keep it after the tab closes and share
 * it with other tabs. Session storage lives as long as the tab, like the
 * bridge. Without it a reload would lose the token, which was removed from the
 * address on purpose.
 */
function remembered(url) {
  try {
    return JSON.parse(sessionStorage.getItem(`sf-bridge:${url}`) ?? "null") ?? {};
  } catch {
    return {}; // private mode, a policy, a full quota — the bridge still works once
  }
}

function remember(url, patch) {
  try {
    const now = { ...remembered(url), ...patch };
    sessionStorage.setItem(`sf-bridge:${url}`, JSON.stringify(now));
  } catch {
    // failing to store it only costs a reconnection
  }
}

/**
 * The bridge requested in the page address, or null.
 *
 * @param search `location.search`
 * @param hash   `location.hash`, where the token is
 */
export function bridgeFromUrl(search, hash) {
  const raw = new URLSearchParams(search).get("bridge");
  if (!raw) return null;
  const url = raw.replace(/\/+$/, "");
  const fromHash = new URLSearchParams((hash || "").replace(/^#/, "")).get("bridge-token");
  // the link carries the token once; after a reload only the tab's copy is left
  const token = fromHash || remembered(url).token || "";
  return { url, token };
}

/**
 * Remove the token from the address bar once read, so it is not in history,
 * bookmarks or on screen. `replaceState` leaves no back entry.
 */
export function hideToken() {
  if (!location.hash.includes("bridge-token")) return;
  const rest = new URLSearchParams(location.hash.replace(/^#/, ""));
  rest.delete("bridge-token");
  const tail = rest.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}${tail ? `#${tail}` : ""}`);
}

/** Seconds to wait before each retry. An agent's process usually comes back
 * with its next session, within the first few attempts. */
const RETRY_AFTER = [3, 5, 10, 20, 30, 30, 30, 30];

export class Bridge {
  #stream = null;
  #timer = null;
  #retry = null;
  #attempt = 0;
  /** The change listener is attached once, however often we reconnect. */
  #wired = false;
  /** Set while applying a graph from the agent, so the resulting change is
   * not posted back. */
  #applying = false;

  /**
   * @param editor   the Editor to attach to
   * @param url      the bridge's address
   * @param token    the token it was started with
   * @param onState  `(state, detail) => void`: "connecting" | "live" | "lost"
   */
  constructor(editor, { url, token, onState = null }) {
    this.editor = editor;
    this.url = url;
    this.token = token;
    this.onState = onState;
    this.note = "";
  }

  /** @returns true if a bridge answered. */
  async start() {
    if (!this.token) {
      this.onState?.("lost", "no token: open the link the agent printed");
      return false;
    }
    this.onState?.("connecting");
    let said;
    try {
      const answer = await this.#fetch("/hello");
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      said = await answer.json();
      if (said?.bridge !== "stageflow") throw new Error("not a StageFlow bridge");
    } catch (err) {
      this.#lost(this.#whyUnreachable(err));
      return false;
    }
    // it answered, so the token is valid; keep it for a reload
    const known = remembered(this.url);
    const session = said?.session ?? "";
    // a different process on the same port has its own message log starting
    // at zero, so this tab's read position does not apply
    if (session && session !== known.session) {
      remember(this.url, { token: this.token, session, seen: 0 });
    } else {
      remember(this.url, { token: this.token });
    }
    this.#attempt = 0;
    clearTimeout(this.#retry);

    // send the current graph straight away, so an agent connecting to an open
    // page sees what is on it
    this.#post();
    if (!this.#wired) {
      this.editor.addEventListener("change", () => this.#changed());
      this.#wired = true;
    }
    this.#stream?.close();
    this.#listen();
    this.onState?.("live");
    return true;
  }

  /**
   * Why the bridge could not be reached. A browser blocking a public page from
   * a loopback address reports an ordinary failed fetch; that case is
   * recognisable from where the page and the bridge are, and is named.
   */
  #whyUnreachable(err) {
    const loopback = /^https?:\/\/(127\.|\[?::1|localhost)/.test(this.url);
    if (loopback && location.protocol === "https:") return "local-network";
    return err?.message || String(err);
  }

  close() {
    this.#stream?.close();
    this.#stream = null;
    clearTimeout(this.#timer);
    clearTimeout(this.#retry);
  }

  /**
   * The bridge is gone: say so and retry for a while. An agent's process
   * stops with its session; one that comes back within a few minutes is
   * picked up automatically. The chip stays clickable either way.
   */
  #lost(reason) {
    this.#stream = null;
    this.onState?.("lost", reason);
    const wait = RETRY_AFTER[this.#attempt];
    if (wait === undefined) return;
    this.#attempt += 1;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => { this.start(); }, wait * 1000);
  }

  /**
   * Try again after giving up, for an agent whose process was restarted.
   */
  reconnect() {
    this.close();
    return this.start();
  }

  #fetch(path, init = {}) {
    const separator = path.includes("?") ? "&" : "?";
    return fetch(`${this.url}${path}${separator}token=${encodeURIComponent(this.token)}`, init);
  }

  /**
   * Read the agent's stream from where this tab stopped. Starting at zero
   * after a reload would re-apply every graph the agent ever pushed, the last
   * one overwriting the user's work since.
   *
   * A tab that has never seen this bridge does start at zero, so a graph
   * drawn before the editor opened is shown.
   */
  #listen() {
    const from = remembered(this.url).seen ?? 0;
    this.#stream = new EventStream(`${this.url}/events?token=${encodeURIComponent(this.token)}`, {
      fetcher: (url, init) => fetch(url, init),
      from,
      onEvent: (message) => this.#message(message),
      onError: (err) => this.#lost(err?.message || String(err)),
      // an agent's stream does not end on its own; if it does, the process is gone
      onClose: () => this.#lost("the agent's process went away"),
    });
  }

  #message(message) {
    if (typeof message?.index === "number") remember(this.url, { seen: message.index + 1 });
    if (message?.type !== "graph" || !message.pipeline) return;
    this.#applying = true;
    try {
      // applied as a change to keep or revert, not just loaded
      this.editor.applyIncoming(message.pipeline);
      this.note = message.note || "";
      this.onState?.("live", this.note);
    } finally {
      // after the change event it caused
      setTimeout(() => { this.#applying = false; }, 0);
    }
  }

  #changed() {
    if (this.#applying) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#post(), SETTLE_MS);
  }

  async #post() {
    try {
      await this.#fetch("/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline: this.editor.getPipeline() }),
      });
    } catch {
      // the agent stopped or the machine slept; the stream reports it when it
      // gives up, without interrupting the user now
    }
  }
}

/**
 * Connect if the address asks for it. Returns the Bridge, or null. Never
 * throws: a bridge that fails must not stop the editor from opening.
 */
export async function connectBridge(editor, { search = location.search,
                                              hash = location.hash,
                                              onState = null } = {}) {
  const asked = bridgeFromUrl(search, hash);
  if (!asked) return null;
  hideToken();
  const bridge = new Bridge(editor, { ...asked, onState });
  await bridge.start();
  return bridge;
}
