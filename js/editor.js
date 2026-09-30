/**
 * The StageFlow editor facade — the entry point of the future library.
 *
 *   import { connectBackend } from "stageflow-editor/connect.js";
 *   import { createEditor } from "stageflow-editor";
 *
 *   const backend = await connectBackend({ storageKey: "stageflow-editor" });
 *   const editor = createEditor(container, {
 *     backend,                                   // where the stages and the run API live
 *     pipeline: {...},                           // the initial pipeline
 *     onChange: (pipeline) => {...},
 *     spacing: { gapX: 96, gapY: 140, dataGap: 120 }, // layout density
 *     dataMode: "focus",                         // data wires: off|focus|all
 *   });
 *
 * The editor holds no stage registry and executes nothing itself: `backend` is
 * required, and it is the one thing without which nothing works (see
 * `backend.js`). It may be a `Backend` or just its address.
 *
 * The public API: getPipeline / setPipeline / setStages / validate, and the
 * "change" event (Editor is an EventTarget). Everything else is internals.
 */
import { Backend, backendStorageKey } from "./backend.js";
import { CanvasView } from "./canvas.js";
import { NODE_MIN_W } from "./geometry.js";
import { t, tn } from "./i18n.js";
import { kindOf } from "./kinds.js";
import { Inspector } from "./inspector.js";
import { PipelineModel } from "./model.js";
import { Palette } from "./palette.js";
import { DebugPanel } from "./debugpanel.js";
import { askRunVars } from "./rundialog.js";
import { Runner } from "./runner.js";
import { SecretStore } from "./secrets.js";
import { BackendCapabilities } from "./capabilities.js";
import { VERSION } from "./version.js";
import { StagesLibrary, Validator } from "./stages.js";
import { EditorStore, readJson, writeJson } from "./storage.js";
import { Toolbar } from "./toolbar.js";

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** The letter of a key regardless of the keyboard layout: on a non-Latin layout
 * `e.key` gives a letter of that alphabet, and Ctrl+Z would stop working
 * exactly where the editor is used. `e.code` describes the physical key, so we
 * take it whenever it is there. */
function letterOf(e) {
  return e.code?.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
}

/**
 * The current selection — state shared by the canvas and the inspector.
 *
 * There can be several selected NODES (the marquee with the right button,
 * Shift-click): they are moved and deleted at once. An edge is selected one at
 * a time — transitions have no group meaning. `current` answers the question
 * "what to show in the panel": one node — its form, several — a summary.
 */
export class Selection extends EventTarget {
  #current = null;
  #nodes = new Set();

