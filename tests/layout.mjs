/**
 * Checking the auto-layout by enumerating random graphs.
 *
 * Two invariants that cannot be caught by eye:
 *
 *  1. no foreign node falls inside the frame of an area (otherwise it looks as
 *     if `try` catches its errors too, and `parallel` runs it in a branch);
 *  2. the cards do not climb onto one another;
 *
 * plus idempotence: laying out again must move nothing.
 *
 * Run: node tests/layout.mjs
 */
import { autoLayout } from "../js/model.js";
import { computeRegions, regionBounds } from "../js/regions.js";
import { nodeLayout } from "../js/geometry.js";

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (list) => list[Math.floor(rnd() * list.length)];

/** A random pipeline: chains of stage/condition/parallel/try, areas nested. */
function randomPipeline(budget) {
  const nodes = [];
  let counter = 0;
  const id = (prefix) => `${prefix}${counter++}`;

  // builds a chain of length len whose tails all lead into `after`; returns its entry
  const chain = (len, after, depth) => {
    let next = after;
    for (let i = 0; i < len; i += 1) {
      const kind = depth > 2 ? "stage" : pick(["stage", "stage", "condition", "parallel", "try"]);
      if (kind === "condition") {
        nodes.push({ id: id("c"), type: "condition", condition: "vars.v0 > 1",
          then: chain(1 + Math.floor(rnd() * 2), next, depth + 1), else: next });
      } else if (kind === "parallel") {
        const branches = [];
        for (let b = 0; b < 2 + Math.floor(rnd() * 2); b += 1) {
          branches.push({ id: `b${b}`, entry: chain(1 + Math.floor(rnd() * 2), null, depth + 1) });
        }
        nodes.push({ id: id("p"), type: "parallel", branches, next });
      } else if (kind === "try") {
        nodes.push({ id: id("t"), type: "try",
          body: chain(1 + Math.floor(rnd() * 2), null, depth + 1),
          except: [{ error_equals: ["*"], next: chain(1, next, depth + 1), result_var: "err" }],
          next });
      } else {
        nodes.push({ id: id("s"), type: "stage", stage: "Step",
          arguments: { vars: { src: `v${Math.floor(rnd() * 3)}` } },
          outputs: { result: `v${Math.floor(rnd() * 3)}` }, next });
      }
      next = nodes[nodes.length - 1].id;
    }
    return next;
  };

  const entry = chain(budget, null, 0);
  return { entry, nodes };
}

function violations(graph) {
  const found = [];
  const size = new Map(graph.nodes.map((n) => [n.id, nodeLayout(n)]));
  const box = (node) => ({ ...node.metadata.ui, ...size.get(node.id) });
  const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;

  for (const region of computeRegions(graph, null)) {
    const frame = regionBounds(region, graph, (n) => size.get(n.id));
    if (!frame) continue;
    for (const node of graph.nodes) {
      if (region.members.has(node.id) || node.id === region.ownerId) continue;
      if (overlap(box(node), frame)) found.push(`foreign ${node.id} inside the frame of ${region.ownerId}`);
    }
  }
  for (const a of graph.nodes) {
    for (const b of graph.nodes) {
      if (a.id < b.id && overlap(box(a), box(b))) found.push(`overlap ${a.id}/${b.id}`);
    }
  }
  return found;
}

const snapshot = (graph) =>
  graph.nodes.map((n) => `${n.id}:${n.metadata.ui.x},${n.metadata.ui.y}`).join("|");

let checked = 0;
let failed = 0;
let biggest = 0;
for (let i = 0; i < 300; i += 1) {
  const graph = randomPipeline(2 + Math.floor(rnd() * 4));
  if (graph.nodes.length < 3) continue;
  checked += 1;
  biggest = Math.max(biggest, graph.nodes.length);

  autoLayout(graph);
  const problems = violations(graph);
  const before = snapshot(graph);
  autoLayout(graph);
  if (snapshot(graph) !== before) problems.push("the layout is not idempotent");

  if (problems.length) {
    failed += 1;
    if (failed <= 3) console.error(`graph #${i} (${graph.nodes.length} nodes):`, problems.slice(0, 5));
  }
}

console.log(`graphs checked: ${checked}, largest: ${biggest} nodes, with violations: ${failed}`);
process.exit(failed ? 1 : 0);
