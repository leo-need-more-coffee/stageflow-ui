/**
 * Connecting nodes with the mouse: the properties that must hold for EVERY
 * node kind, not only for the ones the editor was clicked on by hand.
 *
 * The canvas knows exactly two facts about a node — "which port continues the
 * flow" and "which port is free" (`js/wiring.js`) — and both are computed from
 * `orderPorts`. So a new node kind breaks connecting silently: a wire drops
 * into nowhere, and an insertion loses the tail of the graph. Here that is
 * caught by enumeration.
 *
 * Checked:
 *  - every kind has a port the next node attaches to (except `terminal` — it
 *    has nothing to continue with), and connecting through it really leaves a
 *    reference in the JSON;
 *  - inserting into an edge keeps the chain: A→B becomes A→N→B, and B is still
 *    reachable from A;
 *  - `terminal` is not inserted into an edge, and the graph is not damaged by
 *    the refusal;
 *  - the cards do not overlap after an insertion or an append.
 *
 * Run: node tests/wiring.mjs
 */
import { nodeLayout } from "../js/geometry.js";
import { KINDS, kindOf } from "../js/kinds.js";
import { reachable } from "../js/regions.js";
import {
  canContinue, connectPort, continuationIndex, freePortIndex, insertBetween, placeAfter,
} from "../js/wiring.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

function make(type, id, pos = { x: 0, y: 0 }) {
  return { ...kindOf({ type }).defaults(id), metadata: { ui: { ...pos } } };
}

/** An "a → b" graph of two stages plus an unrelated node below them: an
 * insertion must drop the new node neither onto the tail of the chain nor onto
 * the neighbour underneath. */
function chain() {
  const a = make("stage", "a", { x: 0, y: 0 });
  const b = make("stage", "b", { x: 0, y: 220 });
  const loose = make("terminal", "loose", { x: 40, y: 430 });
  a.next = "b";
  return { entry: "a", nodes: [a, b, loose] };
}

/** Every target of the order ports of a node — what really got into the JSON. */
function targets(node) {
  return kindOf(node).orderPorts(node).map((port) => port.get?.()).filter(Boolean);
}

function boxes(graph) {
  return graph.nodes.map((node) => {
    const { width, height } = nodeLayout(node);
    return { id: node.id, ...node.metadata.ui, width, height };
  });
}

function overlapping(graph) {
  const list = boxes(graph);
  const hits = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y) hits.push(`${a.id}/${b.id}`);
    }
  }
  return hits;
}

// ------------------------------------- "where the next node attaches"

for (const [type] of KINDS) {
  const node = make(type, "n");
  const index = freePortIndex(node);

  if (type === "terminal") {
    check(index < 0, "terminal: there is nothing to attach to, yet a port was found");
    check(!canContinue(type), "terminal: inserting into an edge must be forbidden");
    continue;
  }

  check(index >= 0, `${type}: no free port found for the next node`);
  if (index < 0) continue;

  const graph = { entry: "n", nodes: [node, make("stage", "t", { x: 0, y: 220 })] };
  check(connectPort(graph, "n", index, "t"), `${type}: connecting through the free port did not work`);
  check(targets(node).includes("t"), `${type}: the link did not get into the node JSON`);

  // the port is taken — the next node must find another one (or honestly say
  // there is nowhere)
  const again = freePortIndex(node);
  check(again !== index || kindOf(node).orderPorts(node)[index].add,
    `${type}: an occupied port was offered as free again`);
}

// --------------------------------------------- inserting into an edge

for (const [type] of KINDS) {
  if (type === "entry") continue; // there is no going into the entry point
  const graph = chain();
  const node = make(type, "mid");
  const done = insertBetween(graph, "a", 0, node);

  if (!canContinue(type)) {
    check(!done, `${type}: an insertion without a continuation should have been refused`);
    check(graph.nodes[0].next === "b", `${type}: the refused insertion damaged the edge`);
    continue;
  }

  graph.nodes.push(node);
  check(done, `${type}: the insertion into the edge did not happen`);
  check(graph.nodes[0].next === "mid", `${type}: the source did not switch to the new node`);
  check(targets(node).includes("b"), `${type}: the new node did not pick up the former target`);
  check(reachable(graph, ["a"]).has("b"), `${type}: the tail of the graph was lost after the insertion`);
  check(!overlapping(graph).length,
    `${type}: the cards overlapped after the insertion: ${overlapping(graph).join(", ")}`);
}

// the continuation is chosen by the meaning of the kind, not by the first port
// that turns up
{
  const key = (type) => {
    const node = make(type, "n");
    return kindOf(node).orderPorts(node)[continuationIndex(node)]?.key;
  };
  check(key("stage") === "next", "stage: the continuation must go into next");
  check(key("condition") === "then", "condition: the continuation must go into then");
  check(key("try") === "body", "try: an inserted block must take the target into its body");
}

// ------------------------------------------------------ appending after

for (const [type] of KINDS) {
  if (type === "terminal") continue;
  const graph = chain();
  const node = make(type, "extra");
  graph.nodes.push(node);
  placeAfter(graph, "a", node);
  const index = freePortIndex(graph.nodes[0]);
  if (index >= 0) connectPort(graph, "a", index, "extra");
  check(!overlapping(graph).length,
    `${type}: the appended node landed on a neighbour: ${overlapping(graph).join(", ")}`);
  check(node.metadata.ui.y > graph.nodes[0].metadata.ui.y,
    `${type}: the appended node stood above its predecessor`);
}

// ------------------------------- a repeated insertion into the same chain

{
  const graph = chain();
  for (const id of ["m1", "m2", "m3"]) {
    const node = make("stage", id);
    check(insertBetween(graph, "a", 0, node), `the repeated insertion of ${id} did not happen`);
    graph.nodes.push(node);
  }
  check(reachable(graph, ["a"]).has("b"), "the tail of the graph was lost after three insertions");
  check(!overlapping(graph).length,
    `the cards overlapped after three insertions: ${overlapping(graph).join(", ")}`);
}

if (failed) {
  console.error(`wiring: ${failed} violations out of ${checked} checks`);
  process.exit(1);
}
console.log(`wiring: ${checked} checks, the ports and edge insertion hold`);
