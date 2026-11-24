/**
 * The editor without its looks: everything the interface shows, and every
 * action it can take, as one object.
 *
 * The graph model, the stage library, the runner and the rest live in
 * `src/core` and know nothing of the DOM. This class wires them together the
 * way the editor uses them, and is what `createEditor` hands to an embedding
 * page. The React components read it and call it; they keep no state of
 * their own that another part of the editor would need.
 *
 * It is an EventTarget: "render" after anything that should redraw, "change"
 * after an edit of the graph (what the embedding's `onChange` and the agent
 * bridge listen to, as with the old editor).
 */
import { Backend } from "@/core/backend.js";
import { BackendCapabilities } from "@/core/capabilities.js";
import { rememberBackend } from "@/core/connection.js";
import { NODE_MIN_W } from "@/core/geometry.js";
import { t, tn } from "@/core/i18n.js";
import { kindOf } from "@/core/kinds.js";
import { PipelineModel } from "@/core/model.js";
import { Runner } from "@/core/runner.js";
import { SecretStore } from "@/core/secrets.js";
import { StagesLibrary, Validator } from "@/core/stages.js";
import { EditorStore } from "@/core/storage.js";

export type Pipeline = any;
export type GraphNode = any;
export type DataMode = "off" | "focus" | "all";
export type Theme = "light" | "dark";

export type Picked =
  | null
  | { type: "node"; id: string }
  | { type: "nodes"; ids: string[] }
  | { type: "edge"; from: string; portIndex: number };

export interface Issue {
  graph: string | null;
  node: string | null;
  message: string;
}

export interface RunRequest {
  mode: "run" | "step";
  entry: GraphNode | null;
  previous: Record<string, string>;
  delay: number;
  secretNames: string[];
  secretsStored: number;
}

export interface RunAnswer {
  vars: Record<string, unknown>;
  entered: Record<string, string>;
  delay: number;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "bad" | "ok";
}

export interface EditorOptions {
  backend: any;
  pipeline?: Pipeline;
  storageKey?: string | null;
  runDelay?: number;
  stages?: Record<string, unknown>;
  dataMode?: DataMode;
  spacing?: { gapX?: number; gapY?: number; dataGap?: number };
  onChange?: (pipeline: Pipeline) => void;
}

/** What a canvas offers the editor: the view, and where things are on it. */
export interface CanvasHandle {
  fitView(): void;
  centerWorld(): { x: number; y: number };
  pasteAnchor(): { x: number; y: number } | null;
  focusNode(id: string): void;
}

/**
 * The selection, shared by the canvas and the inspector. Several nodes can be
 * selected and are moved or deleted together; only one edge at a time.
 */
export class Selection extends EventTarget {
  #current: Picked = null;
  #nodes = new Set<string>();

