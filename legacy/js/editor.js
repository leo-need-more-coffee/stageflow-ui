/**
 * The editor facade: the entry point for embedding the editor.
 *
 *   import { connectBackend } from "stageflow-editor/connect.js";
 *   import { createEditor } from "stageflow-editor";
 *
 *   const backend = await connectBackend({ storageKey: "stageflow-editor" });
 *   const editor = createEditor(container, {
 *     backend,                                   // stage specs and the run API
 *     pipeline: {...},                           // the initial pipeline
 *     onChange: (pipeline) => {...},
 *     spacing: { gapX: 96, gapY: 140, dataGap: 120 }, // layout density
 *     dataMode: "focus",                         // data wires: off|focus|all
 *   });
 *
 * The editor has no stages of its own and runs nothing: `backend` (a
 * `Backend` or an address) is required.
 *
 * Public API: getPipeline / setPipeline / setStages / validate and the
 * "change" event (Editor is an EventTarget). The rest is internal.
 */
import { Backend } from "./backend.js";
import { rememberBackend } from "./connect.js";
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
import { EditorStore } from "./storage.js";
import { Toolbar } from "./toolbar.js";

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** The letter of a key independent of the keyboard layout: `e.code` is the
 * physical key, so Ctrl+Z works on non-Latin layouts too. */
function letterOf(e) {
  return e.code?.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
}

/**
 * The current selection, shared by the canvas and the inspector.
 *
 * Several nodes can be selected (marquee, Shift-click) and are moved or
 * deleted together; only one edge at a time. `current` is what the
 * inspector shows: a node's form, or a summary for several.
 */
export class Selection extends EventTarget {
  #current = null;
  #nodes = new Set();

