/**
 * Data flow: which node supplies a variable to the node that reads it.
 *
 * The JSON has no data links: a variable is an entry in the shared frame, and
 * a reader sees the last write before it in execution order, not every write.
 * So for each read the nearest writers are found by walking the order graph
 * backwards from the reader, stopping at the first writer on each path.
 * Branches can give several.
 *
 * A writer with no path to the reader (an unfinished or detached graph) is
 * kept as `ordered: false` and drawn dashed: the names match, the order is
 * undefined.
 */
import { kindOf } from "./kinds.js";
import { computeRegions } from "./regions.js";

/** Write ports by variable: name -> [{id, index}], one per node. */
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
 * Order edges: node -> the nodes it can pass control to.
 *
 * Includes the implicit edges out of a region: when `parallel` branches merge
 * or a `try`/`map` body finishes, control goes to the owner's `next`. Without
 * them the last node of a branch would not count as upstream of a read after
 * the merge. Auto-layout uses the same graph.
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
      // the last node of a region, where control leaves it
      if (node && !targetsOf(node).some((t) => region.members.has(t))) {
        succs.get(id).add(next);
      }
    }
  }
  return succs;
}

/** Reversed order edges: node -> the nodes that can pass control to it. */
function predecessors(graph) {
  const preds = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const [id, targets] of controlSuccessors(graph)) {
    for (const target of targets) preds.get(target)?.push(id);
  }
  return preds;
}

/**
 * The nearest upstream writers of a variable: a backwards breadth-first walk
 * that stops at each writer, since a write hides everything before it.
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
 * The data links of a graph: `[{name, writerId, outIndex, readerId, inIndex,
 * ordered}]`, with the port indices the canvas uses.
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
 * Every variable name the graph writes or reads. The inspector offers them
 * for picking, so a typo does not create a second variable.
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

/** Data links grouped for auto-layout: reader -> Set(writers). */
export function writersOf(graph) {
  const map = new Map(graph.nodes.map((n) => [n.id, new Set()]));
  for (const link of dataLinks(graph)) map.get(link.readerId)?.add(link.writerId);
  return map;
}
