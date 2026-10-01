/**
 * The bridge to an agent working on this graph.
 *
 * The editor is a page and an agent is a process somewhere else, and until
 * they can see one thing at once the collaboration is copy-paste: the model
 * writes JSON into a chat, a person selects it, opens "File → Import", pastes.
 * The graph exists twice and neither side knows what the other did to it.
 *
 * So an agent may run a small server on this machine (stageflow-mcp --bridge)
 * and hand over its address. Then:
 *
 *   - what the agent draws arrives here and goes onto the canvas, through the
 *     ordinary `setPipeline` — which means the auto-layout places nodes that
 *     came without coordinates, the validator runs, and **undo works**. What a
 *     model did to the graph is one keystroke away from being gone;
 *   - what happens here is posted back, so "add a retry to this node" is about
 *     the node on the screen rather than about a graph the agent remembers.
 *
 * Off unless asked for. No `?bridge=` in the address and nothing in this file
 * runs — the editor has no idea it exists, which is the right amount of
 * attention to pay to a feature most readers will never use.
 *
 * ## The token is in the fragment
 *
 * `?bridge=http://127.0.0.1:7433#bridge-token=…`. The token has to travel in
 * the link, and the query string is the one place it must not be: this page is
 * served by somebody else (GitHub Pages, in the usual case), so a query
 * parameter is in their access log, in the `Referer` of every request this
 * page makes, and in the history of whoever is screen-sharing. A fragment is
 * never sent to a server at all.
 */
import { EventStream } from "./sse.js";

/** How long to sit on a burst of edits before telling the agent about them. */
const SETTLE_MS = 500;

/**
 * What this tab remembers about a bridge: the token, and how far it has read.
 *
 * `sessionStorage` rather than the address bar or `localStorage`, and the
 * choice is the whole of the security here. The address bar would put the
 * token in the history, in a bookmark made by accident and on screen;
 * `localStorage` would leave it on the machine after the tab is gone and share
 * it with every other tab. Session storage dies with the tab, which is exactly
 * as long as a bridge lives.
 *
 * Without this a reload ends the connection: the token was taken out of the
 * address on purpose, so after F5 there is nothing left to authenticate with
 * and the feature is gone until somebody digs the link out of a chat log.
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
    // not being able to remember costs a reconnection, not a session
  }
}

/**
 * The bridge asked for in the page's address, or null.
 *
 * @param search `location.search`
 * @param hash   `location.hash` — where the token is
 */
