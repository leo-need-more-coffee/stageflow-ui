/**
 * The edit history: Ctrl+Z must undo exactly what the user did.
 *
 * The subtlety is not in the snapshot stack but in WHAT counts as an edit. The
 * `change` event is also sent by actions that do not change the pipeline —
 * switching a subpipeline, redrawing after the specs load — and if those are
 * recorded too, undo starts "clicking idly": the user presses Ctrl+Z and
 * nothing happens on the screen. That is what is checked here, together with
 * cutting off the branch after an undo and coming back to the graph the edit
 * was made on.
 *
 * Run: node tests/history.mjs
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

const base = () => ({
  nodes: [
    { id: "start", type: "entry", variables: { n: 1 }, next: "a" },
    { id: "a", type: "stage", stage: "LogStage" },
  ],
});

const ids = (model) => model.graph.nodes.map((n) => n.id).join(",");

// ------------------------------------------------- a fresh document

{
  const model = new PipelineModel();
  model.setPipeline(base());
  check(!model.canUndo, "a just-loaded pipeline has nothing to undo");
  check(!model.canRedo, "a just-loaded pipeline has nothing to redo");
}

// ------------------------------------------------- undo and redo

{
  const model = new PipelineModel();
  model.setPipeline(base());
  model.addNode("terminal", { x: 0, y: 0 });
  const withNode = ids(model);
  check(model.canUndo, "after adding a node undo must become available");

  check(model.undo(), "the undo did not work");
  check(ids(model) === "start,a", `the undo did not remove the node: ${ids(model)}`);
  check(model.canRedo, "after an undo redo must become available");

  check(model.redo(), "the redo did not work");
  check(ids(model) === withNode, `the redo did not bring the node back: ${ids(model)}`);
  check(!model.canRedo, "after a redo there is nothing left to redo");
}

// --------------------------------- an "edit" that changes nothing

{
  const model = new PipelineModel();
  model.setPipeline(base());
  model.addNode("terminal", { x: 0, y: 0 });
  model.touch();      // a redraw without an edit (the specs loaded, say)
  model.setGraph(null); // switching the graph is not an edit either
  check(model.undo() && ids(model) === "start,a",
    `idle events got into the history: ${ids(model)}`);
  check(!model.canUndo, "after one edit and one undo there is nothing left to undo");
}

// ------------------------- a new edit cuts off the redo branch

{
  const model = new PipelineModel();
  model.setPipeline(base());
  model.addNode("terminal", { x: 0, y: 0 });
  model.undo();
  check(model.canRedo, "before a new edit redo is still available");
  model.addNode("condition", { x: 0, y: 0 });
  check(!model.canRedo, "a new edit must cut off the undone branch");
  check(ids(model).endsWith("condition"), `the wrong edit survived: ${ids(model)}`);
}

// --------------------------------------- coordinates are an edit too

{
  const model = new PipelineModel();
  model.setPipeline(base());
  const node = model.node("a");
  const before = { ...node.metadata.ui };
  node.metadata.ui = { x: before.x + 300, y: before.y + 200 };
  model.touch();
  model.undo();
  const after = model.node("a").metadata.ui;
  check(after.x === before.x && after.y === before.y,
    `the undo did not restore the node position: ${JSON.stringify(after)} instead of ${JSON.stringify(before)}`);
}

// ------------------- an undo returns to the graph the edit was made on

{
  const model = new PipelineModel();
  model.setPipeline(base());
  model.addSubpipeline("child");
  model.addNode("terminal", { x: 0, y: 0 }); // an edit inside the subpipeline
  model.setGraph(null);
  model.undo();
  check(model.graphKey === "child",
    `undoing an edit of a subpipeline must return into it, not to the root: ${model.graphKey}`);
}

// ------------------------------------- a deep history does not break

{
  const model = new PipelineModel();
  model.setPipeline(base());
  for (let i = 0; i < 150; i += 1) model.addNode("terminal", { x: i, y: i });
  const total = model.graph.nodes.length;
  let steps = 0;
  while (model.canUndo && steps < 200) { model.undo(); steps += 1; }
  check(steps > 0 && model.graph.nodes.length < total,
    `after ${steps} undos the graph did not roll back`);
  check(model.graph.nodes.some((n) => n.id === "start"),
    "rolling back past the history must not lose the original graph");
}

// --------------------------------- a new document is a new history

{
  const model = new PipelineModel();
  model.setPipeline(base());
  model.addNode("terminal", { x: 0, y: 0 });
  model.setPipeline({ nodes: [{ id: "solo", type: "entry", variables: {} }] });
  check(!model.canUndo && !model.canRedo,
    "after loading another pipeline the history must start over");
}

if (failed) {
  console.error(`history: ${failed} violations out of ${checked} checks`);
  process.exit(1);
}
console.log(`history: ${checked} checks, undo and redo walk over real edits`);