  get current() { return this.#current; }

  /** The selected node ids. */
  get nodes() { return this.#nodes; }

  has(id) { return this.#nodes.has(id); }

  set(value) {
    this.#current = value;
    this.#nodes = value?.type === "node" ? new Set([value.id]) : new Set();
    this.dispatchEvent(new Event("change"));
  }

  /** Select a group of nodes. */
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
  /** Extra status bar chips by owner; an owner's update replaces its chip. */
  #notes = new Map();

  constructor(container, options = {}) {
    super();
    this.options = options;
    // Required: without a backend there are no stages and nothing can run.
    this.backend = options.backend instanceof Backend
      ? options.backend
      : new Backend(options.backend);
    this.model = new PipelineModel(options.spacing);
    this.stages = new StagesLibrary();
    // Which node types the backend can run. Fetched once in the background;
    // an older backend without /api/meta just reports nothing.
    this.capabilities = new BackendCapabilities();
    this.capabilities.load(this.backend);
    this.selection = new Selection();
    this.validator = new Validator(this.stages, this.capabilities);
    this.issues = [];
    // Data wires: "off", "focus" (the hovered card and a highlighted
    // variable) or "all".
    this.dataMode = options.dataMode ?? "focus";
    this.showDescriptions = true; // stage descriptions on the cards
    this.panels = { palette: true, inspector: true };
    this.clipboard = []; // the node buffer: lives in the editor, not in the system one
    // Runs execute in the core on the backend; this is only their state.
    this.runner = new Runner(this.backend);
    // Pause between nodes, so a run can be followed by eye. Set before a run
    // and kept across runs and reloads.
    this.runDelay = options.runDelay ?? 0;
    // Secrets are kept outside the graph and never written to the pipeline
    // JSON (see secrets.js). Only names of server-side secrets are fetched.
    this.secrets = new SecretStore(options.storageKey);
    this.secrets.loadEnv(this.backend.secretsUrl, (url, init) => this.backend.fetch(url, init));
    // Arguments of the previous run: `vars` is sent, `entered` refills the
    // dialog next time.
    this.runVars = { vars: {}, entered: {} };

    // The pipeline, view and panel layout survive a reload.
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

    // Specs may be passed in (tests, embedding); normally they come from the
    // backend.
    if (options.stages) this.stages.setSpecs(options.stages);
    else this.reloadStages();

    const pipeline = saved?.pipeline ?? options.pipeline;
    // A restored session keeps the positions the user arranged.
    if (pipeline) this.setPipeline(pipeline, { keepLayout: Boolean(saved?.pipeline) });
    else this.#renderAll();
    if (saved) this.#restoreView(saved);

    // Fit the view once the container has a size, unless a saved view was
    // restored.
    requestAnimationFrame(() => {
      if (this.#restoredView) this.canvas.render();
      else this.canvas.fitView();
    });
    window.addEventListener("pagehide", () => this.store.flush(() => this.#state()));
  }

  /** Restore the view and the current graph from a saved session. */
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

  /** What the last `setPipeline` changed: `{added, removed, changed, moved,
   * fresh}` by node id, or null. The bridge shows the counts in the status
   * bar (see `docs/bridge.md`). */
  lastChange = null;

  /**
   * A graph applied from outside (e.g. by an assistant) that the user has not
   * yet kept or reverted: `{before, change}`. While set, changed cards stay
   * marked and the status bar offers Keep / Revert (Escape or Ctrl+Z revert).
   *
   * `setPipeline` replaces the document and has no undo, so this is the only
   * way to take such a change back.
   */
  pending = null;

  /**
   * Apply a graph from outside, to be kept or reverted. It is applied
   * immediately (so it can be inspected); the previous version is kept until
   * the user decides.
   */
  applyIncoming(pipeline) {
    const before = this.getPipeline();
    const had = this.pending?.before ?? before;
    this.setPipeline(pipeline);
    if (this.lastChange && !this.lastChange.fresh) {
      // A second push before an answer: revert still goes back to the user's
      // version, not to the previous push.
      this.pending = { before: had, change: this.lastChange };
      this.canvas.showChange(this.lastChange, { hold: true });
    } else {
      this.pending = null;
    }
    this.#renderStatus();
    return this.lastChange;
  }

  /** Keep the incoming change: clear the marks and the revert point. */
  acceptChange() {
    if (!this.pending) return false;
    this.pending = null;
    this.canvas.clearMarks();
    this.#renderStatus();
    return true;
  }

  /** Revert the incoming change, keeping the view. */
  revertChange() {
    if (!this.pending) return false;
    const { before } = this.pending;
    this.pending = null;
    this.setPipeline(before, { keepLayout: true });
    this.canvas.clearMarks();
    this.#renderStatus();
    return true;
  }

  getPipeline() { return this.model.toJSON(); }

  /**
   * @param keepLayout use the stored coordinates as they are (a restored
   *   session). Otherwise overlapping coordinates are replaced by an
   *   automatic layout (see `normalizeGraph`).
   */
  setPipeline(pipeline, options = {}) {
    // A new document: forget the previous run's arguments.
    this.runVars = { vars: {}, entered: {} };
    this.model.setPipeline(pipeline, options);
  }

  setStages(specs) { this.stages.setSpecs(specs); }

  /** Fetch the stage specs again (the backend's registry changed). */
  reloadStages() {
    return this.stages.loadUrl(this.backend.stagesUrl,
                               (url, init) => this.backend.fetch(url, init))
      .catch((err) => { this.#note(t("editor.stagesFailed", { reason: err.message ?? err })); });
  }

  validate() { return this.validator.validate(this.model.pipeline, kindOf); }

  /**
   * Draw and validate against another plan.
   *
   * Only changes what is shown: the backend answers `/api/meta?plan=` and
   * `/api/stages?plan=` for any plan, but a run always uses the plan of the
   * credential (a mismatch is refused with a clear message). No reload is
   * needed; the palette, limits and issues are updated.
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
   * Change the credential without reloading (tokens expire or get rotated).
   * Re-fetches stages, capabilities and secrets and repaints.
   *
   * Throws a user-facing message if the new credential does not work, and
   * restores the previous one.
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
    // The probe already fetched the stages.
    this.stages.setSpecs(probe.stages, this.backend.stagesUrl);
    await this.capabilities.load(this.backend);
    this.secrets.loadEnv(this.backend.secretsUrl,
                         (url, init) => this.backend.fetch(url, init));
    this.issues = this.validate();
    this.#renderAll();
    return probe.count;
  }

  /** Save the address with its credential and plan. */
  #persistBackend() {
    const key = this.options.storageKey;
    if (!key) return;
    rememberBackend(key, { url: this.backend.url, auth: this.backend.auth,
                           plan: this.backend.plan });
  }

  /**
   * Run the pipeline on the backend. `mode: "step"` debugs: the session
   * pauses before the first node and advances on command.
   *
   * First asks for the starting variables (the `entry` node has defaults).
   * `ask: false` skips the dialog and reuses the previous values (the "↻"
   * button).
   */
  async run({ mode = "run", delay, vars = null, ask = true } = {}) {
    const pipeline = this.getPipeline();
    let startVars = vars ?? this.runVars.vars;
    let startDelay = delay ?? this.runDelay;
    // Computed before the dialog, so it can show which secrets will be used.
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
        // Secrets first, so values typed in the dialog override them.
        vars: { ...secrets.vars, ...(startVars ?? {}) },
        secrets: { env: secrets.env, names: secrets.names },
        // The plan the graph was drawn against; the backend refuses a run if
        // it differs from the credential's plan.
        plan: this.capabilities.plan,
      });
    } catch (err) {
      // Usually a pipeline error from the core; show it as is.
      this.#note(t("editor.runFailed", { reason: err.message ?? err }));
      return null;
    }
  }

  /**
   * Pause between nodes, in seconds (the "Run" menu, the run dialog and the
   * debug panel all set it). Applies to a run in progress too.
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

  /** Cut: copy and delete (Ctrl+X). */
  cutSelection() {
    const count = this.copySelection();
    if (!count) return 0;
    this.model.removeNodes([...this.selection.nodes]);
    this.selection.clear();
    return count;
  }

  /**
   * Paste from the clipboard (Ctrl+V), under the cursor if it is over the
   * canvas. The pasted nodes become the selection.
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

  /** Delete the selected node(s) or edge (Delete, "Edit" menu). */
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

  /** Hide or show the palette ("palette") or the inspector ("inspector"). */
  togglePanel(name) {
    if (!(name in this.panels)) return;
    this.panels[name] = !this.panels[name];
    this.#applyPanels();
    this.toolbar.render();
    this.#persist();
  }

  /** Data wires: "off", "focus" (the hovered card) or "all" ("View" menu). */
  setDataMode(mode) {
    if (!["off", "focus", "all"].includes(mode) || mode === this.dataMode) return;
    this.dataMode = mode;
    this.#renderAll();
    this.#persist();
  }

  /** Whether cards show their data rows ("arg ← var"). */
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
    // Each panel has its own fold button; a rail brings a folded panel back.
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
      // the backend that absolute icon paths refer to (see icons.js)
      backend: this.backend,
      // the palette dims node types the backend cannot run
      capabilities: this.capabilities,
      // hovering a variable in the index highlights it on the graph
      highlightVar: (name) => this.canvas?.highlightVariable(name),
      // panning and zooming are saved in the session
      onView: () => this.#persist(),
    };
    this.canvas = new CanvasView(this.canvasEl, env);
    this.inspector = new Inspector(this.inspectorEl, env);
    this.palette = new Palette(this.paletteEl, {
      ...env,
      // A click on the palette appends the node after the selected one, so it
      // is connected right away. With nothing to attach to, the node is
      // placed in the centre of the view.
      addNode: (type, extra = {}) => {
        const spec = { type, extra };
        const selected = this.selection.current;
        const node = (selected?.type === "node" ? this.model.appendAfter(selected.id, spec) : null)
          ?? this.model.createAt(spec, this.#centerPos());
        this.selection.set({ type: "node", id: node.id });
      },
      // drag from the palette: the canvas shows the target and handles the drop
      dropHint: (x, y, spec) => this.canvas.dropHint(x, y, spec),
      dropCreate: (spec, x, y) => this.canvas.dropCreate(spec, x, y),
    });
    this.debug = new DebugPanel(this.debugEl, {
      ...env,
      // "run again" uses the same mode
      rerun: () => this.run({ mode: this.runner.mode, ask: false }),
      // same setting as the menu, so it persists across runs
      setDelay: (seconds) => this.setRunDelay(seconds),
    });
    this.toolbar = new Toolbar(this.toolbarEl, this);
    this.#applyPanels();
  }

  /** A panel in a wrapper with a fold button. The button sits next to the
   * panel because the panel clears its own element on render. */
  #side(name, className, panelEl, glyph) {
    const side = el("div", `sf-side ${className}`);
    const button = el("button", "sf-side-toggle", glyph);
    button.title = t("editor.foldPanel");
    button.onclick = () => this.togglePanel(name);
    side.append(panelEl, button);
    return side;
  }

  /** A narrow rail shown in place of a folded panel, to unfold it. */
  #rail(name, className, glyph) {
    const rail = el("button", `sf-rail ${className}`, glyph);
    rail.title = t("editor.unfoldPanel");
    rail.onclick = () => this.togglePanel(name);
    return rail;
  }

  /** The centre of the visible area, for a node with nothing to attach to. */
  #centerPos() {
    const center = this.canvas.centerWorld();
    return { x: center.x - NODE_MIN_W / 2, y: center.y - 50 };
  }