  get current(): Picked { return this.#current; }

  get nodes(): Set<string> { return this.#nodes; }

  has(id: string) { return this.#nodes.has(id); }

  set(value: Picked) {
    this.#current = value;
    this.#nodes = value?.type === "node" ? new Set([value.id]) : new Set();
    this.dispatchEvent(new Event("change"));
  }

  setNodes(ids: Iterable<string>) {
    this.#nodes = new Set(ids);
    const list = [...this.#nodes];
    if (!list.length) this.#current = null;
    else if (list.length === 1) this.#current = { type: "node", id: list[0] };
    else this.#current = { type: "nodes", ids: list };
    this.dispatchEvent(new Event("change"));
  }

  toggle(id: string) {
    const next = new Set(this.#nodes);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setNodes(next);
  }

  clear() { this.set(null); }
}

let toastIds = 0;

export class Editor extends EventTarget {
  readonly options: EditorOptions;
  readonly backend: any;
  readonly model: any;
  readonly stages: any;
  readonly capabilities: any;
  readonly selection = new Selection();
  readonly validator: any;
  readonly runner: any;
  readonly secrets: any;
  readonly store: any;

  issues: Issue[] = [];
  dataMode: DataMode;
  showDescriptions = true;
  /** Subpipelines drawn as frames beside the main graph, editable in place. */
  showSubgraphs = true;
  /** A subpipeline opened on its own, the way the old editor showed them;
   * null while the main graph (with its frames) is on the canvas. */
  standalone: string | null = null;
  /** Where each subpipeline's frame stands, kept for the session. */
  frames = new Map<string, { x: number; y: number; ox: number; oy: number }>();
  /** Switching the graph being edited by clicking into a frame must not
   * move the view the way opening a graph does. */
  #quietGraph = false;
  runDelay: number;
  runVars: { vars: Record<string, unknown>; entered: Record<string, string> } = { vars: {}, entered: {} };
  clipboard: GraphNode[] = [];
  /** What the last `setPipeline` changed, by node id, or null. */
  lastChange: any = null;
  /** A graph applied from outside, not yet kept or reverted. */
  pending: { before: Pipeline; change: any } | null = null;
  /** The nodes the last outside change added, so the canvas can let them
   * appear rather than pop in; with the graph they were added to. */
  incoming: { key: string | null; added: Set<string>; at: number } | null = null;
  /** Nodes to mark as changed on the canvas, and until when. */
  marks: { ids: Set<string>; until: number } | null = null;
  /** Chips owned by something other than the graph (the agent bridge). */
  notes = new Map<string, { text: string; title: string; onClick: (() => void) | null }>();
  toasts: Toast[] = [];
  /** The saved viewport, applied once by the canvas. */
  savedView: { x: number; y: number; zoom: number } | null = null;
  /** A variable hovered in a list, highlighted on the graph. */
  highlightedVar: string | null = null;
  /** Bumped on every change; React reads it to know when to redraw. */
  version = 0;

  /** Set by the canvas once it is mounted. */
  canvas: CanvasHandle | null = null;
  /** Set by the interface: asks for the run arguments, null when cancelled. */
  askRun: ((request: RunRequest) => Promise<RunAnswer | null>) | null = null;

  #notify = 0;

  constructor(options: EditorOptions) {
    super();
    this.options = options;
    this.backend = options.backend instanceof Backend ? options.backend : new Backend(options.backend);
    this.model = new PipelineModel(options.spacing);
    this.stages = new StagesLibrary();
    this.capabilities = new BackendCapabilities();
    this.capabilities.load(this.backend);
    this.validator = new Validator(this.stages, this.capabilities);
    this.dataMode = options.dataMode ?? "focus";
    this.runner = new Runner(this.backend);
    this.runDelay = options.runDelay ?? 0;
    this.secrets = new SecretStore(options.storageKey);
    this.secrets.loadEnv(this.backend.secretsUrl, (url: string, init: RequestInit) => this.backend.fetch(url, init));

    this.store = new EditorStore(options.storageKey);
    const saved = this.store.load();
    if (saved?.ui) {
      this.dataMode = saved.ui.dataMode ?? this.dataMode;
      this.showDescriptions = saved.ui.showDescriptions ?? this.showDescriptions;
      this.showSubgraphs = saved.ui.showSubgraphs ?? this.showSubgraphs;
      if (saved.ui.runVars) this.runVars = { vars: {}, entered: {}, ...saved.ui.runVars };
      if (typeof saved.ui.runDelay === "number") this.runDelay = saved.ui.runDelay;
    }

    this.#wire();

    if (options.stages) this.stages.setSpecs(options.stages);
    else void this.reloadStages();

    const pipeline = saved?.pipeline ?? options.pipeline;
    if (pipeline) this.model.setPipeline(pipeline, { keepLayout: Boolean(saved?.pipeline) });
    else this.issues = this.validate();
    if (saved?.graphKey) {
      this.standalone = saved.graphKey;
      this.model.setGraph(saved.graphKey);
    }
    if (saved?.view && Number.isFinite(saved.view.scale)) {
      this.savedView = { x: saved.view.x ?? 0, y: saved.view.y ?? 0, zoom: saved.view.scale };
    }
    window.addEventListener("pagehide", () => this.store.flush(() => this.#state()));
  }

  // ------------------------------------------------------------- plumbing

  /** Redraw on the next frame; many core events come in one burst. */
  changed() {
    if (this.#notify) return;
    this.#notify = requestAnimationFrame(() => {
      this.#notify = 0;
      this.version += 1;
      this.dispatchEvent(new Event("render"));
    });
  }

  #state() {
    return {
      pipeline: this.model.toJSON(),
      graphKey: this.model.graphKey,
      view: this.view ? { x: this.view.x, y: this.view.y, scale: this.view.zoom } : null,
      ui: {
        dataMode: this.dataMode,
        showDescriptions: this.showDescriptions,
        showSubgraphs: this.showSubgraphs,
        runVars: this.runVars,
        runDelay: this.runDelay,
      },
    };
  }

  /** The current viewport, kept by the canvas for the saved session. */
  view: { x: number; y: number; zoom: number } | null = null;

  persist() {
    this.store.save(() => this.#state());
  }

  #wire() {
    this.model.addEventListener("change", () => {
      this.#pruneSelection();
      if (this.pending) {
        // editing an incoming change keeps it
        this.pending = null;
        this.marks = null;
      }
      this.issues = this.validate();
      this.persist();
      this.changed();
      this.dispatchEvent(new Event("change"));
      this.options.onChange?.(this.getPipeline());
    });
    this.model.addEventListener("reset", (event: Event) => {
      const change = (event as CustomEvent).detail;
      // a new document places its frames afresh
      if (change?.fresh) this.frames.clear();
      if (this.standalone !== null && !(this.standalone in (this.model.pipeline.subpipelines ?? {}))) this.standalone = null;
      const quiet = this.#quietGraph;
      this.#quietGraph = false;
      if (!quiet && (!change || change.fresh)) requestAnimationFrame(() => this.canvas?.fitView());
      this.lastChange = change ?? null;
      this.#mark(change);
    });
    this.selection.addEventListener("change", () => this.changed());
    this.runner.addEventListener("change", () => this.changed());
    this.runner.addEventListener("stream", () => this.changed());
    this.secrets.addEventListener("change", () => this.changed());
    const revalidate = () => {
      this.issues = this.validate();
      this.changed();
    };
    this.stages.addEventListener("change", revalidate);
    this.capabilities.addEventListener("change", revalidate);
  }

  /** Mark the nodes an outside change touched, for a few seconds or until kept. */
  #mark(change: any, hold = false) {
    if (!change || change.fresh) {
      this.marks = null;
      return;
    }
    const ids = new Set<string>([...(change.added ?? []), ...(change.changed ?? [])]);
    if (!ids.size) return;
    this.marks = { ids, until: hold ? Infinity : Date.now() + 4000 };
    if (!hold) setTimeout(() => this.changed(), 4100);
  }

  #pruneSelection() {
    const sel = this.selection.current;
    if (!sel) return;
    if (sel.type === "edge") {
      if (!this.model.node(sel.from)) this.selection.clear();
      return;
    }
    const alive = [...this.selection.nodes].filter((id) => this.model.node(id));
    if (alive.length !== this.selection.nodes.size) this.selection.setNodes(alive);
  }

  /** The file Ctrl+S writes to, once one has been picked (Chromium only). */
  #saveHandle: any = null;

  /**
   * Save the pipeline as JSON. Where the browser can write files, the first
   * save asks where and later ones write the same file in place; `as` asks
   * again. Elsewhere it is a download.
   */
  async save({ as = false }: { as?: boolean } = {}) {
    const json = `${JSON.stringify(this.getPipeline(), null, 2)}\n`;
    const picker = (window as any).showSaveFilePicker;
    if (!picker) {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "pipeline.json";
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      if (as || !this.#saveHandle) {
        this.#saveHandle = await picker({
          suggestedName: this.#saveHandle?.name ?? "pipeline.json",
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
      }
      const writable = await this.#saveHandle.createWritable();
      await writable.write(json);
      await writable.close();
      this.toast(t("app.save.done", { name: this.#saveHandle.name }), "ok");
    } catch (err: any) {
      if (err?.name === "AbortError") return; // the picker was closed
      this.toast(t("app.save.failed", { reason: err?.message ?? String(err) }), "bad");
    }
  }

  toast(text: string, tone: Toast["tone"] = "info") {
    const toast = { id: ++toastIds, text, tone };
    this.toasts = [...this.toasts, toast];
    this.changed();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== toast.id);
      this.changed();
    }, tone === "bad" ? 7000 : 3000);
  }

  // ----------------------------------------------------------- public API

  getPipeline(): Pipeline { return this.model.toJSON(); }

  setPipeline(pipeline: Pipeline, options: { keepLayout?: boolean } = {}) {
    this.runVars = { vars: {}, entered: {} };
    this.model.setPipeline(pipeline, options);
  }

  /** Apply a graph from outside (an assistant), to be kept or reverted. */
  applyIncoming(pipeline: Pipeline) {
    const before = this.getPipeline();
    const had = this.pending?.before ?? before;
    this.setPipeline(pipeline);
    if (this.lastChange && !this.lastChange.fresh) {
      this.pending = { before: had, change: this.lastChange };
      this.#mark(this.lastChange, true);
      this.incoming = { key: this.model.graphKey, added: new Set(this.lastChange.added ?? []), at: Date.now() };
      this.dispatchEvent(new Event("incoming"));
      // bring what changed into view, or the change could be off screen; the
      // newest part, since a graph sent piece by piece grows at its end
      const added = this.lastChange.added ?? [];
      const target = added[added.length - 1] ?? this.lastChange.changed?.[0];
      if (target) this.#focusSoon(target);
    } else {
      this.pending = null;
    }
    this.changed();
    return this.lastChange;
  }

  acceptChange() {
    if (!this.pending) return false;
    this.pending = null;
    this.marks = null;
    this.changed();
    return true;
  }

  revertChange() {
    if (!this.pending) return false;
    const { before } = this.pending;
    this.pending = null;
    this.setPipeline(before, { keepLayout: true });
    this.marks = null;
    this.changed();
    return true;
  }

  setStages(specs: Record<string, unknown>) { this.stages.setSpecs(specs); }

  reloadStages() {
    return this.stages.loadUrl(this.backend.stagesUrl, (url: string, init: RequestInit) => this.backend.fetch(url, init))
      .catch((err: Error) => this.toast(t("editor.stagesFailed", { reason: err.message ?? err }), "bad"));
  }

  validate(): Issue[] { return this.validator.validate(this.model.pipeline, kindOf); }

  /** Draw and validate against another plan; a run still uses the credential's. */
  async setPlan(plan: string | null) {
    const wanted = plan || null;
    if (wanted === this.backend.plan) return;
    this.backend.setPlan(wanted);
    this.#persistBackend();
    await Promise.all([this.capabilities.load(this.backend), this.reloadStages()]);
    this.issues = this.validate();
    this.changed();
  }

  /** Change the credential without reloading; throws and restores on failure. */
  async setCredential(auth: { header: string; value: string }) {
    const previous = this.backend.auth;
    this.backend.setAuth(auth);
    let probe;
    try {
      probe = await this.backend.probe();
    } catch (err) {
      this.backend.setAuth(previous);
      throw err;
    }
    this.#persistBackend();
    this.stages.setSpecs(probe.stages, this.backend.stagesUrl);
    await this.capabilities.load(this.backend);
    this.secrets.loadEnv(this.backend.secretsUrl, (url: string, init: RequestInit) => this.backend.fetch(url, init));
    this.issues = this.validate();
    this.changed();
    return probe.count;
  }

  #persistBackend() {
    const key = this.options.storageKey;
    if (!key) return;
    rememberBackend(key, { url: this.backend.url, auth: this.backend.auth, plan: this.backend.plan });
  }

  /** Run on the backend; `mode: "step"` pauses before the first node. */
  async run({ mode = "run", delay, vars = null, ask = true }:
    { mode?: "run" | "step"; delay?: number; vars?: Record<string, unknown> | null; ask?: boolean } = {}) {
    const pipeline = this.getPipeline();
    let startVars = vars ?? this.runVars.vars;
    let startDelay = delay ?? this.runDelay;
    const secrets = this.secrets.forRun(pipeline);

    if (ask && this.askRun) {
      const asked = await this.askRun({
        mode,
        entry: pipeline.nodes.find((n: GraphNode) => n.type === "entry") ?? null,
        previous: this.runVars.entered,
        delay: startDelay,
        secretNames: [...Object.keys(secrets.vars), ...secrets.env].sort(),
        secretsStored: this.secrets.size,
      });
      if (!asked) return null;
      this.runVars = { vars: asked.vars, entered: asked.entered };
      startVars = asked.vars;
      startDelay = asked.delay;
      this.runDelay = asked.delay;
      this.persist();
    }

    try {
      return await this.runner.start(pipeline, {
        mode,
        delay: startDelay,
        vars: { ...secrets.vars, ...(startVars ?? {}) },
        secrets: { env: secrets.env, names: secrets.names },
        plan: this.capabilities.plan,
      });
    } catch (err: any) {
      this.toast(t("editor.runFailed", { reason: err.message ?? err }), "bad");
      return null;
    }
  }

  setRunDelay(seconds: number) {
    this.runDelay = Math.max(0, Number(seconds) || 0);
    if (this.runner.active) this.runner.setDelay(this.runDelay);
    this.persist();
    this.changed();
  }

  copySelection() {
    const ids = [...this.selection.nodes];
    if (!ids.length) return 0;
    this.clipboard = this.model.copyNodes(ids);
    this.toast(tn("editor.copied", this.clipboard.length));
    return this.clipboard.length;
  }

  cutSelection() {
    const count = this.copySelection();
    if (!count) return 0;
    this.model.removeNodes([...this.selection.nodes]);
    this.selection.clear();
    return count;
  }

  paste() {
    if (!this.clipboard?.length) return [];
    const ids = this.model.pasteNodes(this.clipboard, this.canvas?.pasteAnchor() ?? null);
    if (ids.length) this.selection.setNodes(ids);
    else this.toast(t("editor.pasteEntry"));
    return ids;
  }

  /** Duplicate the selected nodes next to themselves. */
  duplicateSelection() {
    const ids = [...this.selection.nodes];
    if (!ids.length) return [];
    const copies = this.model.copyNodes(ids);
    const pasted = this.model.pasteNodes(copies, null);
    if (pasted.length) this.selection.setNodes(pasted);
    return pasted;
  }

  deleteSelection() {
    const sel = this.selection.current;
    if (!sel) return false;
    if (sel.type === "node" || sel.type === "nodes") this.model.removeNodes([...this.selection.nodes]);
    else if (sel.type === "edge") this.model.disconnect(sel.from, sel.portIndex);
    this.selection.clear();
    return true;
  }

  undo() { return this.model.undo(); }

  redo() { return this.model.redo(); }

  setDataMode(mode: DataMode) {
    if (!["off", "focus", "all"].includes(mode) || mode === this.dataMode) return;
    this.dataMode = mode;
    this.persist();
    this.changed();
  }

  get showData() { return this.dataMode !== "off"; }

  toggleDescriptions() {
    this.showDescriptions = !this.showDescriptions;
    this.persist();
    this.changed();
  }

  highlightVariable(name: string | null) {
    if (this.highlightedVar === name) return;
    this.highlightedVar = name;
    this.changed();
  }

  /**
   * Add a node: after the selected one if it has a free port, so it is
   * connected at once; otherwise in the middle of the view.
   */
  addNode(type: string, extra: Record<string, unknown> = {}) {
    const spec = { type, extra };
    const selected = this.selection.current;
    const node = (selected?.type === "node" ? this.model.appendAfter(selected.id, spec) : null)
      ?? this.model.createAt(spec, this.#centerPos());
    this.selection.set({ type: "node", id: node.id });
    this.#focusSoon(node.id);
    return node;
  }

  #centerPos() {
    const center = this.canvas?.centerWorld() ?? { x: 0, y: 0 };
    return { x: center.x - NODE_MIN_W / 2, y: center.y - 50 };
  }

  /** Whether the canvas shows the main graph with its subpipelines beside it. */
  get framed() {
    return this.showSubgraphs && this.standalone === null
      && Object.keys(this.model.pipeline.subpipelines ?? {}).length > 0;
  }

  /** A graph by key: the root (null) or a subpipeline. */
  graphOf(key: string | null): any {
    return key === null ? this.model.pipeline : this.model.pipeline.subpipelines?.[key];
  }

  /** Open a graph on its own: the root (null) or a subpipeline. */
  openGraph(key: string | null) {
    this.selection.clear();
    this.standalone = key;
    this.model.setGraph(key);
  }

  /**
   * Make a graph the one edits go to, without changing what is shown: a
   * click on a node in a subpipeline's frame.
   */
  focusGraph(key: string | null) {
    if (key === this.model.graphKey) return;
    this.selection.clear();
    this.#quietGraph = true;
    this.model.setGraph(key);
  }

  toggleSubgraphs() {
    this.showSubgraphs = !this.showSubgraphs;
    if (!this.showSubgraphs && this.standalone === null && this.model.graphKey !== null) {
      // the graph being edited is no longer on screen; show the main one
      this.model.setGraph(null);
    }
    this.persist();
    this.changed();
    requestAnimationFrame(() => this.canvas?.fitView());
  }

  /** Go to an issue's node, in whichever graph it is. */
  reveal(issue: Issue) {
    if (issue.graph !== this.model.graphKey) {
      if (this.framed || (this.showSubgraphs && issue.graph !== null && this.standalone === null)) this.focusGraph(issue.graph);
      else this.openGraph(issue.graph);
    }
    if (issue.node) {
      this.selection.set({ type: "node", id: issue.node });
      this.#focusSoon(issue.node);
    }
  }

  /**
   * Bring a node into view on the next frame. Selecting it opens the
   * inspector, which narrows the canvas; the canvas brings the node into view
   * again when that happens (see the ResizeObserver in Canvas).
   */
  #focusSoon(id: string) {
    requestAnimationFrame(() => this.canvas?.focusNode(id));
  }

  setStatusNote(owner: string, text: string, title = "", onClick: (() => void) | null = null) {
    if (text) this.notes.set(owner, { text, title, onClick });
    else this.notes.delete(owner);
    this.changed();
  }

  // the old facade's names, kept for embedding pages and the bridge
  fitView() { this.canvas?.fitView(); }
}

export function createEditorState(options: EditorOptions) {
  return new Editor(options);
}
