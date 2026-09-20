/**
 * The inspector: the property panel of the selected node or edge.
 *
 * The panel answers questions in the order in which a node is thought about
 * rather than repeating the structure of the JSON: WHAT IT GETS -> WHAT IT
 * GIVES -> WHERE NEXT, and everything needed once in a lifetime (the id, the
 * entry, retries, variable copies, foreign keys) is folded into "More". The
 * section is set by the `group` field of a descriptor, the order by `GROUPS`;
 * "Next" is assembled by the inspector itself from the order ports of the node,
 * so a node kind does not have to duplicate next/then/else as separate fields.
 *
 * Everything is edited through forms — there is no hand-written JSON. The set
 * of fields comes from the node kind (kinds.js) as declarative descriptors:
 *   text / cel / number / check / select — scalar controls;
 *   node-ref — a dropdown of the nodes of the current graph;
 *   tags     — a list of strings as chips (entered comma-separated);
 *   rows     — a table editor of rows with columns of different types
 *              (text / number / select / node-ref / label);
 *   spec-args / spec-outputs — the inputs and outputs of a stage BY ITS SPEC: a
 *              row per declared argument (type, description, whether it is
 *              required), the source picked in words "variable / value /
 *              expression", the variable name out of those already in the graph;
 *   stage-spec  — the stage reference.
 */
import { variablesOf } from "./dataflow.js";
import { paintIcon } from "./icons.js";
import { argRows, kindOf, outputRows, writeArgRows, writeOutputRows } from "./kinds.js";

/** The panel sections top to bottom; `more` is drawn separately, collapsed. */
const GROUPS = [
  { key: "main", title: null },
  { key: "in", title: "What it gets" },
  { key: "out", title: "What it gives" },
];

/** Human labels for the order ports, keyed by the stable port key: the JSON key
 * itself stays next to it, in small type. */
