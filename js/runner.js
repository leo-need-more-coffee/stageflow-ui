/**
 * Running a pipeline: the client of the debug API of the backend.
 *
 * The editor does not execute a pipeline itself — the semantics (CEL, types,
 * try/except, parallel) live in the StageFlow core, and a second implementation
 * in JavaScript would mean the debugger shows something other than what
 * actually happens. So there is only state here: where we stand, what is in the
 * frame, what happened.
 *
 * The state is assembled from an EVENT STREAM (SSE) rather than by polling: a
 * debug step is an event, not the result of a request, and "the node started"
 * must appear on the graph when it happened, not on the next polling tick.
 * Commands (step, pause, editing a variable) go as ordinary POSTs — they are
 * initiated by the user, and their answer is not needed before the event.
 */
const LOG_LIMIT = 200; // a debug log, not a server log: more is not needed

/**
 * Ready-made delays between nodes — a shared list for the "Run" menu and the
 * run dialog, so that "half a second" means the same thing in both places.
 *
 * A run without a delay ends before the eye can follow the path through the
 * graph: the nodes all flash at once, and "what is going on" is only visible in
 * the log. Stepping by hand shows it honestly, but talking about a pipeline
 * while pressing F10 on every node is awkward — so between "instantly" and "one
 * node per keystroke" there has to be a pace one can simply watch.
 */
export const DELAY_PRESETS = [
  [0, "no delay", "the nodes all flash at once"],
  [0.25, "0.25 s", null],
  [0.5, "0.5 s", "the execution order is visible"],
  [1, "1 s", null],
  [2, "2 s", "time to talk about a node"],
];

/**
 * A delay out of whatever was typed: "0,5" and "0.5" are the same thing (on
 * some keyboard layouts the comma is the one at hand, and `type=number` does
 * not accept it), garbage and a minus are zero rather than "it broke".
 */
