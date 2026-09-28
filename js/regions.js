/**
 * Regions — visual areas around the nodes that belong to one owner: the
 * branches of `parallel`, the body of `try` and its `except` handlers, the
 * body of `map`.
 *
 * There are no regions in the pipeline JSON, and there should not be:
 * membership is derived from the graph — the nodes reachable from the entries
 * of the area along order edges, but NOT reachable from the exit point (the
 * owner's `next`). So a region cannot diverge from the real structure: move an
 * edge and the area is recomputed. This is exactly how the core computes the
 * scope of a `try` block (see TryNode.scope).
 */
import { kindOf } from "./kinds.js";

/** Nodes reachable along order edges from `starts`, not entering `stopAt`. */
export function reachable(graph, starts, stopAt = new Set()) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id) || stopAt.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    for (const port of kindOf(node).orderPorts(node)) {
      const target = port.get?.();
      if (target) queue.push(target);
    }
  }
  return seen;
}

/**
 * The regions of the current graph: `[{key, ownerId, rank, title, members: Set,
 * color}]`, sorted from the largest to the smallest — that way nested areas are
 * drawn on top of the enclosing ones.
 *
 * One node can own several areas (`regionGroups`): for `try` those are the body
 * and the handlers. They are computed in turn and do not intersect — a node
 * reachable from both stays with the first one, that is, with the body. `key`
 * is unique per graph: the layout tells columns apart by it, and the canvas
 * tells frames apart.
 */
export function computeRegions(graph, env) {
  const regions = [];
  for (const node of graph.nodes) {
    const kind = kindOf(node);
    const groups = kind.regionGroups(node);
    if (!groups?.length) continue;

    // the exit point and everything after it are not part of the area
    const taken = node.next ? reachable(graph, [node.next]) : new Set();
    for (const group of groups) {
      const members = reachable(graph, group.entries ?? [], taken);
      members.delete(node.id);
      if (!members.size) continue;
      for (const id of members) taken.add(id);

      regions.push({
        key: group.key ? `${node.id}:${group.key}` : node.id,
        ownerId: node.id,
        rank: group.rank ?? 0,
        title: group.title ? `${node.id} · ${group.title}` : node.id,
        glyph: group.glyph ?? kind.glyph,
        members,
        color: group.color ?? kind.accent(node, env),
      });
    }
  }
  regions.sort((a, b) => b.members.size - a.members.size);
  return regions;
}

/** Bounds of an area from the placement of its nodes; null if none was found. */
export function regionBounds(region, graph, layoutOf, padding = 20, labelSpace = 20) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of graph.nodes) {
    if (!region.members.has(node.id)) continue;
    const { x, y } = node.metadata.ui;
    const { width, height } = layoutOf(node);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  if (minX === Infinity) return null;
  return {
    x: minX - padding,
    y: minY - padding - labelSpace,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2 + labelSpace,
  };
}
