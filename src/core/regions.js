/**
 * Regions: the areas drawn around nodes that belong to a block (`parallel`
 * branches, a `try` body and its handlers, a `map` body).
 *
 * They are not stored in the JSON but derived from the graph: the nodes
 * reachable from the block's entries along order edges, but not from its
 * exit (the owner's `next`). The core computes a `try` scope the same way
 * (TryNode.scope).
 */
import { crossesBox } from "./geometry.js";
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
 * The regions of a graph: `[{key, ownerId, rank, title, members: Set,
 * color}]`, largest first so nested regions are drawn on top.
 *
 * A node may own several regions (`regionGroups`), e.g. a `try` body and its
 * handlers. They do not overlap: a node reachable from both belongs to the
 * first. `key` is unique per graph; layout and canvas tell regions apart by
 * it.
 */
export function computeRegions(graph, env) {
  const regions = [];
  for (const node of graph.nodes) {
    const kind = kindOf(node);
    const groups = kind.regionGroups(node);
    if (!groups?.length) continue;

    // the exit and everything after it are outside the region
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

/** A region's bounds from its nodes' positions, or null if it has none. */
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

/**
 * The region an order edge skips: a loop body for the loop's `next`, a `try`
 * body for what follows the block. `orderEdgePath` routes such edges around
 * the region instead of behind its cards.
 *
 * Only this node's regions count, only those the target is not in (an edge
 * into the body enters it), and only those in the way (`except` handlers sit
 * beside the body, not below it). The remaining ones are merged into one box.
 *
 * @param regions as returned by `computeRegions`, each with a `box`
 */
function inside(p, box) {
  return p.x > box.x && p.x < box.right && p.y > box.y && p.y < box.bottom;
}

export function skippedArea(regions, ownerId, targetId, from, to) {
  const boxes = (regions ?? [])
    .filter((r) => r.ownerId === ownerId && r.box && !r.members.has(targetId))
    .map((r) => ({
      ...r.box,
      right: r.box.x + r.box.width,
      bottom: r.box.y + r.box.height,
    }))
    // a wire that ends inside the block (its target sits within the frame
    // though not part of the body) cannot go around it: a detour would only
    // run to the side lane and cut back across the frame
    .filter((box) => !inside(to, box) && !inside(from, box))
    .filter((box) => crossesBox(from, to, box));
  if (!boxes.length) return null;
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.min(...boxes.map((b) => b.y)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}
