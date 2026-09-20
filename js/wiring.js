/**
 * Connecting nodes: the graph operations the mouse performs.
 *
 * A node editor is not assembled by "add a node — open a panel — type the id
 * of the neighbour" but by movement: pull a wire out of a port, let go, pick
 * what to create there. For this to work the same way for every kind of node,
 * two things have to be known about a node that are not in the JSON:
 *
 *  - which port CONTINUES the flow (`continuationIndex`) — the new node picks
 *    up whatever went on through it when it is inserted into an edge;
 *  - which port of a node is FREE (`freePortIndex`) — the next node added with
 *    this one selected attaches to it.
 *
 * Both answers come from the node kind itself (`orderPorts` + `continuationKey`
 * / `appendKey`, matched by the stable port `key`, never by the visible label),
 * so a new node type requires no changes either here or on the canvas.
 *
 * The functions are pure: they take a graph, change it, and know nothing about
 * the DOM or the model — which is why they are checked in `tests/wiring.mjs`.
 */
import { nodeLayout } from "./geometry.js";
import { kindOf } from "./kinds.js";
import { reachable } from "./regions.js";

const GAP = { gapX: 110, gapY: 120 };

function portsOf(node) {
  return kindOf(node).orderPorts(node);
}

function nodeById(graph, id) {
  return graph.nodes.find((n) => n.id === id);
}

/**
 * The port through which a node continues the execution flow: `next`, and for
 * branching kinds the one that leads down the main road (`then` for condition,
 * `body` for try). It is the one that picks up the former target when the node
 * is inserted into an edge: insert a `try` between A and B and B becomes the
 * body of the block, not what follows it. `-1` — there is nothing to continue
 * with (terminal).
 */
export function continuationIndex(node) {
  const kind = kindOf(node);
  const ports = portsOf(node);
  const key = kind.continuationKey(node);
  const named = ports.findIndex((port) => !port.add && port.key === key);
  return named >= 0 ? named : ports.findIndex((port) => !port.add && port.set);
}

/** Whether a node of this type can be inserted into an edge. */
export function canContinue(type, extra = {}) {
  const node = { ...kindOf({ type }).defaults("tmp"), ...extra };
  return continuationIndex(node) >= 0;
}

/**
 * The port the next node should sensibly attach to: a free continuation,
 * otherwise any unoccupied port, otherwise a list button (`+ case`,
 * `+ branch`, `+ except`) — that one creates a free slot itself. `-1` — there
 * is nothing to attach to.
 */
export function freePortIndex(node) {
  const ports = portsOf(node);
  // the node kind says itself what it is missing first: an empty `parallel`
  // needs a branch, not a `next` after the merge
  const wanted = ports.findIndex((port) => port.key === kindOf(node).appendKey(node));
  if (wanted >= 0 && (ports[wanted].add ? ports[wanted].drop : !ports[wanted].get?.())) return wanted;
  const idle = ports.findIndex((port) => !port.add && port.set && !port.get?.());
  if (idle >= 0) return idle;
  return ports.findIndex((port) => port.add && port.drop);
}

/** Links a port of a node with a target; a list port (`+ case`) creates a new
 * list item. Works with a node that is not in the graph yet — inserting into
 * an edge links the new node before it gets there. */
export function connectNode(node, portIndex, targetId) {
  const port = node && portsOf(node)[portIndex];
  if (!port) return false;
  if (port.drop) port.drop(targetId);
  else if (port.set) port.set(targetId);
  else return false;
  return true;
}

/** The same, by the node id in the graph. */
export function connectPort(graph, fromId, portIndex, targetId) {
  return connectNode(nodeById(graph, fromId), portIndex, targetId);
}

/** Where the port leads right now (a list button leads nowhere). */
export function portTarget(graph, fromId, portIndex) {
  const node = nodeById(graph, fromId);
  return node ? portsOf(node)[portIndex]?.get?.() ?? null : null;
}