  get current() { return this.#current; }

  /** The set of selected nodes (for a single selection — of one id). */
  get nodes() { return this.#nodes; }

  has(id) { return this.#nodes.has(id); }

  set(value) {
    this.#current = value;
    this.#nodes = value?.type === "node" ? new Set([value.id]) : new Set();
    this.dispatchEvent(new Event("change"));
  }

  /** A group selection; a single node behaves like an ordinary selection. */
  setNodes(ids) {
    this.#nodes = new Set(ids);
    const list = [...this.#nodes];
    if (!list.length) this.#current = null;
    else if (list.length === 1) this.#current = { type: "node", id: list[0] };
    else this.#current = { type: "nodes", ids: list };
    this.dispatchEvent(new Event("change"));
  }

  /** Add/remove a node from the selection (Shift-click). */
  toggle(id) {
    const next = new Set(this.#nodes);
    next.has(id) ? next.delete(id) : next.add(id);
    this.setNodes([...next]);
  }

  clear() { this.set(null); }
}

export class Editor extends EventTarget {
  #restoredView = false;

  constructor(container, options = {}) {
    super();
    this.options = options;
    // the backend is the one required option: without it there are no stages
    // to put on the canvas and nothing to run the graph with
    this.backend = options.backend instanceof Backend
      ? options.backend
      : new Backend(options.backend);
    this.model = new PipelineModel(options.spacing);
    this.stages = new StagesLibrary();
    // which node types the core on that backend can run. Asked once, never
    // blocking: an older backend serves no /api/meta and then nothing is
    // known and nothing is marked (see capabilities.js)
    this.capabilities = new BackendCapabilities();
    this.capabilities.load(this.backend);
    this.selection = new Selection();
    this.validator = new Validator(this.stages, this.capabilities);
    this.issues = [];
    // data wires: "off" — hide the layer, "focus" — only for the card under the
    // cursor (and for a highlighted variable), "all" — everything at once
    this.dataMode = options.dataMode ?? "focus";
    this.showDescriptions = true; // stage descriptions on the cards
    this.panels = { palette: true, inspector: true };
    this.clipboard = []; // the node buffer: lives in the editor, not in the system one
    // the run is executed by the StageFlow core on the backend, here it is state only
    this.runner = new Runner(this.backend);
    // the pace of a run: the pause between nodes, so that execution can be
    // followed by eye. It lives in the editor rather than in the run: it is
    // chosen BEFORE the start and survives both the run and a reload
    this.runDelay = options.runDelay ?? 0;
    // secrets: the keys live apart from the graph and never get into the
    // pipeline JSON (see secrets.js). The names of the server-side ones are
    // fetched, the values are not
    this.secrets = new SecretStore(options.storageKey);
    this.secrets.loadEnv(this.backend.secretsUrl, (url, init) => this.backend.fetch(url, init));
    // the arguments of the previous run: `vars` goes into the run, `entered`
    // comes back into the dialog, so that the same things are not retyped every
    // time
    this.runVars = { vars: {}, entered: {} };

    // the saved session: the pipeline, the view and the panel layout survive a
    // reload — the editor is a workplace, not a demonstration
    this.store = new EditorStore(options.storageKey);
    const saved = this.store.load();
    if (saved?.ui) {
      this.dataMode = saved.ui.dataMode ?? this.dataMode;
      this.showDescriptions = saved.ui.showDescriptions ?? this.showDescriptions;
      this.panels = { ...this.panels, ...saved.ui.panels };
      if (saved.ui.runVars) this.runVars = { vars: {}, entered: {}, ...saved.ui.runVars };
      if (typeof saved.ui.runDelay === "number") this.runDelay = saved.ui.runDelay;
    }

    this.#buildDom(container);
    this.#wire();

    // the specs can be handed over ready-made (a test, an embedding with its
    // own registry); normally they come from the backend
    if (options.stages) this.stages.setSpecs(options.stages);
    else this.reloadStages();

    const pipeline = saved?.pipeline ?? options.pipeline;
    // a restored session keeps its coordinates: they are where this reader
    // dragged the cards, and two that touch are their arrangement
    if (pipeline) this.setPipeline(pipeline, { keepLayout: Boolean(saved?.pipeline) });
    else this.#renderAll();
    if (saved) this.#restoreView(saved);

    // the first fit happens after the container has got its size; a restored
    // view is left alone, or "it did not reset" would turn into "the zoom reset
    // itself"
    requestAnimationFrame(() => {
      if (this.#restoredView) this.canvas.render();
      else this.canvas.fitView();
    });
    window.addEventListener("pagehide", () => this.store.flush(() => this.#state()));
  }

  /** Restores the view and the current graph from a saved session. */
  #restoreView(saved) {
    if (saved.graphKey) this.model.setGraph(saved.graphKey); // resets the view by itself
    const view = saved.view;
    if (!view || !Number.isFinite(view.scale)) return;
    Object.assign(this.canvas.view, {
      x: view.x ?? 0, y: view.y ?? 0, scale: view.scale,
    });
    this.#restoredView = true;
  }

  #state() {
    return {
      pipeline: this.model.toJSON(),
      graphKey: this.model.graphKey,
      view: { x: this.canvas.view.x, y: this.canvas.view.y, scale: this.canvas.view.scale },
      ui: {
        dataMode: this.dataMode,
        showDescriptions: this.showDescriptions,
        panels: { ...this.panels },
        runVars: this.runVars,
        runDelay: this.runDelay,
      },
    };
  }

  #persist() {
    this.store.save(() => this.#state());
  }

  // ---------------------------------------------------------- public API

  getPipeline() { return this.model.toJSON(); }

  /**
   * @param keepLayout the coordinates are ours already — a session coming back.
   *   A document from anywhere else is checked: coordinates that stack the
   *   cards get replaced by a real layout (see `normalizeGraph`).
   */
  setPipeline(pipeline, options = {}) {
    // another document — another set of starting arguments: the values of the
    // previous run belonged to the previous graph and must not be substituted
    // silently
    this.runVars = { vars: {}, entered: {} };
    this.model.setPipeline(pipeline, options);
  }

  setStages(specs) { this.stages.setSpecs(specs); }

  /** Re-asks the backend for the stage specs (the registry changed, the
   * backend was restarted). */
  reloadStages() {
    return this.stages.loadUrl(this.backend.stagesUrl,
                               (url, init) => this.backend.fetch(url, init))
      .catch((err) => { this.#note(t("editor.stagesFailed", { reason: err.message ?? err })); });
  }

  validate() { return this.validator.validate(this.model.pipeline, kindOf); }

  /**
   * Draw and validate against another plan.
   *
   * A request to be SHOWN something, not a change of allowance: the backend
   * answers `/api/meta?plan=` and `/api/stages?plan=` for any plan it has,
   * unverified, and decides what a run may do from the credential instead.
   * So this is honest as a preview — "what would this graph look like on the
   * cheaper tier" — and honest as a mistake: a graph drawn against a plan the
   * credential is not on is refused at the start of the run, by name.
   *
   * Unlike changing the backend, this needs no reload. The address, the
   * session and the graph all stay; what changes is the palette, the limits
   * and therefore the issues — which is exactly the thing being looked at.
   */
  async setPlan(plan) {
    const wanted = plan || null;
    if (wanted === this.backend.plan) return;
    this.backend.setPlan(wanted);
    this.#persistBackend();
    await Promise.all([this.capabilities.load(this.backend), this.reloadStages()]);
    this.issues = this.validate();
    this.#renderAll();
  }

  /**
   * Change the credential without leaving the session.
   *
   * A token is the one connection setting that goes stale *during* the work:
   * it expires, it gets rotated, it turns out to be the wrong tenant's. The
   * address is the ground everything stands on and changing it reloads the
   * page; the credential is not — the backend is the same backend, the graph
   * is the same graph, and only the answers change. So this re-asks the three
   * questions and repaints, and a reload would only lose the work.
   *
   * Throws with a message fit for showing if the new credential does not
   * work; the old one is put back, because a half-applied credential is a
   * session that fails at the next request instead of at this one.
   */
  async setCredential(auth) {
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
    // the probe already fetched the registry — asking twice would be a second
    // round trip to learn the same thing
    this.stages.setSpecs(probe.stages, this.backend.stagesUrl);
    await this.capabilities.load(this.backend);
    this.secrets.loadEnv(this.backend.secretsUrl,
                         (url, init) => this.backend.fetch(url, init));
    this.issues = this.validate();
    this.#renderAll();
    return probe.count;
  }

  /** The credential and the plan live with the address they belong to. */
  #persistBackend() {
    const key = this.options.storageKey;
    if (!key) return;
    const saved = readJson(backendStorageKey(key)) ?? {};
    writeJson(backendStorageKey(key), { ...saved, url: this.backend.url,
                                        auth: this.backend.auth,
                                        plan: this.backend.plan });
  }

  /**
   * Run the pipeline. `mode: "step"` means debugging: the session stops before
   * the very first node and goes on by command. It is executed by the core on
   * the backend, so the debugger shows exactly what will happen.
   *
   * Before the start it asks for the starting variables: the `entry` node
   * declares DEFAULT values, and running the graph with different ones is
   * exactly what "run with arguments" means — not an edit of the JSON.
   * `ask: false` skips the question (a repeat run by the "↻" button goes with
   * the same arguments).
   */
  async run({ mode = "run", delay, vars = null, ask = true } = {}) {
    const pipeline = this.getPipeline();
    let startVars = vars ?? this.runVars.vars;
    let startDelay = delay ?? this.runDelay;
    // computed BEFORE the dialog: which keys exactly will be substituted is
    // visible in the same place where "Run" is pressed
    const secrets = this.secrets.forRun(pipeline);

    if (ask) {
      const entry = pipeline.nodes.find((n) => n.type === "entry") ?? null;
      const asked = await askRunVars({
        entry,
        previous: this.runVars.entered,
        delay: startDelay,
        secretNames: [...Object.keys(secrets.vars), ...secrets.env].sort(),
        secretsStored: this.secrets.size,
        mode,
      });
      if (!asked) return null; // cancelled — we do not start the run
      this.runVars = { vars: asked.vars, entered: asked.entered };
      startVars = asked.vars;
      startDelay = asked.delay;
      this.runDelay = asked.delay;
      this.#persist();
    }

    try {
      return await this.runner.start(pipeline, {
        mode,
        delay: startDelay,
        // the secrets go FIRST: what the user typed into the dialog by hand
        // overrides the store — otherwise "run it with another key" would be
        // impossible without touching the store
        vars: { ...secrets.vars, ...(startVars ?? {}) },
        secrets: { env: secrets.env, names: secrets.names },
        // which plan this graph was drawn and validated against. The backend
        // runs on whatever the credential says and refuses the run if the two
        // differ — "you are on basic" instead of six stages that "do not exist"
        plan: this.capabilities.plan,
      });
    } catch (err) {
      // most often this is a pipeline description error from the core — it is
      // more useful than "it did not work", so it goes to the status bar as it is
      this.#note(t("editor.runFailed", { reason: err.message ?? err }));
      return null;
    }
  }

  /**
   * The pace of a run: the pause between nodes in seconds (the "Run" menu, the
   * run dialog and the field in the debug panel all lead here).
   *
   * A running session picks it up on the fly: "too fast, I did not get to
   * explain" is discovered in the middle of a demonstration rather than before
   * it, and there is nothing to restart for that.
   */
  setRunDelay(seconds) {
    this.runDelay = Math.max(0, Number(seconds) || 0);
    if (this.runner.active) this.runner.setDelay(this.runDelay);
    this.#persist();
    this.toolbar.render();
  }

  /** Copy the selected nodes into the internal buffer (Ctrl+C). */
  copySelection() {
    const ids = [...this.selection.nodes];
    if (!ids.length) return 0;
    this.clipboard = this.model.copyNodes(ids);
    this.canvas.flashHint(tn("editor.copied", this.clipboard.length));
    return this.clipboard.length;
  }

  /** Cut: the same plus deletion (Ctrl+X). */
  cutSelection() {
    const count = this.copySelection();
    if (!count) return 0;
    this.model.removeNodes([...this.selection.nodes]);
    this.selection.clear();
    return count;
  }

  /**
   * Paste copies from the buffer (Ctrl+V) — under the cursor if it is over the
   * canvas. What was pasted becomes the selection at once: a copy is almost
   * always moved or edited right away rather than looked for by eye.
   */
  paste() {
    if (!this.clipboard?.length) return [];
    const ids = this.model.pasteNodes(this.clipboard, this.canvas.pasteAnchor());
    if (ids.length) {
      this.selection.setNodes(ids);
      this.canvas.flashHint(tn("editor.pasted", ids.length));
    } else {
      this.canvas.flashHint(t("editor.pasteEntry"));
    }
    return ids;
  }

  /** Delete the selection: a node, a group of nodes or a link (Delete, the
   * "Edit" menu). */
  deleteSelection() {
    const sel = this.selection.current;
    if (!sel) return false;
    if (sel.type === "node" || sel.type === "nodes") {
      this.model.removeNodes([...this.selection.nodes]);
    } else if (sel.type === "edge") {
      this.model.disconnect(sel.from, sel.portIndex);
    }
    this.selection.clear();
    return true;
  }

  /** Undo/redo the last graph edit (Ctrl+Z / Ctrl+Shift+Z). */
  undo() { return this.model.undo(); }

  redo() { return this.model.redo(); }

  /** Hide/show the palette ("palette") or the inspector ("inspector"): on a
   * narrow screen the panels eat the very canvas everything is about. */
  togglePanel(name) {
    if (!(name in this.panels)) return;
    this.panels[name] = !this.panels[name];
    this.#applyPanels();
    this.toolbar.render();
    this.#persist();
  }

  /** The data layer: "off" — hide, "focus" — for the card under the cursor,
   * "all" — everything at once (the "View" menu). */
  setDataMode(mode) {
    if (!["off", "focus", "all"].includes(mode) || mode === this.dataMode) return;
    this.dataMode = mode;
    this.#renderAll();
    this.#persist();
  }

  /** Whether the data connectors are visible on the cards (the "arg ← var" rows). */
  get showData() { return this.dataMode !== "off"; }

  toggleDescriptions() {
    this.showDescriptions = !this.showDescriptions;
    this.#renderAll();
    this.#persist();
  }

  #applyPanels() {
    this.container.classList.toggle("sf-no-palette", !this.panels.palette);
    this.container.classList.toggle("sf-no-inspector", !this.panels.inspector);
  }

  // ---------------------------------------------------------------- build

  #buildDom(container) {
    this.container = container;
    container.classList.add("sf-editor");
    this.toolbarEl = el("div");
    const main = el("div", "sf-main");
    this.paletteEl = el("div");
    this.canvasEl = el("div");
    this.inspectorEl = el("div");
    // the fold button lives in the panel itself — where people look at it; the
    // rail in the place of a folded panel brings it back
    main.append(
      this.#side("palette", "sf-side-left", this.paletteEl, "‹"),
      this.#rail("palette", "sf-rail-left", "›"),
      this.canvasEl,
      this.#rail("inspector", "sf-rail-right", "‹"),
      this.#side("inspector", "sf-side-right", this.inspectorEl, "›"),
    );
    this.debugEl = el("div");
    this.statusEl = el("div", "sf-status");
    container.append(this.toolbarEl, main, this.debugEl, this.statusEl);

    const env = {
      model: this.model,
      stages: this.stages,
      selection: this.selection,
      getIssues: () => this.issues,
      showData: () => this.showData,
      dataMode: () => this.dataMode,
      showDescriptions: () => this.showDescriptions,
      runner: this.runner,
      secrets: this.secrets,
      // the backend an absolute icon path belongs to (see icons.js)
      backend: this.backend,
      // what that backend can run — the palette dims what it cannot
      capabilities: this.capabilities,
      // the variable index in the panel lights the graph as it is hovered
      highlightVar: (name) => this.canvas?.highlightVariable(name),
      // panning and zooming do not change the model, but they do change the
      // session state
      onView: () => this.#persist(),
    };
    this.canvas = new CanvasView(this.canvasEl, env);
    this.inspector = new Inspector(this.inspectorEl, env);
    this.palette = new Palette(this.paletteEl, {
      ...env,
      // a click on the palette CONTINUES the chain from the selected node: a
      // card dropped in the middle of the canvas with no links is work
      // postponed, not a result. If there is nowhere to attach (nothing is
      // selected, every port is taken), the node appears in the centre of the
      // view, as before
      addNode: (type, extra = {}) => {
        const spec = { type, extra };
        const selected = this.selection.current;
        const node = (selected?.type === "node" ? this.model.appendAfter(selected.id, spec) : null)
          ?? this.model.createAt(spec, this.#centerPos());
        this.selection.set({ type: "node", id: node.id });
      },
      // dragging from the palette: the target highlight and the drop itself
      // belong to the canvas
      dropHint: (x, y, spec) => this.canvas.dropHint(x, y, spec),
      dropCreate: (spec, x, y) => this.canvas.dropCreate(spec, x, y),
    });
    this.debug = new DebugPanel(this.debugEl, {
      ...env,
      // "once more" repeats the run in the same mode — usually that is what is
      // wanted
      rerun: () => this.run({ mode: this.runner.mode, ask: false }),
      // the delay field in the panel changes THE SAME pace as the menu:
      // otherwise what was set during a run would be forgotten by the next one
      setDelay: (seconds) => this.setRunDelay(seconds),
    });
    this.toolbar = new Toolbar(this.toolbarEl, this);
    this.#applyPanels();
  }

  /** A panel in a wrapper with its own fold button. The panel wipes its host on
   * render, so the button lives NEXT to it rather than inside. */
  #side(name, className, panelEl, glyph) {
    const side = el("div", `sf-side ${className}`);
    const button = el("button", "sf-side-toggle", glyph);
    button.title = t("editor.foldPanel");
    button.onclick = () => this.togglePanel(name);
    side.append(panelEl, button);
    return side;
  }

  /** A narrow rail in the place of a folded panel: bringing it back must be as
   * easy as folding it. */
  #rail(name, className, glyph) {
    const rail = el("button", `sf-rail ${className}`, glyph);
    rail.title = t("editor.unfoldPanel");
    rail.onclick = () => this.togglePanel(name);
    return rail;
  }

  /** The centre of the visible area — the place for a node that has nothing to
   * attach to. */
  #centerPos() {
    const center = this.canvas.centerWorld();
    return { x: center.x - NODE_MIN_W / 2, y: center.y - 50 };
  }

  #wire() {
    this.model.addEventListener("change", () => {
      this.#pruneSelection();
      this.issues = this.validate();
      this.#renderAll();
      this.#persist();
      this.dispatchEvent(new Event("change"));
      this.options.onChange?.(this.getPipeline());
    });
    this.model.addEventListener("reset", () => this.canvas.fitView());
    this.selection.addEventListener("change", () => {
      // a node was selected — so it is about to be looked at or edited: a
      // folded panel unfolds by itself, or a click on a card looks like
      // "nothing happened". We do not fold it back: that is the user's
      // decision, not a consequence of a click
      const picked = this.selection.current?.type;
      if ((picked === "node" || picked === "nodes") && !this.panels.inspector) {
        this.togglePanel("inspector");
      }
      this.canvas.render();
      this.inspector.render();
    });
    // the run: the highlight on the graph, the debug panel and the state of the
    // toolbar buttons
    this.runner.addEventListener("change", () => {
      this.canvas.render();
      this.debug.render();
      this.toolbar.render();
    });
    // a key was added or removed — both the variable name suggestions and the
    // counter in the "File" menu change
    this.secrets.addEventListener("change", () => this.#renderAll());
    this.stages.addEventListener("change", () => {
      this.issues = this.validate();
      this.#renderAll();
    });
    // the answer arrives after the first paint: revalidate, because a node
    // the backend cannot run is an issue only once we know it cannot
    this.capabilities.addEventListener("change", () => {
      this.issues = this.validate();
      this.#renderAll();
    });
    document.addEventListener("keydown", (e) => this.#onKeyDown(e));
  }

  /** The selection may point at something that is no longer there: a node was
   * deleted, an edit was undone. */
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

  #onKeyDown(e) {
    // inside an input Ctrl+Z is an undo OF THE TYPING, and the browser does it
    if (e.target.matches("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = letterOf(e);
      if (key === "z") {
        e.preventDefault();
        e.shiftKey ? this.model.redo() : this.model.undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        this.model.redo();
        return;
      }
      if (key === "c" || key === "x" || key === "v") {
        // we only copy when there is something to copy: otherwise Ctrl+C must
        // stay the browser's (selected text on the page)
        if (key === "v" ? this.clipboard.length : this.selection.nodes.size) {
          e.preventDefault();
          if (key === "c") this.copySelection();
          else if (key === "x") this.cutSelection();
          else this.paste();
          return;
        }
      }
    }
    // the view is on the keyboard too: "View" menu items without hotkeys would
    // mean going into the menu bar for "fit to screen" every single time
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const key = letterOf(e);
      if (key === "f") {
        e.preventDefault();
        this.canvas.fitView();
        return;
      }
      if (key === "l") {
        e.preventDefault();
        this.model.relayout();
        return;
      }
    }
    // running and stepping are on keys, as in a debugger: the menu must not be
    // the only way to run a pipeline
    if (e.key === "F5") {
      e.preventDefault();
      this.run({ mode: e.shiftKey ? "step" : "run" });
      return;
    }
    if (e.key === "F10" && this.runner.active) {
      e.preventDefault();
      this.runner.step();
      return;
    }
    if (e.key === "Escape") this.selection.clear();
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!this.selection.current) return;
    e.preventDefault();
    this.deleteSelection();
  }

  // --------------------------------------------------------------- render

  #renderAll() {
    this.toolbar.render();
    this.palette.render();
    this.canvas.render();
    this.inspector.render();
    this.debug.render();
    this.#renderStatus();
  }

  #renderStatus() {
    this.statusEl.textContent = "";
    // which backend this is talking to, on the right of the bar: the answer
    // to "why is the map node greyed out" should not need the console
    const about = this.capabilities.summary();
    if (about) {
      // a button, not a label: "which backend is this" and "where do I put
      // the token" are one question, and the bar is where it gets asked
      const badge = el("button", "sf-status-backend");
      badge.textContent = `${t("editor.name", { version: VERSION })} · ${about}`;
      badge.onclick = () => this.toolbar.openConnection();
      const lines = [this.backend.url];
      if (this.capabilities.previewing) {
        lines.push(t("editor.previewing", { plan: this.capabilities.plan }));
      }
      lines.push(this.capabilities.known
        ? t("conn.answer.runs", { types: this.capabilities.nodeTypes.join(", ") })
        : t("conn.answer.none"));
      lines.push(t("editor.clickToChange"));
      badge.title = lines.join("\n");
      this.statusEl.append(badge);
    }
    if (!this.issues.length) {
      const ok = el("span", "sf-status-ok");
      ok.textContent = `✓ ${t("editor.valid")}`;
      this.statusEl.append(ok);
      return;
    }
    for (const issue of this.issues) {
      const item = el("button", "sf-status-issue");
      const where = issue.graph === null ? "" : `[${issue.graph}] `;
      item.textContent = `${where}${issue.node ? issue.node + ": " : ""}${issue.message}`;
      item.onclick = () => {
        if (issue.graph !== this.model.graphKey) this.model.setGraph(issue.graph);
        if (issue.node) this.selection.set({ type: "node", id: issue.node });
      };
      this.statusEl.append(item);
    }
  }

  #note(message) {
    this.statusEl.textContent = "";
    this.statusEl.append(Object.assign(el("span", "sf-status-issue"), { textContent: message }));
  }
}

export function createEditor(container, options) {
  return new Editor(container, options);
}
