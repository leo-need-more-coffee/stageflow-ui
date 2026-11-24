/**
 * Running a pipeline: the client of the backend's run API.
 *
 * The editor executes nothing; CEL, types, try/except and parallel live in the
 * core, and a JavaScript copy would make the debugger show something other
 * than what happens. This holds only state: where the run is, the frame, what
 * happened.
 *
 * State is built from the event stream (SSE), not by polling, so a node shows
 * as started when it starts. Commands (step, pause, set a variable) are plain
 * POSTs.
 *
 * Every request, the stream included, goes through `Backend.fetch` (see
 * `sse.js`), so the credential is sent everywhere.
 */
import { t } from "./i18n.js";
import { EventStream } from "./sse.js";
const LOG_LIMIT = 200; // a debug log, not a server log: more is not needed

/**
 * Preset delays between nodes, shared by the Run menu and the run dialog.
 * Without a delay a run is over before the eye can follow it; stepping works
 * but is tedious to present with, so there are paces in between.
 */
export const DELAY_PRESETS = [
  [0, "none"],
  [0.25, "quarter"],
  [0.5, "half"],
  [1, "one"],
  [2, "two"],
];

/**
 * A delay from typed text: "0,5" equals "0.5" (some layouts type a comma and
 * `type=number` rejects it); invalid or negative input is zero.
 */
