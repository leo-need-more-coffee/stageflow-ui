/**
 * Checking the auto-layout by enumerating random graphs.
 *
 * Two invariants that cannot be caught by eye:
 *
 *  1. no foreign node falls inside the frame of an area (otherwise it looks as
 *     if `try` catches its errors too, and `parallel` runs it in a branch);
 *  2. the cards do not climb onto one another;
 *  3. an order edge that steps OVER an area does not run across the cards
 *     inside it — a wire hidden behind a card is a wire that cannot be seen,
 *     hovered or cut, and the card it hides behind looks like its target;
 *
 * plus idempotence: laying out again must move nothing.
 *
 * Run: node tests/layout.mjs
 */
import "./_catalog.mjs";
import { PipelineModel, autoLayout } from "../js/model.js";
import { computeRegions, regionBounds, skippedArea } from "../js/regions.js";
import { nodeLayout, orderEdgePath } from "../js/geometry.js";

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (list) => list[Math.floor(rnd() * list.length)];

/** A random pipeline: chains of stage/condition/parallel/try/map, areas nested. */
function randomPipeline(budget) {
  const nodes = [];
  let counter = 0;
  const id = (prefix) => `${prefix}${counter++}`;

  // builds a chain of length len whose tails all lead into `after`; returns its entry
  const chain = (len, after, depth) => {
    let next = after;
    for (let i = 0; i < len; i += 1) {
      const kind = depth > 2
        ? "stage"
        : pick(["stage", "stage", "condition", "parallel", "try", "map"]);
      if (kind === "condition") {
        nodes.push({ id: id("c"), type: "condition", condition: "vars.v0 > 1",
          then: chain(1 + Math.floor(rnd() * 2), next, depth + 1), else: next });
      } else if (kind === "parallel") {
        const branches = [];
        for (let b = 0; b < 2 + Math.floor(rnd() * 2); b += 1) {
          branches.push({ id: `b${b}`, entry: chain(1 + Math.floor(rnd() * 2), null, depth + 1) });
        }
        nodes.push({ id: id("p"), type: "parallel", branches, next });
      } else if (kind === "map") {
        // the body of a loop is closed: its chain leads nowhere, like a branch
        nodes.push({ id: id("m"), type: "map", items: "vars.v0", item_var: "it",
          body: chain(1 + Math.floor(rnd() * 2), null, depth + 1),
          collect: { v1: "v2" }, next });
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

/** The points of a path of the shape `M … C …` or `M … C … L … C …` — the only
 * two `orderEdgePath` produces. The numbers are read in order, so a command
 * consumes as many as it takes. */
function samplePath(d, per = 24) {
  const tokens = d.match(/[MCL]|-?\d+(?:\.\d+)?/g) ?? [];
  const points = [];
  let at = null;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") { at = { x: num(), y: num() }; points.push(at); continue; }
    if (cmd === "L") {
      const to = { x: num(), y: num() };
      for (let k = 1; k <= per; k += 1) {
        points.push({ x: at.x + (to.x - at.x) * (k / per), y: at.y + (to.y - at.y) * (k / per) });
      }
      at = to;
      continue;
    }
    const p1 = { x: num(), y: num() };
    const p2 = { x: num(), y: num() };
    const p3 = { x: num(), y: num() };
    for (let k = 1; k <= per; k += 1) {
      const t = k / per;
      const u = 1 - t;
      points.push({
        x: u * u * u * at.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * at.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      });
    }
    at = p3;
  }
  return points;
}

function violations(graph) {
  const found = [];
  const size = new Map(graph.nodes.map((n) => [n.id, nodeLayout(n)]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const box = (node) => ({ ...node.metadata.ui, ...size.get(node.id) });
  const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
  const inside = (p, b) => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height;

  const regions = computeRegions(graph, null);
  for (const region of regions) {
    const frame = regionBounds(region, graph, (n) => size.get(n.id));
    if (!frame) continue;
    region.box = frame; // `skippedArea` asks the regions for their bounds, as the canvas does
    for (const node of graph.nodes) {
      if (region.members.has(node.id) || node.id === region.ownerId) continue;
      if (overlap(box(node), frame)) found.push(`foreign ${node.id} inside the frame of ${region.ownerId}`);
    }
  }

  for (const node of graph.nodes) {
    const layout = size.get(node.id);
    layout.orders.forEach((port, index) => {
      const targetId = port.get?.();
      const target = targetId && byId.get(targetId);
      if (!target) return;
      const from = { x: node.metadata.ui.x + layout.orderOut(index).dx,
        y: node.metadata.ui.y + layout.orderOut(index).dy };
      const to = { x: target.metadata.ui.x + size.get(targetId).orderIn.dx,
        y: target.metadata.ui.y + size.get(targetId).orderIn.dy };
      const skipped = skippedArea(regions, node.id, targetId, from, to);
      if (!skipped) return;
      const points = samplePath(orderEdgePath(from, to, skipped));
      for (const member of regions.filter((r) => r.ownerId === node.id
        && !r.members.has(targetId))) {
        for (const id of member.members) {
          if (points.some((p) => inside(p, box(byId.get(id))))) {
            found.push(`edge ${node.id}.${port.key} -> ${targetId} runs across ${id}`);
          }
        }
      }
    });
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

// --------------------------------------------------------------------------
// Coordinates that stack the cards are not a layout, and are not believed.
//
// A graph arriving with `metadata.ui` on every node used to be taken as "this
// was arranged by somebody". A writer that fills the field mechanically — one
// point on every node, or numbers that took no account of how wide a card is —
// produced an unreadable pile instead, and the editor drew it faithfully.

const piledUp = (graph) => {
  const size = new Map(graph.nodes.map((n) => [n.id, nodeLayout(n)]));
  const box = (n) => ({ ...n.metadata.ui, ...size.get(n.id) });
  for (let i = 0; i < graph.nodes.length; i += 1) {
    for (let j = i + 1; j < graph.nodes.length; j += 1) {
      const a = box(graph.nodes[i]);
      const b = box(graph.nodes[j]);
      if (a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y) {
        return `${graph.nodes[i].id}/${graph.nodes[j].id}`;
      }
    }
  }
  return null;
};

const uiOf = (graph) => JSON.stringify(graph.nodes.map((n) => n.metadata.ui));

const chainWith = (place) => ({
  nodes: [
    { id: "start", type: "entry", next: "a", metadata: { ui: place(0) } },
    { id: "a", type: "stage", stage: "Step", next: "b", metadata: { ui: place(1) } },
    { id: "b", type: "condition", condition: "vars.v0 > 1", then: "c", else: "d",
      metadata: { ui: place(2) } },
    { id: "c", type: "stage", stage: "Step", next: "d", metadata: { ui: place(3) } },
    { id: "d", type: "terminal", metadata: { ui: place(4) } },
  ],
});

const claim = (ok, message) => {
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
};

for (const point of [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 40, y: 40 }]) {
  const model = new PipelineModel();
  model.setPipeline(chainWith(() => ({ ...point })));
  claim(!piledUp(model.graph),
    `one point on every node is a pile, not a layout: ${JSON.stringify(point)}`);
}

{ // numbers that ignore how wide a card is
  const model = new PipelineModel();
  model.setPipeline(chainWith((i) => ({ x: i * 40, y: i * 30 })));
  claim(!piledUp(model.graph), "coordinates narrower than a card are not believed either");
}

{ // an arrangement that places the cards apart comes back exactly as it came
  const graph = chainWith((i) => ({ x: 17 + i * 400, y: 23 + i * 200 }));
  const before = uiOf(graph);
  const model = new PipelineModel();
  model.setPipeline(graph);
  claim(uiOf(model.graph) === before, "a usable layout is left alone");
}

{ // a session coming back is the reader's own: touching cards and all
  const graph = chainWith((i) => ({ x: 60 + i * 12, y: 60 + i * 9 }));
  const before = uiOf(graph);
  const model = new PipelineModel();
  model.setPipeline(graph, { keepLayout: true });
  claim(uiOf(model.graph) === before,
    "a restored session is not corrected — somebody dragged those cards");
}

{ // a subpipeline is a graph like any other
  const model = new PipelineModel();
  model.setPipeline({
    nodes: [{ id: "root", type: "entry", metadata: { ui: { x: 60, y: 60 } } }],
    subpipelines: { inner: chainWith(() => ({ x: 0, y: 0 })) },
  });
  model.setGraph("inner");
  claim(!piledUp(model.graph), "a subpipeline arriving as a pile is laid out too");
}

{ // and a node put where one already is steps aside rather than hiding it
  const model = new PipelineModel();
  model.setPipeline({ nodes: [{ id: "start", type: "entry", metadata: { ui: { x: 60, y: 60 } } }] });
  for (let i = 0; i < 4; i += 1) model.addNode("stage", { x: 300, y: 300 }, { stage: "Step" });
  claim(!piledUp(model.graph), "four nodes asked for one point do not become one card");
}
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
