/**
 * Data flows: which node actually supplies a variable to the one that reads it.
 *
 * There are no data links in the pipeline JSON — the memory of StageFlow is a
 * shared frame, a variable is not "a wire from A to B" but an entry in it.
 * The editor used to draw every writer × reader pair of one name, and on a
 * graph of a dozen nodes that produced a tangle: long curves across half the
 * canvas, most of them a lie. A lie because a reader sees NOT all the writes
 * but the last one that happened before it in execution order.
 *
 * That is what is computed here: for every read we look for the NEAREST
 * writers — a backwards walk over the order graph from the reader that stops
 * at the first writer of that variable it meets. Branching gives several
 * nearest ones (one per path) — which is honest: on different paths the value
 * arrives from different nodes.
 *
 * A writer with no path to the reader in execution order (the graph is not
 * assembled yet, or the node is detached) is not discarded — the link is
 * marked `ordered: false` and drawn dashed: "the names match, but the order is
 * undefined".
 */
import { kindOf } from "./kinds.js";
import { computeRegions } from "./regions.js";

/** Write ports by variable: name -> [{id, index}] (one per node). */
function writerPorts(graph) {
  const byVar = new Map();
  for (const node of graph.nodes) {
    kindOf(node).dataOuts(node).forEach((out, index) => {
      const key = out.variable.name;
      const list = byVar.get(key) ?? byVar.set(key, []).get(key);
      if (!list.some((w) => w.id === node.id)) list.push({ id: node.id, index });
    });
  }
  return byVar;
}

/**
 * The order edges of the graph: node -> whom it can hand control to.
 *
 * Besides the edges from the JSON this counts the IMPLICIT transitions:
 * leaving an area (`parallel` — branches merging, `try` — the body finishing
 * normally) leads into the owner's `next`, even though there is no such edge
 * in the pipeline. Without them the last node of a branch would not count as
 * an ancestor of whoever reads its variable after the merge.
 *
 * Auto-layout uses the same graph: if a writer lies on the path to a reader,
 * the wire already goes top to bottom.
 */
export function controlSuccessors(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const succs = new Map(graph.nodes.map((n) => [n.id, new Set()]));
  const targetsOf = (node) => kindOf(node).orderPorts(node)
    .map((port) => port.get?.())
    .filter(Boolean);

  for (const node of graph.nodes) {
    for (const target of targetsOf(node)) {
      if (succs.has(target)) succs.get(node.id).add(target);
    }
  }

  for (const region of computeRegions(graph, null)) {
    const next = byId.get(region.ownerId)?.next;
    if (!next || !succs.has(next)) continue;
    for (const id of region.members) {
      const node = byId.get(id);
      // the tail of an area — the one after which control leaves it
      if (node && !targetsOf(node).some((t) => region.members.has(t))) {
        succs.get(id).add(next);
      }
    }
  }
  return succs;
}

/** Reversed order edges: node -> who can hand control to it. */
function predecessors(graph) {
  const preds = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const [id, targets] of controlSuccessors(graph)) {
    for (const target of targets) preds.get(target)?.push(id);
  }
  return preds;
}

/**
 * The nearest writers of a variable upstream: a breadth-first walk backwards
 * that does not pass THROUGH a writer — that one shadows everything before it
 * with its own write.
 */
function nearestWriters(readerId, writers, preds) {
  const byId = new Map(writers.map((w) => [w.id, w]));
  const found = [];
  const seen = new Set([readerId]);
  let frontier = [...(preds.get(readerId) ?? [])];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const writer = byId.get(id);
      if (writer) found.push(writer);
      else next.push(...(preds.get(id) ?? []));
    }
    frontier = next;
  }
  return found;
}

/**
 * The data links of the current graph:
 * `[{name, writerId, outIndex, readerId, inIndex, ordered}]`.
 * The port indices are the same ones the canvas uses to compute attachment
 * points.
 */
export function dataLinks(graph) {
  const byVar = writerPorts(graph);
  const preds = predecessors(graph);
  const links = [];

  for (const reader of graph.nodes) {
    kindOf(reader).dataIns(reader).forEach((input, inIndex) => {
      const done = new Set();
      for (const ref of input.refs ?? []) {
        const key = ref.name;
        if (done.has(key)) continue;
        done.add(key);
        const all = (byVar.get(key) ?? []).filter((w) => w.id !== reader.id);
        if (!all.length) continue;

        const near = nearestWriters(reader.id, all, preds);
        const ordered = near.length > 0;
        for (const writer of ordered ? near : all) {
          links.push({
            name: ref.name,
            writerId: writer.id, outIndex: writer.index,
            readerId: reader.id, inIndex, ordered,
          });
        }
      }
    });
  }
  return links;
}

/**
 * The variable names occurring in the graph: both written and read. The
 * inspector offers them when a variable is picked — the name is chosen with
 * the mouse rather than typed, so a typo does not silently create a second
 * variable.
 */
export function variablesOf(graph) {
  const seen = new Set();
  for (const node of graph.nodes) {
    const kind = kindOf(node);
    for (const out of kind.dataOuts(node)) seen.add(out.variable.name);
    for (const port of kind.dataIns(node)) {
      for (const ref of port.refs ?? []) seen.add(ref.name);
    }
  }
  return [...seen].sort();
}

/** Data links folded for auto-layout: reader -> Set(writers). */
export function writersOf(graph) {
  const map = new Map(graph.nodes.map((n) => [n.id, new Set()]));
  for (const link of dataLinks(graph)) map.get(link.readerId)?.add(link.writerId);
  return map;
}
