/**
 * The node buffer: a copy must be A COPY, not a second remote control for the
 * original.
 *
 * The danger of pasting is not in duplicating JSON but in the references. Paste
 * a copy of a branch — and if the references did not move onto the copies, the
 * pasted node controls the original one: the graph looks copied but runs as
 * one. The opposite mistake is cutting everything off: a paste into the same
 * graph lawfully keeps the outward references, because a copy of a branch
 * merges where the original merged.
 *
 * Both are checked here, plus the uniqueness of the ids, the placement of the
 * copies, and the fact that a paste is ONE history step (Ctrl+Z removes it
 * whole).
 *
 * Run: node tests/clipboard.mjs
 */
import "./_catalog.mjs";
import { PipelineModel } from "../js/model.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

/** start → a → b, plus a separate terminal. */
const base = () => ({
  nodes: [
    { id: "start", type: "entry", variables: { n: 1 }, next: "a",
      metadata: { ui: { x: 0, y: 0 } } },
    { id: "a", type: "stage", stage: "LogStage", next: "b",
      metadata: { ui: { x: 0, y: 200 } } },
    { id: "b", type: "stage", stage: "LogStage",
      metadata: { ui: { x: 0, y: 400 } } },
    { id: "end", type: "terminal", metadata: { ui: { x: 300, y: 600 } } },
  ],
});

const byId = (model, id) => model.graph.nodes.find((n) => n.id === id);

// ----------------------- the references inside the set move onto the copies

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const ids = model.pasteNodes(model.copyNodes(["a", "b"]));
  check(ids.length === 2, `not two nodes were pasted: ${ids}`);
  check(!ids.includes("a") && !ids.includes("b"), `the ids are not unique: ${ids}`);
  const copyA = byId(model, ids[0]);
  check(copyA.next === ids[1],
    `the copy refers to the original instead of the copy: ${copyA.next} instead of ${ids[1]}`);
  check(byId(model, "a").next === "b", "the original must not change on a paste");
}

// ------------------ an outward reference is kept if the target exists

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const [copy] = model.pasteNodes(model.copyNodes(["a"]));
  check(byId(model, copy).next === "b",
    `the outward reference was lost: ${byId(model, copy).next}`);
}

// --------------- ...and is cleared if the target is not in the graph

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const buffer = model.copyNodes(["a"]);
  model.addSubpipeline("child"); // an empty graph, there is no `b` in it
  const [copy] = model.pasteNodes(buffer);
  check(byId(model, copy).next === null,
    `in a foreign graph the reference must be cleared, not left dangling: ${byId(model, copy).next}`);
}

// ---------------------------------------- a second entry is not pasted

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const ids = model.pasteNodes(model.copyNodes(["start", "a"]));
  check(ids.length === 1, `the entry was pasted as a second one: ${ids}`);
  check(model.graph.nodes.filter((n) => n.type === "entry").length === 1,
    "the graph ended up with more than one entry point");
  check(model.pasteNodes(model.copyNodes(["start"])).length === 0,
    "pasting a lone entry into a graph that has one must do nothing");
}

// ------------------------------- an entry is pasted if there is none

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const buffer = model.copyNodes(["start"]);
  model.addSubpipeline("child");
  const ids = model.pasteNodes(buffer);
  check(ids.length === 1, "in a graph without an entry the entry point must be pasted");
  check(model.graph.entry === ids[0],
    `the pasted entry must become the start of the graph: ${model.graph.entry}`);
}

// ------------------------------------------ the placement of the copies

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const ids = model.pasteNodes(model.copyNodes(["a", "b"]), { x: 500, y: 100 });
  const [first, second] = ids.map((id) => byId(model, id).metadata.ui);
  check(first.x === 500 && first.y === 100,
    `the set did not land at the paste point: ${JSON.stringify(first)}`);
  check(second.y - first.y === 200,
    `the relative placement of the copies was not preserved: ${JSON.stringify([first, second])}`);
}

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const [copy] = model.pasteNodes(model.copyNodes(["b"]));
  const at = byId(model, copy).metadata.ui;
  const origin = byId(model, "b").metadata.ui;
  check(at.x !== origin.x || at.y !== origin.y,
    "without a paste point the copy must not land exactly on the original");
}

// ------------------------------------- a paste is one history step

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const before = model.graph.nodes.length;
  model.pasteNodes(model.copyNodes(["a", "b"]));
  check(model.graph.nodes.length === before + 2, "the paste did not add the nodes");
  model.undo();
  check(model.graph.nodes.length === before,
    `Ctrl+Z must remove the whole paste at once: ${model.graph.nodes.length} left`);
}

// ------------------------------------ a repeated paste does not clash

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const buffer = model.copyNodes(["a"]);
  const first = model.pasteNodes(buffer);
  const second = model.pasteNodes(buffer);
  check(first[0] !== second[0], `the repeated paste produced the same id: ${first[0]}`);
  check(new Set(model.graph.nodes.map((n) => n.id)).size === model.graph.nodes.length,
    "identical ids appeared in the graph");
}

if (failed) {
  console.error(`clipboard: ${failed} violations out of ${checked} checks`);
  process.exit(1);
}
console.log(`clipboard: ${checked} checks, the copies do not control the originals`);
