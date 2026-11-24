/**
 * Data flows: which node really supplies the variable a node reads.
 *
 * The canvas draws a wire from a writer to a reader. The rule that makes the
 * wires honest is "the nearest write upstream in execution order": a later
 * write shadows an earlier one, different roads bring different writers, and
 * leaving a block (a `parallel` merging, a `map` body ending) leads to the
 * owner's `next` even though no edge in the JSON says so. A writer with no
 * road to the reader is still shown, but as unordered.
 *
 * Run: node tests/dataflow.mjs
 */
import "./_catalog.mjs";
import { controlSuccessors, dataLinks, variablesOf, writersOf } from "../js/dataflow.js";
import { categoryColor, varColor } from "../js/colors.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const stage = (id, reads = {}, writes = {}, next = null) => ({
  id, type: "stage", stage: "X",
  arguments: { vars: reads }, outputs: writes, ...(next ? { next } : {}),
});
const entry = (next) => ({ id: "start", type: "entry", next });
/** `name: writer -> reader (ordered?)` for every link, sorted. */
const described = (graph) => dataLinks(graph)
  .map((l) => `${l.name}: ${l.writerId} -> ${l.readerId}${l.ordered ? "" : " ?"}`)
  .sort();

// ------------------------------------------------------- a straight line

{
  const graph = { nodes: [
    entry("a"),
    stage("a", {}, { v: "x" }, "b"),
    stage("b", {}, { v: "x" }, "c"),
    stage("c", { in: "x" }),
  ] };
  check(same(described(graph), ["x: b -> c"]),
    `the nearest write shadows the earlier one: ${described(graph)}`);
  const [link] = dataLinks(graph);
  check(link.outIndex === 0 && link.inIndex === 0, "the port indices are the canvas's");
}

{
  const graph = { nodes: [
    entry("a"),
    stage("a", {}, { v: "x" }, "b"),
    stage("b", { in: "x" }, { v: "x" }, "c"),
    stage("c", { in: "x" }),
  ] };
  check(same(described(graph), ["x: a -> b", "x: b -> c"]),
    `a node that reads and rewrites a name is both ends, never its own source: ${described(graph)}`);
}

// ------------------------------------------------------- branching

{
  const graph = { nodes: [
    entry("check"),
    { id: "check", type: "condition", condition: "vars.ok", then: "yes", else: "no" },
    stage("yes", {}, { v: "x" }, "join"),
    stage("no", {}, { v: "x" }, "join"),
    stage("join", { in: "x" }),
  ] };
  check(same(described(graph), ["x: no -> join", "x: yes -> join"]),
    `two roads, two writers, both drawn: ${described(graph)}`);
}

{
  const graph = { nodes: [
    entry("par"),
    { id: "par", type: "parallel", next: "after",
      branches: [{ id: "l", entry: "l" }, { id: "r", entry: "r" }] },
    stage("l", {}, { v: "x" }),
    stage("r", {}, { v: "y" }),
    stage("after", { a: "x", b: "y" }),
  ] };
  const succ = controlSuccessors(graph);
  check(succ.get("l").has("after") && succ.get("r").has("after"),
    "the end of a branch hands control to the parallel's next");
  check(same(described(graph), ["x: l -> after", "y: r -> after"]),
    `variables written in branches reach the node after the merge: ${described(graph)}`);
}

{
  const graph = { nodes: [
    entry("each"),
    { id: "each", type: "map", items: "vars.xs", body: "work", next: "after" },
    stage("work", { item: "item" }, { v: "x" }),
    stage("after", { in: "x" }),
  ] };
  check(controlSuccessors(graph).get("work").has("after"),
    "the end of a map body leads to the map's next");
  check(same(described(graph), ["item: each -> work", "x: work -> after"]),
    `the map hands the element to its body, the body's write leaves it: ${described(graph)}`);
}

// ------------------------------------------------------- no road

{
  const graph = { nodes: [
    entry("b"),
    stage("lonely", {}, { v: "x" }),
    stage("b", { in: "x" }),
  ] };
  check(same(described(graph), ["x: lonely -> b ?"]),
    `a writer with no road to the reader is shown, as unordered: ${described(graph)}`);
}

{
  const graph = { nodes: [entry("a"), stage("a", { in: "nobody_writes" })] };
  check(dataLinks(graph).length === 0, "a variable nobody writes has no wire");
}

// ------------------------------------------------------- what the inspector offers

{
  const graph = { nodes: [
    entry("a"),
    stage("a", { in: "zeta" }, { v: "alpha" }, "b"),
    stage("b", { one: "alpha", two: "alpha" }, { w: "mid" }),
  ] };
  check(same(variablesOf(graph), ["alpha", "mid", "zeta"]),
    `every name read or written, once, sorted: ${variablesOf(graph)}`);
  const writers = writersOf(graph);
  check(same([...writers.get("b")], ["a"]) && writers.get("a").size === 0,
    "writersOf folds the links per reader");
}

// ------------------------------------------------------- colors

check(varColor("ticket") === varColor("ticket"), "a variable keeps its color");
check(varColor("ticket") !== varColor("reply"), "two names, two colors (for these two)");
check(/^hsl\(\d{1,3} 58% 62%\)$/.test(varColor("x")), "within the theme's lightness");
check(categoryColor(null) === null && categoryColor("") === null,
  "no category, no accent");
check(categoryColor("llm") !== varColor("llm"),
  "a category and a variable of the same name are told apart");

if (failed) {
  console.error(`dataflow: ${failed} of ${checked} checks failed`);
  process.exit(1);
}
console.log(`dataflow: ${checked} checks, a wire comes from the nearest write`);
