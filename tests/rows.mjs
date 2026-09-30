/**
 * The table editors: a row that has just been added must not disappear.
 *
 * `#rowsEditor` draws rows FROM the node JSON, and an empty row cannot be
 * represented in JSON (no variable name, no `when` of a case, not both ends of
 * an `expose`) — so "+ row" without drafts looked like "nothing happened":
 * `field.set` dropped the row and the redraw took the JSON afresh.
 *
 * The property checked here: for every table field of every node kind a fresh
 * row (`blank()`) is either saved into the JSON or marked `incomplete` — that
 * is, it will live in the panel as a draft.
 *
 * Run: node tests/rows.mjs
 */
import "./_catalog.mjs";
import { KINDS, celExpr, celSource, formatLiteral, parseLiteral } from "../js/kinds.js";

let failed = 0;
let checked = 0;

/** An environment sufficient for `fields()`: stage specs and a subpipeline list. */
const env = {
  stages: { loaded: false, get: () => null, names: () => [] },
  model: { pipeline: { subpipelines: { child: {} } }, graph: { nodes: [] } },
};

for (const [type, kind] of KINDS) {
  const node = kind.defaults(type);
  for (const field of kind.fields(node, env)) {
    if (field.kind !== "rows") continue;
    checked++;

    const blank = field.blank();
    const draft = Boolean(field.incomplete?.(blank));

    // the way the panel does it: put a row in and read it back from the JSON
    field.set([blank]);
    const saved = field.get().length;

    if (!draft && saved === 0) {
      failed++;
      console.error(`✗ ${type} / "${field.label}": the row disappears when added`
        + " — an incomplete predicate is needed, or the \"+ row\" button does nothing");
    }
    // the predicate must agree with set: a complete row cannot be a draft
    if (draft && saved > 0) {
      failed++;
      console.error(`✗ ${type} / "${field.label}": the row is both saved and marked`
        + " a draft — it will be doubled in the panel");
    }
    field.set([]);
  }
}

// ------------------------------------------- value literals: round-trip

// A value of nothing but spaces is a lawful setting (`separator: " "`), and it
// must not disappear when typed or when the panel is opened again.
for (const value of [" ", "  x  ", "5", "true", "null", '["a"]', "text", ""]) {
  const back = formatLiteral(parseLiteral(value));
  checked++;
  if (back !== value) {
    failed++;
    console.error(`✗ the literal ${JSON.stringify(value)} does not survive a round-trip:`
      + ` got ${JSON.stringify(back)}`);
  }
}

// ------------------------------- CEL fields: the source survives the trip

/**
 * `condition`, the `when` of a case and the `items` of a loop keep CEL and
 * nothing else in the JSON, so the panel reads the source back out of the text.
 * What must hold: whatever the form writes, the form reads the same way — the
 * mode must not jump from under the cursor, and the value must not change
 * meaning between two openings of the panel.
 */
for (const [source, value] of [
  ["vars", "x"], ["vars", "итог"], ["vars", "count_2"],
  ["const", "5"], ["const", "true"], ["const", "null"], ["const", "text"],
  ["const", '["a","b"]'], ["const", '{"k":1}'],
  ["cel", "vars.count > 0"], ["cel", "size(vars.xs) != 0"], ["cel", '"42"'],
]) {
  const expr = celExpr(source, value);
  const back = celSource(expr);
  checked++;
  if (back.source !== source || back.value !== value) {
    failed++;
    console.error(`✗ ${source} ${JSON.stringify(value)} -> ${JSON.stringify(expr)}`
      + ` reads back as ${back.source} ${JSON.stringify(back.value)}`);
  }
  // and the text itself is stable: opening the panel twice writes nothing new
  checked++;
  if (celExpr(back.source, back.value) !== expr) {
    failed++;
    console.error(`✗ ${JSON.stringify(expr)} is rewritten on a second reading`);
  }
}

// a value of nothing but spaces clears the field: these three fields are a
// condition, a predicate and a list, and for none of them is " " a setting. The
// string itself is still sayable — as the expression `" "`
for (const blank of ["", "   "]) {
  checked++;
  if (celExpr("const", blank) !== "") {
    failed++;
    console.error(`✗ a value of ${JSON.stringify(blank)} does not clear the field`);
  }
}

// an empty expression names no source at all: the panel shows such a field as
// "not set", as it shows an unfilled stage argument, and only falls back to
// this answer where there is no picker to remember a choice
for (const empty of ["", "   ", null, undefined]) {
  checked++;
  if (celSource(empty).source !== "vars" || celSource(empty).value !== "") {
    failed++;
    console.error(`✗ an empty expression ${JSON.stringify(empty)} is not an empty variable`);
  }
}

// what somebody else wrote by hand stays exactly as written
for (const written of ["vars.a && vars.b", "[1, 2]", "'ключ'", "vars.x.y"]) {
  checked++;
  const back = celSource(written);
  if (celExpr(back.source, back.value) !== written) {
    failed++;
    console.error(`✗ a hand-written ${JSON.stringify(written)} is changed by a reading:`
      + ` got ${JSON.stringify(celExpr(back.source, back.value))}`);
  }
}

console.log(failed
  ? `\nchecks failed: ${failed}`
  : `table editors: ${checked} checks, rows, literals and CEL sources are not lost`);
process.exit(failed ? 1 : 0);