export function parseDelay(text) {
  const value = Number(String(text).trim().replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A delay's label for the toolbar and menu: 0.5 -> "0.5 s". */
export function delayLabel(seconds) {
  const preset = DELAY_PRESETS.find(([value]) => value === seconds);
  if (preset) return t(`delay.${preset[1]}`);
  return t("delay.seconds", { seconds });
}

export class Runner extends EventTarget {
  // idle | running | paused | awaiting | finished | stopped | failed
  // `awaiting`: saved on the backend at a `wait` node until it is answered
  status = "idle";
  meters = {};       // what this run has spent so far, by meter
  meterLimits = {};  // what it is allowed, for the meters that are limited
  runId = null;
  node = null;       // the node we stand on or that is being executed
  vars = {};         // the frame at the stop point
  visited = [];      // the nodes passed — the trace on the graph
  log = [];
  mode = "run";      // run | step
  delay = 0;         // the delay between nodes, seconds
  streams = new Map();   // node -> the text that arrived in chunks
  streamNode = null;     // whose stream to show: the last node that wrote
  streamLabel = null;    // what the stage itself called it; null — it did not
  error = null;
  result = null;
  artifacts = null;
  awaiting = null;   // while `awaiting`: {node, input, deadline}
  nextEvent = 0;     // the first event not yet seen, where the stream resumes

  /** @param backend the `Backend` to run on; the run URL and credential come
   * from it */
  constructor(backend) {
    super();
    this.backend = backend;
    this.base = backend.runUrl;
  }

  get active() { return this.status === "running" || this.status === "paused"; }

  get waiting() { return this.status === "paused"; }

  /** Saved at a `wait` node: nothing runs until `answer`. */
  get awaitingInput() { return this.status === "awaiting"; }

  /** The text a node is streaming now (or streamed last). */
  get streamText() { return this.streams.get(this.streamNode) ?? ""; }

  // ----------------------------------------------------------------- start

  /**
   * Start a run. `mode: "step"` stops before the first node.
   */
  async start(pipeline, { mode = "run", delay = 0, vars = {}, secrets = null,
                          plan = null } = {}) {
    this.stopStream();
    Object.assign(this, {
      status: "running", node: null, vars: {}, visited: [], log: [],
      meters: {}, meterLimits: {}, awaiting: null, nextEvent: 0,
      error: null, result: null, artifacts: null, mode, delay,
      streams: new Map(), streamNode: null, streaming: false,
    });
    this.#changed();

    let data;
    try {
      // secrets: {env: names the backend substitutes from its environment,
      // names: every secret name, which the backend masks in the events}.
      // `plan` is the plan the graph was drawn against; the backend takes the
      // real one from the credential and refuses a mismatch with a clear
      // message
      data = await this.#post("", { pipeline, mode, delay, vars, secrets, plan });
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

  async stop() {
    if (!this.awaitingInput) return this.#control({ action: "stop" });
    // a run saved at a wait is stopped on the backend; its last events come on
    // the same log, from where this editor left off
    const state = await this.#post(`/${this.runId}/control`, { action: "stop" });
    this.#resumeListening();
    return state;
  }

  /**
   * Answer a run waiting at a `wait` node: `type` is the input it waits for,
   * `payload` the fields its `outputs` read. The run continues on the backend
   * and its events continue in the same log.
   */
  async answer(payload, type = this.awaiting?.input) {
    if (!this.runId || !this.awaitingInput) return null;
    const state = await this.#post(`/${this.runId}/input`, { type, payload });
    this.#resumeListening();
    return state;
  }

  #resumeListening() {
    this.status = "running";
    this.awaiting = null;
    this.#changed();
    this.#listen(this.nextEvent);
  }

  setDelay(seconds) {
    this.delay = Math.max(0, Number(seconds) || 0);
    this.#changed();
    return this.runId ? this.#control({ action: "delay", delay: this.delay }) : null;
  }

  /** Write a frame variable; it is applied before the next node. */
  setVar(name, value) { return this.#vars({ set: { [name]: value } }); }

  dropVar(name) { return this.#vars({ drop: [name] }); }

  /** Close the debugger: stop the run and forget its state. */
  reset() {
    if (this.active) this.stop().catch(() => {});
    this.stopStream();
    Object.assign(this, {
      status: "idle", runId: null, node: null, vars: {}, visited: [], log: [],
      meters: {}, meterLimits: {}, awaiting: null, nextEvent: 0,
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

  #listen(from = 0) {
    this.stopStream();
    this.stream = new EventStream(`${this.base}/${this.runId}/events`, {
      from,
      fetcher: (url, init) => this.backend.fetch(url, init),
      onEvent: (event) => this.#event(event),
      // reconnecting failed: the run may still be going, but say we lost sight
      // of it rather than freeze
      onError: (err) => {
        if (!this.active) return;
        this.status = "failed";
        this.error = t("run.streamLost", { reason: err.message ?? err });
        this.#changed();
      },
    });
  }

  #event(event) {
    if (Number.isInteger(event.index)) this.nextEvent = event.index + 1;
    // Any event with payload `{stream: true, text: "…"}` is a chunk of text the
    // node is writing; the event name does not matter, so any streaming stage
    // works. `label` titles the column.
    //
    // Chunks bypass the general "change" event, which would redraw the whole
    // editor for each of hundreds of chunks; a separate "stream" event patches
    // only the text. They are not logged either, which would push out
    // everything else (the log keeps 200 entries).
    const chunk = event.payload;
    if (chunk?.stream === true && typeof chunk.text === "string") {
      const node = event.node ?? this.node;
      this.streamNode = node;
      this.streamLabel = typeof chunk.label === "string" ? chunk.label : null;
      this.streams.set(node, (this.streams.get(node) ?? "") + chunk.text);
      this.streaming = true;
      this.dispatchEvent(new Event("stream"));
      return;
    }
    this.#pushLog(event);
    switch (event.type) {
      case "node_enter":
        // a new entry into the node starts its text afresh, so a retry does not
        // append to the previous attempt
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
        // the totals are not in the stream, so read the state once at the end
        this.#refreshState();
        break;
      case "waiting":
        // the backend saved the run and closed the stream; it goes on when
        // answered (`answer`), maybe days later
        this.status = "awaiting";
        this.awaiting = { node: event.node, input: event.input, deadline: event.deadline ?? null };
        this.node = event.node ?? this.node;
        this.stopStream();
        this.#refreshState();
        break;
      case "failed":
        this.status = "failed";
        this.error = event.error ?? t("run.failed");
        this.node = event.node ?? this.node;
        this.stopStream();
        break;
      default:
        break;
    }
    // the end of a node ends its stream
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
    // a run that has ended has nothing to step, pause or resume; marking it
    // "running" here would leave it so, with no event to correct it
    if (!this.active) return null;
    // show pause and step at once rather than waiting for the event
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
    // what the run has spent and its limits; a backend that counts nothing
    // sends neither
    if (state.meters) this.meters = state.meters;
    if (state.limits) this.meterLimits = state.limits;
    this.#changed();
  }

  /** Re-read the run state, for the totals the stream does not carry. */
  async #refreshState() {
    if (!this.runId) return;
    try {
      const response = await this.backend.fetch(`${this.base}/${this.runId}`);
      if (response.ok) this.#apply(await response.json());
    } catch {
      // a run whose state cannot be re-read is still finished
    }
  }

  async #post(path, payload) {
    const response = await this.backend.fetch(`${this.base}${path}`, {
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
