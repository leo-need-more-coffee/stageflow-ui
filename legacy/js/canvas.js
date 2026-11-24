/**
 * The editor canvas: drawing the graph and handling the mouse.
 *
 * The two kinds of connectors run on different axes:
 *
 *  - order (diamonds, vertical): execution order. The inlet is at the top
 *    middle, the outlets along the bottom (next/then/else/cases/branches/
 *    catch). These are the JSON's edges, drawn as vertical béziers, so a
 *    pipeline reads top to bottom.
 *  - data (circles, horizontal): variables. Inputs on the left
 *    ("arg ← variable"), outputs on the right ("field → variable"). These
 *    edges are derived (dataflow.js) and drawn in the variable's color.
 *
 * In the default "focus" mode only the data wires of the hovered card are
 * shown, and hovering a row highlights that variable's path. All edges are in
 * the SVG and toggled by CSS, so highlighting needs no redraw.
 *
 * Geometry is computed, not measured, and matches editor.css.
 *
 * A graph is built on the canvas: a wire dropped on empty space offers what to
 * create and connects it; a click on a port holds the wire until the next
 * click; hovering an edge shows ⊕ to insert a node; a double click on the
 * background creates one. While a wire is held, valid targets are highlighted.
 */
import { categoryColor, varColor } from "./colors.js";
import { dataLinks } from "./dataflow.js";
import { NODE_MIN_W, nodeLayout, orderEdgePath } from "./geometry.js";
import { t } from "./i18n.js";
import { paintIcon } from "./icons.js";
import { KINDS, StageKind, kindOf } from "./kinds.js";
import { openMenu } from "./menu.js";
import { computeRegions, regionBounds, skippedArea } from "./regions.js";

/** How long a new or changed card stays marked. */
const MARKS_MS = 6000;
import { canContinue, freePortIndex } from "./wiring.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The view transform: pan and zoom plus screen <-> world conversions. */
export class Viewport {
  x = 40;
  y = 40;
  scale = 1;

  apply(target, gridHost) {
    target.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    if (gridHost) {
      const step = 24 * this.scale;
      gridHost.style.backgroundSize = `${step}px ${step}px`;
      gridHost.style.backgroundPosition = `${this.x}px ${this.y}px`;
    }
  }

  toWorld(clientX, clientY, hostRect) {
    return {
      x: (clientX - hostRect.left - this.x) / this.scale,
      y: (clientY - hostRect.top - this.y) / this.scale,
    };
  }

  zoomAt(clientX, clientY, hostRect, factor) {
    const before = this.toWorld(clientX, clientY, hostRect);
    this.scale = Math.min(2.5, Math.max(0.25, this.scale * factor));
    this.x = clientX - hostRect.left - before.x * this.scale;
    this.y = clientY - hostRect.top - before.y * this.scale;
  }
}

/** The color of an order port dot, by port key: next is green, then amber,
 * else/default soft, except red; block bodies and parallel branches take
 * their region's color. Edges and labels use the same colors. */
function portColor(port, kindColor) {
  if (port.add) return "var(--ink-faint)";
  if (port.key === "next") return "var(--ok)";
  if (port.key === "then") return "var(--warn)";
  if (port.key === "else" || port.key === "default") return "var(--ink-soft)";
  if (port.key === "except") return "var(--danger)";
  if (port.key === "on_timeout") return "var(--ink-soft)";
  return kindColor;
}

/** A data port label; the arrow is drawn separately so the row reads as
 * "came in" / "went out". */
function rowLabel(text) {
  const node = el("span", "sf-rlabel");
  for (const part of String(text).split(/([←→⇢])/)) {
    if (!part) continue;
    node.append(/[←→⇢]/.test(part) ? el("span", "sf-arrow-glyph", part) : part);
  }
  return node;
}

export class CanvasView {
  #hover = { node: null, key: null }; // what is under the cursor: a card and a variable row
  #cursor = null;  // the last cursor position over the canvas (for pasting)
  #armed = null;   // a port taken "on wire" by a click: waits for a click on a target
  #hotEdge = null; // the edge under the cursor, highlighted as a drop target
  #flash = null;   // the timer of a short hint
  #menu = null;

