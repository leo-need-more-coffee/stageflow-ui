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
 * The bridge asked for in the page's address, or null.
 *
 * @param search `location.search`
 * @param hash   `location.hash` — where the token is
 */
export function bridgeFromUrl(search, hash) {
  const url = new URLSearchParams(search).get("bridge");
  if (!url) return null;
  const token = new URLSearchParams((hash || "").replace(/^#/, "")).get("bridge-token");
  return { url: url.replace(/\/+$/, ""), token: token || "" };
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

export class Bridge {
  #stream = null;
  #timer = null;
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
    this.onState?.("connecting");
    try {
      const answer = await this.#fetch("/hello");
      if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
      const said = await answer.json();
      if (said?.bridge !== "stageflow") throw new Error("not a StageFlow bridge");
    } catch (err) {
      this.onState?.("lost", err?.message || String(err));
      return false;
    }

    // tell it what is on the canvas before it asks: an agent that connected to
    // a page with a graph already open should be looking at that graph
    this.#post();
    this.editor.addEventListener("change", () => this.#changed());
    this.#listen();
    this.onState?.("live");
    return true;
  }

  close() {
    this.#stream?.close();
    this.#stream = null;
    clearTimeout(this.#timer);
  }

  #fetch(path, init = {}) {
    const separator = path.includes("?") ? "&" : "?";
    return fetch(`${this.url}${path}${separator}token=${encodeURIComponent(this.token)}`, init);
  }

  #listen() {
    this.#stream = new EventStream(`${this.url}/events?token=${encodeURIComponent(this.token)}`, {
      fetcher: (url, init) => fetch(url, init),
      onEvent: (message) => this.#message(message),
      onError: (err) => this.onState?.("lost", err?.message || String(err)),
    });
  }

  #message(message) {
    if (message?.type !== "graph" || !message.pipeline) return;
    this.#applying = true;
    try {
      this.editor.setPipeline(message.pipeline);
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
