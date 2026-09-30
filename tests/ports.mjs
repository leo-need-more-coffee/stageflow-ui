/**
 * Checking the data ports of nodes: what the editor counts as reading and
 * writing the frame.
 *
 * The ports are derived from the node JSON (`dataIns`/`dataOuts` in kinds.js)
 * and are backed by nothing in that JSON — which means a missed data source
 * breaks nothing noticeable, it simply is not drawn. That is exactly how the
 * reads of computed outputs went missing once. Here every node kind is checked
 * for declaring all of its reads and writes.
 *
 * Run: node tests/ports.mjs
 */
import "./_catalog.mjs";
import { kindOf } from "../js/kinds.js";

let failed = 0;

function check(what, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.error(`✗ ${what}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

const ins = (node) => kindOf(node).dataIns(node).map((p) => p.refs?.map((r) => r.name) ?? []);
const outs = (node) => kindOf(node).dataOuts(node).map((p) => p.variable?.name);

// ------------------------------------------------- stage: arguments

check("stage: a variable argument is read",
  ins({ type: "stage", stage: "S", arguments: { vars: { current: "n" } } }),
  [["n"]]);

check("stage: a literal does not read the frame",
  ins({ type: "stage", stage: "S", arguments: { const: { delta: 10 } } }),
  []);

check("stage: a CEL argument reads all of its variables",
  ins({ type: "stage", stage: "S",
        arguments: { const: { "parts.$": "[vars.a, string(vars.b)]" } } }),
  [["a", "b"]]);

// --------------------------------- stage: value settings on the card

// A literal has no connector — but it must not disappear from the card either:
// a `fetch` node without its `url` shown is "some request somewhere".
const values = (node) => kindOf(node).valueRows(node).map((r) => `${r.name}=${r.text}`);

check("stage: a value argument is visible on the card",
  values({ type: "stage", stage: "S",
           arguments: { const: { url: "https://x", delta: 10 } } }),
  ["url=https://x", "delta=10"]);

check("stage: a variable argument does not become a value row (it has a port)",
  values({ type: "stage", stage: "S", arguments: { vars: { current: "n" } } }),
  []);

check("stage: an expression with variables is a port, not a value",
  values({ type: "stage", stage: "S", arguments: { const: { "x.$": "vars.n + 1" } } }),
  []);

check("stage: an expression without variables is a value (it has no port)",
  values({ type: "stage", stage: "S", arguments: { const: { "x.$": "2 + 2" } } }),
  ["x=ƒ 2 + 2"]);

check("stage: a value of spaces is visible instead of looking empty",
  values({ type: "stage", stage: "S", arguments: { const: { separator: " " } } }),
  ['separator=" "']);

check("stage: an empty string is visible too",
  values({ type: "stage", stage: "S", arguments: { const: { prefix: "" } } }),
  ['prefix=""']);

check("stage: a long list of settings is trimmed instead of growing the card",
  values({ type: "stage", stage: "S",
           arguments: { const: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 } } }),
  ["a=1", "b=2", "c=3", "d=4", "e=5", "…=3 more"]);

check("nodes without settings do not create empty rows",
  values({ type: "condition", condition: "vars.n > 1" }),
  []);

// ----------------------------------------- stage: outputs, CEL ones included

check("stage: an ordinary output writes a variable",
  outs({ type: "stage", stage: "S", outputs: { value: "total" } }),
  ["total"]);

check("stage: a computed output writes a variable",
  outs({ type: "stage", stage: "S", outputs: { "report.$": "vars.total + 1" } }),
  ["report"]);

check("stage: a computed output READS the frame (or it writes out of nowhere)",
  ins({ type: "stage", stage: "S", outputs: { "report.$": "vars.total + 1" } }),
  [["total"]]);

check("stage: output.* in an expression is not a frame variable",
  ins({ type: "stage", stage: "S",
        outputs: { "report.$": "{'a': output.count, 'b': vars.total}" } }),
  [["total"]]);

// --------------------------------------------------- CEL branching

check("condition: the condition reads the frame",
  ins({ type: "condition", condition: "vars.n > 3 && vars.flag" }),
  [["n"], ["flag"]]);

check("switch: every condition reads the frame, names are not duplicated",
  ins({ type: "switch", cases: [{ when: "vars.a > 1" }, { when: "vars.a < 0" },
                                 { when: "vars.b == 'x'" }] }),
  [["a"], ["b"]]);

// ------------------------------------------------------------ expose

check("expose: reads the source and writes the destination",
  [ins({ type: "parallel", branches: [], expose: { total: "copy" } }),
   outs({ type: "parallel", branches: [], expose: { total: "copy" } })],
  [[["total"]], ["copy"]]);

// ------------------------------------------- subpipeline / terminal / try

check("subpipeline: inputs read, artifact_outputs and result_output write",
  [ins({ type: "subpipeline", subpipeline_id: "s", inputs: { child: "parent" } }),
   outs({ type: "subpipeline", subpipeline_id: "s",
          artifact_outputs: { got: "made" }, result_output: "res" })],
  [[["parent"]], ["got", "res"]]);

check("terminal: the artifacts read the frame",
  ins({ type: "terminal", artifacts: ["a", "b"] }),
  [["a"], ["b"]]);

check("try: the result_var of a handler writes a variable",
  outs({ type: "try", body: "x", except: [{ error_equals: ["*"], result_var: "error" }] }),
  ["error"]);

// The index form of access is the only one CEL allows for a non-ASCII name, so
// the non-Latin identifiers below are the point of these two checks.
check("stage: the index form of access is read too",
  ins({ type: "stage", stage: "S",
        arguments: { const: { "x.$": "vars['итог'] + vars.n" } } }),
  [["итог", "n"]]);

check("condition: the index form of access is read too",
  ins({ type: "condition", condition: "vars[\'счёт\'] > 3" }),
  [["счёт"]]);

// -------------------------------------------------------------- entry

check("entry: every variable is a frame write",
  outs({ type: "entry", variables: { n: 5, "total.$": "vars.n * 2" } }),
  ["n", "total"]);

check("entry: an expression reads only what came from outside",
  ins({ type: "entry", variables: { "greeting.$": "'hello ' + vars.who" } }),
  [["who"]]);

check("entry: a reference to its own variable does not become a port",
  ins({ type: "entry", variables: { n: 5, "total.$": "vars.n * 2" } }),
  []);

check("entry: expose works here too",
  [ins({ type: "entry", expose: { n: "copy" } }),
   outs({ type: "entry", expose: { n: "copy" } })],
  [[["n"]], ["copy"]]);

// ---------------------------------------------------------------- map

check("map: the items expression is the read",
  ins({ type: "map", items: "vars.tickets", body: "x" }),
  [["tickets"]]);

check("map: the element is written even when the field is left at its default",
  outs({ type: "map", items: "vars.tickets", body: "x" }),
  ["item"]);

check("map: element, index and every collected list are writes",
  outs({ type: "map", items: "vars.tickets", body: "x", item_var: "ticket",
         index_var: "i", collect: { reply: "replies", score: "scores" } }),
  ["ticket", "i", "replies", "scores"]);

check("map: the index form of access is read too",
  ins({ type: "map", items: "vars['заявки']", body: "x" }),
  [["заявки"]]);

console.log(failed ? `\nchecks failed: ${failed}` : "node ports: all checks passed");
process.exit(failed ? 1 : 0);