  #wire() {
    this.model.addEventListener("change", () => {
      this.#pruneSelection();
      // Editing an incoming change keeps it.
      if (this.pending) {
        this.pending = null;
        this.canvas.clearMarks();
      }
      this.issues = this.validate();
      this.#renderAll();
      this.#persist();
      this.dispatchEvent(new Event("change"));
      this.options.onChange?.(this.getPipeline());
    });
    this.model.addEventListener("reset", (event) => {
      const change = event.detail;
      // Fit the view for a new document, not for an edit of the current one.
      if (!change || change.fresh) this.canvas.fitView();
      this.lastChange = change ?? null;
      this.canvas.showChange(change);
    });
    this.selection.addEventListener("change", () => {
      // Selecting a node unfolds a folded inspector (it is not folded back
      // automatically).
      const picked = this.selection.current?.type;
      if ((picked === "node" || picked === "nodes") && !this.panels.inspector) {
        this.togglePanel("inspector");
      }
      this.canvas.render();
      this.inspector.render();
    });
    // run state: graph highlight, debug panel, toolbar buttons
    this.runner.addEventListener("change", () => {
      this.canvas.render();
      this.debug.render();
      this.toolbar.render();
    });
    // secrets changed: variable suggestions and the "File" menu counter
    this.secrets.addEventListener("change", () => this.#renderAll());
    this.stages.addEventListener("change", () => {
      this.issues = this.validate();
      this.#renderAll();
    });
    // capabilities arrive after the first paint; revalidate
    this.capabilities.addEventListener("change", () => {
      this.issues = this.validate();
      this.#renderAll();
    });
    document.addEventListener("keydown", (e) => this.#onKeyDown(e));
  }

  /** Drop selected ids that no longer exist (after delete or undo). */
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
    // in an input, Ctrl+Z undoes typing (the browser handles it)
    if (e.target.matches("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = letterOf(e);
      if (key === "z") {
        e.preventDefault();
        // The first Ctrl+Z after an incoming change reverts it.
        if (!e.shiftKey && this.revertChange()) return;
        e.shiftKey ? this.model.redo() : this.model.undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        this.model.redo();
        return;
      }
      if (key === "c" || key === "x" || key === "v") {
        // Only intercept Ctrl+C when nodes are selected, so copying page text
        // still works.
        if (key === "v" ? this.clipboard.length : this.selection.nodes.size) {
          e.preventDefault();
          if (key === "c") this.copySelection();
          else if (key === "x") this.cutSelection();
          else this.paste();
          return;
        }
      }
    }
    // View shortcuts.
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
    // Run and debug shortcuts.
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
    if (e.key === "Escape") {
      if (this.revertChange()) return;
      this.selection.clear();
    }
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

  /**
   * A status bar chip owned by something other than the graph (e.g. the
   * agent bridge). Falsy text removes the owner's chip.
   */
  setStatusNote(owner, text, title = "", onClick = null) {
    if (text) this.#notes.set(owner, { text, title, onClick });
    else this.#notes.delete(owner);
    this.#renderStatus();
  }

  #renderStatus() {
    this.statusEl.textContent = "";
    // The backend this editor is connected to, on the right.
    const about = this.capabilities.summary();
    if (about) {
      // a button: it opens the connection settings
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
    for (const [owner, note] of this.#notes) {
      // a button only if clicking does something
      const chip = el(note.onClick ? "button" : "span",
        `sf-status-note sf-status-${owner}${note.onClick ? " sf-status-act" : ""}`);
      chip.textContent = note.text;
      if (note.title) chip.title = note.title;
      if (note.onClick) chip.onclick = note.onClick;
      this.statusEl.append(chip);
    }
    // keep/revert buttons for an incoming change
    if (this.pending) {
      const keep = el("button", "sf-status-note sf-status-act sf-status-keep");
      keep.textContent = t("review.keep");
      keep.title = t("review.keep.hint");
      keep.onclick = () => this.acceptChange();
      const back = el("button", "sf-status-note sf-status-act sf-status-back");
      back.textContent = t("review.back");
      back.title = t("review.back.hint");
      back.onclick = () => this.revertChange();
      this.statusEl.append(keep, back);
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