const PORT_LABELS = {
  next: "onwards", then: "if yes", else: "if no",
  default: "otherwise", body: "block body",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Inspector {
  #flushing = false; // a field is being committed — do not touch a nested render()
  /** Unfinished rows of the table editors: `<node id>|<field label>` -> rows.
   * They cannot be represented in JSON but must survive a redraw. */
  #drafts = new Map();

  constructor(host, env) {
    this.host = host;
    this.env = env;
    host.classList.add("sf-inspector");
  }

  render() {
    this.#flushPending();
    this.host.textContent = "";
    const sel = this.env.selection.current;
    if (!sel) return this.#renderOverview();
    if (sel.type === "edge") return this.#renderEdge(sel);
    if (sel.type === "nodes") return this.#renderNodes(sel);
    const node = this.env.model.node(sel.id);
    if (!node) return this.#renderOverview();
    this.#renderNode(node);
  }

  #touch() {
    this.env.model.touch();
  }

  /**
   * A text field that does not lose what was typed.
   *
   * `change` arrives on Enter and on losing focus — but the panel is often
   * rebuilt EARLIER: a click on the canvas changes the selection, the field is
   * removed from the DOM, and its `change` never arrives — what was typed is
   * gone silently. So every field can commit itself on demand, and `render()`
   * asks the field that holds the cursor to do so before rebuilding the panel.
   */
  #bindInput(input, apply) {
    let dirty = false;
    input.addEventListener("input", () => { dirty = true; });
    const commit = () => {
      if (!dirty) return;
      dirty = false;
      apply();
    };
    input.addEventListener("change", commit);
    input.__sfCommit = commit;
    return input;
  }

  /** Commit the field under the cursor before the panel is rebuilt. The flag
   * guards against recursion: writing to the model redraws the panel itself. */
  #flushPending() {
    const active = document.activeElement;
    if (this.#flushing || !active?.__sfCommit || !this.host.contains(active)) return;
    this.#flushing = true;
    try {
      active.__sfCommit();
    } finally {
      this.#flushing = false;
    }
  }

  // ------------------------------------------------------------ sections

  #renderOverview() {
    const { model } = this.env;
    this.host.append(el("h3", "", "Pipeline"));
    const graphName = model.graphKey === null
      ? "the root graph"
      : `the subpipeline '${model.graphKey}'`;
    this.host.append(el("p", "sf-muted",
      `${graphName}: nodes ${model.graph.nodes.length}, entry: ${model.graph.entry || "—"}`));
    this.host.append(el("p", "sf-muted",
      "Arrows are the execution order, colored dots are the variable flows."));

    // the panel with nothing selected is the one place there is room to write
    // WHAT a graph is assembled with: otherwise the canvas gestures have to be
    // guessed
    this.host.append(el("div", "sf-section-title", "How to assemble a graph"));
    const tips = el("ul", "sf-tips");
    for (const text of [
      "Pull a wire from the bottom port of a card: onto a node it links them, into empty space it offers to create a node there.",
      "A click on a port takes the wire until the next click — Esc lets it go.",
      "Hover a link: ⊕ inserts a node into it, × cuts it.",
      "A node from the palette can be dragged: onto a link it is inserted into it, onto a card it is attached after it.",
      "A double click on empty space creates a node right there.",
      "The middle button pans, the right one draws a selection marquee; Shift-click adds a node to the selection.",
      "Delete removes what is selected: a single node as well as a whole group.",
      "Ctrl+Z undoes an edit, Ctrl+Shift+Z brings it back; the same is in the Edit menu.",
      "Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste nodes under the cursor.",
      "The handle on the panel edge folds it away; the same handle at the edge of the canvas "
        + "brings it back (or just click a node — its panel unfolds by itself).",
      "Shift+F fits the graph into the screen, Shift+L lays it out again; the rest is in the menu bar.",
    ]) tips.append(el("li", "", text));
    this.host.append(tips);
  }

  /** A group selection: "five nodes" have no common form, so the panel shows
   * what is in the group and what can be done with it. A click on a name
   * narrows the selection to a single node — to its ordinary form. */
  #renderNodes(sel) {
    this.host.append(el("h3", "", `Nodes selected: ${sel.ids.length}`));
    this.host.append(el("p", "sf-muted",
      "Drag any of them and all of them move. Delete removes the selected ones."));
    const box = el("div", "sf-tags");
    for (const id of sel.ids) {
      const tag = el("button", "sf-tag", id);
      tag.title = "show this node";
      tag.onclick = () => this.env.selection.set({ type: "node", id });
      box.append(tag);
    }
    this.host.append(box);

    const remove = el("button", "sf-btn sf-danger", "Delete selected");
    remove.onclick = () => {
      this.env.model.removeNodes(sel.ids);
      this.env.selection.clear();
    };
    this.host.append(remove);
  }

  #renderEdge(sel) {
    const node = this.env.model.node(sel.from);
    const port = node && kindOf(node).orderPorts(node)[sel.portIndex];
    this.host.append(el("h3", "", "Transition"));
    this.host.append(el("p", "sf-muted",
      port ? `${sel.from} [${port.label}] → ${port.get?.() ?? "—"}` : "?"));
    const remove = el("button", "sf-btn sf-danger", "Delete transition");
    remove.onclick = () => {
      this.env.model.disconnect(sel.from, sel.portIndex);
      this.env.selection.clear();
    };
    this.host.append(remove);
  }

  #renderNode(node) {
    const kind = kindOf(node);
    const head = el("h3", "sf-kind-title");
    head.style.setProperty("--kind-color", kind.accent(node, this.env));
    // the header is like the one on the card: the kind tile, then the node id
    // and the stage — the panel is open for a particular node, not for its type
    const caption = el("span", "sf-kind-text");
    caption.append(
      el("span", "sf-kind-id", node.id),
      el("span", "sf-kind-sub", kind.subtitle(node, this.env) || kind.title),
    );
    head.append(
      paintIcon(el("span", "sf-icon"), kind.icon(node, this.env), {
        mono: kind.iconMono(node, this.env),
        fallback: kind.iconFallback(node, this.env),
        base: this.env.backend?.url,
      }),
      caption,
    );
    this.host.append(head);

    const description = kind.description(node, this.env);
    if (description) this.host.append(el("p", "sf-muted", description));

    const fields = kind.fields(node, this.env);
    for (const { key, title } of GROUPS) {
      const own = fields.filter((f) => (f.group ?? "main") === key);
      if (!own.length) continue;
      this.host.append(this.#section(title, own.map((f) => this.#control(f))));
    }

    const ports = this.#flowSection(node, kind);
    if (ports) this.host.append(ports);

    this.host.append(this.#moreSection(node, fields.filter((f) => f.group === "more")));

    const remove = el("button", "sf-btn sf-danger", "Delete node");
    remove.onclick = () => {
      this.env.model.removeNode(node.id);
      this.env.selection.clear();
    };
    this.host.append(remove);
  }

  #section(title, controls) {
    const box = el("section", "sf-section");
    if (title) box.append(el("div", "sf-section-title", title));
    box.append(...controls);
    return box;
  }

  /** "Next" — the simple order ports of a node (next / then / else / body...).
   * List ports (branches, cases, except) live in their own editors. */
  #flowSection(node, kind) {
    const ports = kind.orderPorts(node).filter((port) => !port.add && !port.removeItem);
    if (!ports.length) return null;
    const controls = ports.map((port) => {
      const human = PORT_LABELS[port.key];
      const label = el("span", "sf-field-label");
      label.append(human ?? port.label);
      if (human) label.append(el("span", "sf-key-hint", port.label));
      const select = this.#nodeSelect(port.get?.() ?? "", (value) => {
        port.set?.(value || null);
        this.#touch();
      });
      const wrap = el("label", "sf-field");
      wrap.append(label, select);
      return wrap;
    });
    return this.#section("Next", controls);
  }

  /** "More" — what is rarely touched: the node name, entry, retries, copies. */
  #moreSection(node, fields) {
    const box = el("details", "sf-more");
    box.append(el("summary", "sf-section-title", "More: node name, entry, retries, copies"));
    box.append(this.#idField(node), this.#entryRow(node));
    for (const field of fields) box.append(this.#control(field));
    return box;
  }

  /** A dropdown of the graph nodes (an empty value means "not set"). */
  #nodeSelect(value, onChange) {
    const select = el("select");
    for (const id of ["", ...this.env.model.graph.nodes.map((n) => n.id)]) {
      const opt = el("option", "", id === "" ? "— not set —" : id);
      opt.value = id;
      select.append(opt);
    }
    select.value = String(value ?? "");
    select.onchange = () => onChange(select.value);
    return select;
  }

  #idField(node) {
    const wrap = el("label", "sf-field");
    wrap.append(el("span", "sf-field-label", "node name (id)"));
    const input = el("input");
    input.value = node.id;
    this.#bindInput(input, () => {
      const next = input.value.trim();
      if (!this.env.model.renameNode(node.id, next)) input.value = node.id;
      else this.env.selection.set({ type: "node", id: next });
    });
    wrap.append(input);
    return wrap;
  }

  #entryRow(node) {
    const graph = this.env.model.graph;
    const isEntry = graph.entry === node.id;
    const owner = graph.nodes.find((n) => n.type === "entry");
    const btn = el("button", "sf-btn", isEntry ? "✓ entry of this graph" : "Make it the entry");
    btn.disabled = isEntry;
    // the start of a graph is set by an entry node; making somebody else the
    // entry point means getting an entry node nobody ever enters
    if (!isEntry && owner) {
      btn.disabled = true;
      btn.title = `the entry point is set by the entry node '${owner.id}'`;
    }
    btn.onclick = () => this.env.model.setEntry(node.id);
    return btn;
  }

  // ------------------------------------------------------------ controls

  #control(field) {
    switch (field.kind) {
      case "stage-spec": return this.#stageSpec(field);
      case "spec-args": return this.#specArgs(field);
      case "spec-outputs": return this.#specOutputs(field);
      case "rows": return this.#rowsEditor(field);
      case "tags": return this.#tagsField(field);
      default: return this.#scalarField(field);
    }
  }

  #labeled(label, control) {
    const wrap = el("label", "sf-field");
    wrap.append(el("span", "sf-field-label", label), control);
    return wrap;
  }

  #scalarField(field) {
    if (field.kind === "check") {
      const wrap = el("label", "sf-field sf-field-inline");
      const input = el("input");
      input.type = "checkbox";
      input.checked = Boolean(field.get());
      input.onchange = () => { field.set(input.checked); this.#touch(); };
      wrap.append(input, el("span", "", field.label));
      return wrap;
    }
    if (field.kind === "select" || field.kind === "node-ref") {
      const select = el("select");
      const options = field.kind === "node-ref"
        ? ["", ...this.env.model.graph.nodes.map((n) => n.id)]
        : field.options;
      for (const option of options) {
        const [value, label] = Array.isArray(option) ? option : [option, option];
        const opt = el("option", "", label === "" ? "—" : label);
        opt.value = value;
        select.append(opt);
      }
      select.value = String(field.get() ?? "");
      select.onchange = () => { field.set(select.value || null); this.#touch(); };
      return this.#labeled(field.label, select);
    }
    const input = el("input");
    if (field.kind === "number") input.type = "number";
    if (field.kind === "cel") input.classList.add("sf-cel");
    input.value = field.get() ?? "";
    if (field.placeholder) input.placeholder = field.placeholder;
    this.#bindInput(input, () => { field.set(input.value.trim() || null); this.#touch(); });
    return this.#labeled(field.label, input);
  }

  #tagsField(field) {
    const wrap = el("div", "sf-field");
    wrap.append(el("span", "sf-field-label", field.label));
    const box = el("div", "sf-tags");
    const values = field.get();
    for (const value of values) {
      const tag = el("span", "sf-tag", value);
      const x = el("button", "sf-tag-x", "×");
      x.onclick = () => { field.set(values.filter((v) => v !== value)); this.#touch(); };
      tag.append(x);
      box.append(tag);
    }
    const input = el("input", "sf-tag-input");
    input.placeholder = "+ name, Enter";
    const addTag = () => {
      const value = input.value.trim();
      if (!value || values.includes(value)) return;
      field.set([...values, value]);
      this.#touch();
    };
    input.onkeydown = (e) => { if (e.key === "Enter") addTag(); };
    this.#bindInput(input, addTag); // the field was left, or the panel was rebuilt

    box.append(input);
    wrap.append(box);
    return wrap;
  }

  /** The generic table editor of lists (arguments, outputs, cases...). Edits go
   * into the model on change; rows are added and removed with buttons.
   *
   * Unfinished rows live in the panel as DRAFTS rather than in the JSON.
   * Otherwise "+ row" would not work at all: a row without a required field
   * (a variable name, the `when` of a case, both ends of an `expose`) cannot be
   * represented in JSON, so `field.set` dropped it, `touch()` redrew the panel
   * from the JSON — and the click looked like "nothing happened". A draft
   * survives a redraw, so the columns can be filled in any order; as soon as a
   * row becomes complete it goes into the JSON and stops being a draft.
   */
  #rowsEditor(field) {
    const wrap = el("details", "sf-rows");
    const key = `${this.env.selection.current?.id ?? "-"}|${field.label}`;
    const incomplete = field.incomplete ?? (() => false);
    const saved = field.get();
    const drafts = (this.#drafts.get(key) ?? []).filter(incomplete);
    const rows = [...saved, ...drafts];

    wrap.open = !field.collapsed || rows.length > 0;
    wrap.append(el("summary", "sf-field-label", field.label));

    const commit = () => {
      const pending = rows.filter(incomplete);
      pending.length ? this.#drafts.set(key, pending) : this.#drafts.delete(key);
      field.set(rows.filter((row) => !incomplete(row)));
      this.#touch();
    };

    const table = el("div", "sf-rows-table");
    rows.forEach((row, index) => {
      const line = el("div", "sf-rows-line" + (incomplete(row) ? " sf-rows-draft" : ""));
      for (const col of field.columns) {
        line.append(this.#rowCell(col, row, commit));
      }
      const x = el("button", "sf-tag-x", "×");
      x.onclick = () => { rows.splice(index, 1); commit(); };
      line.append(x);
      table.append(line);
    });

    const add = el("button", "sf-btn sf-btn-small", "+ row");
    add.onclick = () => { rows.push(field.blank()); commit(); };
    wrap.append(table, add);
    return wrap;
  }

  #rowCell(col, row, commit) {
    if (col.type === "label") {
      const span = el("span", "sf-rows-arrow", col.text);
      return span;
    }
    if (col.type === "select" || col.type === "node-ref") {
      const select = el("select");
      const options = col.type === "node-ref"
        ? ["", ...this.env.model.graph.nodes.map((n) => n.id)]
        : col.options;
      for (const option of options) {
        const [value, label] = Array.isArray(option) ? option : [option, option];
        const opt = el("option", "", label === "" ? "—" : label);
        opt.value = value;
        select.append(opt);
      }
      select.value = String(row[col.key] ?? "");
      select.onchange = () => {
        row[col.key] = col.asBool ? select.value === "true" : select.value;
        commit();
      };
      if (col.width) select.style.flex = `0 1 ${col.width}`;
      if (col.title) select.title = col.title;
      return select;
    }
    const input = el("input");
    if (col.type === "number") input.type = "number";
    input.value = row[col.key] ?? "";
    if (col.placeholder) input.placeholder = col.placeholder;
    if (col.width) input.style.flex = `0 1 ${col.width}`;
    if (col.title) input.title = col.title;
    this.#bindInput(input, () => { row[col.key] = input.value; commit(); });
    if (col.suggestions?.length) {
      const listId = `sf-dl-${col.key}-${Math.random().toString(36).slice(2, 8)}`;
      const datalist = el("datalist");
      datalist.id = listId;
      for (const s of col.suggestions) {
        const opt = el("option");
        opt.value = s;
        datalist.append(opt);
      }
      input.setAttribute("list", listId);
      // a fragment, not a wrapper: the input must stay a direct flex child of
      // the row, or it stops stretching
      const frag = document.createDocumentFragment();
      frag.append(input, datalist);
      return frag;
    }
    return input;
  }

  // ------------------------------------- stage inputs and outputs by the spec

  /**
   * The inputs of a stage: a row per argument DECLARED by the spec — with the
   * type, the description and a mark of whether it is required. The user does
   * not invent table rows but fills in what the stage said about itself. Keys
   * that are not in the spec (someone else's pipeline, a stage without a
   * docstring) are shown below as a separate group — nothing gets lost.
   */
  #specArgs(field) {
    const { node, spec } = field;
    const declared = (spec?.arguments ?? []).filter((a) => a.name !== "*");
    const rows = argRows(node);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const write = (name, row) => {
      const next = argRows(node).filter((r) => r.name !== name);
      if (row) next.push({ name, ...row });
      writeArgRows(node, next);
      this.#touch();
    };

    const box = el("div", "sf-args");
    for (const arg of declared) box.append(this.#argRow(arg, byName.get(arg.name), write));

    // `*` in a spec means "I accept any additional arguments" (that is how
    // LogStage, TemplateStage and AssertStage are built). Without it a stage
    // simply receives the extra argument and, if it does not read it, silently
    // ignores it — which is legal, but it has to be said right in the row and
    // not only in the group heading, which scrolls away
    const acceptsExtra = (spec?.arguments ?? []).some((a) => a.name === "*");
    const extra = rows.filter((r) => !declared.some((a) => a.name === r.name));
    if (extra.length && declared.length) {
      box.append(el("div", "sf-args-note", acceptsExtra
        ? "additional arguments: the stage accepts any"
        : "the stage did not declare such arguments"));
    }
    for (const row of extra) {
      box.append(this.#argRow({
        name: row.name,
        description: acceptsExtra
          ? "the stage accepts any additional arguments"
          : "the stage did not declare such an argument — it will receive it, "
            + "but if it does not read it, the value simply goes unused",
      }, row, write, true));
    }

    if (!declared.length && !extra.length) {
      box.append(el("div", "sf-muted", spec
        ? "the stage declared no arguments"
        : "no stage selected, or its spec is not loaded"));
    }

    const add = el("button", "sf-btn sf-btn-small", "+ own argument");
    add.onclick = () => {
      const name = prompt("Argument name:")?.trim();
      if (name) write(name, { source: "vars", value: "" });
    };
    box.append(add);
    return box;
  }

  /** One input row: a header with the type, the description, the source and the
   * value. */
  #argRow(arg, row, write, removable = false) {
    const required = arg.optional === false;
    const wrap = el("div", "sf-arg" + (required && !row ? " sf-arg-missing" : ""));

    const head = el("div", "sf-arg-head");
    head.append(el("span", "sf-arg-name", arg.name));
    if (required) {
      const star = el("span", "sf-arg-req", "*");
      star.title = "required argument";
      head.append(star);
    }
    if (arg.type) head.append(el("span", "sf-chip", arg.type));
    if (arg.optional) head.append(el("span", "sf-arg-opt", "optional"));
    if (removable) {
      const x = el("button", "sf-tag-x", "×");
      x.title = "remove the argument";
      x.onclick = () => write(arg.name, null);
      head.append(x);
    }
    wrap.append(head);
    if (arg.description) wrap.append(el("div", "sf-arg-hint", arg.description));

    const mode = !row ? "" : { const: "const", cel: "cel" }[row.source] ?? "var";
    const line = el("div", "sf-arg-line");
    const source = el("select", "sf-arg-source");
    for (const [value, label] of [["", "— not set —"], ["var", "variable"],
      ["const", "value"], ["cel", "expression"]]) {
      const opt = el("option", "", label);
      opt.value = value;
      source.append(opt);
    }
    source.value = mode;
    source.onchange = () => {
      const next = source.value;
      if (!next) return write(arg.name, null);
      const value = next === mode ? row?.value ?? "" : "";
      write(arg.name, { source: next === "var" ? "vars" : next, value });
    };
    line.append(source);

    if (mode === "var") {
      line.append(this.#varInput(row.value,
        (value) => write(arg.name, { source: "vars", value })));
    } else if (mode === "const") {
      line.append(this.#constInput(arg, row, write));
    } else if (mode) {
      const input = el("input");
      input.classList.add("sf-cel");
      input.value = row.value ?? "";
      input.placeholder = "CEL: vars.count + 1";
      this.#bindInput(input, () => write(arg.name, { source: row.source, value: input.value }));
      line.append(input);
    }
    wrap.append(line);
    return wrap;
  }

  /**
   * The outputs of a stage: a "save it" checkbox per declared result field plus
   * the name of the variable it goes into. The unchecked fields are visible —
   * so what the stage can hand over but is currently thrown away is visible too.
   */
  #specOutputs(field) {
    const { node, spec } = field;
    const declared = spec?.outputs ?? [];
    const rows = outputRows(node);
    const write = (src, row) => {
      const next = outputRows(node).filter((r) => r.cel || r.src !== src);
      if (row) next.push({ src, cel: false, ...row });
      writeOutputRows(node, next);
      this.#touch();
    };
    const writeAt = (index, patch) => {
      const next = outputRows(node);
      if (patch) next[index] = { ...next[index], ...patch };
      else next.splice(index, 1);
      writeOutputRows(node, next);
      this.#touch();
    };

    const box = el("div", "sf-args");
    for (const out of declared) {
      box.append(this.#outRow(out, rows.find((r) => !r.cel && r.src === out.name), write));
    }

    const extra = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.cel || !declared.some((o) => o.name === row.src));
    const computed = extra.filter(({ row }) => row.cel);
    const foreign = extra.filter(({ row }) => !row.cel);
    const known = declared.map((o) => o.name);

    if (computed.length) {
      box.append(el("div", "sf-args-note", "pipeline variables from expressions"));
      for (const { row, index } of computed) {
        box.append(this.#outExtraRow(row, index, writeAt, known));
      }
    }
    if (foreign.length) {
      if (declared.length) box.append(el("div", "sf-args-note", "the stage does not return this"));
      for (const { row, index } of foreign) {
        box.append(this.#outExtraRow(row, index, writeAt, known));
      }
    }

    if (!declared.length && !extra.length) {
      box.append(el("div", "sf-muted", spec
        ? "the stage declared no outputs"
        : "no stage selected, or its spec is not loaded"));
    }

    // What a stage result consists of is determined by its code, a field cannot
    // be invented — so when a stage has declared its outputs, the only lawful
    // addition offered is a pipeline variable computed by an expression (a key
    // with `.$`). If the stage says nothing about outputs (no docstring, or a
    // declared `*`), the contract is unknown — then the field is typed by hand.
    const contractKnown = known.length && !known.includes("*");
    const add = el("button", "sf-btn sf-btn-small",
      contractKnown ? "+ variable from an expression" : "+ result field");
    add.onclick = () => {
      const name = prompt(contractKnown
        ? "Pipeline variable name:"
        : "Stage result field:")?.trim();
      if (!name) return;
      if (contractKnown) writeAt(outputRows(node).length, { cel: true, src: "", dest: name });
      else write(name, { dest: name });
    };
    box.append(add);
    return box;
  }

  #outRow(out, row, write) {
    const wrap = el("div", "sf-arg" + (row ? "" : " sf-arg-off"));
    const head = el("div", "sf-arg-head");
    const toggle = el("label", "sf-arg-name");
    const check = el("input");
    check.type = "checkbox";
    check.checked = Boolean(row);
    check.onchange = () => write(out.name, check.checked ? { dest: out.name } : null);
    toggle.append(check, el("span", "", out.name));
    head.append(toggle);
    if (out.type) head.append(el("span", "sf-chip", out.type));
    if (!row) head.append(el("span", "sf-arg-opt", "not saved"));
    wrap.append(head);
    if (out.description) wrap.append(el("div", "sf-arg-hint", out.description));

    if (row) {
      const line = el("div", "sf-arg-line");
      line.append(el("span", "sf-rows-arrow", "→"),
        this.#varInput(row.dest, (dest) => write(out.name, { dest })));
      wrap.append(line);
    }
    return wrap;
  }

  /** An output that did not match a spec row: a CEL expression or a result
   * field.
   *
   * An expression is a lawful case, it is not obliged to be in the spec. But a
   * field the stage does not return is a guaranteed StageOutputError at run
   * time, so the row turns red and says plainly what is wrong; the same text
   * goes to the status bar as an error (see StageKind.validate). */
  #outExtraRow(row, index, writeAt, known = []) {
    const unknownField = !row.cel && known.length && !known.includes(row.src)
      && !known.includes("*");
    const wrap = el("div", "sf-arg" + (unknownField ? " sf-arg-missing" : ""));
    const head = el("div", "sf-arg-head");
    const src = el("input", "sf-arg-name-input" + (row.cel ? " sf-cel" : ""));
    src.value = row.src ?? "";
    src.placeholder = row.cel ? "CEL expression" : "result field";
    this.#bindInput(src, () => writeAt(index, { src: src.value.trim() }));
    head.append(src, el("span", "sf-chip", row.cel ? "expression" : "field"));
    const x = el("button", "sf-tag-x", "×");
    x.title = "remove the output";
    x.onclick = () => writeAt(index, null);
    head.append(x);
    wrap.append(head);

    if (unknownField) {
      wrap.append(el("div", "sf-arg-hint",
        `the stage does not return such a field — it gives: ${known.join(", ")}`));
    } else if (row.cel) {
      wrap.append(el("div", "sf-arg-hint", row.src
        ? "a pipeline variable: the value is computed by the expression, the stage has nothing to do with it"
        : "set an expression — for example `5`, `vars.n + 1` or `output.value`"));
    }

    const line = el("div", "sf-arg-line");
    line.append(el("span", "sf-rows-arrow", "→"),
      this.#varInput(row.dest, (dest) => writeAt(index, { dest })));
    wrap.append(line);
    return wrap;
  }

  /** A variable name: an input with a list of the names already in the graph —
   * the name is picked with the mouse, so a typo does not create a second
   * variable. */
  #varInput(value, onChange) {
    const input = el("input", "sf-var-input");
    input.value = value ?? "";
    input.placeholder = "variable name";
    if (value && this.env.secrets?.has(value)) {
      // marked but not revealed: it is visible that a key rather than an
      // ordinary variable is wired into the stage — and still not visible which
      input.classList.add("sf-var-secret");
      input.title = "a secret from the store: the value is substituted at start";
    }
    const list = el("datalist");
    list.id = `sf-vars-${Math.random().toString(36).slice(2, 8)}`;
    // secrets are the same variables to the graph, so they stand in the same
    // list: a key is wired into a stage BY NAME, and there is no point typing it
    // by hand (with a typo half the time)
    const secretNames = this.env.secrets?.names() ?? [];
    for (const name of [...new Set([...variablesOf(this.env.model.graph), ...secretNames])].sort()) {
      const opt = el("option");
      opt.value = name;
      if (secretNames.includes(name)) opt.label = `${name} — secret`;
      list.append(opt);
    }
    input.setAttribute("list", list.id);
    this.#bindInput(input, () => onChange(input.value.trim()));
    // a fragment, not a wrapper: the input must stay a direct flex child of the
    // row, or it stops stretching
    const frag = document.createDocumentFragment();
    frag.append(input, list);
    return frag;
  }

  /** Entering a literal argument value: a control by the type from the stage
   * spec (a checkbox for bool, a number field for numbers), otherwise text with
   * JSON parsing — so that a list and an object can be typed by hand too. */
  #constInput(arg, row, write) {
    const type = (arg.type ?? "any").toLowerCase();
    const set = (value) => write(arg.name, { source: "const", value });

    if (type === "bool" || type === "boolean") {
      const box = el("label", "sf-arg-bool");
      const check = el("input");
      check.type = "checkbox";
      check.checked = row.value === true || row.value === "true";
      check.onchange = () => set(String(check.checked));
      box.append(check, el("span", "", "yes / no"));
      return box;
    }

    const input = el("input");
    if (["number", "int", "float"].includes(type)) input.type = "number";
    input.value = row.value ?? "";
    input.placeholder = type === "list" ? '["a", "b"]'
      : type === "object" ? '{"k": 1}'
      : "value or JSON";
    this.#bindInput(input, () => set(input.value));
    return input;
  }

  /** The reference of the selected stage — data from the backend
   * (StagesLibrary). */
  #stageSpec(field) {
    const wrap = el("details", "sf-spec");
    wrap.append(el("summary", "sf-field-label", "stage spec"));
    const spec = this.env.stages.get(field.stage());
    if (!spec) {
      wrap.append(el("div", "sf-muted",
        this.env.stages.loaded ? "the stage is not in the registry" : "stage specs are not loaded"));
      return wrap;
    }
    if (spec.description) wrap.append(el("div", "sf-muted", spec.description));
    for (const section of ["arguments", "outputs"]) {
      const fields = spec[section] ?? [];
      if (!fields.length) continue;
      wrap.append(el("div", "sf-spec-title", section));
      for (const f of fields) {
        const row = el("div", "sf-spec-row");
        row.append(el("code", "", f.name));
        row.append(el("span", "sf-muted",
          ` ${f.type}${f.optional ? " (opt.)" : ""}${f.description ? " — " + f.description : ""}`));
        wrap.append(row);
      }
    }
    return wrap;
  }
}