export function parseDelay(text) {
  const value = Number(String(text).trim().replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The label of a delay for the toolbar and the menu: 0.5 -> "0.5 s". */
export function delayLabel(seconds) {
  const preset = DELAY_PRESETS.find(([value]) => value === seconds);
  if (preset) return preset[1];
  return `${seconds} s`;
}

export class Runner extends EventTarget {
  status = "idle";   // idle | running | paused | finished | stopped | failed
  runId = null;
  node = null;       // the node we stand on or that is being executed
  vars = {};         // the frame at the stop point
  visited = [];      // the nodes passed — the trace on the graph
  log = [];
  mode = "run";      // run | step
  delay = 0;         // the delay between nodes, seconds
  streams = new Map();   // node -> the text that arrived in chunks
  streamNode = null;     // whose stream to show: the last node that wrote
  streamLabel = "Stream"; // what the stage itself called it
  error = null;
  result = null;
  artifacts = null;

  /** @param base the base URL of the run API on the backend (`…/api/run`) */
  constructor(base) {
    super();
    this.base = base;
  }

  get active() { return this.status === "running" || this.status === "paused"; }

  get waiting() { return this.status === "paused"; }

  /** The text the model is writing right now (or wrote last). */
  get streamText() { return this.streams.get(this.streamNode) ?? ""; }

  // ----------------------------------------------------------------- start

  /**
   * Starts a run. `mode: "step"` stops before the very first node — that is
   * what "open the debugger" means: from there on, by steps.
   */
  async start(pipeline, { mode = "run", delay = 0, vars = {}, secrets = null } = {}) {
    this.stopStream();
    Object.assign(this, {
      status: "running", node: null, vars: {}, visited: [], log: [],
      error: null, result: null, artifacts: null, mode, delay,
      streams: new Map(), streamNode: null, streaming: false,
    });
    this.#changed();

    let data;
    try {
      // secrets: {env: [names from the backend environment], names: [every
      // secret name]} — the backend substitutes the former and scrubs the
      // values of the latter out of the events, so that a key does not come
      // back to the browser through the debug log
      data = await this.#post("", { pipeline, mode, delay, vars, secrets });
    } catch (err) {
      this.status = "failed";
      this.error = String(err.message ?? err);
      this.#changed();
      throw err;
    }
    this.runId = data.id;
    this.#apply(data.state);
    this.#listen();
    return data.id;
  }

  // --------------------------------------------------------------- control

  step(count = 1) { return this.#control({ action: "step", count }); }

  resume() { return this.#control({ action: "resume" }); }

  pause() { return this.#control({ action: "pause" }); }

  stop() { return this.#control({ action: "stop" }); }

  setDelay(seconds) {
    this.delay = Math.max(0, Number(seconds) || 0);
    this.#changed();
    return this.runId ? this.#control({ action: "delay", delay: this.delay }) : null;
  }

  /** Write a frame variable; it is applied before the next node. */
  setVar(name, value) { return this.#vars({ set: { [name]: value } }); }

  dropVar(name) { return this.#vars({ drop: [name] }); }

  /** Close the debugger: the run stops, the state is forgotten. */
  reset() {
    if (this.active) this.stop().catch(() => {});
    this.stopStream();
    Object.assign(this, {
      status: "idle", runId: null, node: null, vars: {}, visited: [], log: [],
      error: null, result: null, artifacts: null,
      streams: new Map(), streamNode: null, streaming: false,
    });
    this.#changed();
  }

  stopStream() {
    this.stream?.close();
    this.stream = null;
  }

  // -------------------------------------------------------------- internals

  #listen() {
    this.stopStream();
    const stream = new EventSource(`${this.base}/${this.runId}/events`);
    this.stream = stream;
    stream.onmessage = (e) => {
      try {
        this.#event(JSON.parse(e.data));
      } catch { /* a heartbeat frame or garbage — skip it */ }
    };
    // The run is over — the backend closes the stream, and EventSource would go
    // reconnecting to a finished run. We close it ourselves.
    stream.onerror = () => {
      if (!this.active) this.stopStream();
    };
  }

  #event(event) {
    // A text stream is an EVENT CONTRACT, not knowledge about particular
    // stages: any event with the payload `{stream: true, text: "…"}` counts as
    // a chunk of text a node is writing right now. The name of the event does
    // not matter — otherwise the editor would know the demo server's stages by
    // name, and a foreign streaming stage (a transcription, a build log) would
    // be left out. The column heading comes from there too (`label`): what the
    // text is, the stage knows.
    //
    // This stream goes PAST the common "change": there are hundreds of chunks,
    // and each of them would redraw the graph, the palette and the toolbar
    // whole — the tab would lie down on the thirtieth token. A separate
    // "stream" event patches only the piece of the panel where the text is
    // printed. The chunks do not go into the log either: they would crowd out
    // everything meaningful (the limit is 200 entries).
    const chunk = event.payload;
    if (chunk?.stream === true && typeof chunk.text === "string") {
      const node = event.node ?? this.node;
      this.streamNode = node;
      this.streamLabel = typeof chunk.label === "string" ? chunk.label : "Stream";
      this.streams.set(node, (this.streams.get(node) ?? "") + chunk.text);
      this.streaming = true;
      this.dispatchEvent(new Event("stream"));
      return;
    }
    this.#pushLog(event);
    switch (event.type) {
      case "node_enter":
        // a new entry into a node starts its text afresh: a retry must not be
        // appended to the unfinished answer of the previous attempt
        this.streams.delete(event.node);
        this.streaming = false;
        this.node = event.node;
        this.vars = event.vars ?? this.vars;
        if (this.visited[this.visited.length - 1] !== event.node) this.visited.push(event.node);
        this.status = "running";
        break;
      case "paused":
        this.node = event.node ?? this.node;
        this.vars = event.vars ?? this.vars;
        this.status = "paused";
        break;
      case "node_exit":
      case "var_set":
      case "var_dropped":
        if (event.vars) this.vars = event.vars;
        break;
      case "finished":
        this.status = event.status === "stopped" ? "stopped" : "finished";
        this.result = event.result ?? null;
        this.artifacts = event.artifacts ?? null;
        if (event.vars) this.vars = event.vars;
        this.stopStream();
        break;
      case "failed":
        this.status = "failed";
        this.error = event.error ?? "the run failed";
        this.node = event.node ?? this.node;
        this.stopStream();
        break;
      default:
        break;
    }
    // the node has finished — the cursor stops blinking; no separate "stream
    // closed" is needed for that, the end of a node is the end of its stream
    if (this.streaming && ["node_exit", "finished", "failed"].includes(event.type)) {
      this.streaming = false;
      this.dispatchEvent(new Event("stream"));
    }
    this.#changed();
  }

  #pushLog(event) {
    this.log.push(event);
    if (this.log.length > LOG_LIMIT) this.log.shift();
  }

  async #control(payload) {
    if (!this.runId) return null;
    // a pause and a step are visible at once, without waiting for an event: a
    // button must answer
    if (payload.action === "pause") this.status = "paused";
    if (payload.action === "step" || payload.action === "resume") this.status = "running";
    this.#changed();
    const state = await this.#post(`/${this.runId}/control`, payload);
    this.mode = state.mode ?? this.mode;
    return state;
  }

  async #vars(payload) {
    if (!this.runId) return null;
    const state = await this.#post(`/${this.runId}/vars`, payload);
    this.#apply(state);
    return state;
  }

  #apply(state) {
    if (!state) return;
    if (state.node) this.node = state.node;
    if (state.vars) this.vars = state.vars;
    if (state.mode) this.mode = state.mode;
    if (typeof state.delay === "number") this.delay = state.delay;
    this.#changed();
  }

  async #post(path, payload) {
    const response = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }

  #changed() {
    this.dispatchEvent(new Event("change"));
  }
}
