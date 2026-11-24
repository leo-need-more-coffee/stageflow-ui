/**
 * The editor toolbar: file operations, the stage source, pipeline settings,
 * running and debugging, and switching between the root and the subpipelines.
 */
import { connectBackend } from "./connect.js";
import { has, locale, locales, setLocale, t, tn } from "./i18n.js";
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
  /** @param editor the Editor facade (its public API is used) */
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

    // A menu bar (document, edit, view, run) rather than a row of fourteen
    // buttons; items show their shortcuts. Sections are keyed by name, not by
    // the translated title, so `openMenuName` survives a redraw
    this.builders = new Map([
      ["file", () => this.#fileItems()],
      ["edit", () => this.#editItems()],
      ["view", () => this.#viewItems()],
      ["run", () => this.#runItems()],
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

  /** The bar is redrawn on every change (an edit, a run event, specs
   * loading). An open section stays open: it moves to the new button and its
   * items are updated in place (see `Menu.setItems`). */
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
    const button = el("button", "sf-menubtn", t(`bar.${title}`));
    // a click closes a section only if a click opened it; otherwise a section
    // opened by hover would close on the click meant to pin it
    button.onclick = () => {
      if (this.openMenuName === title) {
        if (this.openedByHover) this.openedByHover = false;
        else this.#closeMenu();
        return;
      }
      this.#openMenu(title);
    };
    // while a menu is open, hovering another section switches to it
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
      // left/right arrows move between sections
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

  /** Highlight the open section's button. The bar is redrawn, so the
   * highlight is always set here, on the current buttons; clearing it on the
   * old button would be too late. */
  #markOpen(title) {
    for (const [name, button] of this.buttons) {
      button.classList.toggle("sf-menubtn-open", name === title);
    }
  }

  /** The neighbouring section, wrapping around. */
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
      { label: t("file.new"), hint: t("file.new.hint"), apply: () => {
        if (!model.pipeline.nodes.length || confirm(t("file.new.confirm"))) model.reset();
      } },
      { separator: true },
      { label: t("file.import"), apply: () => this.#importModal() },
      { label: t("file.export"), apply: () => this.#exportModal() },
      { separator: true },
      { label: t("file.settings"), hint: t("file.settings.hint"),
        apply: () => this.#settingsModal() },
      { label: t("file.registry"), hint: this.editor.stages.loaded
          ? t("file.registry.loaded", { n: this.editor.stages.names().length })
          : t("file.registry.empty"),
        apply: () => this.#stagesModal() },
      { label: t("file.connection"), hint: this.#connectionHint(),
        apply: () => this.openConnection() },
      { label: t("file.secrets"), hint: this.editor.secrets.size
          ? t("file.secrets.count", { n: this.editor.secrets.size })
          : t("file.secrets.hint"),
        apply: () => this.#secretsModal() },
    ];
  }

  #editItems() {
    const { model, selection } = this.editor;
    const picked = selection.nodes.size;
    return [
      { label: t("edit.undo"), shortcut: "Ctrl+Z", disabled: !model.canUndo,
        apply: () => this.editor.undo() },
      { label: t("edit.redo"), shortcut: "Ctrl+Shift+Z", disabled: !model.canRedo,
        apply: () => this.editor.redo() },
      { separator: true },
      { label: t("edit.copy"), shortcut: "Ctrl+C", disabled: !picked,
        apply: () => this.editor.copySelection() },
      { label: t("edit.cut"), shortcut: "Ctrl+X", disabled: !picked,
        apply: () => this.editor.cutSelection() },
      { label: t("edit.paste"), shortcut: "Ctrl+V", disabled: !this.editor.clipboard.length,
        apply: () => this.editor.paste() },
      { separator: true },
      { label: picked > 1 ? tn("edit.deleteSelected", picked) : t("edit.delete"),
        shortcut: "Delete", disabled: !selection.current,
        apply: () => this.editor.deleteSelection() },
    ];
  }

  /** The data-wire modes as three ticked items rather than one cycling
   * toggle, which in a closing menu would take up to three openings. */
  #viewItems() {
    const editor = this.editor;
    const dataModes = ["off", "focus", "all"];
    return [
      { label: t("view.fit"), shortcut: "Shift+F",
        apply: () => editor.canvas.fitView() },
      { label: t("view.relayout"), shortcut: "Shift+L", hint: t("view.relayout.hint"),
        apply: () => editor.model.relayout() },
      { separator: true },
      { heading: t("view.wires") },
      ...dataModes.map((mode) => ({
        label: t(`view.wires.${mode}`), hint: t(`view.wires.${mode}.hint`),
        checked: editor.dataMode === mode,
        apply: () => editor.setDataMode(mode),
      })),
      { separator: true },
      { label: t("view.descriptions"), checked: editor.showDescriptions,
        apply: () => editor.toggleDescriptions() },
      { separator: true },
      { label: t("view.palette"), checked: editor.panels.palette,
        apply: () => editor.togglePanel("palette") },
      { label: t("view.inspector"), checked: editor.panels.inspector,
        apply: () => editor.togglePanel("inspector") },
      { separator: true },
      { heading: t("view.language") },
      ...this.#languageItems(),
    ];
  }

  /** The run pace as items in the Run section, next to Run itself; it changes
   * a running session too (see `Editor.setRunDelay`). */
  #runItems() {
    const editor = this.editor;
    const { runner } = editor;
    const active = runner.active;
    return [
      { label: t("run.start"), shortcut: "F5", disabled: active,
        hint: t("run.start.hint", { pace: delayLabel(editor.runDelay) }),
        apply: () => editor.run({ mode: "run" }) },
      { label: t("run.debug"), shortcut: "Shift+F5", disabled: active,
        hint: t("run.debug.hint"), apply: () => editor.run({ mode: "step" }) },
      { separator: true },
      { label: t("run.step"), shortcut: "F10", disabled: !active,
        apply: () => runner.step() },
      { label: runner.waiting ? t("run.continue") : t("run.pause"), disabled: !active,
        apply: () => (runner.waiting ? runner.resume() : runner.pause()) },
      { label: t("run.stop"), disabled: !active, apply: () => runner.stop() },
      { separator: true },
      { heading: t("run.delay") },
      // only some paces have a hint ("1 s" needs none); set it only where the
      // catalog has one
      ...DELAY_PRESETS.map(([value, key]) => ({
        label: t(`delay.${key}`),
        ...(has(`delay.${key}.hint`) ? { hint: t(`delay.${key}.hint`) } : {}),
        checked: editor.runDelay === value,
        apply: () => editor.setRunDelay(value),
      })),
      // a pace typed in the run dialog gets its own item, so the current pace
      // is always ticked
      ...(DELAY_PRESETS.some(([value]) => value === editor.runDelay) ? [] : [{
        label: delayLabel(editor.runDelay), hint: t("delay.custom.hint"),
        checked: true, apply: () => {},
      }]),
    ];
  }

  /** The languages with a catalog, as ticked items. The list comes from
   * `i18n`; adding a language is adding a file. */
  #languageItems() {
    const all = locales();
    return Object.entries(all).map(([tag, name]) => ({
      label: name, checked: tag === locale(),
      apply: () => { if (tag !== locale()) setLocale(tag); },
    }));
  }

  /** The run state at the right of the bar, kept in sight during a session. */
  #runIndicator() {
    const { runner } = this.editor;
    const wrap = el("div", "sf-runstate");
    if (runner.status === "idle") return wrap;
    const glyphs = {
      running: "▶", paused: "⏸", awaiting: "⏳", finished: "✓", stopped: "⏹", failed: "✕",
    };
    const glyph = glyphs[runner.status] ?? "•";
    const text = glyphs[runner.status] ? t(`status.${runner.status}`) : runner.status;
    const chip = el("button", `sf-runstate-chip sf-debug-${runner.status}`);
    chip.append(el("span", "sf-debug-glyph", glyph), el("span", "", text));
    if (runner.node) chip.append(el("span", "sf-runstate-node", runner.node));
    chip.title = t("status.showNode");
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

    const rootOpt = el("option", "", t("graph.root"));
    rootOpt.value = "";
    select.append(rootOpt);
    for (const key of Object.keys(model.pipeline.subpipelines ?? {})) {
      const opt = el("option", "", t("graph.sub", { id: key }));
      opt.value = key;
      select.append(opt);
    }
    select.value = model.graphKey ?? "";
    select.onchange = () => {
      this.editor.selection.clear();
      model.setGraph(select.value === "" ? null : select.value);
    };
    wrap.append(select);

    wrap.append(this.#button(t("graph.add"), () => {
      const id = prompt(t("graph.add.prompt"));
      if (id && !model.addSubpipeline(id.trim())) alert(t("graph.add.taken"));
    }, "sf-btn sf-btn-small"));

    if (model.graphKey !== null) {
      wrap.append(this.#button("✕", () => {
        if (confirm(t("graph.remove.confirm", { id: model.graphKey }))) {
          this.editor.selection.clear();
          model.removeSubpipeline(model.graphKey);
        }
      }, "sf-btn sf-btn-small sf-danger"));
    }
    return wrap;
  }

  // -------------------------------------------------------------- modals

  #importModal() {
    const modal = new Modal(t("import.title")).open();
    const area = el("textarea", "sf-modal-area");
    area.placeholder = t("import.placeholder");
    area.spellcheck = false;

    const file = el("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.onchange = async () => {
      if (file.files[0]) area.value = await file.files[0].text();
    };

    const apply = this.#button(t("import.load"), () => {
      try {
        this.editor.setPipeline(JSON.parse(area.value));
        modal.close();
      } catch (err) {
        alert(t("common.badJson", { reason: err.message }));
      }
    }, "sf-btn sf-primary");

    modal.body.append(file, area, apply);
  }

  #exportModal() {
    const modal = new Modal(t("export.title")).open();
    const json = JSON.stringify(this.editor.getPipeline(), null, 2);
    const area = el("textarea", "sf-modal-area");
    area.value = json;
    area.readOnly = true;
    area.spellcheck = false;

    const row = el("div", "sf-modal-row");
    row.append(
      this.#button(t("export.download"), () => {
        const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        const link = el("a");
        link.href = url;
        link.download = "pipeline.json";
        link.click();
        URL.revokeObjectURL(url);
      }, "sf-btn sf-primary"),
      this.#button(t("export.copy"), () => navigator.clipboard?.writeText(json)),
    );
    modal.body.append(area, row);
  }

  /** The pipeline sections with no canvas representation (types, variables,
   * metadata), edited as JSON. */
  #settingsModal() {
    const modal = new Modal(t("settings.title")).open();
    const { model } = this.editor;
    const sections = [
      ["types", '{"User": {"id": "int", "name": "string"}}'],
      ["variables", '{"user": "User"}'],
      ["metadata", "{}"],
    ];
    const areas = new Map();
    for (const [key, placeholder] of sections) {
      modal.body.append(el("div", "sf-field-label", t(`settings.${key}`)));
      const area = el("textarea", "sf-modal-area sf-modal-area-small");
      area.spellcheck = false;
      area.placeholder = placeholder;
      const value = model.pipeline[key];
      area.value = value && Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
      areas.set(key, area);
      modal.body.append(area);
    }
    modal.body.append(this.#button(t("common.save"), () => {
      try {
        for (const [key, area] of areas) {
          const text = area.value.trim();
          if (text === "") delete model.pipeline[key];
          else model.pipeline[key] = JSON.parse(text);
        }
        model.touch();
        modal.close();
      } catch (err) {
        alert(t("common.badJson", { reason: err.message }));
      }
    }, "sf-btn sf-primary"));
  }

  /**
   * The secret store: API keys kept apart from the graph.
   *
   * Listed as "name · source · ••••••••": a saved value is never shown again,
   * only replaced or deleted. A value can be revealed while typing it, to
   * catch typos before saving.
   */
  #secretsModal() {
    const modal = new Modal(t("secrets.title")).open();
    const { secrets } = this.editor;

    modal.body.append(el("p", "sf-muted", t("secrets.lead")));

    const list = el("div", "sf-secrets");
    const renderList = () => {
      list.textContent = "";
      const names = secrets.names();
      if (!names.length) {
        list.append(el("div", "sf-muted", t("secrets.none")));
        return;
      }
      for (const name of names) {
        const env = secrets.sourceOf(name) === "env";
        const row = el("div", "sf-secret");
        row.append(el("span", "sf-secret-name", name));
        row.append(el("span", "sf-secret-value", SECRET_MASK));
        const source = el("span", "sf-secret-source",
                          t(env ? "secrets.from.env" : "secrets.from.browser"));
        source.title = t(env ? "secrets.from.env.hint" : "secrets.from.browser.hint");
        row.append(source);
        // a server-side secret was not created here and cannot be deleted here
        const drop = el("button", "sf-tag-x", "×");
        drop.title = t(env ? "secrets.drop.env" : "secrets.drop");
        drop.disabled = env;
        drop.onclick = () => {
          if (confirm(t("secrets.drop.confirm", { name }))) {
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

    modal.body.append(el("div", "sf-field-label", t("secrets.add")));
    const form = el("div", "sf-secret-form");
    const name = el("input", "sf-secret-input-name");
    name.placeholder = "OPENAI_API_KEY";
    name.spellcheck = false;
    const value = el("input", "sf-secret-input-value");
    value.type = "password";
    value.placeholder = t("secrets.value");
    value.spellcheck = false;
    value.autocomplete = "off";
    // the eye reveals only the value being typed
    const peek = el("button", "sf-btn sf-btn-small", t("common.show"));
    peek.type = "button";
    peek.title = t("secrets.peek");
    peek.onclick = () => {
      value.type = value.type === "password" ? "text" : "password";
      peek.textContent = t(value.type === "password" ? "common.show" : "common.hide");
    };
    const save = this.#button(t("common.save"), () => {
      const key = name.value.trim();
      if (!validSecretName(key)) {
        alert(t("secrets.badName"));
        return;
      }
      if (!value.value) {
        alert(t("secrets.emptyValue"));
        return;
      }
      secrets.set(key, value.value);
      name.value = "";
      value.value = "";
      value.type = "password";
      peek.textContent = t("common.show");
      renderList();
    }, "sf-btn sf-primary");
    form.append(name, value, peek, save);
    modal.body.append(form);

    modal.body.append(el("p", "sf-muted", t("secrets.note")));
  }

  /**
   * Change the backend address: the start-up connection screen, then a
   * reload. Reached from the connection dialog, which changes the credential
   * and plan in place.
   *
   * A reload because everything depends on the address (stages, the running
   * session, secret names); swapping it live would leave a graph of one
   * backend's stages with another backend's run.
   */
  #changeBackend() {
    connectBackend({
      storageKey: this.editor.options.storageKey,
      force: true,
      onCancel: () => {},
    }).then(async (backend) => {
      if (!backend) return;
      if (backend.url !== this.editor.backend.url) {
        location.reload();
        return;
      }
      // the same address with a new credential is not a new backend: no
      // reload, but the credential is applied
      await this.editor.setCredential(backend.auth).catch(() => {});
    });
  }

  #connectionHint() {
    const { backend, capabilities } = this.editor;
    const bits = [backend.url.replace(/^https?:\/\//, "")];
    if (capabilities.plan) {
      bits.push(capabilities.previewing ? `${capabilities.plan} (preview)` : capabilities.plan);
    }
    if (backend.authenticated) bits.push(t("conn.authorized"));
    return bits.join(" · ");
  }

  /**
   * The connection dialog: address, credential and plan in one place.
   *
   * One dialog because they answer one question (what am I talking to, as
   * whom, seeing which plan), and because a published editor used against
   * someone else's backend has to have all three set and corrected here.
   *
   * Only the address reloads; the credential and plan are applied in place,
   * since the backend and the graph stay the same.
   */
  openConnection() {
    const modal = new Modal(t("conn.title")).open();
    // every section depends on the backend's answers, so the whole body is
    // redrawn after a change; `notice` carries what just happened
    const draw = (notice = null) => {
      modal.body.textContent = "";
      this.#connAddress(modal);
      this.#connAuth(modal, draw, notice);
      this.#connPlan(modal, draw);
      this.#connAnswer(modal);
    };
    draw();
    return modal;
  }

  #connSection(modal, title, aside = null) {
    const section = el("div", "sf-conn-section");
    const head = el("div", "sf-conn-head");
    head.append(el("span", "sf-conn-title", title));
    if (aside) head.append(aside);
    section.append(head);
    modal.body.append(section);
    return section;
  }

  #connAddress(modal) {
    const { backend } = this.editor;
    const change = this.#button(t("conn.change"),
                               () => { modal.close(); this.#changeBackend(); });
    const section = this.#connSection(modal, t("conn.backend"), change);
    section.append(el("div", "sf-conn-url", backend.url));
    section.append(el("p", "sf-muted", t("conn.backend.note")));
    // the failure browsers report worst for a published editor
    if (typeof location !== "undefined" && location.protocol === "https:") {
      section.append(el("p", "sf-muted", t("conn.backend.https")));
    }
  }

  #connAuth(modal, redraw, notice) {
    const { backend } = this.editor;
    const section = this.#connSection(modal, t("conn.auth"));
    const row = el("div", "sf-conn-row");
    const header = el("input", "sf-conn-header");
    header.type = "text";
    header.spellcheck = false;
    header.autocomplete = "off";
    header.placeholder = "Authorization";
    header.value = backend.auth.header;
    const value = el("input");
    // a password field keeps the token off screen during a demo
    value.type = "password";
    value.spellcheck = false;
    value.autocomplete = "off";
    value.placeholder = backend.authenticated ? t("conn.auth.kept") : "Bearer …";
    value.value = backend.auth.value;
    const apply = this.#button(t("conn.apply"), () => submit(), "sf-btn sf-primary");
    row.append(header, value, apply);
    section.append(row);

    const say = el("div", "sf-conn-say");
    section.append(say);
    const said = (text, kind) => {
      say.textContent = text;
      say.className = `sf-conn-say sf-conn-${kind}`;
    };
    if (notice) said(notice.text, notice.kind);

    const submit = async () => {
      apply.disabled = true;
      said(t("conn.checking"), "wait");
      try {
        const count = await this.editor.setCredential({
          header: header.value, value: value.value,
        });
        // plan, node types and limits may all have changed
        redraw({ kind: "ok", text: value.value.trim()
          ? tn("conn.auth.accepted", count)
          : tn("conn.auth.cleared", count) });
      } catch (err) {
        said(t("conn.auth.rejected", { reason: err.message ?? err }), "bad");
        apply.disabled = false;
      }
    };
    value.onkeydown = (e) => { if (e.key === "Enter") submit(); };
    header.onkeydown = (e) => { if (e.key === "Enter") submit(); };

    section.append(el("p", "sf-muted", t("conn.auth.note")));
  }

  #connPlan(modal, redraw) {
    const { capabilities, backend } = this.editor;
    if (!capabilities.plans) return;
    const section = this.#connSection(modal, t("conn.plan"));
    section.append(el("p", "sf-muted", t("conn.plan.note")));

    const list = el("div", "sf-plan-list");
    const own = capabilities.previewing ? null : capabilities.plan;
    const pick = (plan, label, note) => {
      const row = el("div", "sf-plan-option");
      if ((plan ?? null) === backend.plan) row.classList.add("sf-on");
      row.append(el("code", "", label));
      if (note) row.append(el("span", "sf-muted", note));
      row.onclick = async () => {
        await this.editor.setPlan(plan);
        redraw();
      };
      list.append(row);
    };
    // "mine" first, so returning from a preview needs no plan name
    pick(null, t("conn.plan.mine"),
         own ? t("conn.plan.mine.is", { plan: own }) : t("conn.plan.mine.unknown"));
    for (const plan of capabilities.plans) {
      pick(plan, plan, t(plan === own ? "conn.plan.same" : "conn.plan.preview"));
    }
    section.append(list);
  }

  #connAnswer(modal) {
    const { capabilities } = this.editor;
    if (!capabilities.probed) return;
    const section = this.#connSection(modal, t("conn.answer"));
    if (!capabilities.known) {
      section.append(el("p", "sf-muted", t("conn.answer.none")));
      return;
    }
    section.append(el("div", "sf-conn-url", capabilities.summary()));
    section.append(el("p", "sf-muted",
      t("conn.answer.runs", { types: capabilities.nodeTypes.join(", ") })));
    const counters = Object.entries(capabilities.limits?.counters ?? {});
    const gauges = Object.entries(capabilities.limits?.gauges ?? {});
    if (counters.length || gauges.length) {
      section.append(el("p", "sf-muted", t("conn.answer.limits", {
        limits: [...counters, ...gauges].map(([name, value]) => `${name} ${value}`).join(", "),
      })));
    }
  }

  #stagesModal() {
    const modal = new Modal(t("registry.title")).open();
    const { stages } = this.editor;
    modal.body.append(el("p", "sf-muted", stages.loaded
      ? tn("registry.loaded", stages.names().length, { source: stages.source })
      : t("registry.empty")));
    modal.body.append(el("p", "sf-muted",
      t("registry.note", { url: this.editor.backend.url })));

    const loadBtn = this.#button(t("registry.reload"), async () => {
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
        alert(t("common.badJson", { reason: err.message }));
      }
    };

    modal.body.append(loadBtn, el("div", "sf-field-label", t("registry.fromFile")), file);
  }
}
