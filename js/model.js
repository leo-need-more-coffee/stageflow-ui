/**
 * The pipeline model: the single owner of the editor's data.
 *
 * Every mutation goes through a model method and ends with `touch()` — a
 * "change" event every view is subscribed to. Nodes are stored exactly in the
 * format of the StageFlow JSON schema; the editor's coordinates live in
 * `node.metadata.ui` (metadata is allowed by the schema, so the layout
 * survives export and import).
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

/** The density of the auto-layout. The gaps used to be three times wider: the
 * data wires hung on the canvas all at once, and without air the graph read as
 * porridge. Now those wires are shown on focus (dataflow.js) and there is no
 * need to reserve room for them — only as much as order arrows need to bend.
 * Overridden by the editor's `spacing` option. */
export const DEFAULT_SPACING = { gapX: 110, gapY: 120, dataGap: 130 };

/** How many edit steps the history remembers. A snapshot is a JSON string of
 * the pipeline, so a hundred of them are cheaper than one picture; nobody
 * rewinds deeper. */
const HISTORY_LIMIT = 100;

export class PipelineModel extends EventTarget {
  #pipeline = emptyPipeline();
  #graphKey = null; // null — the root graph, otherwise a subpipeline id
  // history: snapshots of the state AFTER every edit, the cursor is where we are
  #history = [];
  #cursor = -1;
  #replaying = false; // an undo/redo is running — do not record a new entry

  constructor(spacing = {}) {
    super();
    this.spacing = { ...DEFAULT_SPACING, ...spacing };
  }

  // ------------------------------------------------------------- history

