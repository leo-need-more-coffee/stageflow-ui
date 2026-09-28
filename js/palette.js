/**
 * The palette: node types plus the stages from the backend (by category, with
 * a search).
 *
 * A node gets from the palette into the graph in two ways, and both of them
 * CONNECT it:
 *
 *  - by dragging onto the canvas — a drop on an edge inserts the node into it,
 *    on a card attaches it to that card's free port, on empty space simply
 *    creates it there (the canvas hints at what will happen while the node is
 *    in hand);
 *  - by a click — the node stands after the selected one, continuing the chain.
 *
 * A click used to put a card in the centre of the screen unconnected, and it
 * still had to be wired up afterwards — that is, the palette created work
 * rather than a node.
 */
import { categoryColor } from "./colors.js";
import { paintIcon } from "./icons.js";
import { KINDS, StageKind } from "./kinds.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Palette {
  #filter = "";
  // the time of the last drop: a drop ends with an ordinary `click`, and
  // without this cutoff it would add a SECOND node. It cannot be done with a
  // flag — a drop's own `click` never arrives at all (the redraw throws the
  // button out of the DOM), the flag stays raised and eats the next real click
  #droppedAt = 0;

  /** @param env — plus addNode/dropHint/dropCreate from the editor */
  constructor(host, env) {
    this.host = host;
    this.env = env;
    host.classList.add("sf-palette");
  }

  render() {
    this.host.textContent = "";

    const search = el("input", "sf-search");
    search.type = "search";
    search.placeholder = "Search a stage...";
    search.value = this.#filter;
    search.oninput = () => {
      this.#filter = search.value.toLowerCase();
      this.#renderStages();
    };
    this.host.append(search);

    this.host.append(el("div", "sf-palette-title", "Nodes"));
    for (const kind of KINDS.values()) {
      if (kind === StageKind) continue; // stage is added by picking a stage
      const item = el("button", "sf-palette-item");
      item.style.setProperty("--kind-color", kind.color);
      item.append(paintIcon(el("span", "sf-icon"), kind.glyph), el("span", "", kind.title));
      // a type the backend cannot run stays on the list, dimmed: hiding it
      // would answer "why is there no map node" with silence, and the answer
      // is "your backend is older", which is worth saying
      const unsupported = this.env.capabilities?.supports(kind.type) === false;
      if (unsupported) item.classList.add("sf-palette-unsupported");
      item.title = unsupported
        ? this.env.capabilities.reason(kind.type)
        : kind.description({}, this.env) || kind.title;
      this.#wire(item, { type: kind.type }, kind.title, kind.glyph);
      this.host.append(item);
    }

    this.host.append(el("div", "sf-palette-title", "Stages"));
    this.stagesEl = el("div", "sf-palette-stages");
    this.host.append(this.stagesEl);
    this.#renderStages();
  }

  #renderStages() {
    this.stagesEl.textContent = "";
    if (!this.env.stages.loaded) {
      this.stagesEl.append(el("div", "sf-muted",
        "No stages loaded. Menu File -> Stage registry..."));
      return;
    }
    for (const [category, specs] of this.env.stages.byCategory()) {
      const matched = specs.filter((s) =>
        !this.#filter
        || s.stage_name.toLowerCase().includes(this.#filter)
        || (s.description ?? "").toLowerCase().includes(this.#filter));
      if (!matched.length) continue;

      this.stagesEl.append(el("div", "sf-palette-cat", category));
      for (const spec of matched) {
        const item = el("button", "sf-palette-item sf-palette-stage");
        item.style.setProperty("--kind-color",
          spec.color || categoryColor(spec.category) || StageKind.color);
        const monogram = StageKind.iconFallback({ stage: spec.stage_name });
        const iconOpts = { mono: spec.icon_mono, fallback: monogram,
          base: this.env.backend?.url };
        const icon = paintIcon(el("span", "sf-icon"), spec.icon || monogram, iconOpts);
        item.append(icon, el("span", "", spec.stage_name));
        if (spec.description) item.title = spec.description;
        this.#wire(item, { type: "stage", extra: { stage: spec.stage_name } },
          spec.stage_name, spec.icon || monogram, iconOpts);
        this.stagesEl.append(item);
      }
    }
  }

  /** A click adds the node after the selected one; a drag drops it on the canvas. */
  #wire(item, spec, label, icon, iconOpts = {}) {
    item.onclick = () => {
      if (performance.now() - this.#droppedAt < 200) return; // the tail of a drop
      this.env.addNode(spec.type, spec.extra ?? {});
    };
    // a picture inside a button is dragged by the browser as native
    // drag-and-drop — once that starts, pointerup never reaches us and the drop
    // "falls through"
    item.draggable = false;
    item.addEventListener("dragstart", (e) => e.preventDefault());

    item.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // there is nowhere to drop — then do not start the drag either, or the
      // ghost rides after the cursor, no node appears, and only the code knows
      if (!this.env.dropCreate) return;
      let ghost = null;
      const move = (ev) => {
        if (ghost && ev.buttons === 0) { abort(); return; }
        if (!ghost && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
        ghost ??= this.#ghost(label, icon, iconOpts);
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
        this.env.dropHint?.(ev.clientX, ev.clientY, spec);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", abort);
      };
      // the button was released outside the window, or the gesture was taken
      // over by the system: the ghost and the highlight must disappear, but no
      // node is created
      const abort = () => {
        stop();
        ghost?.remove();
        this.env.dropCreate(spec, -1, -1);
      };
      const up = (ev) => {
        stop();
        if (!ghost) return; // the threshold was not passed — an ordinary click
        ghost.remove();
        this.#droppedAt = performance.now();
        this.env.dropCreate(spec, ev.clientX, ev.clientY);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", abort);
    });
  }

  /** A ghost card under the cursor: you can see what exactly you are carrying. */
  #ghost(label, icon, iconOpts) {
    const ghost = el("div", "sf-ghost");
    ghost.append(paintIcon(el("span", "sf-icon"), icon, iconOpts), el("span", "", label));
    document.body.append(ghost);
    return ghost;
  }
}