/** The size of a node (without the description — its size depends on the
 * specs, and a minimal estimate is enough for the layout). */
function sizeOf(node) {
  const { width, height } = nodeLayout(node);
  return { width, height };
}

function boxOf(node) {
  const { x, y } = node.metadata?.ui ?? { x: 0, y: 0 };
  const { width, height } = sizeOf(node);
  return { x, y, width, height };
}

function overlaps(a, b, pad = 16) {
  return a.x < b.x + b.width + pad && a.x + a.width + pad > b.x
    && a.y < b.y + b.height + pad && a.y + a.height + pad > b.y;
}

/**
 * Shifts a node to the right while it lies on top of somebody else. A new node
 * appears where it was called for (under its predecessor, at the cursor), and
 * it must not cover a neighbour — otherwise it is "added and lost".
 */
export function avoidOverlap(graph, node) {
  const others = graph.nodes.filter((n) => n !== node).map(boxOf);
  const box = boxOf(node);
  for (let step = 0; step < 40; step += 1) {
    const hit = others.find((other) => overlaps(box, other));
    if (!hit) break;
    box.x = hit.x + hit.width + GAP.gapX;
  }
  node.metadata.ui.x = Math.round(box.x);
  return node;
}

/**
 * Frees space under the node `afterId`: both the tail of the chain (everything
 * reachable from it in order) and everything that simply lies below move down
 * by `amount`.
 *
 * The second condition is not redundant: the tail is what an insertion moves
 * by meaning, but the new node can also bump into an unrelated node that
 * happens to be under it on the canvas. A whole band moves, not a branch, so
 * the relative placement of neighbours is preserved — unlike pushing sideways.
 */
export function pushDown(graph, afterId, amount, keep = new Set()) {
  if (amount <= 0) return;
  const fromY = nodeById(graph, afterId)?.metadata?.ui?.y ?? 0;
  const tail = reachable(graph, [afterId]);
  for (const node of graph.nodes) {
    if (keep.has(node.id) || !node.metadata?.ui) continue;
    if (!tail.has(node.id) && node.metadata.ui.y < fromY) continue;
    node.metadata.ui.y = Math.round(node.metadata.ui.y + amount);
  }
}

/**
 * Inserts a ready node into an edge: A→B becomes A→N→B. The node stands
 * between them, and the tail of the graph moves down far enough for it to fit.
 * Returns false if the node has nothing to continue the flow with.
 */
export function insertBetween(graph, fromId, portIndex, node, spacing = {}) {
  const { gapY } = { ...GAP, ...spacing };
  const source = nodeById(graph, fromId);
  const targetId = portTarget(graph, fromId, portIndex);
  const cont = continuationIndex(node);
  if (!source || !targetId || cont < 0) return false;

  const target = nodeById(graph, targetId);
  connectPort(graph, fromId, portIndex, node.id);
  connectNode(node, cont, targetId);

  const from = boxOf(source);
  const to = target ? boxOf(target) : null;
  const size = sizeOf(node);
  node.metadata.ui = {
    x: Math.round(to ? (from.x + to.x) / 2 : from.x),
    y: Math.round(to
      ? Math.max(from.y + from.height + gapY / 2, (from.y + from.height + to.y - size.height) / 2)
      : from.y + from.height + gapY),
  };
  if (to) {
    const need = node.metadata.ui.y + size.height + gapY - to.y;
    pushDown(graph, targetId, need, new Set([fromId, node.id]));
  }
  return true;
}

/** Places a node after `fromId` — below it, without climbing on neighbours. */
export function placeAfter(graph, fromId, node, spacing = {}) {
  const { gapY } = { ...GAP, ...spacing };
  const source = nodeById(graph, fromId);
  const from = source ? boxOf(source) : { x: 60, y: 60, width: 0, height: 0 };
  node.metadata.ui = { x: Math.round(from.x), y: Math.round(from.y + from.height + gapY) };
  return avoidOverlap(graph, node);
}
