/**
 * The pipeline model: the single owner of the editor's data.
 *
 * Every change goes through a model method and ends with `touch()`, which
 * dispatches a "change" event to all views. Nodes are stored in the StageFlow
 * JSON format; editor coordinates live in `node.metadata.ui` (allowed by the
 * schema, so the layout survives export and import).
 */
import { controlSuccessors, writersOf } from "./dataflow.js";
import { nodeLayout } from "./geometry.js";
import { kindOf } from "./kinds.js";
import { computeRegions, reachable } from "./regions.js";
import {
  avoidOverlap, connectPort, freePortIndex, insertBetween, placeAfter,
} from "./wiring.js";

export function emptyPipeline() {
  return { entry: "", nodes: [], metadata: {}, subpipelines: {} };
}

/** Auto-layout spacing. Data wires are only shown on focus (dataflow.js), so
 * only order arrows need room. Overridden by the editor's `spacing` option. */
export const DEFAULT_SPACING = { gapX: 110, gapY: 120, dataGap: 130 };

/** Undo history depth. Snapshots are JSON strings, so this is cheap. */
const HISTORY_LIMIT = 100;

export class PipelineModel extends EventTarget {
  #pipeline = emptyPipeline();
  #graphKey = null; // null — the root graph, otherwise a subpipeline id
  // undo history: snapshots of the state after each edit, and the cursor
  #history = [];
  #cursor = -1;
  #replaying = false; // an undo/redo is running — do not record a new entry

  constructor(spacing = {}) {
    super();
    this.spacing = { ...DEFAULT_SPACING, ...spacing };
  }

  // -------------------------------------------------------------- history

