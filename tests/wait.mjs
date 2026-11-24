/**
 * The `wait` node in the editor: its ports, its form, and the checks the
 * core makes before a run, said here before the run.
 *
 * Run: node tests/wait.mjs
 */
import "./_catalog.mjs";
import { isDuration, kindOf } from "../src/core/kinds.js";

let failed = 0;
let checks = 0;

function check(what, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.error(`✗ ${what}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

const env = { stages: { get: () => null, loaded: false, names: () => [] } };
const issues = (node, graph, pipeline = graph) =>
  kindOf(node).validate(node, graph, pipeline, env);
const ports = (node) => kindOf(node).orderPorts(node).map((p) => p.key);
const field = (node, label) => kindOf(node).fields(node, env).find((f) => f.label === label);

const end = { id: "end", type: "terminal" };
const late = { id: "late", type: "terminal" };
const graphOf = (...nodes) => ({ entry: nodes[0].id, nodes, subpipelines: {} });

// ------------------------------------------------------------ ports

check("without a timeout there is only `next`",
  ports({ id: "w", type: "wait", input: "x" }), ["next"]);
check("a timeout brings the `on_timeout` road",
  ports({ id: "w", type: "wait", input: "x", timeout: "1d" }), ["next", "on_timeout"]);
const timeoutPort = kindOf({ type: "wait" })
  .orderPorts({ id: "w", type: "wait", timeout: "1d" })[1];
check("the timeout road is drawn dashed", timeoutPort.dashed, true);

check("the answer's fields are written to variables",
  kindOf({ type: "wait" }).dataOuts({ type: "wait", outputs: { ok: "approved", "note.$": "vars.a" } })
    .map((p) => p.label),
  ["ok → approved", "ƒ → note"]);
check("a computed output reads the frame",
  kindOf({ type: "wait" }).dataIns({ type: "wait", outputs: { "note.$": "vars.a + vars.b" } })
    .map((p) => p.refs.map((r) => r.name)),
  [["a", "b"]]);

// ------------------------------------------------------------- form

const node = { id: "w", type: "wait", input: "", next: "end" };
field(node, "input to wait for").set("  approval ");
check("the input type is trimmed", node.input, "approval");
const timeout = field(node, "timeout");
timeout.set("7d");
check("a timeout with a unit stays text", node.timeout, "7d");
timeout.set("90");
check("bare seconds become a number", node.timeout, 90);
timeout.set("");
check("an empty timeout is no timeout", "timeout" in node, false);

const outputs = field(node, "what to take from the answer");
outputs.set([{ how: "field", src: "ok", dest: "approved" },
             { how: "cel", src: "has(output.text) ? output.text : vars.reply", dest: "reply" }]);
check("outputs are written as the core reads them", node.outputs,
  { ok: "approved", "reply.$": "has(output.text) ? output.text : vars.reply" });
check("and read back into the same rows", outputs.get().map((r) => [r.how, r.src, r.dest]),
  [["field", "ok", "approved"], ["cel", "has(output.text) ? output.text : vars.reply", "reply"]]);

// ------------------------------------------------------- validation

const ok = { id: "w", type: "wait", input: "approval", timeout: "1d", on_timeout: "late", next: "end" };
check("a complete wait has nothing to say", issues(ok, graphOf(ok, end, late)), []);

check("an input type is required",
  issues({ id: "w", type: "wait", input: "", next: "end" }, graphOf(end)),
  ["no input type to wait for"]);

check("a timeout needs somewhere to go",
  issues({ id: "w", type: "wait", input: "x", timeout: "1d", next: "end" }, graphOf(end)),
  ["timeout and on_timeout go together: how long to wait and where to go if nothing comes"]);

check("a duration is checked",
  issues({ id: "w", type: "wait", input: "x", timeout: "soon", on_timeout: "late", next: "end" },
         graphOf(end, late)).length > 0 &&
  issues({ id: "w", type: "wait", input: "x", timeout: "soon", on_timeout: "late", next: "end" },
         graphOf(end, late))[0].startsWith("timeout soon is not a duration"),
  true);
check("durations the core accepts",
  ["90s", "15m", "2h", "7d", "1.5h", 30, "30"].map(isDuration), [true, true, true, true, true, true, true]);
check("and ones it refuses",
  ["soon", "7 days", "", 0, -1, "d"].map(isDuration), [false, false, false, false, false, false]);

// a wait inside a block: the core refuses it, so the editor says so
const inParallel = { id: "w", type: "wait", input: "x" };
const parallel = { id: "p", type: "parallel", branches: [{ id: "w", entry: "w" }], next: "end" };
check("not inside a parallel branch",
  issues(inParallel, graphOf(parallel, inParallel, end)),
  ["a wait cannot be inside the parallel node 'p': a saved run comes back to a node of the main graph"]);

const inTry = { id: "w", type: "wait", input: "x", next: "end" };
const tryNode = { id: "t", type: "try", body: "w", next: "end",
                  except: [{ error_equals: ["*"], next: "end" }] };
check("not inside a try body",
  issues(inTry, graphOf(tryNode, inTry, end)).some((m) => m.includes("try node 't'")), true);

const after = { id: "w", type: "wait", input: "x", next: "end" };
const blockBefore = { id: "p", type: "parallel", branches: [{ id: "b", entry: "b" }], next: "w" };
const branch = { id: "b", type: "terminal" };
check("after a block is fine",
  issues(after, graphOf(blockBefore, branch, after, end)), []);

const sub = graphOf({ id: "w", type: "wait", input: "x", next: "end" }, end);
const root = { ...graphOf(end), subpipelines: { inner: sub } };
check("not in a subpipeline",
  issues(sub.nodes[0], sub, root),
  ["a wait cannot be in a subpipeline: a saved run comes back to a node of the main graph"]);

if (failed) {
  console.error(`wait: ${failed} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`wait: ${checks} checks, the node is drawn and checked as the core reads it`);
