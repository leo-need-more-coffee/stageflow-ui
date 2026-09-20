/**
 * The editor toolbar: file operations, the stage source, pipeline settings,
 * running and debugging, and switching between the root and the subpipelines.
 */
import { connectBackend } from "./connect.js";
import { Modal } from "./modal.js";
import { openMenu } from "./menu.js";
import { DELAY_PRESETS, delayLabel } from "./runner.js";
import { SECRET_MASK, validSecretName } from "./secrets.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Toolbar {
  /** @param editor — the Editor facade (uses its public API) */
  constructor(host, editor) {
    this.host = host;
    this.editor = editor;
    host.classList.add("sf-toolbar");
  }

  render() {
    this.host.textContent = "";

    const brand = el("div", "sf-brand");
    brand.append(el("span", "sf-brand-mark", "◇"), el("span", "", "StageFlow"));
    this.host.append(brand);

    // A menu bar instead of a row of buttons: the bar used to hold fourteen
    // controls of four different meanings — document, edit, view, run — and
    // finding the right one meant reading the whole bar. Now the meaning is
    // visible from the menu name, and the items themselves carry the hotkeys,
    // so the bar stops being the only way to reach them.
    this.builders = new Map([
      ["File", () => this.#fileItems()],
      ["Edit", () => this.#editItems()],
      ["View", () => this.#viewItems()],
      ["Run", () => this.#runItems()],
    ]);
    this.buttons = new Map();
    for (const title of this.builders.keys()) {
      const button = this.#menuButton(title);
      this.buttons.set(title, button);
      this.host.append(button);
    }

    this.host.append(this.#graphSelector());
    this.host.append(el("div", "sf-spacer"));
    this.host.append(this.#runIndicator());
    this.#refreshOpenMenu();
  }

  /** The bar is redrawn on every change — an edit of the graph, a run tick, the
   * specs loading. An open section survives that: the buttons are new, so the
   * menu moves to a new anchor and the items are updated in place (see
   * `Menu.setItems`). Closing it here would mean the "Run" section slams shut
   * under the hand during a run. */
  #refreshOpenMenu() {
    if (!this.menu || !this.openMenuName) return;
    const button = this.buttons.get(this.openMenuName);
    const build = this.builders.get(this.openMenuName);
    if (!button || !build) {
      this.#closeMenu();
      return;
    }
    this.menu.setAnchor(button);
    this.menu.setItems(build());
  }

  // ------------------------------------------------------------- menu bar

  #menuButton(title) {
    const button = el("button", "sf-menubtn", title);
    // A click closes a section only if it was opened BY A CLICK: a menu opened
    // by hovering would otherwise slam shut on the very press that was meant to
    // pin it (first pointerenter opens it, then click closes it — and the
    // section cannot be opened at all).
    button.onclick = () => {
      if (this.openMenuName === title) {
        if (this.openedByHover) this.openedByHover = false;
        else this.#closeMenu();
        return;
      }
      this.#openMenu(title);
    };
    // an open menu switches on hover, as in any menu bar: otherwise every move
    // between sections is a close and an open
    button.onpointerenter = () => {
      if (this.openMenuName && this.openMenuName !== title) {
        this.#openMenu(title);
        this.openedByHover = true;
      }
    };
    if (this.openMenuName === title) button.classList.add("sf-menubtn-open");
    return button;
  }

  #openMenu(title) {
    const anchor = this.buttons.get(title);
    const build = this.builders.get(title);
    if (!anchor || !build) return;
    const rect = anchor.getBoundingClientRect();
    this.#closeMenu();
    this.openMenuName = title;
    this.openedByHover = false;
    this.#markOpen(title);
    this.menu = openMenu(this.editor.container, {
      x: rect.left - 4, y: rect.bottom - 2,
      items: build(), anchor, closeOnOutside: true,
      // left/right arrows walk the sections without closing the menu bar
      onSide: (delta) => this.#openMenu(this.#neighbour(title, delta)),
      onClose: () => {
        if (this.openMenuName === title) {
          this.openMenuName = null;
          this.#markOpen(null);
        }
        this.menu = null;
      },
    });
  }

  /** The highlight of the open section lives on a button, and the bar gets
   * redrawn: clearing it on the button that opened the menu is too late — that
   * button is no longer in the DOM, and the section would stay highlighted
   * forever. So the highlight is always set by one method and over the CURRENT
   * buttons. */
  #markOpen(title) {
    for (const [name, button] of this.buttons) {
      button.classList.toggle("sf-menubtn-open", name === title);
    }
  }

  /** The neighbouring section, wrapping around: right of the last one is the
   * first. */
  #neighbour(title, delta) {
    const titles = [...this.builders.keys()];
    const index = titles.indexOf(title);
    return titles[(index + delta + titles.length) % titles.length];
  }

  #closeMenu() {
    this.menu?.close();
    this.menu = null;
    this.openMenuName = null;
    this.openedByHover = false;
  }

  // ------------------------------------------------------------- sections

  #fileItems() {
    const { model } = this.editor;
    return [
      { label: "New", hint: "clear the graph", apply: () => {
        if (!model.pipeline.nodes.length || confirm("Clear the pipeline?")) model.reset();
      } },
      { separator: true },
      { label: "Import JSON…", apply: () => this.#importModal() },
      { label: "Export JSON…", apply: () => this.#exportModal() },
      { separator: true },
      { label: "Pipeline settings…", hint: "types, variables, metadata",
        apply: () => this.#settingsModal() },
      { label: "Stage registry…", hint: this.editor.stages.loaded
          ? `loaded: ${this.editor.stages.names().length}` : "not loaded",
        apply: () => this.#stagesModal() },
      { label: "Backend…", hint: this.editor.backend.url,
        apply: () => this.#changeBackend() },
      { label: "Secrets…", hint: this.editor.secrets.size
          ? `keys: ${this.editor.secrets.size}` : "API keys outside the JSON",
        apply: () => this.#secretsModal() },
    ];
  }

  #editItems() {
    const { model, selection } = this.editor;
    const picked = selection.nodes.size;
    return [
      { label: "Undo", shortcut: "Ctrl+Z", disabled: !model.canUndo,
        apply: () => this.editor.undo() },
      { label: "Redo", shortcut: "Ctrl+Shift+Z", disabled: !model.canRedo,
        apply: () => this.editor.redo() },
      { separator: true },
      { label: "Copy", shortcut: "Ctrl+C", disabled: !picked,
        apply: () => this.editor.copySelection() },
      { label: "Cut", shortcut: "Ctrl+X", disabled: !picked,
        apply: () => this.editor.cutSelection() },
      { label: "Paste", shortcut: "Ctrl+V", disabled: !this.editor.clipboard.length,
        apply: () => this.editor.paste() },
      { separator: true },
      { label: picked > 1 ? `Delete selected (${picked})` : "Delete selection",
        shortcut: "Delete", disabled: !selection.current,
        apply: () => this.editor.deleteSelection() },
    ];
  }

  /** The data layer gets three items with a tick rather than one toggle that
   * cycles: in a menu that closes after a choice, "cycling" would mean opening
   * it three times to reach the far mode. */
  #viewItems() {
    const editor = this.editor;
    const dataModes = [
      ["off", "hide", "a cleaner graph, but who writes to whom is invisible"],
      ["focus", "for the card under the cursor", "one node at a time"],
      ["all", "all at once", "every variable flow is visible"],
    ];
    return [
      { label: "Fit the graph to the screen", shortcut: "Shift+F",
        apply: () => editor.canvas.fitView() },
      { label: "Lay out again", shortcut: "Shift+L", hint: "levels and columns from the graph",
        apply: () => editor.model.relayout() },
      { separator: true },
      { heading: "Data wires" },
      ...dataModes.map(([mode, label, hint]) => ({
        label, hint, checked: editor.dataMode === mode,
        apply: () => editor.setDataMode(mode),
      })),
      { separator: true },
      { label: "Stage descriptions on the cards", checked: editor.showDescriptions,
        apply: () => editor.toggleDescriptions() },
      { separator: true },
      { label: "Node palette on the left", checked: editor.panels.palette,
        apply: () => editor.togglePanel("palette") },
      { label: "Node panel on the right", checked: editor.panels.inspector,
        apply: () => editor.togglePanel("inspector") },
    ];
  }

  /** The pace lives as items right in the run section rather than as a separate
   * setting: "show what is happening" is decided where "Run" is pressed, and on
   * a running session it changes on the fly (see `Editor.setRunDelay`). */
  #runItems() {
    const editor = this.editor;
    const { runner } = editor;
    const active = runner.active;
    return [
      { label: "Run", shortcut: "F5", disabled: active,
        hint: `asks for the starting variables, pace: ${delayLabel(editor.runDelay)}`,
        apply: () => editor.run({ mode: "run" }) },
      { label: "Debug step by step", shortcut: "Shift+F5", disabled: active,
        hint: "stops before the first node", apply: () => editor.run({ mode: "step" }) },
      { separator: true },
      { label: "Step", shortcut: "F10", disabled: !active, apply: () => runner.step() },
      { label: runner.waiting ? "Continue" : "Pause", disabled: !active,
        apply: () => (runner.waiting ? runner.resume() : runner.pause()) },
      { label: "Stop", disabled: !active, apply: () => runner.stop() },
      { separator: true },
      { heading: "Delay between nodes" },
      ...DELAY_PRESETS.map(([value, label, hint]) => ({
        label, hint, checked: editor.runDelay === value,
        apply: () => editor.setRunDelay(value),
      })),
      // a pace typed into the run dialog is shown as an item of its own:
      // otherwise the menu would carry no tick at all and the current pace
      // would look like "none", though the run will go exactly at it
      ...(DELAY_PRESETS.some(([value]) => value === editor.runDelay) ? [] : [{
        label: delayLabel(editor.runDelay), hint: "set in the run dialog",
        checked: true, apply: () => {},
      }]),
    ];
  }

  /** The state of the run on the right of the bar: while a session is going,
   * this is the only thing worth keeping in sight permanently. */
  #runIndicator() {
    const { runner } = this.editor;
    const wrap = el("div", "sf-runstate");
    if (runner.status === "idle") return wrap;
    const labels = {
      running: ["▶", "running"], paused: ["⏸", "paused"], finished: ["✓", "finished"],
      stopped: ["⏹", "stopped"], failed: ["✕", "failed"],
    };
    const [glyph, text] = labels[runner.status] ?? ["•", runner.status];
    const chip = el("button", `sf-runstate-chip sf-debug-${runner.status}`);
    chip.append(el("span", "sf-debug-glyph", glyph), el("span", "", text));
    if (runner.node) chip.append(el("span", "sf-runstate-node", runner.node));
    chip.title = "show the node of the run";
    chip.onclick = () => {
      if (runner.node) this.editor.selection.set({ type: "node", id: runner.node });
    };
    wrap.append(chip);
    return wrap;
  }

  #button(label, onClick, className = "sf-btn") {
    const btn = el("button", className, label);
    btn.onclick = onClick;
    return btn;
  }

  // ------------------------------------------------------ graph selector

  #graphSelector() {
    const { model } = this.editor;
    const wrap = el("div", "sf-graphsel");
    const select = el("select");

    const rootOpt = el("option", "", "root graph");
    rootOpt.value = "";
    select.append(rootOpt);
    for (const key of Object.keys(model.pipeline.subpipelines ?? {})) {
      const opt = el("option", "", `sub: ${key}`);
      opt.value = key;
      select.append(opt);
    }
    select.value = model.graphKey ?? "";
    select.onchange = () => {
      this.editor.selection.clear();
      model.setGraph(select.value === "" ? null : select.value);
    };
    wrap.append(select);

    wrap.append(this.#button("+ sub", () => {
      const id = prompt("Id of the new subpipeline:");
      if (id && !model.addSubpipeline(id.trim())) alert("Such an id already exists, or it is empty");
    }, "sf-btn sf-btn-small"));

    if (model.graphKey !== null) {
      wrap.append(this.#button("✕", () => {
        if (confirm(`Delete the subpipeline '${model.graphKey}'?`)) {
          this.editor.selection.clear();
          model.removeSubpipeline(model.graphKey);
        }
      }, "sf-btn sf-btn-small sf-danger"));
    }
    return wrap;
  }

  // -------------------------------------------------------------- modals

  #importModal() {
    const modal = new Modal("Import a pipeline").open();
    const area = el("textarea", "sf-modal-area");
    area.placeholder = "Paste the pipeline JSON...";
    area.spellcheck = false;

    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.onchange = async () => {
      if (file.files[0]) area.value = await file.files[0].text();
    };

    const apply = this.#button("Load", () => {
      try {
        this.editor.setPipeline(JSON.parse(area.value));
        modal.close();
      } catch (err) {
        alert(`Malformed JSON: ${err.message}`);
      }
    }, "sf-btn sf-primary");

    modal.body.append(file, area, apply);
  }

  #exportModal() {
    const modal = new Modal("Export the pipeline").open();
    const json = JSON.stringify(this.editor.getPipeline(), null, 2);
    const area = el("textarea", "sf-modal-area");
    area.value = json;
    area.readOnly = true;
    area.spellcheck = false;

    const row = el("div", "sf-modal-row");
    row.append(
      this.#button("Download", () => {
        const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const link = el("a");
        link.href = url;
        link.download = "pipeline.json";
        link.click();
        URL.revokeObjectURL(url);
      }, "sf-btn sf-primary"),
      this.#button("Copy", () => navigator.clipboard?.writeText(json)),
    );
    modal.body.append(area, row);
  }

  /** The pipeline sections that have no visual representation on the canvas:
   * types / variables / metadata — edited as JSON. */
  #settingsModal() {
    const modal = new Modal("Pipeline settings").open();
    const { model } = this.editor;
    const sections = [
      ["types", "Named types", '{"User": {"id": "int", "name": "string"}}'],
      ["variables", "Variable types", '{"user": "User"}'],
      ["metadata", "Metadata", "{}"],
    ];
    const areas = new Map();
    for (const [key, label, placeholder] of sections) {
      modal.body.append(el("div", "sf-field-label", label));
      const area = el("textarea", "sf-modal-area sf-modal-area-small");
      area.spellcheck = false;
      area.placeholder = placeholder;
      const value = model.pipeline[key];
      area.value = value && Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
      areas.set(key, area);
      modal.body.append(area);
    }
    modal.body.append(this.#button("Save", () => {
      try {
        for (const [key, area] of areas) {
          const text = area.value.trim();
          if (text === "") delete model.pipeline[key];
          else model.pipeline[key] = JSON.parse(text);
        }
        model.touch();
        modal.close();
      } catch (err) {
        alert(`Malformed JSON: ${err.message}`);
      }
    }, "sf-btn sf-primary"));
  }

  /**
   * The secret store: the place where the API keys live — apart from the graph
   * and without showing the values.
   *
   * The list is written as "name · source · ••••••••": a saved value is never
   * shown again to anybody, it can only be replaced or deleted. What was typed
   * can be checked before saving — with the eye next to the input; afterwards
   * there is no point, and there may well be someone to show it to over the
   * shoulder.
   */
  #secretsModal() {
    const modal = new Modal("Secrets").open();
    const { secrets } = this.editor;

    modal.body.append(el("p", "sf-muted",
      "Keys are kept apart from the pipeline: only the NAME stays in the JSON, "
      + "in an export and on the cards, and the value is substituted at start. A node "
      + "reads it like an ordinary variable — put the name into the \"vars\" bucket of a "
      + "stage argument."));

    const list = el("div", "sf-secrets");
    const renderList = () => {
      list.textContent = "";
      const names = secrets.names();
      if (!names.length) {
        list.append(el("div", "sf-muted", "Nothing here yet."));
        return;
      }
      for (const name of names) {
        const env = secrets.sourceOf(name) === "env";
        const row = el("div", "sf-secret");
        row.append(el("span", "sf-secret-name", name));
        row.append(el("span", "sf-secret-value", SECRET_MASK));
        const source = el("span", "sf-secret-source", env ? "server environment" : "browser");
        source.title = env
          ? "the value lives in the server environment and never reaches the browser"
          : "the value lies in the localStorage of this browser";
        row.append(source);
        // a server-side secret does not belong to the editor: it cannot be
        // deleted from here, and rightly so — it was not the editor that
        // created it
        const drop = el("button", "sf-tag-x", "×");
        drop.title = env ? "set by an environment variable of the server" : "delete the key";
        drop.disabled = env;
        drop.onclick = () => {
          if (confirm(`Delete the secret "${name}"?`)) {
            secrets.remove(name);
            renderList();
          }
        };
        row.append(drop);
        list.append(row);
      }
    };
    renderList();
    modal.body.append(list);

    modal.body.append(el("div", "sf-field-label", "Add or replace"));
    const form = el("div", "sf-secret-form");
    const name = el("input", "sf-secret-input-name");
    name.placeholder = "OPENAI_API_KEY";
    name.spellcheck = false;
    const value = el("input", "sf-secret-input-value");
    value.type = "password";
    value.placeholder = "value";
    value.spellcheck = false;
    value.autocomplete = "off";
    // the eye is only for the value BEING TYPED: a typo has to be seen before
    // the key goes into the store, and afterwards there is nothing to show
    const peek = el("button", "sf-btn sf-btn-small", "show");
    peek.type = "button";
    peek.title = "show the typed value";
    peek.onclick = () => {
      value.type = value.type === "password" ? "text" : "password";
      peek.textContent = value.type === "password" ? "show" : "hide";
    };
    const save = this.#button("Save", () => {
      const key = name.value.trim();
      if (!validSecretName(key)) {
        alert("A secret name is like a variable name: letters, digits, underscore.");
        return;
      }
      if (!value.value) {
        alert("An empty value is not saved: to remove a key, delete it from the list.");
        return;
      }
      secrets.set(key, value.value);
      name.value = "";
      value.value = "";
      value.type = "password";
      peek.textContent = "show";
      renderList();
    }, "sf-btn sf-primary");
    form.append(name, value, peek, save);
    modal.body.append(form);

    modal.body.append(el("p", "sf-muted",
      "This is not encryption: the browser store is readable by extensions and devtools. "
      + "It protects against the key spreading through exports, screenshots and the debug "
      + "log. For a real secret use the environment variables of the server "
      + "(SF_SECRETS=NAME or SF_SECRET_NAME=value): the browser receives the name only."));
  }

  /**
   * Changing the backend: the same connection screen as at the start, and a
   * reload afterwards.
   *
   * A reload rather than a live swap on purpose: the address is not a setting
   * but the ground everything stands on — the stage registry, the running
   * session, the names of the environment secrets. Swapping it under a live
   * session would leave a graph built from the stages of one backend with a run
   * belonging to another.
   */
  #changeBackend() {
    connectBackend({
      storageKey: this.editor.options.storageKey,
      force: true,
      onCancel: () => {},
    }).then((backend) => {
      if (backend && backend.url !== this.editor.backend.url) location.reload();
    });
  }

  #stagesModal() {
    const modal = new Modal("Stage registry").open();
    const { stages } = this.editor;
    modal.body.append(el("p", "sf-muted", stages.loaded
      ? `Stages loaded: ${stages.names().length} (${stages.source})`
      : "No stage specs loaded yet."));
    modal.body.append(el("p", "sf-muted",
      `The registry comes from the backend at ${this.editor.backend.url}. `
      + "Reload it after the backend has registered new stages; a file is for "
      + "working on a graph while that backend is down."));

    const loadBtn = this.#button("Reload from the backend", async () => {
      await this.editor.reloadStages();
      modal.close();
    }, "sf-btn sf-primary");

    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.onchange = async () => {
      if (!file.files[0]) return;
      try {
        stages.setSpecs(JSON.parse(await file.files[0].text()), file.files[0].name);
        modal.close();
      } catch (err) {
        alert(`Malformed JSON: ${err.message}`);
      }
    };

    modal.body.append(loadBtn, el("div", "sf-field-label", "…or from a file"), file);
  }
}