export function bridgeFromUrl(search, hash) {
  const raw = new URLSearchParams(search).get("bridge");
  if (!raw) return null;
  const url = raw.replace(/\/+$/, "");
  const fromHash = new URLSearchParams((hash || "").replace(/^#/, "")).get("bridge-token");
  // the link carries the token once; a reload has only what the tab kept
  const token = fromHash || remembered(url).token || "";
  return { url, token };
}

/**
 * Take the token out of the address bar once it has been read.
 *
 * It stays in the page's own memory, which is where a credential belongs; in
 * the address bar it is in the history, in a bookmark made by accident, and on
 * screen. `replaceState` leaves no entry to go back to.
 */
export function hideToken() {
  if (!location.hash.includes("bridge-token")) return;
  const rest = new URLSearchParams(location.hash.replace(/^#/, ""));
  rest.delete("bridge-token");
  const tail = rest.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}${tail ? `#${tail}` : ""}`);
}

/** How long to wait before trying a bridge again, in seconds, and then every
 * 30 until the attempts run out. An agent's process comes back when its next
 * session starts, which is usually within the first few of these. */
const RETRY_AFTER = [3, 5, 10, 20, 30, 30, 30, 30];

export class Bridge {
  #stream = null;
  #timer = null;
  #retry = null;
  #attempt = 0;
  /** The change listener is attached once, however many times we reconnect. */
  #wired = false;
  /** Set while a graph from the agent is being applied, so the change it
   * causes is not posted straight back as news. */
  #applying = false;

  /**
   * @param editor   the Editor to attach to
   * @param url      the bridge's address
   * @param token    what it was given at startup
   * @param onState  `(state, detail) => void` — "connecting" | "live" | "lost"
   */
  constructor(editor, { url, token, onState = null }) {
    this.editor = editor;
    this.url = url;
    this.token = token;
    this.onState = onState;
    this.note = "";
  }

  /** @returns true if something answered and it was a bridge. */
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
    // it answered, so the token is good and worth keeping for a reload
    const known = remembered(this.url);
    const session = said?.session ?? "";
    // a different process behind the same port has a message log of its own,
    // starting at zero — what this tab has read says nothing about it
    if (session && session !== known.session) {
      remember(this.url, { token: this.token, session, seen: 0 });
    } else {
      remember(this.url, { token: this.token });
    }
    this.#attempt = 0;
    clearTimeout(this.#retry);

    // tell it what is on the canvas before it asks: an agent that connected to
    // a page with a graph already open should be looking at that graph
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
   * Why the bridge could not be reached, in terms somebody can act on.
   *
   * A browser refusing to let a public page touch a loopback address reports
   * it as an ordinary failed fetch, and "Failed to fetch" sends a person
   * looking for a crashed process that is running perfectly well. The one
   * case worth naming is that one, and it is recognisable from where the page
   * is served and where the bridge is.
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
   * The bridge is not there. Say so, and quietly try again for a while.
   *
   * An agent is a process somebody starts, and it goes away with the session
   * that started it — a page that gave up the first time would have to be
   * reopened from a link that is by then somewhere in a chat log. So the
   * attempts are spaced out and bounded: a bridge that comes back within a few
   * minutes is picked up on its own, and one that does not stops being asked
   * about. The chip stays a button either way.
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
   * Try again after the connection was given up on.
   *
   * The agent's process is a thing somebody starts and stops — it goes away
   * when a session ends and comes back with the next one. Without this a tab
   * that saw one of those has to be reopened from a link, which by then is
   * somewhere in a chat log.
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
   * Read on from where this tab stopped, not from the beginning.
   *
   * The stream is a log, so a reader can start anywhere — and starting at zero
   * after a reload would re-apply every graph the agent ever pushed, the last
   * one landing on top of whatever the person has done since. What they had
   * would be replaced by something they had already moved past.
   *
   * A tab that has never seen this bridge starts at zero deliberately: a graph
   * drawn before the editor was open is the "look what I made" case, and it
   * should be there when the canvas finally opens.
   */
  #listen() {
    const from = remembered(this.url).seen ?? 0;
    this.#stream = new EventStream(`${this.url}/events?token=${encodeURIComponent(this.token)}`, {
      fetcher: (url, init) => fetch(url, init),
      from,
      onEvent: (message) => this.#message(message),
      onError: (err) => this.#lost(err?.message || String(err)),
      // an agent's stream is not supposed to end. When it does, that process
      // is gone — it was stopped, or its session was
      onClose: () => this.#lost("the agent's process went away"),
    });
  }

  #message(message) {
    if (typeof message?.index === "number") remember(this.url, { seen: message.index + 1 });
    if (message?.type !== "graph" || !message.pipeline) return;
    this.#applying = true;
    try {
      // handed over to be kept or put back, not merely loaded: a graph
      // somebody else put on your canvas needs a way out of it
      this.editor.applyIncoming(message.pipeline);
      this.note = message.note || "";
      this.onState?.("live", this.note);
    } finally {
      // after the change event this caused has been and gone
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
      // the agent's process was closed, or the machine went to sleep. The
      // canvas is not the place to report it: the person is drawing, and the
      // stream will say so when it gives up for good.
    }
  }
}

/**
 * Connect if the address asks for it. Returns the Bridge, or null.
 *
 * Never throws: a bridge that will not connect is a feature that is not
 * working, and an editor that refuses to open because of one would be worse
 * than the copy-paste it replaces.
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