  /** @param env {{model, stages, selection, getIssues,
   *   showData: () => bool, dataMode: () => "off"|"focus"|"all"}} */
  constructor(host, env) {
    this.host = host;
    this.env = env;
    this.view = new Viewport();

    host.classList.add("sf-canvas");
    this.viewportEl = el("div", "sf-viewport");
    this.regionsEl = el("div", "sf-regions"); // the backing layer under edges and nodes
    this.svg = svgEl("svg", { class: "sf-edges" });
    this.nodesEl = el("div", "sf-nodes");
    // the overlay is separate from `svg`, so a held wire survives redraws
    this.overlay = svgEl("svg", { class: "sf-edges sf-overlay" });
    this.toolsEl = el("div", "sf-tools");
    // buttons on the hovered edge: insert a node, or cut the link
    this.edgeToolsEl = el("div", "sf-edge-tools");
    this.edgeToolsEl.hidden = true;
    const plus = el("button", "sf-edge-btn sf-edge-plus", "+");
    plus.title = t("canvas.insertNode");
    plus.onclick = (e) => this.#onEdgeButton(e, "insert");
    const cut = el("button", "sf-edge-btn sf-edge-cut", "×");
    cut.title = t("canvas.cutEdge");
    cut.onclick = (e) => this.#onEdgeButton(e, "cut");
    this.edgeToolsEl.append(plus, cut);
    this.toolsEl.append(this.edgeToolsEl);
    this.viewportEl.append(this.regionsEl, this.svg, this.nodesEl, this.overlay, this.toolsEl);
    this.hintEl = el("div", "sf-hint");
    this.hintEl.hidden = true;
    host.append(this.viewportEl, this.hintEl);

    host.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false });
    host.addEventListener("pointerdown", (e) => this.#onPointerDown(e));
    host.addEventListener("dblclick", (e) => this.#onDoubleClick(e));
    // the right button draws the selection marquee and the middle one pans, so
    // the context menu and autoscroll are suppressed
    host.addEventListener("contextmenu", (e) => e.preventDefault());
    host.addEventListener("auxclick", (e) => e.preventDefault());
    host.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    // Esc drops a held wire without clearing the selection; caught before the
    // editor sees it
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.#armed) return;
      this.#disarm();
      e.stopPropagation();
    }, true);

    // hovering a card shows its data wires; hovering a variable row highlights
    // its path. pointermove on the canvas, since cards are replaced on redraw
    // and their pointerout would be lost
    host.addEventListener("pointermove", (e) => {
      this.#cursor = { x: e.clientX, y: e.clientY };
      this.#onHover(e.target);
    });
    host.addEventListener("pointerleave", () => {
      this.#cursor = null;
      this.#onHover(null);
    });
  }

  /** Where to paste: under the cursor if it is over the canvas, else null (the
   * copies are offset from the originals). */
  pasteAnchor() {
    if (!this.#cursor) return null;
    return this.view.toWorld(this.#cursor.x, this.#cursor.y, this.host.getBoundingClientRect());
  }

  /** A short message at the bottom of the canvas ("copied", "pasted"). */
  flashHint(text, ms = 1600) {
    this.#hint(text);
    clearTimeout(this.#flash);
    this.#flash = setTimeout(() => {
      if (!this.host.classList.contains("sf-connecting")) this.#hint(null);
    }, ms);
  }

  centerWorld() {
    const rect = this.host.getBoundingClientRect();
    return this.view.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2, rect);
  }

  /** Fit the graph to the view. The scale does not go below `MIN_FIT_SCALE`:
   * a large graph is better shown partly and readable. */
  fitView(padding = 56) {
    const nodes = this.env.model.graph.nodes;
    const rect = this.host.getBoundingClientRect();
    if (!nodes.length || !rect.width) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      const layout = this.#layout(node);
      const { x, y } = node.metadata.ui;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + layout.width);
      maxY = Math.max(maxY, y + layout.height);
    }
    const MIN_FIT_SCALE = 0.62;
    const exact = Math.min(
      1.1,
      (rect.width - padding * 2) / (maxX - minX),
      (rect.height - padding * 2) / (maxY - minY),
    );
    const fits = exact >= MIN_FIT_SCALE;
    const scale = Math.max(MIN_FIT_SCALE, exact);
    this.view.scale = scale;

    if (fits) {
      this.view.x = (rect.width - (maxX - minX) * scale) / 2 - minX * scale;
      this.view.y = (rect.height - (maxY - minY) * scale) / 2 - minY * scale;
    } else {
      // too big to fit: show the start of the graph
      this.view.x = padding - minX * scale;
      this.view.y = padding - minY * scale;
    }
    this.render();
    this.env.onView?.();
  }

  // ------------------------------------------------------------ geometry

  #layout(node) {
    return nodeLayout(node, this.env.showData(), this.env);
  }

  #marksTimer = null;

  /**
   * Show a replaced graph as a change rather than a jump. After the render,
   * each moved card is put back at its old position with a transform and
   * released on the next frame, so it slides to its new place. New and
   * changed cards are marked for a few seconds, answering "what did it touch".
   */
  showChange(change, { hold = false } = {}) {
    if (!change || (!change.moved?.size && !change.touched)) return;
    clearTimeout(this.#marksTimer);

    for (const [id, { dx, dy }] of change.moved ?? []) {
      const card = this.#nodeElById(id);
      if (!card || (!dx && !dy)) continue;
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      card.classList.add("sf-node-gliding");
    }
    for (const id of change.added ?? []) this.#nodeElById(id)?.classList.add("sf-node-new");
    for (const id of change.changed ?? []) this.#nodeElById(id)?.classList.add("sf-node-edited");

      // released on the next frame; set and cleared in one frame, nothing would
      // move
    requestAnimationFrame(() => {
      for (const id of (change.moved ?? new Map()).keys()) {
        const card = this.#nodeElById(id);
        if (card) card.style.transform = "";
      }
    });

    // with `hold` the marks stay until the change is kept or reverted
    if (!hold) this.#marksTimer = setTimeout(() => this.clearMarks(), MARKS_MS);
  }

  clearMarks() {
    for (const card of this.nodesEl.querySelectorAll(
      ".sf-node-new, .sf-node-edited, .sf-node-gliding")) {
      card.classList.remove("sf-node-new", "sf-node-edited", "sf-node-gliding");
      card.style.transform = "";
    }
  }

  /** A local attachment point in world coordinates. */
  #point(node, { dx, dy }) {
    return { x: node.metadata.ui.x + dx, y: node.metadata.ui.y + dy };
  }

  /** A horizontal bézier, for data edges. */
  #hPath(a, b) {
    const dx = Math.max(48, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  // -------------------------------------------------------------- render

  render() {
    this.view.apply(this.viewportEl, this.host);
    this.nodesEl.textContent = "";
    this.regionsEl.textContent = "";
    this.svg.textContent = "";
    this.#hideEdgePlus(); // the edges are rebuilt — a former button would hang in the void

    const graph = this.env.model.graph;
    const selection = this.env.selection.current;
    const badNodes = new Set(
      this.env.getIssues()
        .filter((i) => i.graph === this.env.model.graphKey && i.node)
        .map((i) => i.node),
    );

    // an empty canvas says where to start
    this.hostEmpty ??= el("div", "sf-empty");
    this.hostEmpty.textContent = "";
    if (!graph.nodes.length) {
      this.hostEmpty.append(
        el("div", "sf-empty-title", t("canvas.empty")),
        el("div", "", t("canvas.empty.1")),
        el("div", "", t("canvas.empty.2")),
      );
      this.host.append(this.hostEmpty);
    } else {
      this.hostEmpty.remove();
    }

    // a run's trace: visited nodes lit more faintly than the current one
    this.visitedNodes = new Set(this.env.runner?.visited ?? []);

    const layouts = new Map(graph.nodes.map((n) => [n.id, this.#layout(n)]));
    this.#renderRegions(graph, layouts);
    for (const node of graph.nodes) {
      this.nodesEl.append(this.#nodeEl(node, graph, layouts.get(node.id), badNodes));
    }
    this.host.classList.toggle("sf-data-focus", this.env.dataMode() === "focus");
    if (this.env.showData()) this.#renderDataEdges(graph, layouts);
    this.#renderOrderEdges(graph, layouts, selection);
    if (this.#armed) this.#markSource(this.#armed.fromId); // the cards were recreated
  }

  /** Regions around parallel branches, try bodies and handlers: membership from
   * the graph (regions.js), bounds from the nodes' positions. */
  #renderRegions(graph, layouts) {
    this.regions = computeRegions(graph, this.env);
    for (const region of this.regions) {
      const box = regionBounds(region, graph, (n) => layouts.get(n.id));
      if (!box) continue;
      region.box = box;

      const frame = el("div", "sf-region");
      frame.dataset.region = region.key;
      frame.dataset.owner = region.ownerId;
      frame.style.left = `${box.x}px`;
      frame.style.top = `${box.y}px`;
      frame.style.width = `${box.width}px`;
      frame.style.height = `${box.height}px`;
      frame.style.setProperty("--region-color", region.color);
      if (this.env.selection.has(region.ownerId)) frame.classList.add("sf-region-active");

      const label = el("div", "sf-region-label");
      label.dataset.region = region.key;
      label.dataset.owner = region.ownerId;
      label.append(el("span", "sf-region-glyph", region.glyph ?? "◆"), el("span", "", region.title));
      label.title = t("canvas.region", { node: region.ownerId });
      frame.append(label);
      this.regionsEl.append(frame);
    }
  }

  #nodeEl(node, graph, layout, badNodes) {
    const kind = kindOf(node);
    const root = el("div", "sf-node");
    root.dataset.id = node.id;
    root.dataset.kind = node.type;
    root.style.left = `${node.metadata.ui.x}px`;
    root.style.top = `${node.metadata.ui.y}px`;
    root.style.width = `${layout.width}px`;
    root.style.setProperty("--kind-color", kind.accent(node, this.env));
    if (this.env.selection.has(node.id)) root.classList.add("sf-selected");
    if (badNodes.has(node.id)) root.classList.add("sf-invalid");
    // the run: the current node and the ones already visited
    const run = this.env.runner;
    if (run?.active && run.node === node.id) {
      root.classList.add(run.waiting ? "sf-run-paused" : "sf-run-active");
    } else if (this.visitedNodes?.has(node.id)) {
      root.classList.add("sf-run-done");
    }

    // the order inlet: a diamond at the top middle
    root.append(el("span", "sf-conn sf-conn-order sf-conn-top"));

    const head = el("div", "sf-head");
    const icon = paintIcon(el("span", "sf-icon"), kind.icon(node, this.env), {
      mono: kind.iconMono(node, this.env),
      fallback: kind.iconFallback(node, this.env),
      base: this.env.backend?.url,
    });
    icon.title = kind.title;
    head.append(icon, el("span", "sf-node-id", node.id));

    const badges = el("span", "sf-badges");
    for (const badge of kind.badges(node)) {
      const mark = el("span", "sf-badge", badge.glyph);
      mark.title = badge.title;
      badges.append(mark);
    }
    head.append(badges);
    if (graph.entry === node.id) head.append(el("span", "sf-entry-badge", "entry"));
    root.append(head);

    root.append(el("div", "sf-sub", kind.subtitle(node, this.env)));
    if (layout.hasDescription) {
      root.append(el("div", "sf-desc", kind.description(node, this.env)));
    }

    layout.ins.forEach((port) => {
      const row = el("div", "sf-row sf-row-datain");
      const dot = el("span", "sf-conn sf-conn-data sf-conn-left");
      const ref = port.refs[0];
      if (ref) {
        dot.style.setProperty("--var-color", varColor(ref.name));
        row.dataset.var = ref.name;
      }
      row.append(dot, rowLabel(port.label));
      root.append(row);
    });

    // value settings ("argument = value"); no connector, since the value comes
    // from the pipeline, not another node
    layout.values.forEach((row) => {
      const line = el("div", "sf-row sf-row-value");
      line.title = `${row.name} = ${row.text}`;
      line.append(
        el("span", "sf-row-name", row.name),
        el("span", "sf-row-eq", "="),
        el("span", "sf-row-lit", row.text),
      );
      root.append(line);
    });

    layout.outs.forEach((port, index) => {
      const row = el("div", "sf-row sf-row-dataout");
      row.dataset.dataout = index;
      row.dataset.var = port.variable.name;
      const dot = el("span", "sf-conn sf-conn-data sf-conn-right sf-conn-drag");
      dot.style.setProperty("--var-color", varColor(port.variable.name));
      row.append(rowLabel(port.label), dot);
      root.append(row);
    });

    // the order outlets along the bottom
    if (layout.orders.length) {
      const bar = el("div", "sf-orderbar");
      layout.orders.forEach((port, index) => {
        // free ports are marked, since a wire is pulled from them to continue
        const free = !port.add && !port.get?.();
        const slot = el("div", "sf-oport" + (port.add ? " sf-oport-add" : "")
          + (free ? " sf-oport-free" : ""));
        slot.dataset.order = index;
        slot.style.setProperty("--port-color", portColor(port, kind.accent(node, this.env)));
        slot.title = port.label;
        slot.append(
          el("span", "sf-olabel", port.label),
          el("span", "sf-conn sf-conn-order sf-conn-bottom sf-conn-drag"
            + (port.dashed ? " sf-conn-dashed" : "")),
        );
        bar.append(slot);
      });
      root.append(bar);
    }
    return root;
  }

  #renderOrderEdges(graph, layouts, selection) {
    for (const node of graph.nodes) {
      const layout = layouts.get(node.id);
      layout.orders.forEach((port, index) => {
        const targetId = port.get?.();
        const target = targetId && graph.nodes.find((n) => n.id === targetId);
        if (!target) return;

        const from = this.#point(node, layout.orderOut(index));
        const to = this.#point(target, layouts.get(target.id).orderIn);
        const d = orderEdgePath(from, to,
          skippedArea(this.regions, node.id, targetId, from, to));

        const path = svgEl("path", {
          class: "sf-edge sf-edge-order" + (port.dashed ? " sf-dashed" : ""),
          d,
          "marker-end": "url(#sf-arrow)",
        });
        const hit = svgEl("path", { class: "sf-edge-hit", d });
        hit.dataset.from = node.id;
        hit.dataset.port = index;
        hit.__path = path; // highlight the edge under the cursor without hunting for it
        if (selection?.type === "edge"
            && selection.from === node.id && selection.portIndex === index) {
          path.classList.add("sf-selected");
        }
        this.svg.append(path, hit);
      });
    }
    this.svg.append(this.#arrowDefs());
  }

  #arrowDefs() {
    const defs = svgEl("defs");
    const marker = svgEl("marker", {
      id: "sf-arrow", viewBox: "0 0 8 8", refX: "6.5", refY: "4",
      markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse",
    });
    marker.append(svgEl("path", { d: "M 0 1 L 7 4 L 0 7 z", class: "sf-arrow-head" }));
    defs.append(marker);
    return defs;
  }

  /**
   * Data edges from dataflow.js. In "focus" mode only the hovered card's edges
   * are shown (`sf-focus`, set in `#applyHover`); the rest are hidden by CSS
   * until a variable is hovered.
   */
  #renderDataEdges(graph, layouts) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    for (const link of dataLinks(graph)) {
      const writer = byId.get(link.writerId);
      const reader = byId.get(link.readerId);
      if (!writer || !reader) continue;

      const a = this.#point(writer, layouts.get(writer.id).dataOut(link.outIndex));
      const b = this.#point(reader, layouts.get(reader.id).dataIn(link.inIndex));
      const path = svgEl("path", {
        class: "sf-edge sf-edge-data" + (link.ordered ? "" : " sf-dashed"),
        d: this.#hPath(a, b),
      });
      path.dataset.var = link.name;
      path.dataset.writer = link.writerId;
      path.dataset.reader = link.readerId;
      path.style.stroke = varColor(link.name);
      const title = svgEl("title");
      title.textContent = `${link.name}: ${link.writerId} → ${link.readerId}`
        + (link.ordered ? "" : ` ${t("canvas.orderUndefined")}`);
      path.append(title);
      this.svg.append(path);
    }
    this.#applyHover(); // the cursor may have stayed on a card
  }

  /** Highlight a variable's path from outside the canvas (the panel's variable
   * index). `null` clears it; the next hover on the canvas overrides it. */
  highlightVariable(name) {
    if (this.#hover.key === (name ?? null)) return;
    this.#hover = { ...this.#hover, key: name ?? null };
    this.#applyHover();
  }

  /** Track what is hovered and repaint the data layer when it changes. */
  #onHover(target) {
    // ⊕ on the hovered edge, kept while the cursor is on the edge or the button
    const hit = target?.closest?.(".sf-edge-hit");
    // hide the edge buttons while a wire or palette node is held
    if (this.#armed || this.host.classList.contains("sf-connecting")) this.#hideEdgePlus();
    else if (hit) this.#showEdgePlus(hit);
    else if (!target?.closest?.(".sf-edge-tools")) this.#hideEdgePlus();

    const node = target?.closest?.(".sf-node")?.dataset.id ?? null;
    const key = target?.closest?.(".sf-row[data-var]")?.dataset.var ?? null;
    if (node === this.#hover.node && key === this.#hover.key) return;
    this.#hover = { node, key };
    this.#applyHover();
  }

  /** Show the hovered card's wires (`sf-focus`) and the hovered variable's path
   * (`sf-hl-on`); CSS dims the rest. */
  #applyHover() {
    const { node, key } = this.#hover;
    this.host.classList.toggle("sf-hl", Boolean(key));
    for (const path of this.svg.querySelectorAll(".sf-edge-data")) {
      path.classList.toggle("sf-hl-on", Boolean(key) && path.dataset.var === key);
      path.classList.toggle("sf-focus", Boolean(node)
        && (path.dataset.writer === node || path.dataset.reader === node));
    }
    for (const row of this.nodesEl.querySelectorAll(".sf-row[data-var]")) {
      row.classList.toggle("sf-hl-on", Boolean(key) && row.dataset.var === key);
    }
  }

  // ---------------------------------------------------------- interaction

  #onWheel(e) {
    // wheel events inside the menu scroll the menu, not zoom the graph
    if (e.target.closest?.(".sf-menu")) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.view.zoomAt(e.clientX, e.clientY, this.host.getBoundingClientRect(), factor);
    this.view.apply(this.viewportEl, this.host);
    this.env.onView?.(); // the view is part of the session, it is saved too
  }

  #onPointerDown(e) {
    // the menu and overlay buttons handle their own clicks
    if (e.target.closest?.(".sf-menu") || e.target.closest?.(".sf-tools")) return;

    // middle button pans and right button draws the marquee, wherever they start
    if (e.button === 1) { this.#closeMenu(); this.#startPan(e); return; }
    if (e.button === 2) { this.#closeMenu(); this.#startMarquee(e); return; }
    if (e.button !== 0) return;

    // a wire is held: a click on a node connects, on empty space offers to
    // create a node
    if (this.#armed) {
      const armed = this.#armed;
      const targetId = this.#nodeAt(e);
      this.#disarm();
      if (targetId) {
        if (targetId !== armed.fromId) this.env.model.connect(armed.fromId, armed.portIndex, targetId);
        else this.flashHint(t("canvas.noSelfLink"));
      } else {
        this.#offerCreate(e, armed.fromId, armed.portIndex);
      }
      return;
    }

    this.#closeMenu();
    const nodeEl = e.target.closest?.(".sf-node");
    const edgeHit = e.target.closest?.(".sf-edge-hit");
    const isDrag = e.target.classList?.contains("sf-conn-drag");
    const orderSlot = e.target.closest?.(".sf-oport");
    const dataRow = e.target.closest?.(".sf-row-dataout");
    const regionLabel = e.target.closest?.(".sf-region-label");

    if (regionLabel) {
      this.env.selection.set({ type: "node", id: regionLabel.dataset.owner });
      this.#startRegionDrag(e, regionLabel.dataset.region);
    } else if (nodeEl && orderSlot) {
      // the whole port slot starts a wire, not just the small diamond
      this.#startOrderDrag(e, nodeEl.dataset.id, Number(orderSlot.dataset.order));
    } else if (nodeEl && isDrag && dataRow) {
      this.#startDataDrag(e, nodeEl.dataset.id, Number(dataRow.dataset.dataout));
    } else if (nodeEl) {
      const id = nodeEl.dataset.id;
      // clicking a node in a group keeps the group so it can be dragged; it
      // narrows to that node on release if nothing moved
      if (e.shiftKey) this.env.selection.toggle(id);
      else if (!this.env.selection.has(id)) this.env.selection.set({ type: "node", id });
      this.#startNodeDrag(e, id);
    } else if (edgeHit) {
      this.env.selection.set({
        type: "edge",
        from: edgeHit.dataset.from,
        portIndex: Number(edgeHit.dataset.port),
      });
    } else {
      this.#startPan(e);
    }
  }

  /** A double click creates a node: in place on the background, in the
   * middle of an edge. */
  #onDoubleClick(e) {
    if (e.target.closest?.(".sf-node") || e.target.closest?.(".sf-menu")
      || e.target.closest?.(".sf-tools")) return;
    const edge = this.#edgeAt(e);
    if (edge) { this.#offerInsert(e, edge.fromId, edge.portIndex); return; }
    this.#createMenu(e, {
      title: t("canvas.create"),
      pick: (spec) => this.#select(this.env.model.createAt(spec, this.#dropPos(e))),
    });
  }

  /** A drag that always cleans up: `pointercancel` (the system took the
   * gesture, the window lost focus) removes the temporary graphics. */
  #drag(e, { move, up, cancel }) {
    const finish = (handler) => (ev) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      handler?.(ev);
    };
    const onMove = (ev) => move(ev);
    const onUp = finish(up);
    const onCancel = finish(cancel ?? up);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    e.preventDefault();
  }

  #startPan(e) {
    const start = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
    let moved = false;
    this.#drag(e, {
      move: (ev) => {
        moved = true;
        this.view.x = start.vx + ev.clientX - start.x;
        this.view.y = start.vy + ev.clientY - start.y;
        this.view.apply(this.viewportEl, this.host);
      },
      up: () => {
        if (moved) this.env.onView?.();
        else this.env.selection.clear();
      },
    });
  }

  /** Drag a card, or the whole group if it is part of one. */
  #startNodeDrag(e, id) {
    const selection = this.env.selection;
    const group = selection.has(id) && selection.nodes.size > 1
      ? this.env.model.graph.nodes.filter((n) => selection.has(n.id))
      : [this.env.model.node(id)].filter(Boolean);
    if (!group.length) return;

    const start = { x: e.clientX, y: e.clientY };
    const origin = group.map((node) => ({ node, ...node.metadata.ui }));
    let moved = false;

    this.#drag(e, {
      move: (ev) => {
        moved = true;
        const dx = (ev.clientX - start.x) / this.view.scale;
        const dy = (ev.clientY - start.y) / this.view.scale;
        for (const item of origin) {
          item.node.metadata.ui = { x: Math.round(item.x + dx), y: Math.round(item.y + dy) };
        }
        this.render();
      },
      up: () => {
        if (moved) this.env.model.touch();
        // nothing moved: a click on a grouped node selects just that node
        else if (group.length > 1 && !e.shiftKey) selection.set({ type: "node", id });
      },
    });
  }

  /**
   * The selection marquee (right button): everything it touches is selected,
   * to be moved or deleted together. Shift adds to the selection.
   */
  #startMarquee(e) {
    const box = el("div", "sf-marquee");
    this.host.append(box);
    const keep = e.shiftKey ? [...this.env.selection.nodes] : [];
    // clear the old selection when the gesture starts, so only the new one is
    // highlighted while dragging
    if (!e.shiftKey && this.env.selection.nodes.size) this.env.selection.clear();
    let moved = false;

    const place = (ev) => {
      const rect = this.host.getBoundingClientRect();
      const area = {
        x: Math.min(e.clientX, ev.clientX), y: Math.min(e.clientY, ev.clientY),
        w: Math.abs(ev.clientX - e.clientX), h: Math.abs(ev.clientY - e.clientY),
      };
      box.style.left = `${area.x - rect.left}px`;
      box.style.top = `${area.y - rect.top}px`;
      box.style.width = `${area.w}px`;
      box.style.height = `${area.h}px`;
      return area;
    };
    const done = () => {
      box.remove();
      for (const card of this.nodesEl.children) card.classList.remove("sf-marked");
    };

    this.#drag(e, {
      move: (ev) => {
        moved = true;
        const inside = new Set(this.#nodesIn(place(ev)));
        for (const card of this.nodesEl.children) {
          card.classList.toggle("sf-marked", inside.has(card.dataset.id));
        }
      },
      cancel: done,
      up: (ev) => {
        const area = moved ? place(ev) : null;
        done();
        if (!area) { this.env.selection.clear(); return; } // a right click on empty space
        this.env.selection.setNodes([...new Set([...keep, ...this.#nodesIn(area)])]);
      },
    });
  }

  /** The nodes touched by a screen rectangle. */
  #nodesIn({ x, y, w, h }) {
    const rect = this.host.getBoundingClientRect();
    const from = this.view.toWorld(x, y, rect);
    const to = this.view.toWorld(x + w, y + h, rect);
    return this.env.model.graph.nodes.filter((node) => {
      const { width, height } = this.#layout(node);
      const ui = node.metadata.ui;
      return ui.x < to.x && ui.x + width > from.x && ui.y < to.y && ui.y + height > from.y;
    }).map((node) => node.id);
  }

  /** Dragging a region by its label moves all its nodes. */
  #startRegionDrag(e, regionKey) {
    const region = this.regions?.find((r) => r.key === regionKey);
    if (!region) return;
    const members = this.env.model.graph.nodes.filter((n) => region.members.has(n.id));
    const start = { x: e.clientX, y: e.clientY };
    const origin = members.map((node) => ({ node, ...node.metadata.ui }));
    let moved = false;

    this.#drag(e, {
      move: (ev) => {
        moved = true;
        const dx = (ev.clientX - start.x) / this.view.scale;
        const dy = (ev.clientY - start.y) / this.view.scale;
        for (const item of origin) {
          item.node.metadata.ui = {
            x: Math.round(item.x + dx),
            y: Math.round(item.y + dy),
          };
        }
        this.render();
      },
      up: () => { if (moved) this.env.model.touch(); },
    });
  }

  #tempEdge(from, vertical, extraClass = "") {
    const temp = svgEl("path", { class: `sf-edge sf-edge-temp ${extraClass}` });
    this.overlay.append(temp);
    return {
      update: (ev) => {
        const rect = this.host.getBoundingClientRect();
        const to = this.view.toWorld(ev.clientX, ev.clientY, rect);
        temp.setAttribute("d", vertical ? orderEdgePath(from, to) : this.#hPath(from, to));
      },
      remove: () => temp.remove(),
    };
  }

  // ------------------------------------------------ targets under the cursor

  /** The node under the pointer (elementsFromPoint, since a temporary edge or
   * a region label may be on top). */
  #nodeAt(ev) {
    return document.elementsFromPoint(ev.clientX, ev.clientY)
      .map((x) => x.closest?.(".sf-node"))
      .find(Boolean)?.dataset.id ?? null;
  }

  /** The order edge under the pointer. */
  #edgeAt(ev) {
    const hit = document.elementsFromPoint(ev.clientX, ev.clientY)
      .find((x) => x.classList?.contains("sf-edge-hit"));
    return hit
      ? { fromId: hit.dataset.from, portIndex: Number(hit.dataset.port), hit }
      : null;
  }

  /** World coordinates for a drop, centring the card under the cursor. */
  #dropPos(ev) {
    const point = this.view.toWorld(ev.clientX, ev.clientY, this.host.getBoundingClientRect());
    return { x: point.x - NODE_MIN_W / 2, y: point.y };
  }

  #nodeElById(id) {
    return this.nodesEl.querySelector(`.sf-node[data-id="${CSS.escape(id)}"]`);
  }

  #select(node) {
    if (node) this.env.selection.set({ type: "node", id: node.id });
    return node;
  }

  // ---------------------------------------------- hints while connecting

  /** Wire-in-hand mode: show what to do next and highlight the source. */
  #beginConnecting(fromId, hint) {
    this.host.classList.add("sf-connecting");
    this.#markSource(fromId);
    this.#hint(hint);
  }

  #endConnecting() {
    this.host.classList.remove("sf-connecting");
    for (const node of this.nodesEl.querySelectorAll(".sf-conn-source, .sf-drop-hot")) {
      node.classList.remove("sf-conn-source", "sf-drop-hot");
    }
    this.#markEdgeHot(null);
    this.#hint(null);
  }

  #markSource(id) {
    this.#nodeElById(id)?.classList.add("sf-conn-source");
  }

  #hint(text) {
    this.hintEl.textContent = text ?? "";
    this.hintEl.hidden = !text;
  }

  /**
   * Highlight where a drop would land. The source card is not a target: a port
   * pointing at its own node is a loop with no way out.
   */
  #hotTarget(ev, withEdges = false, exclude = null) {
    for (const node of this.nodesEl.querySelectorAll(".sf-drop-hot")) {
      node.classList.remove("sf-drop-hot");
    }
    const at = this.#nodeAt(ev);
    const id = at === exclude ? null : at;
    if (id) this.#nodeElById(id)?.classList.add("sf-drop-hot");
    // over the source card nothing is a target, edges included
    this.#markEdgeHot(!at && withEdges ? this.#edgeAt(ev) : null);
  }

  #markEdgeHot(edge) {
    this.#hotEdge?.classList.remove("sf-edge-hot");
    this.#hotEdge = edge?.hit?.__path ?? null;
    this.#hotEdge?.classList.add("sf-edge-hot");
  }

  // ------------------------------------------------------- ⊕ on an edge

  #showEdgePlus(hit) {
    const length = hit.isConnected ? hit.getTotalLength() : 0;
    const at = length ? hit.getPointAtLength(length / 2) : null;
    // a zero-length edge has no midpoint; without this the buttons fly to (0, 0)
    if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) { this.#hideEdgePlus(); return; }
    this.edgeToolsEl.style.left = `${at.x}px`;
    this.edgeToolsEl.style.top = `${at.y}px`;
    this.edgeToolsEl.dataset.from = hit.dataset.from;
    this.edgeToolsEl.dataset.port = hit.dataset.port;
    this.edgeToolsEl.hidden = false;
  }

  #hideEdgePlus() {
    this.edgeToolsEl.hidden = true;
  }

  #onEdgeButton(e, action) {
    e.stopPropagation();
    const { from, port } = this.edgeToolsEl.dataset;
    this.#hideEdgePlus();
    if (action === "cut") this.env.model.disconnect(from, Number(port));
    else this.#offerInsert(e, from, Number(port));
  }

  // ------------------------------------------------------- connecting

  #startOrderDrag(e, fromId, portIndex) {
    const node = this.env.model.node(fromId);
    if (!node) return;
    const layout = this.#layout(node);
    const port = layout.orders[portIndex];
    if (!port) return;
    const origin = this.#point(node, layout.orderOut(portIndex));
    const temp = this.#tempEdge(origin, true);
    this.#beginConnecting(fromId, t("canvas.dragging", { port: port.label }));
    let moved = false;

    this.#drag(e, {
      move: (ev) => {
        moved = moved || Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 4;
        temp.update(ev);
        this.#hotTarget(ev, false, fromId);
      },
      cancel: () => { temp.remove(); this.#endConnecting(); },
      up: (ev) => {
        temp.remove();
        // a click without dragging holds the wire
        if (!moved) { this.#arm(fromId, portIndex, origin, port.label); return; }
        this.#endConnecting();
        const targetId = this.#nodeAt(ev);
        if (!targetId) this.#offerCreate(ev, fromId, portIndex);
        else if (targetId !== fromId) this.env.model.connect(fromId, portIndex, targetId);
        // dropped on its own card: refused, and said so
        else this.flashHint(t("canvas.noSelfLink"));
      },
    });
  }

  /**
   * A click on a port holds the wire until the next click: a long drag is hard
   * on a touchpad, and the view can be scrolled and zoomed in between.
   */
  #arm(fromId, portIndex, origin, label) {
    this.#disarm();
    const temp = this.#tempEdge(origin, true);
    const onMove = (ev) => { temp.update(ev); this.#hotTarget(ev, false, fromId); };
    window.addEventListener("pointermove", onMove);
    this.#armed = { fromId, portIndex, temp, onMove };
    this.#beginConnecting(fromId, t("canvas.armed", { port: label }));
  }

  #disarm() {
    if (!this.#armed) return;
    window.removeEventListener("pointermove", this.#armed.onMove);
    this.#armed.temp.remove();
    this.#armed = null;
    this.#endConnecting();
  }

  /** A wire dropped on empty space: offer what to create, connected to the
   * port. The main way of building a graph. */
  #offerCreate(ev, fromId, portIndex) {
    this.#createMenu(ev, {
      title: t("canvas.createConnected"),
      hint: t("canvas.createConnected.hint"),
      allow: (spec) => spec.type !== "entry", // there is no going into the entry point
      pick: (spec) => this.#select(
        this.env.model.createConnected(fromId, portIndex, spec, this.#dropPos(ev))),
    });
  }

  /** Insert into an edge: A→B becomes A→N→B. */
  #offerInsert(ev, fromId, portIndex) {
    this.#createMenu(ev, {
      title: t("canvas.insertOnEdge"),
      hint: t("canvas.insertOnEdge.hint"),
      allow: (spec) => spec.type !== "entry" && canContinue(spec.type, spec.extra),
      pick: (spec) => this.#select(this.env.model.insertOnEdge(fromId, portIndex, spec)),
    });
  }

  /** Drag a variable from a data output: on a node, a menu of ways to connect
   * it (kind.acceptVariable); on empty space, first what to create, then the
   * same menu on the new node. */
  #startDataDrag(e, fromId, outIndex) {
    const node = this.env.model.node(fromId);
    if (!node) return;
    const layout = this.#layout(node);
    const port = layout.outs[outIndex];
    if (!port) return;
    const temp = this.#tempEdge(this.#point(node, layout.dataOut(outIndex)), false, "sf-edge-data");
    this.#beginConnecting(fromId, t("canvas.varDragging", { name: port.variable.name }));

    this.#drag(e, {
      move: (ev) => { temp.update(ev); this.#hotTarget(ev); },
      cancel: () => { temp.remove(); this.#endConnecting(); },
      up: (ev) => {
        temp.remove();
        this.#endConnecting();
        const targetId = this.#nodeAt(ev);
        if (targetId === fromId) return;
        if (targetId) { this.#offerVariable(ev, targetId, port.variable); return; }
        this.#createMenu(ev, {
          title: t("canvas.varToNode", { name: port.variable.name }),
          hint: t("canvas.varToNode.hint"),
          allow: (spec) => spec.type !== "entry",
          pick: (spec) => {
            // the reader goes after the writer in the flow: in a shared frame a
            // node reads what was written before it in execution order
            const free = freePortIndex(node);
            const created = free >= 0
              ? this.env.model.createConnected(fromId, free, spec, this.#dropPos(ev))
              : this.env.model.createAt(spec, this.#dropPos(ev));
            this.#select(created);
            this.#offerVariable(ev, created.id, port.variable);
          },
        });
      },
    });
  }

  #offerVariable(ev, targetId, variable) {
    const target = this.env.model.node(targetId);
    if (!target) return;
    const options = kindOf(target).acceptVariable(target, variable, this.env);
    if (!options.length) return;
    this.#openMenu(ev, {
      title: `${variable.name} →`,
      items: options.map((option) => ({
        label: option.label,
        apply: () => {
          if (option.applyNamed) {
            const name = prompt(option.prompt ?? "Name:");
            if (!name?.trim()) return;
            option.applyNamed(name.trim());
          } else {
            option.apply();
          }
          this.env.model.touch();
        },
      })),
    });
  }

  // ------------------------------------------------- a drop from the palette

  /** Highlight the target while a palette node is dragged. */
  dropHint(clientX, clientY, spec) {
    const ev = { clientX, clientY };
    if (!this.#inside(ev)) { this.#endConnecting(); return; }
    this.host.classList.add("sf-connecting");
    this.#hotTarget(ev, canContinue(spec.type, spec.extra));
    const edge = this.#edgeAt(ev);
    const overId = this.#nodeAt(ev);
    this.#hint(edge && !overId ? t("canvas.insertOnEdge")
      : overId ? t("canvas.attachAfter", { node: overId })
      : t("canvas.createHere"));
  }

  /**
   * A drop from the palette: on an edge, insert; on a node, attach to its free
   * port; on empty space, create. The node arrives connected.
   */
  dropCreate(spec, clientX, clientY) {
    const ev = { clientX, clientY };
    this.#endConnecting();
    if (!this.#inside(ev)) return null;

    const model = this.env.model;
    const edge = this.#edgeAt(ev);
    let node = edge ? model.insertOnEdge(edge.fromId, edge.portIndex, spec) : null;
    if (!node) {
      const overId = this.#nodeAt(ev);
      if (overId) node = model.appendAfter(overId, spec);
    }
    return this.#select(node ?? model.createAt(spec, this.#dropPos(ev)));
  }

  #inside(ev) {
    const rect = this.host.getBoundingClientRect();
    return ev.clientX >= rect.left && ev.clientX <= rect.right
      && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
  }

  // -------------------------------------------------------------- menu

  /** The "what to create" menu: node types and stages, with search. */
  #createMenu(ev, { title, hint, allow, pick }) {
    const graph = this.env.model.graph;
    const items = [];

    for (const kind of KINDS.values()) {
      if (kind === StageKind) continue; // a stage is picked by name, below
      const spec = { type: kind.type };
      // a second entry node would be invalid, so it is not offered
      if (kind.type === "entry" && graph.nodes.some((n) => n.type === "entry")) continue;
      if (allow && !allow(spec)) continue;
      items.push({
        label: kind.title,
        hint: kind.description(kind.defaults("new"), this.env),
        icon: kind.glyph,
        color: kind.color,
        keywords: kind.type,
        apply: () => pick(spec),
      });
    }

    if (!allow || allow({ type: "stage" })) {
      for (const [category, specs] of this.env.stages.byCategory()) {
        for (const spec of specs) {
          const fallback = StageKind.iconFallback({ stage: spec.stage_name });
          items.push({
            label: spec.stage_name,
            hint: spec.description ?? "",
            icon: spec.icon || fallback,
            iconMono: spec.icon_mono,
            iconBase: this.env.backend?.url,
            fallback,
            color: spec.color || categoryColor(category) || StageKind.color,
            keywords: category,
            apply: () => pick({ type: "stage", extra: { stage: spec.stage_name } }),
          });
        }
      }
    }
    this.#openMenu(ev, { title, hint, items, search: true });
  }

  #openMenu(ev, { title, hint, items, search = false }) {
    this.#closeMenu();
    this.#menu = openMenu(this.host, {
      x: ev.clientX, y: ev.clientY, title, hint, items, search,
      onClose: () => { this.#menu = null; },
    });
  }

  #closeMenu() {
    this.#menu?.close();
    this.#menu = null;
  }
}