  get canUndo() { return this.#cursor > 0; }

  get canRedo() { return this.#cursor >= 0 && this.#cursor < this.#history.length - 1; }

  /**
   * Remembers the state after an edit.
   *
   * Comparing with the head of the history is not an optimisation but the
   * point: `touch()` is also sent by actions that do not change the pipeline
   * (switching a subpipeline, redrawing after the specs load), and without the
   * comparison Ctrl+Z would rewind empty steps in which nothing happened for
   * the user.
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
    // the graph the edit was made on: otherwise undoing an edit in a
    // subpipeline would happen "somewhere not here"
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

  // -------------------------------------------------------------- access

  get pipeline() { return this.#pipeline; }

  get graphKey() { return this.#graphKey; }

  /** The graph currently being edited: the root or one of the subpipelines. */
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

  // -------------------------------------------------------- pipeline/graph

  setPipeline(data) {
    this.#pipeline = normalizePipeline(structuredClone(data), this.spacing);
    this.#graphKey = null;
    // another document — another history: there is no undoing into a foreign
    // pipeline
    this.#history = [];
    this.#cursor = -1;
    this.touch();
    // the whole graph changed — the views should refit the view
    this.dispatchEvent(new Event("reset"));
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

  /** Lay the current graph out again, discarding the manual coordinates. */
  relayout() {
    autoLayout(this.graph, this.spacing);
    this.touch();
    this.dispatchEvent(new Event("reset"));
  }

  // --------------------------------------------------------------- nodes

  /** The shared part of every way of adding a node: the node is created but no
   * event is sent — connecting gets to finish the graph before the redraw. */
  #create({ type, extra = {} }, pos) {
    const kind = kindOf({ type });
    const base = (extra.stage ?? type).replace(/Stage$/, "").toLowerCase() || type;
    const node = {
      ...kind.defaults(this.#uniqueId(base)),
      ...extra,
      metadata: { ui: { x: Math.round(pos.x), y: Math.round(pos.y) } },
    };
    this.graph.nodes.push(node);
    // an entry node IS the start of the graph: we keep the `entry` field in
    // sync so that the entry point does not have to be assigned as a second
    // action
    if (node.type === "entry" && !this.#entryNodeId(node.id)) this.graph.entry = node.id;
    return node;
  }

  addNode(type, pos, extra = {}) {
    const node = this.#create({ type, extra }, pos);
    this.touch();
    return node;
  }

  /** A node at a canvas point (a double click, a drop from the palette). */
  createAt(spec, pos) {
    const node = avoidOverlap(this.graph, this.#create(spec, pos));
    this.touch();
    return node;
  }

  /** Link an order port of a node with a target (dragging a wire). */
  connect(fromId, portIndex, targetId) {
    if (!connectPort(this.graph, fromId, portIndex, targetId)) return false;
    this.touch();
    return true;
  }

  /** Create a node and connect it to a port right away: "pull a wire into
   * nowhere and pick what appears there" — the main way of assembling a graph. */
  createConnected(fromId, portIndex, spec, pos) {
    const node = this.#create(spec, pos);
    connectPort(this.graph, fromId, portIndex, node.id);
    avoidOverlap(this.graph, node);
    this.touch();
    return node;
  }

  /** Break a link: for a list port (`case`, a branch, `except`) the list item
   * itself disappears — a "branch into nowhere" cannot be represented in JSON. */
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

  /** Add a node after an existing one — into its first free port. That is how
   * a click on the palette works when a node is selected: the chain grows
   * downwards instead of piling up unconnected cards. */
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

  /** The id of another entry node in the current graph (there should be at
   * most one — a second is highlighted by validation). */
  #entryNodeId(exceptId) {
    return this.graph.nodes.find((n) => n.type === "entry" && n.id !== exceptId)?.id ?? null;
  }

  removeNode(id) {
    this.removeNodes([id]);
  }

  /** Delete several nodes at once: the references are scrubbed from everything
   * that remains, and there is a single event — otherwise a group deletion
   * would redraw the graph once per selected node. */
  removeNodes(ids) {
    const drop = new Set(ids);
    if (!drop.size) return;
    const graph = this.graph;
    graph.nodes = graph.nodes.filter((n) => !drop.has(n.id));
    for (const node of graph.nodes) {
      for (const id of drop) this.#scrubRefs(node, id);
    }
    // the entry point is gone — if an entry node is still in the graph the
    // start is just as obvious, no need to clear the field and make it be
    // assigned again
    if (drop.has(graph.entry)) graph.entry = this.#entryNodeId(null) ?? "";
    this.touch();
  }

  /** A snapshot of nodes for the clipboard: a copy of the JSON as it is, with
   * no references to the model — it can be pasted into another graph and after
   * other edits. */
  copyNodes(ids) {
    const want = new Set(ids);
    return this.graph.nodes.filter((n) => want.has(n.id)).map((n) => structuredClone(n));
  }

  /**
   * Pastes copies of nodes into the current graph. Returns the ids of what was
   * pasted.
   *
   * Three rules, without which a paste produces a broken graph:
   *  - ids are unique, and the references INSIDE the pasted set move onto the
   *    copies — otherwise a pasted branch would control the original;
   *  - a reference outwards is kept if such a node is in the graph (a copy of a
   *    branch still merges into the same place), and cleared if it is not: a
   *    paste into another subpipeline must not leave a reference into nowhere;
   *  - a second `entry` is not pasted: there is one entry point per graph, and
   *    such a node would be a validation error right away.
   *
   * @param at the top-left corner to paste at (world coordinates) or null —
   *           then the copies land offset from the originals.
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

    // the offset is shared by the whole set: the relative placement of the
    // copies is preserved
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

  /** Removes every reference of a node to a deleted id (a port with a list
   * item — by removing the item, a single one — by clearing it). */
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

// ----------------------------------------------------------- normalization

function normalizePipeline(data, spacing) {
  const pipeline = { ...emptyPipeline(), ...(data ?? {}) };
  pipeline.nodes ??= [];
  pipeline.subpipelines ??= {};
  normalizeGraph(pipeline, spacing);
  for (const sub of Object.values(pipeline.subpipelines)) {
    sub.nodes ??= [];
    normalizeGraph(sub, spacing);
  }
  return pipeline;
}

function normalizeGraph(graph, spacing) {
  let needsLayout = false;
  // the `entry` field is optional in the JSON if the start is given by an entry
  // node: we derive it right at load time — both the auto-layout and the
  // validation depend on it
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
    // the same shorthand the core accepts: a list of names means "keep the name"
    if (node.type === "map" && Array.isArray(node.collect)) {
      node.collect = Object.fromEntries(node.collect.map((name) => [name, name]));
    }
    if (!node.metadata.ui) needsLayout = true;
  }
  if (needsLayout) autoLayout(graph, spacing);
}

/**
 * The layout for graphs without saved coordinates:
 *
 * - Y gives the execution order: the BFS depth over order edges, top to bottom.
 * - X gives nesting and data flow: every area (the branches of `parallel`, the
 *   body of `try`, the body of `map`) gets a COLUMN of its own, and inside a
 *   column a node stands to the right of those whose variables it reads.
 *
 * Columns are not decoration but a guarantee: the frame of an area is drawn
 * around the bounds of its nodes, so an unrelated node that falls inside that
 * rectangle looks like part of the area — as if `try` caught its errors too.
 * While X was handed out by a common packing per level, strangers regularly
 * ended up inside (most often the `except` handlers: they stand at the level of
 * the body but are not part of that area). Separating them afterwards does not
 * work — on nested areas the pushing-out loops forever. Columns rule it out by
 * construction: a node lies in the column of its own area and in nobody else's.
 *
 * Columns are reused vertically: two blocks that follow one another occupy the
 * same column — the graph does not sprawl to the right with every `try` in a
 * chain.
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
  // The merge point of a parallel must be BELOW every node of its branches —
  // otherwise it stands at the same level as they do and lands inside the
  // branching area. We shift it together with everything after it; several
  // passes for the case of nested parallels.
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

  // Whom a writer reaches through control (with the implicit exits from
  // areas). The anchor needs this: if a reader stands BELOW a writer in the
  // flow, the wire already reads top to bottom — no reason to move the reader
  // right. Otherwise a chain of "everyone reads the previous one" walked off
  // across the whole canvas like a staircase.
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

  // ---------------------------------------------------------- columns

  // the group of a node is the tightest area it belongs to ("" — the root)
  const regions = computeRegions(graph, null); // sorted from the largest down
  const groupOf = new Map();
  for (const region of regions) {
    for (const id of region.members) groupOf.set(id, region.key);
  }

  // the tree of areas: the parent is the smallest of the strictly enclosing ones
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
   * The column of one group in its own coordinates.
   *
   * The nested areas are placed first — a block takes the left position and
   * the group's own nodes step aside to the right. The order is exactly that
   * because a block is the main road: the body of a `try` should read before
   * its `except` handlers rather than hide behind them (the handlers have their
   * own area with a bigger `rank`, so on shared levels they stand to the right
   * of the body). Returns the column width, the relative Xs and the range of
   * occupied levels.
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

    // nested areas go in bands from left to right; a band can be put under an
    // occupied one if their levels do not overlap (the frame only covers its
    // own levels, on foreign ones it is not there) — otherwise the graph would
    // drift right with every block
    const bands = [];
    const nested = regions
      .filter((region) => parentGroup.get(region.key) === key)
      .map((region) => ({ region, ...layoutGroup(region.key) }))
      // at equal levels the area with the smaller rank goes left: the body of a
      // `try` reads before its `except` handlers
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

    /** Shifts a node right while it climbs onto a band of its own level. */
    const clearBands = (x, width, lvl) => {
      for (let step = 0; step <= bands.length; step += 1) {
        const hit = bands.find((b) => b.minLevel <= lvl && b.maxLevel >= lvl
          && x < b.x + b.width + GAP_X && x + width + GAP_X > b.x);
        if (!hit) break;
        x = hit.x + hit.width + GAP_X;
      }
      return x;
    };

    // the left bound of a node: not left of whoever handed control to it, and
    // right of the writers ACROSS the flow — those the node's control never
    // reaches. Data along the flow (which is almost all of it) already reads
    // top to bottom.
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
      // those whom the data pulls further left go first — otherwise the
      // neighbours crowd them out
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

  // Y is shared by the whole graph: a level takes as much as the tallest card
  // on it needs
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
