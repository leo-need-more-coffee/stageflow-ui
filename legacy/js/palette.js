/**
 * The palette: node types, and the backend's stages by category, with search.
 *
 * Adding from the palette always connects the node:
 *  - dragging onto the canvas: dropped on an edge, it is inserted into it; on
 *    a card, attached to its free port; on empty space, created there;
 *  - clicking: it is added after the selected node.
 */
import { categoryColor } from "./colors.js";
import { has, t } from "./i18n.js";
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
  // when the last drop happened: a drop is followed by a `click` that would add
  // a second node. A flag would not do, because after a redraw that click
  // never arrives and the flag would swallow the next real one
  #droppedAt = 0;

  /** @param env also addNode/dropHint/dropCreate from the editor */
  constructor(host, env) {
    this.host = host;
    this.env = env;
    host.classList.add("sf-palette");
  }

  render() {
    this.host.textContent = "";

    const search = el("input", "sf-search");
    search.type = "search";
    search.placeholder = t("palette.search");
    search.value = this.#filter;
    search.oninput = () => {
      this.#filter = search.value.toLowerCase();
      this.#renderStages();
    };
    this.host.append(search);

    this.host.append(el("div", "sf-palette-title", t("palette.nodes")));
    for (const kind of KINDS.values()) {
      if (kind === StageKind) continue; // stage is added by picking a stage
      const item = el("button", "sf-palette-item");
      item.style.setProperty("--kind-color", kind.color);
      item.append(paintIcon(el("span", "sf-icon"), kind.glyph), el("span", "", kind.title));
      // a type the backend cannot run is shown dimmed rather than hidden, so
      // its absence is explained
      const unsupported = this.env.capabilities?.supports(kind.type) === false;
      if (unsupported) item.classList.add("sf-palette-unsupported");
      item.title = unsupported
        ? this.env.capabilities.reason(kind.type)
        : kind.description({}, this.env) || kind.title;
      this.#wire(item, { type: kind.type }, kind.title, kind.glyph);
      this.host.append(item);
    }

    this.host.append(el("div", "sf-palette-title", t("palette.stages")));
    this.stagesEl = el("div", "sf-palette-stages");
    this.host.append(this.stagesEl);
    this.#renderStages();
  }

  #renderStages() {
    this.stagesEl.textContent = "";
    if (!this.env.stages.loaded) {
      this.stagesEl.append(el("div", "sf-muted", t("palette.noStages")));
      return;
    }
    for (const [category, specs] of this.env.stages.byCategory()) {
      const matched = specs.filter((s) =>
        !this.#filter
        || s.stage_name.toLowerCase().includes(this.#filter)
        || (s.description ?? "").toLowerCase().includes(this.#filter));
      if (!matched.length) continue;

      // a category is the backend's id. Built-in ones have a translation;
      // others are shown as written. Checked with `has` first, since `t` warns
      // about a missing key and custom categories are normal
      const named = has(`category.${category}`);
      this.stagesEl.append(el("div", "sf-palette-cat",
        named ? t(`category.${category}`) : category));
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
    // stop the browser's native drag of the image, which would swallow pointerup
    item.draggable = false;
    item.addEventListener("dragstart", (e) => e.preventDefault());

    item.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // nothing to drop onto, so do not start a drag
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
      // released outside the window or the gesture was taken over: remove the
      // ghost and the highlight, create nothing
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

  /** A ghost card under the cursor, showing what is being dragged. */
  #ghost(label, icon, iconOpts) {
    const ghost = el("div", "sf-ghost");
    ghost.append(paintIcon(el("span", "sf-icon"), icon, iconOpts), el("span", "", label));
    document.body.append(ghost);
    return ghost;
  }
}