  get canUndo() { return this.#cursor > 0; }

  get canRedo() { return this.#cursor >= 0 && this.#cursor < this.#history.length - 1; }

  /**
   * Record the state after an edit, unless it equals the current head:
   * `touch()` is also sent when nothing changed (switching subpipelines,
   * redrawing after specs load), and those must not become undo steps.
   */
  #record() {
    if (this.#replaying) return;
    const json = JSON.stringify(this.#pipeline);
    if (this.#history[this.#cursor]?.json === json) return;
    this.#history.splice(this.#cursor + 1); // the branch after an undo is cut off
    this.#history.push({ json, graphKey: this.#graphKey });
    if (this.#history.length > HISTORY_LIMIT) this.#history.shift();
    this.#cursor = this.#history.length - 1;
  }

  #restore(index) {
    const snapshot = this.#history[index];
    if (!snapshot) return false;
    this.#cursor = index;
    this.#pipeline = JSON.parse(snapshot.json);
    // switch back to the graph the edit was made in
    this.#graphKey = snapshot.graphKey !== null && snapshot.graphKey in (this.#pipeline.subpipelines ?? {})
      ? snapshot.graphKey
      : null;
    this.#replaying = true;
    try {
      this.touch();
    } finally {
      this.#replaying = false;
    }
    return true;
  }

  undo() { return this.canUndo && this.#restore(this.#cursor - 1); }

  redo() { return this.canRedo && this.#restore(this.#cursor + 1); }

  // --------------------------------------------------------------- access

  get pipeline() { return this.#pipeline; }

  get graphKey() { return this.#graphKey; }

  /** The graph being edited: the root or a subpipeline. */
  get graph() {
    return this.#graphKey === null
      ? this.#pipeline
      : this.#pipeline.subpipelines[this.#graphKey];
  }

  node(id) {
    return this.graph.nodes.find((n) => n.id === id);
  }

  toJSON() {
    return structuredClone(this.#pipeline);
  }

  touch() {
    this.#record();
    this.dispatchEvent(new Event("change"));
  }

  // --------------------------------------------------------- pipeline/graph

  /**
   * @param keepLayout use the coordinates in `data` as they are (a restored
   *   session of this editor).
   */
  setPipeline(data, { keepLayout = false } = {}) {
    const before = snapshotNodes(this.graph);
    const incoming = structuredClone(data);
    inheritPlacement(this.#pipeline, incoming);
    this.#pipeline = normalizePipeline(incoming, this.spacing, keepLayout);
    this.#graphKey = null;
    // a new document starts a new undo history
    this.#history = [];
    this.#cursor = -1;
    this.touch();
    // Report what changed, so views can tell a new document (fit the view)
    // from an edit of the current one (do not move the view).
    this.dispatchEvent(new CustomEvent("reset", {
      detail: changeBetween(before, snapshotNodes(this.graph)),
    }));
  }

  reset() {
    this.setPipeline(emptyPipeline());
  }

  setGraph(key) {
    this.#graphKey = key !== null && key in (this.#pipeline.subpipelines ?? {}) ? key : null;
    this.touch();
    this.dispatchEvent(new Event("reset"));
  }

  addSubpipeline(id) {
    if (!id || (this.#pipeline.subpipelines ??= {})[id]) return false;
    this.#pipeline.subpipelines[id] = { entry: "", nodes: [] };
    this.#graphKey = id;
    this.touch();
    return true;
  }

  removeSubpipeline(id) {
    delete this.#pipeline.subpipelines[id];
    if (this.#graphKey === id) this.#graphKey = null;
    this.touch();
  }

  setEntry(id) {
    this.graph.entry = id;
    this.touch();
  }

  /** Re-run the automatic layout, discarding manual positions. */
  relayout() {
    autoLayout(this.graph, this.spacing);
    this.touch();
    this.dispatchEvent(new Event("reset"));
  }

  // ---------------------------------------------------------------- nodes

  /** Create a node without dispatching an event, so the caller can connect
   * it before the redraw. */
  #create({ type, extra = {} }, pos) {
    const kind = kindOf({ type });
    const base = (extra.stage ?? type).replace(/Stage$/, "").toLowerCase() || type;
    const node = {
      ...kind.defaults(this.#uniqueId(base)),
      ...extra,
      metadata: { ui: { x: Math.round(pos.x), y: Math.round(pos.y) } },
    };
    this.graph.nodes.push(node);
    // the first entry node becomes the graph's `entry`
    if (node.type === "entry" && !this.#entryNodeId(node.id)) this.graph.entry = node.id;
    return node;
  }

  /** Add a node at a point, moved aside if it would overlap another card. */
  addNode(type, pos, extra = {}) {
    const node = avoidOverlap(this.graph, this.#create({ type, extra }, pos));
    this.touch();
    return node;
  }

  /** Create a node at a canvas point (double click, drop from the palette). */
  createAt(spec, pos) {
    const node = avoidOverlap(this.graph, this.#create(spec, pos));
    this.touch();
    return node;
  }

  /** Connect an order port of a node to a target (dragging a wire). */
  connect(fromId, portIndex, targetId) {
    if (!connectPort(this.graph, fromId, portIndex, targetId)) return false;
    this.touch();
    return true;
  }

  /** Create a node and connect it to a port (dragging a wire into empty space). */
  createConnected(fromId, portIndex, spec, pos) {
    const node = this.#create(spec, pos);
    connectPort(this.graph, fromId, portIndex, node.id);
    avoidOverlap(this.graph, node);
    this.touch();
    return node;
  }

  /** Disconnect a port. For list ports (`case`, branch, `except`) the list
   * item is removed, since JSON cannot express an item without a target. */
  disconnect(fromId, portIndex) {
    const node = this.node(fromId);
    const port = node && kindOf(node).orderPorts(node)[portIndex];
    if (!port) return false;
    port.removeItem ? port.removeItem() : port.set?.(null);
    this.touch();
    return true;
  }

  /** Insert a node into an edge: A→B becomes A→N→B. */
  insertOnEdge(fromId, portIndex, spec) {
    const node = this.#create(spec, { x: 0, y: 0 });
    if (!insertBetween(this.graph, fromId, portIndex, node, this.spacing)) {
      this.graph.nodes.pop(); // the node has nothing to continue with — no insertion happened
      return null;
    }
    this.touch();
    return node;
  }

  /** Add a node after an existing one, into its first free port (a palette
   * click with a node selected). */
  appendAfter(fromId, spec) {
    const source = this.node(fromId);
    const portIndex = source ? freePortIndex(source) : -1;
    if (portIndex < 0) return null;
    const node = this.#create(spec, { x: 0, y: 0 });
    placeAfter(this.graph, fromId, node, this.spacing);
    connectPort(this.graph, fromId, portIndex, node.id);
    this.touch();
    return node;
  }

  /** The id of an entry node other than `exceptId`, if any (there should be
   * at most one; validation flags a second). */
  #entryNodeId(exceptId) {
    return this.graph.nodes.find((n) => n.type === "entry" && n.id !== exceptId)?.id ?? null;
  }

  removeNode(id) {
    this.removeNodes([id]);
  }

  /** Delete nodes and remove references to them, with a single event. */
  removeNodes(ids) {
    const drop = new Set(ids);
    if (!drop.size) return;
    const graph = this.graph;
    graph.nodes = graph.nodes.filter((n) => !drop.has(n.id));
    for (const node of graph.nodes) {
      for (const id of drop) this.#scrubRefs(node, id);
    }
    // if the entry node was deleted, use another entry node if there is one
    if (drop.has(graph.entry)) graph.entry = this.#entryNodeId(null) ?? "";
    this.touch();
  }

  /** Plain JSON copies of nodes for the clipboard. */
  copyNodes(ids) {
    const want = new Set(ids);
    return this.graph.nodes.filter((n) => want.has(n.id)).map((n) => structuredClone(n));
  }

  /**
   * Paste copies of nodes into the current graph; returns the new ids.
   *
   * - ids are made unique, and references between pasted nodes point to the
   *   copies;
   * - references to other nodes are kept if the target exists in this graph,
   *   cleared otherwise;
   * - an `entry` node is not pasted if the graph already has one.
   *
   * @param at top-left corner in world coordinates, or null to offset the
   *           copies from the originals.
   */
  pasteNodes(nodes, at = null) {
    const graph = this.graph;
    const hasEntry = graph.nodes.some((n) => n.type === "entry");
    const source = (nodes ?? []).filter((n) => n?.type !== "entry" || !hasEntry);
    if (!source.length) return [];

    const remap = new Map();
    const copies = [];
    for (const node of source) {
      const copy = structuredClone(node);
      copy.id = this.#uniqueId(node.id);
      copy.metadata ??= {};
      copy.metadata.ui = { ...(node.metadata?.ui ?? { x: 0, y: 0 }) };
      remap.set(node.id, copy.id);
      graph.nodes.push(copy); // into the graph at once — or the next copy takes the same id
      copies.push(copy);
    }

    for (const copy of copies) {
      for (const port of kindOf(copy).orderPorts(copy)) {
        const target = port.get?.();
        if (!target) continue;
        if (remap.has(target)) port.set?.(remap.get(target));
        else if (!graph.nodes.some((n) => n.id === target)) port.set?.(null);
      }
    }

    // one offset for the whole set keeps the relative placement
    const left = Math.min(...copies.map((c) => c.metadata.ui.x));
    const top = Math.min(...copies.map((c) => c.metadata.ui.y));
    const dx = at ? Math.round(at.x - left) : 48;
    const dy = at ? Math.round(at.y - top) : 48;
    for (const copy of copies) {
      copy.metadata.ui = { x: copy.metadata.ui.x + dx, y: copy.metadata.ui.y + dy };
    }
    if (!at && copies.length === 1) avoidOverlap(graph, copies[0]);

    if (!graph.entry) graph.entry = this.#entryNodeId(null) ?? graph.entry;
    this.touch();
    return copies.map((c) => c.id);
  }

  renameNode(oldId, newId) {
    if (!newId || newId === oldId) return false;
    if (this.node(newId)) return false;
    const node = this.node(oldId);
    if (!node) return false;
    node.id = newId;
    for (const other of this.graph.nodes) this.#remapRefs(other, oldId, newId);
    if (this.graph.entry === oldId) this.graph.entry = newId;
    this.touch();
    return true;
  }

  /** Remove references from `node` to a deleted id: list items are removed,
   * single references cleared. */
  #scrubRefs(node, id) {
    for (const port of kindOf(node).orderPorts(node)) {
      if (port.get?.() === id) {
        port.removeItem ? port.removeItem() : port.set?.(null);
      }
    }
  }

  #remapRefs(node, oldId, newId) {
    for (const port of kindOf(node).orderPorts(node)) {
      if (port.get?.() === oldId) port.set?.(newId);
    }
  }

  #uniqueId(base) {
    if (!this.node(base)) return base;
    let n = 2;
    while (this.node(`${base}_${n}`)) n += 1;
    return `${base}_${n}`;
  }
}

/**
 * Copy coordinates from the current graph to an incoming one, by node id.
 *
 * A graph from outside (e.g. an assistant) usually has no coordinates.
 * Without this, nodes that did not change would be laid out again and every
 * card the user arranged would move. Coordinates in the incoming graph win.
 */
function inheritPlacement(from, to) {
  const carry = (older, newer) => {
    const was = new Map((older?.nodes ?? []).map((n) => [n.id, n.metadata?.ui]));
    for (const node of newer?.nodes ?? []) {
      const ui = was.get(node.id);
      if (!ui || node.metadata?.ui) continue;
      node.metadata = { ...(node.metadata ?? {}), ui: { ...ui } };
    }
  };
  carry(from, to);
  for (const [key, graph] of Object.entries(to?.subpipelines ?? {})) {
    carry(from?.subpipelines?.[key], graph);
  }
}

// ---------------------------------------------------------------- changes

/** Each node's position and content, by id. */
function snapshotNodes(graph) {
  const out = new Map();
  for (const node of graph?.nodes ?? []) {
    const { ui, ...metadata } = node.metadata ?? {};
    const { metadata: _drop, ...rest } = node;
    out.set(node.id, {
      x: ui?.x ?? 0,
      y: ui?.y ?? 0,
      body: JSON.stringify({ ...rest, metadata }),
    });
  }
  return out;
}

/**
 * What changed between two versions of a graph.
 *
 * `fresh` is true when they share no node id, i.e. a different document
 * (fit the view) rather than an edit (keep the view). `moved` holds how far
 * each card moved, for animation. `changed` compares node content without
 * the position, so a relayout changes nothing.
 */
export function changeBetween(before, after) {
  const added = [];
  const changed = [];
  const moved = new Map();
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) { added.push(id); continue; }
    if (was.body !== now.body) changed.push(id);
    if (was.x !== now.x || was.y !== now.y) {
      moved.set(id, { dx: was.x - now.x, dy: was.y - now.y });
    }
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const shared = [...after.keys()].some((id) => before.has(id));
  const fresh = before.size === 0 || !shared;
  if (fresh) {
    // A new document is not marked as "everything added": marks mean
    // "just changed", which does not apply to a graph seen for the first time.
    return { added: [], removed: [], changed: [], moved: new Map(), fresh: true, touched: 0 };
  }
  return {
    added,
    removed,
    changed,
    moved,
    fresh: false,
    touched: added.length + removed.length + changed.length,
  };
}

// ---------------------------------------------------------- normalization

function normalizePipeline(data, spacing, keepLayout = false) {
  const pipeline = { ...emptyPipeline(), ...(data ?? {}) };
  pipeline.nodes ??= [];
  pipeline.subpipelines ??= {};
  normalizeGraph(pipeline, spacing, keepLayout);
  for (const sub of Object.values(pipeline.subpipelines)) {
    sub.nodes ??= [];
    normalizeGraph(sub, spacing, keepLayout);
  }
  return pipeline;
}

/**
 * Place nodes that have no coordinates, leaving the others where they are.
 *
 * A new node goes below the node that leads to it (as a manual insert would)
 * and moves aside from existing cards. Nodes are placed in passes, since a
 * new node may depend on another new node; whatever is left goes below the
 * graph.
 */
function placeNewNodes(graph, spacing) {
  const leadsTo = new Map();
  for (const node of graph.nodes) {
    for (const port of kindOf(node).orderPorts(node)) {
      const target = port.get?.();
      if (target && !leadsTo.has(target)) leadsTo.set(target, node.id);
    }
  }
  const placed = (id) => Boolean(graph.nodes.find((n) => n.id === id)?.metadata?.ui);
  let waiting = graph.nodes.filter((n) => !n.metadata?.ui);

  while (waiting.length) {
    const next = [];
    for (const node of waiting) {
      const from = leadsTo.get(node.id);
      if (from && placed(from)) placeAfter(graph, from, node, spacing);
      else next.push(node);
    }
    if (next.length === waiting.length) break; // nothing moved: no parent to hang on
    waiting = next;
  }

  // the rest start a column below the graph
  let y = Math.max(60, ...graph.nodes
    .filter((n) => n.metadata?.ui)
    .map((n) => n.metadata.ui.y + nodeLayout(n).height));
  for (const node of waiting) {
    node.metadata.ui = { x: 60, y: Math.round(y + (spacing.gapY ?? DEFAULT_SPACING.gapY)) };
    avoidOverlap(graph, node);
    y = node.metadata.ui.y + nodeLayout(node).height;
  }
}

/**
 * Whether the stored coordinates make cards overlap, i.e. they are not a
 * real layout (e.g. `{x: 0, y: 0}` on every node). Uses the auto-layout's
 * card sizes.
 */
function cardsCollide(graph) {
  // Only nodes with coordinates: a node without them is unplaced, not at
  // (0, 0).
  const boxes = graph.nodes
    .filter((node) => node.metadata?.ui)
    .map((node) => {
      const { width, height } = nodeLayout(node);
      return { x: node.metadata.ui.x, y: node.metadata.ui.y, width, height };
    });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y) return true;
    }
  }
  return false;
}

/**
 * @param keepLayout use the stored coordinates as they are (a restored
 *   session), even if some cards touch.
 */
function normalizeGraph(graph, spacing, keepLayout = false) {
  let needsLayout = false;
  // `entry` is optional when there is an entry node; derive it on load, since
  // layout and validation need it.
  if (!graph.entry) {
    const entryNode = graph.nodes.find((n) => n.type === "entry");
    if (entryNode) graph.entry = entryNode.id;
  }
  for (const node of graph.nodes) {
    node.metadata ??= {};
    if (node.type === "parallel") {
      node.branches = (node.branches ?? []).map((b) =>
        typeof b === "string" ? { id: b, entry: b } : b);
    }
    // as in the core: a list of names means "same name"
    if (node.type === "map" && Array.isArray(node.collect)) {
      node.collect = Object.fromEntries(node.collect.map((name) => [name, name]));
    }
    if (!node.metadata.ui) needsLayout = true;
  }
  // coordinates from outside may not be a real layout
  const collide = !keepLayout && cardsCollide(graph);
  const arranged = graph.nodes.filter((n) => n.metadata.ui).length;
  if (collide || (needsLayout && !arranged)) {
    // nothing to keep, or the stored positions overlap
    autoLayout(graph, spacing);
  } else if (needsLayout) {
    // some nodes are placed and some are new: place only the new ones
    placeNewNodes(graph, spacing);
  }
}

/**
 * Automatic layout for graphs without saved coordinates.
 *
 * - Y is execution order: BFS depth along order edges.
 * - X is nesting and data flow: every region (`parallel` branches, `try`
 *   body and handlers, `map` body) gets its own column; within a column, a
 *   node is placed to the right of the nodes whose variables it reads.
 *
 * Separate columns guarantee that no unrelated node falls inside a region's
 * frame (which would make it look like part of the region). Columns are
 * reused by blocks that follow one another, so the graph does not grow
 * sideways with every block.
 */
export function autoLayout(graph, spacing = {}) {
  const level = new Map();
  const parent = new Map(); // who handed control over — we stand under them
  const queue = [];
  if (graph.entry && graph.nodes.some((n) => n.id === graph.entry)) {
    level.set(graph.entry, 0);
    queue.push(graph.entry);
  }
  while (queue.length) {
    const id = queue.shift();
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) continue;
    for (const port of kindOf(node).orderPorts(node)) {
      const target = port.get?.();
      if (target && !level.has(target)) {
        level.set(target, level.get(id) + 1);
        parent.set(target, id);
        queue.push(target);
      }
    }
  }
  // A parallel's merge point must be below all its branch nodes, or it would
  // fall inside the branch region. Shift it and everything after it down;
  // repeat for nested parallels.
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const region of computeRegions(graph, null)) {
      const owner = graph.nodes.find((n) => n.id === region.ownerId);
      if (!owner?.next || !level.has(owner.next)) continue;
      const deepest = Math.max(...[...region.members].map((id) => level.get(id) ?? -1));
      const shift = deepest + 1 - level.get(owner.next);
      if (shift > 0) {
        for (const id of reachable(graph, [owner.next])) {
          if (level.has(id)) level.set(id, level.get(id) + shift);
        }
        changed = true;
      }
    }
    if (!changed) break;
  }

  const { gapX: GAP_X, gapY: GAP_Y, dataGap: DATA_GAP } = { ...DEFAULT_SPACING, ...spacing };
  const ORIGIN_X = 60;
  const sizes = new Map(graph.nodes.map((n) => [n.id, nodeLayout(n)]));
  const writers = writersOf(graph);

  // Nodes reachable from each writer through control flow. If a reader is
  // below its writer, the wire already reads top to bottom and the reader
  // does not need to move right (avoids a staircase layout).
  const succs = controlSuccessors(graph);
  const downstream = new Map();
  const flowsInto = (from, to) => {
    let set = downstream.get(from);
    if (!set) {
      set = new Set();
      const queue = [...(succs.get(from) ?? [])];
      while (queue.length) {
        const id = queue.shift();
        if (!id || set.has(id)) continue;
        set.add(id);
        queue.push(...(succs.get(id) ?? []));
      }
      downstream.set(from, set);
    }
    return set.has(to);
  };
  const orphanLevel = Math.max(-1, ...level.values()) + 1;
  const levelOf = (node) => (level.has(node.id) ? level.get(node.id) : orphanLevel);

  // -------------------------------------------------------------- columns

  // a node's group is the smallest region containing it ("" is the root)
  const regions = computeRegions(graph, null); // sorted from the largest down
  const groupOf = new Map();
  for (const region of regions) {
    for (const id of region.members) groupOf.set(id, region.key);
  }

  // region tree: a region's parent is the smallest region strictly enclosing it
  const encloses = (outer, inner) => outer.members.size > inner.members.size
    && [...inner.members].every((id) => outer.members.has(id));
  const parentGroup = new Map();
  for (const region of regions) {
    let best = null;
    for (const other of regions) {
      if (encloses(other, region) && (!best || other.members.size < best.members.size)) best = other;
    }
    parentGroup.set(region.key, best?.key ?? "");
  }

  const membersOf = new Map([["", []]]);
  for (const region of regions) membersOf.set(region.key, []);
  for (const node of graph.nodes) membersOf.get(groupOf.get(node.id) ?? "").push(node);

  /**
   * Lay out one group's column in its own coordinates.
   *
   * Nested regions are placed first, from the left, and the group's own
   * nodes go to their right. Regions with a lower `rank` go first, so a `try`
   * body is left of its handlers. Returns the width, relative x positions and
   * the range of levels used.
   */
  const layoutGroup = (key) => {
    const pos = new Map();
    const rows = new Map();
    let minLevel = Infinity;
    let maxLevel = -Infinity;

    for (const node of membersOf.get(key)) {
      const lvl = levelOf(node);
      if (!rows.has(lvl)) rows.set(lvl, []);
      rows.get(lvl).push(node);
      minLevel = Math.min(minLevel, lvl);
      maxLevel = Math.max(maxLevel, lvl);
    }

    // Nested regions are placed in bands from left to right; a band can be
    // reused by a region on levels that do not overlap.
    const bands = [];
    const nested = regions
      .filter((region) => parentGroup.get(region.key) === key)
      .map((region) => ({ region, ...layoutGroup(region.key) }))
      // on the same levels, lower rank first (`try` body before handlers)
      .sort((a, b) => a.minLevel - b.minLevel || a.region.rank - b.region.rank);

    for (const band of nested) {
      let x = 0;
      for (let step = 0; step <= bands.length; step += 1) {
        const hit = bands.find((b) => b.minLevel <= band.maxLevel && b.maxLevel >= band.minLevel
          && x < b.x + b.width + GAP_X);
        if (!hit) break;
        x = hit.x + hit.width + GAP_X;
      }
      bands.push({ x, width: band.width, minLevel: band.minLevel, maxLevel: band.maxLevel });
      for (const [id, rel] of band.pos) pos.set(id, x + rel);
      minLevel = Math.min(minLevel, band.minLevel);
      maxLevel = Math.max(maxLevel, band.maxLevel);
    }

    /** Move a node right until it clears the bands on its level. */
    const clearBands = (x, width, lvl) => {
      for (let step = 0; step <= bands.length; step += 1) {
        const hit = bands.find((b) => b.minLevel <= lvl && b.maxLevel >= lvl
          && x < b.x + b.width + GAP_X && x + width + GAP_X > b.x);
        if (!hit) break;
        x = hit.x + hit.width + GAP_X;
      }
      return x;
    };

    // A node's leftmost position: not left of its predecessor, and right of
    // writers it reads from that are not on its control path.
    const anchor = (node) => {
      let x = pos.get(parent.get(node.id)) ?? 0;
      for (const writer of writers.get(node.id) ?? []) {
        if (flowsInto(writer, node.id)) continue;
        const at = pos.get(writer);
        if (at !== undefined) x = Math.max(x, at + sizes.get(writer).width + DATA_GAP);
      }
      return Math.max(0, x);
    };

    let width = Math.max(0, ...bands.map((b) => b.x + b.width));
    for (const lvl of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(lvl);
      // nodes pulled furthest left by their data go first
      row.sort((a, b) => anchor(a) - anchor(b));
      let cursor = 0;
      for (const node of row) {
        const size = sizes.get(node.id).width;
        const x = clearBands(Math.max(cursor, anchor(node)), size, lvl);
        pos.set(node.id, x);
        cursor = x + size + GAP_X;
      }
      width = Math.max(width, cursor - GAP_X);
    }

    return { pos, width, minLevel, maxLevel };
  };

  const root = layoutGroup("");

  // Y is shared by the whole graph; each level is as tall as its tallest card
  const heights = new Map();
  for (const node of graph.nodes) {
    const lvl = levelOf(node);
    heights.set(lvl, Math.max(heights.get(lvl) ?? 0, sizes.get(node.id).height));
  }
  const topOf = new Map();
  let y = 60;
  for (const lvl of [...heights.keys()].sort((a, b) => a - b)) {
    topOf.set(lvl, y);
    y += heights.get(lvl) + GAP_Y;
  }

  for (const node of graph.nodes) {
    node.metadata ??= {};
    node.metadata.ui = {
      x: Math.round(ORIGIN_X + (root.pos.get(node.id) ?? 0)),
      y: topOf.get(levelOf(node)),
    };
  }
}
