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
import { KINDS, formatLiteral, parseLiteral } from "../js/kinds.js";

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

console.log(failed
  ? `\nchecks failed: ${failed}`
  : `table editors: ${checked} checks, rows and literals are not lost`);
process.exit(failed ? 1 : 0);
