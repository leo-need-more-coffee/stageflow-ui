/**
 * Connecting nodes: the graph operations behind the mouse gestures.
 *
 * Two things about a node are needed that the JSON does not say:
 *  - which port continues the flow (`continuationIndex`): inserted into an
 *    edge, the node takes over the edge's target on that port;
 *  - which port is free (`freePortIndex`): the next node added while this one
 *    is selected attaches there.
 *
 * Both come from the node kind (`orderPorts` with `continuationKey` /
 * `appendKey`, matched by port `key`), so a new node type needs no changes
 * here or on the canvas.
 *
 * The functions are pure: they change a graph and know nothing of the DOM or
 * the model (see `tests/wiring.mjs`).
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
 * The port that continues the flow: `next`, or the main road of a branching
 * kind (`then` of a condition, `body` of a try). Inserted into an edge, the
 * node takes the old target on this port, so a `try` inserted between A and
 * B gets B as its body. `-1` if there is none (terminal).
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
 * The port the next node should attach to: a free continuation, else any free
 * port, else a list button (`+ case`, `+ branch`, `+ except`) that makes a new
 * slot. `-1` if there is none.
 */
export function freePortIndex(node) {
  const ports = portsOf(node);
  // the kind says what it needs first: an empty `parallel` needs a branch,
  // not a `next`
  const wanted = ports.findIndex((port) => port.key === kindOf(node).appendKey(node));
  if (wanted >= 0 && (ports[wanted].add ? ports[wanted].drop : !ports[wanted].get?.())) return wanted;
  const idle = ports.findIndex((port) => !port.add && port.set && !port.get?.());
  if (idle >= 0) return idle;
  return ports.findIndex((port) => port.add && port.drop);
}

/** Connect a port to a target; a list port (`+ case`) adds a list item. Works
 * on a node not yet in the graph, as when inserting into an edge. */
export function connectNode(node, portIndex, targetId) {
  const port = node && portsOf(node)[portIndex];
  if (!port) return false;
  if (port.drop) port.drop(targetId);
  else if (port.set) port.set(targetId);
  else return false;
  return true;
}

/** `connectNode` by node id. */
export function connectPort(graph, fromId, portIndex, targetId) {
  return connectNode(nodeById(graph, fromId), portIndex, targetId);
}

/** Where a port leads now (a list button leads nowhere). */
export function portTarget(graph, fromId, portIndex) {
  const node = nodeById(graph, fromId);
  return node ? portsOf(node)[portIndex]?.get?.() ?? null : null;
}

/** A node's size without its description, which depends on specs; a lower
 * bound is enough for placement. */
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
 * Move a node right until it no longer covers another, so a new node does not
 * hide its neighbour.
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
 * Make room below `afterId`: move down by `amount` both the chain after it
 * (everything reachable in order) and anything else lying below it. Moving the
 * whole band keeps neighbours' relative positions.
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
 * Insert a node into an edge: A→B becomes A→N→B, and the rest of the graph
 * moves down to make room. Returns false if the node cannot continue the flow.
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

/** Place a node below `fromId` without covering its neighbours. */
export function placeAfter(graph, fromId, node, spacing = {}) {
  const { gapY } = { ...GAP, ...spacing };
  const source = nodeById(graph, fromId);
  const from = source ? boxOf(source) : { x: 60, y: 60, width: 0, height: 0 };
  node.metadata.ui = { x: Math.round(from.x), y: Math.round(from.y + from.height + gapY) };
  return avoidOverlap(graph, node);
}
