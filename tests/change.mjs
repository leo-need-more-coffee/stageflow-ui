/**
 * What `setPipeline` reports about what it did.
 *
 * Loading a graph used to be one event meaning "everything is different", and
 * the canvas answered the only way it could: refit the view. That is right for
 * a document somebody opened and wrong for an edit to the graph on screen —
 * which is what every push from an assistant is. Moving the canvas under a
 * reader is the thing that makes a collaborator feel like an interruption.
 *
 * So the event carries a diff, and these are its rules.
 *
 * Run: node tests/change.mjs
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

/** The diff `setPipeline` announced. */
function loading(model, pipeline, options) {
  let change = null;
  const onReset = (event) => { change = event.detail; };
  model.addEventListener("reset", onReset);
  model.setPipeline(pipeline, options);
  model.removeEventListener("reset", onReset);
  return change;
}

const at = (id, x, y, extra = {}) => ({
  id, type: "stage", stage: "Step", metadata: { ui: { x, y } }, ...extra,
});

const graph = (...nodes) => ({ nodes: [{ id: "start", type: "entry", next: nodes[0]?.id,
  metadata: { ui: { x: 60, y: 60 } } }, ...nodes] });

{ // the first load is a document, whatever is in it
  const model = new PipelineModel();
  const change = loading(model, graph(at("a", 60, 300)));
  check(change.fresh, "the first graph of a session is a document, not an edit");
  check(change.added.length === 0 && change.touched === 0,
    "nothing was there before, so nothing was added TO anything");
}

{ // a graph sharing nothing is another document
  const model = new PipelineModel();
  loading(model, graph(at("a", 60, 300)));
  const change = loading(model, { nodes: [
    { id: "other", type: "entry", metadata: { ui: { x: 60, y: 60 } } },
  ]});
  check(change.fresh, "a graph with no node in common is a different document");
}

{ // one shared id is enough to call it the same graph
  const model = new PipelineModel();
  loading(model, graph(at("a", 60, 300)));
  const change = loading(model, graph(at("b", 60, 300)));
  check(!change.fresh,
    "an assistant rewriting a pipeline keeps the entry — that is an edit, not a document");
  check(change.added.includes("b"), "the node that appeared is named");
  check(change.removed.includes("a"), "the node that went is named");
}

{ // what a node SAYS, position excluded
  const model = new PipelineModel();
  loading(model, graph(at("a", 60, 300), at("b", 60, 500)));
  const change = loading(model, graph(
    at("a", 60, 300, { arguments: { const: { n: 1 } } }),
    at("b", 400, 500),
  ));
  check(change.changed.includes("a"), "a node whose fields changed is `changed`");
  check(!change.changed.includes("b"), "a node that only moved did not change");
  check(change.moved.has("b"), "the one that moved is in `moved`");
  check(!change.moved.has("a"), "the one that stayed is not");
}

{ // how far it moved, so the move can be shown rather than jumped
  const model = new PipelineModel();
  loading(model, graph(at("a", 100, 200)));
  const change = loading(model, graph(at("a", 400, 260)));
  const { dx, dy } = change.moved.get("a");
  check(dx === -300 && dy === -60,
    `the delta is from the new position back to the old one (got ${dx}, ${dy})`);
}

{ // a relayout moves everything and changes nothing
  const model = new PipelineModel();
  loading(model, graph(at("a", 60, 300), at("b", 60, 500)));
  const before = JSON.stringify(model.graph.nodes.map((n) => n.id));
  const change = loading(model, graph(at("a", 900, 900), at("b", 950, 1100)));
  check(change.touched === 0, "moving every card is not touching anything");
  check(change.moved.size >= 2, "but all of it is reported as movement");
  check(JSON.stringify(model.graph.nodes.map((n) => n.id)) === before,
    "and the graph itself is the same");
}

{ // a graph arriving without coordinates keeps the ones the cards already have
  //
  // An assistant is told not to invent coordinates, so an edit arrives with
  // none at all. Laying the result out would move every card the person had
  // dragged because two more nodes appeared — they asked for two more cards,
  // not for a new arrangement.
  const model = new PipelineModel();
  loading(model, graph(at("a", 700, 400), at("b", 900, 650)));
  const where = (id) => {
    const n = model.graph.nodes.find((x) => x.id === id);
    return `${n.metadata.ui.x},${n.metadata.ui.y}`;
  };
  const kept = { a: where("a"), b: where("b"), start: where("start") };

  // the same graph plus one node, written out with no placement anywhere
  loading(model, { nodes: [
    { id: "start", type: "entry", next: "a" },
    { id: "a", type: "stage", stage: "Step", next: "c" },
    { id: "c", type: "stage", stage: "Step", next: "b" },
    { id: "b", type: "stage", stage: "Step" },
  ]});

  check(where("a") === kept.a, `the card that stayed did not move (${where("a")} vs ${kept.a})`);
  check(where("b") === kept.b, "and neither did the other one");
  check(where("start") === kept.start, "nor the entry");
  const added = model.graph.nodes.find((n) => n.id === "c");
  check(Boolean(added.metadata.ui), "the new node was given a place");
  check(added.metadata.ui.y > model.graph.nodes.find((n) => n.id === "a").metadata.ui.y,
    "under whoever leads to it, which is where an insertion by hand goes");
}

{ // a chain of new nodes is placed in order, each under the last
  const model = new PipelineModel();
  loading(model, graph(at("a", 300, 300)));
  loading(model, { nodes: [
    { id: "start", type: "entry", next: "a" },
    { id: "a", type: "stage", stage: "Step", next: "x" },
    { id: "x", type: "stage", stage: "Step", next: "y" },
    { id: "y", type: "stage", stage: "Step" },
  ]});
  const at_ = (id) => model.graph.nodes.find((n) => n.id === id).metadata.ui;
  check(at_("x").y > at_("a").y && at_("y").y > at_("x").y,
    "a new node whose predecessor is also new waits for it");
}

{ // a graph nobody has arranged is still laid out whole
  const model = new PipelineModel();
  const change = loading(model, { nodes: [
    { id: "start", type: "entry", next: "a" },
    { id: "a", type: "stage", stage: "Step" },
  ]});
  check(change.fresh, "the first graph is a document");
  const ys = model.graph.nodes.map((n) => n.metadata.ui.y);
  check(new Set(ys).size === ys.length, "and it got a real layout, not a pile");
}

if (failed) {
  console.error(`change: ${failed} of ${checked} checks failed`);
  process.exit(1);
}
console.log(`change: ${checked} checks, an edit is told from a document`);
