/**
 * Node kinds: the editor's mirror of the core's node types.
 *
 * Each kind is a class of static members over raw JSON nodes: defaults, a
 * caption, two kinds of connectors, and inspector fields.
 *
 * - orderPorts(node): control edges (next/then/else/cases/branches/catch),
 *   stored in the JSON and edited by dragging;
 * - dataIns(node) / dataOuts(node): the frame variables the node reads and
 *   writes. Data edges are not stored; they are derived by matching names.
 *
 * Inspector fields are declarative descriptors.
 *
 * Every order port has a stable `key` (`next`, `then`, `add-case`, ...),
 * independent of its translated label; wiring.js and the canvas use the key.
 */

import { categoryColor } from "./colors.js";
import { t, tn } from "./i18n.js";

export const KINDS = new Map();

function register(cls) {
  KINDS.set(cls.type, cls);
  return cls;
}

export function kindOf(node) {
  return KINDS.get(node?.type) ?? NodeKind;
}

// ---------------------------------------------------------------- helpers

/** Remove a list item by identity (indices shift after a splice). */
function dropItem(list, item) {
  const idx = list.indexOf(item);
  if (idx >= 0) list.splice(idx, 1);
}

function exists(graph, id) {
  return (graph.nodes ?? []).some((n) => n.id === id);
}

/** @param what the port as named in the JSON (`next`, `body`), or translated
 * text where there is no such name */
function refIssue(graph, id, what) {
  return id && !exists(graph, id) ? [t("issue.notInGraph", { what, id })] : [];
}

/** Variables referenced in a CEL expression, in both forms: `vars.x`, and
 * `vars['итог']` for names that are not ASCII identifiers (CEL allows the
 * dotted form only for those). Missing the index form would drop a data port
 * (see `tests/ports.mjs`). */
export function celRefs(expr) {
  const refs = [];
  const pattern = /\bvars(?:\.([^\W\d]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/gu;
  for (const m of String(expr ?? "").matchAll(pattern)) {
    refs.push({ name: m[1] ?? m[2] });
  }
  return refs;
}

/** A dependency cycle between one entry node's variables: they are bound in
 * dependency order, so a cycle cannot be computed. */
function cycleIssues(rows) {
  const own = new Set(rows.map((r) => r.name).filter(Boolean));
  const deps = new Map(rows
    .filter((r) => r.name)
    .map((r) => [r.name, r.source === "cel"
      ? celRefs(r.value).map((x) => x.name).filter((n) => own.has(n))
      : []]));
  const done = new Set();
  let moved = true;
  while (moved) {
    moved = false;
    for (const [name, refs] of deps) {
      if (done.has(name) || !refs.every((r) => done.has(r))) continue;
      done.add(name);
      moved = true;
    }
  }
  const stuck = [...deps.keys()].filter((n) => !done.has(n)).sort();
  return stuck.length ? [t("issue.varCycle", { names: stuck.join(", ") })] : [];
}

/** A literal from a text input: a number, bool, null or JSON, else a string.
 *
 * Only the JSON attempt trims; a string is returned as typed, so a value of
 * spaces (ConcatStage's `separator: " "`) is not turned into an empty string. */
export function parseLiteral(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return text ?? "";
  try { return JSON.parse(trimmed); } catch { return text; }
}

export function formatLiteral(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** An expression that is exactly one variable: `vars.x`, `vars['итог']`. */
const WHOLE_VAR = /^\s*vars(?:\.([^\W\d]\w*)|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\])\s*$/u;

/** A variable as CEL addresses it: dotted for an identifier, indexed
 * otherwise (`vars['итог']`), the two shapes `celRefs` reads. */
export function celVarRef(name) {
  const clean = String(name ?? "").trim();
  if (!clean) return "";
  return /^[^\W\d]\w*$/u.test(clean) ? `vars.${clean}` : `vars['${clean}']`;
}

/**
 * How an expression was written: a bare variable, a bare value, or a real
 * expression.
 *
 * A condition, a case's `when` and a loop's `items` are CEL only, so unlike a
 * stage argument they cannot store the source as a separate shape. It is read
 * back from the text, and the panel offers the same three choices as for a
 * stage argument. An empty field is a variable not yet named.
 */
export function celSource(expr) {
  const text = String(expr ?? "");
  if (!text.trim()) return { source: "vars", value: "" };
  const whole = text.match(WHOLE_VAR);
  if (whole) return { source: "vars", value: whole[1] ?? whole[2] ?? whole[3] };
  try {
    const value = formatLiteral(JSON.parse(text));
    // only if it round-trips; otherwise the string "42" would silently become
    // the number 42 on first edit
    if (celExpr("const", value) === text) return { source: "const", value };
  } catch { /* not a value, then — an expression */ }
  return { source: "cel", value: text };
}

/** The expression text for a source and value; the inverse of `celSource`.
 * A value is written as JSON, which is valid CEL for anything a form makes. */
export function celExpr(source, value) {
  if (source === "vars") return celVarRef(value);
  if (source !== "const") return String(value ?? "");
  const text = String(value ?? "");
  return text.trim() === "" ? "" : JSON.stringify(parseLiteral(text));
}

/**
 * The read ports of an expression field, labelled like a stage argument's:
 * `items ← tickets` for a variable, `items ← ƒ(a,b)` for an expression, so the
 * card says what the variable is for.
 */
function celFieldIns(field, expr) {
  const refs = celRefs(expr);
  if (!refs.length) return [];
  return celSource(expr).source === "vars"
    ? [{ label: `${field} ← ${refs[0].name}`, refs }]
    : [{ label: `${field} ← ƒ(${refs.map((r) => r.name).join(",")})`, refs }];
}

// ------------------------------------------- arguments <-> form rows

/** node.arguments (vars/const buckets, `.$` = CEL) -> rows
 * {name, source: vars|const|cel, value}. */
export function argRows(node) {
  const rows = [];
  const buckets = node.arguments ?? {};
  const bucket = buckets.vars;
  const entries = Array.isArray(bucket)
    ? bucket.map((name) => [name, name])
    : Object.entries(bucket ?? {});
  for (const [key, value] of entries) {
    if (key.endsWith(".$")) rows.push({ name: key.slice(0, -2), source: "cel", value });
    else rows.push({ name: key, source: "vars", value });
  }
  for (const [key, value] of Object.entries(buckets.const ?? {})) {
    if (key.endsWith(".$")) rows.push({ name: key.slice(0, -2), source: "cel", value });
    else rows.push({ name: key, source: "const", value: formatLiteral(value) });
  }
  return rows;
}

export function writeArgRows(node, rows) {
  const out = {};
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    if (row.source === "const") (out.const ??= {})[name] = parseLiteral(String(row.value ?? ""));
    else if (row.source === "cel") (out.const ??= {})[`${name}.$`] = row.value;
    else (out[row.source] ??= {})[name] = (row.value ?? "").trim() || name;
  }
  Object.keys(out).length ? node.arguments = out : delete node.arguments;
}

// --------------------------------------------- outputs <-> form rows

/** node.outputs -> rows {src, dest, cel}: a plain key sends result field src
 * to variable dest; with cel, src is a CEL expression. */
export function outputRows(node) {
  const rows = [];
  for (const [key, value] of Object.entries(node.outputs ?? {})) {
    if (key.endsWith(".$")) rows.push({ src: value, dest: key.slice(0, -2), cel: true });
    else rows.push({ src: key, dest: value, cel: false });
  }
  return rows;
}

export function writeOutputRows(node, rows) {
  const bucket = {};
  for (const row of rows) {
    const src = (row.src ?? "").trim();
    const dest = (row.dest ?? "").trim();
    if (!dest) continue;
    // a computed output may get its expression later (validation reports an
    // empty one); a plain one needs both ends, since the key names a result
    // field
    if (row.cel) bucket[`${dest}.$`] = src;
    else if (src) bucket[src] = dest;
  }
  Object.keys(bucket).length ? node.outputs = bucket : delete node.outputs;
}

// --------------------------------------- entry.variables <-> form rows

/** node.variables -> rows {name, source: const|cel, value}. */
export function varRows(node) {
  const rows = [];
  for (const [key, value] of Object.entries(node.variables ?? {})) {
    if (key.endsWith(".$")) rows.push({ name: key.slice(0, -2), source: "cel", value });
    else rows.push({ name: key, source: "const", value: formatLiteral(value) });
  }
  return rows;
}

export function writeVarRows(node, rows) {
  const out = {};
  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    // an expression may be filled in later (validation reports an empty one),
    // so the row is kept
    if (row.source === "cel") out[`${name}.$`] = row.value ?? "";
    else out[name] = parseLiteral(String(row.value ?? ""));
  }
  Object.keys(out).length ? node.variables = out : delete node.variables;
}

// ------------------------------------------------- shared port helpers

function exposeDataPorts(node) {
  const ins = [];
  const outs = [];
  for (const [src, dst] of Object.entries(node.expose ?? {})) {
    if (src) ins.push({ label: `⇢ ${src}`, refs: [{ name: src }] });
    if (dst) outs.push({ label: `⇢ ${dst}`, variable: { name: dst } });
  }
  return { ins, outs };
}

// --------------------------------------------- shared form descriptors

const exposeFieldDesc = (node) => ({
  kind: "rows", group: "more", label: t("field.expose"),
  columns: [
    { key: "srcName", type: "text", placeholder: t("field.expose.from") },
    { key: "arrow", type: "label", text: "→", width: "20px" },
    { key: "dstName", type: "text", placeholder: t("field.expose.to") },
  ],
  get: () => Object.entries(node.expose ?? {}).map(([src, dst]) => ({
    srcName: src, dstName: dst,
  })),
  set: (rows) => {
    const out = {};
    for (const r of rows) {
      if (r.srcName?.trim() && r.dstName?.trim()) {
        out[r.srcName.trim()] = r.dstName.trim();
      }
    }
    Object.keys(out).length ? node.expose = out : delete node.expose;
  },
  incomplete: (r) => !r.srcName?.trim() || !r.dstName?.trim(),
  blank: () => ({ srcName: "", dstName: "" }),
});

const retryFieldDesc = (node) => ({
  kind: "rows", group: "more", label: t("field.retry"), collapsed: true,
  columns: [
    { key: "errors", type: "text", placeholder: t("field.retry.errors") },
    { key: "attempts", type: "number", placeholder: "3", width: "58px", title: "max_attempts" },
    { key: "interval", type: "number", placeholder: "1.0", width: "58px", title: "interval_seconds" },
  ],
  get: () => (node.retry ?? []).map((r) => ({
    errors: (r.error_equals ?? ["*"]).join(","),
    attempts: r.max_attempts ?? "",
    interval: r.interval_seconds ?? "",
  })),
  set: (rows) => {
    const out = rows.filter((r) => r.errors?.trim()).map((r) => ({
      error_equals: r.errors.split(",").map((s) => s.trim()).filter(Boolean),
      ...(r.attempts !== "" && r.attempts != null ? { max_attempts: Number(r.attempts) } : {}),
      ...(r.interval !== "" && r.interval != null ? { interval_seconds: Number(r.interval) } : {}),
    }));
    out.length ? node.retry = out : delete node.retry;
  },
  blank: () => ({ errors: "*", attempts: "", interval: "" }),
});

// -------------------------------------------------------------- the base

export class NodeKind {
  static type = "node";
  // a getter: a static field would be evaluated at class definition, before
  // any catalog is loaded
  static get title() { return t("kind.node"); }
  static color = "#97a0ad";
  /** The kind's glyph; a stage node shows the stage's icon instead. */
  static glyph = "◆";

  static defaults(id) { return { id, type: this.type }; }

  static subtitle(_node, _env) { return ""; }

  /** The card icon: a glyph, an SVG link or inline markup. */
  static icon(_node, _env) { return this.glyph; }

  /** Shown instead of the icon if it fails to load. */
  static iconFallback(_node, _env) { return this.glyph; }

  /** Whether to paint an SVG icon in the node color (monochrome sets). */
  static iconMono(_node, _env) { return false; }

  /** The card's accent color. */
  static accent(_node, _env) { return this.color; }

  /** The note under the title (for a stage, its description from the backend). */
  static description(_node, _env) { return ""; }

  /**
   * Badges for behaviour not visible without the inspector: retries, error
   * handling, consumed and exposed variables.
   */
  static badges(node) {
    const badges = [];
    if (node.retry?.length) badges.push({ glyph: "↻", title: t("badge.retry") });
    if (node.consume?.length) {
      badges.push({ glyph: "✂",
                    title: t("badge.consume", { names: node.consume.join(", ") }) });
    }
    if (node.expose && Object.keys(node.expose).length) {
      badges.push({ glyph: "⇄", title: t("badge.expose") });
    }
    return badges;
  }

  /** Control ports: {key, label} with get/set of the target, or add+drop for
   * list ports. `key` is stable, independent of the label. */
  static orderPorts(_node) { return []; }

  /**
   * The port that continues the flow. Inserted into an edge, the node takes
   * the old target here (`wiring.js`): a stage inserted between A and B gets B
   * as its `next`. Branching kinds override it.
   */
  static continuationKey(_node) { return "next"; }

  /**
   * The port the next node attaches to when added with this one selected.
   * Usually the continuation, but branching kinds need branches first: an
   * empty `parallel` needs a branch, not a `next`.
   */
  static appendKey(node) { return this.continuationKey(node); }

  /** Variable reads: {label, refs: [{name}, ...]}. */
  static dataIns(node) { return exposeDataPorts(node).ins; }

  /** Variable writes: {label, variable: {name}}. */
  static dataOuts(node) { return exposeDataPorts(node).outs; }

  /**
   * Value rows on the card: settings that do not read the frame (literals,
   * expressions without variables). They have no connector, but are shown so
   * the card says what the node does (a `fetch` without its `url` says
   * little).
   */
  static valueRows(_node) { return []; }

  /** The entries of the node's own region (parallel branches, a try body), or
   * null. The canvas draws a region from them. */
  static regionEntries(_node) { return null; }

  /** The node's regions as groups: `{entries, key?, title?, glyph?, color?,
   * rank?}`, by default one from `regionEntries`. A `try` has two (body and
   * handlers); a node reachable from both belongs to the first. */
  static regionGroups(node) {
    const entries = this.regionEntries(node);
    return entries?.length ? [{ entries }] : [];
  }

  /** Accept a variable dropped on the node (canvas). Returns options
   * {label, apply} for a menu. */
  static acceptVariable(_node, _variable, _env) { return []; }

  static fields(_node, _env) { return []; }

  static validate(node, _graph, _pipeline, _env) {
    const issues = [];
    for (const [src, dst] of Object.entries(node.expose ?? {})) {
      for (const path of [src, dst]) {
        if (!/^[^\W\d]\w*$/u.test(path)) {
          issues.push(t("issue.exposeName", { name: path }));
        }
      }
    }
    return issues;
  }
}

// ------------------------------------------------------------------- entry

export const EntryKind = register(class EntryKind extends NodeKind {
  static type = "entry";
  static get title() { return t("kind.entry"); }
  static color = "#3fbf9f";
  static glyph = "▶";

  static description() { return t("kind.entry.about"); }

  static defaults(id) { return { id, type: "entry", variables: {}, next: null }; }

  static subtitle(node) {
    const names = varRows(node).map((r) => r.name).filter(Boolean);
    return names.length ? names.join(", ") : t("kind.entry.noVars");
  }

  static orderPorts(node) {
    return [{ key: "next", label: "next", get: () => node.next, set: (v) => { node.next = v; } }];
  }

  /** An expression reads variables from outside, or other variables of this
   * node (bound in dependency order, see EntryNode.seed_plan in the core). */
  static dataIns(node) {
    const own = new Set(varRows(node).map((r) => r.name));
    const ins = [];
    for (const row of varRows(node)) {
      if (row.source !== "cel") continue;
      const refs = celRefs(row.value).filter((r) => !own.has(r.name));
      if (refs.length) {
        ins.push({ label: `${row.name} ← ƒ(${refs.map((r) => r.name).join(",")})`, refs });
      }
    }
    return [...ins, ...super.dataIns(node)];
  }

  static dataOuts(node) {
    const outs = varRows(node).map((row) => ({
      label: `${row.source === "cel" ? "ƒ" : "="} → ${row.name}`,
      variable: { name: row.name },
    }));
    return [...outs, ...super.dataOuts(node)];
  }

  static acceptVariable(node, variable) {
    return [{
      label: t("accept.entryDefault", { name: variable.name }),
      apply: () => {
        const rows = varRows(node).filter((r) => r.name !== variable.name);
        rows.push({ name: variable.name, source: "const", value: "" });
        writeVarRows(node, rows);
      },
    }];
  }

  static fields(node) {
    return [
      { kind: "rows", group: "out", label: t("field.entryVars"),
        columns: [
          { key: "name", type: "text", placeholder: t("field.varName"), width: "112px" },
          { key: "source", type: "select", width: "104px",
            options: [["const", t("field.source.const")], ["cel", t("field.source.cel")]] },
          { key: "value", type: "text", placeholder: t("field.entryVars.value") },
        ],
        get: () => varRows(node),
        set: (rows) => writeVarRows(node, rows),
        incomplete: (r) => !r.name?.trim(),
        blank: () => ({ name: "", source: "const", value: "" }) },
      exposeFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    const rows = varRows(node);
    const seen = new Set();
    for (const row of rows) {
      if (!row.name) issues.push(t("issue.varNoName"));
      else if (seen.has(row.name)) issues.push(t("issue.varTwice", { name: row.name }));
      seen.add(row.name);
      if (row.source === "cel" && !String(row.value ?? "").trim()) {
        issues.push(t("issue.varNoExpr", { name: row.name }));
      }
    }
    issues.push(...cycleIssues(rows));

    // one entry point, never jumped back into: the core's rules
    // (Pipeline._entry_node_errors)
    const others = (graph.nodes ?? []).filter((n) => n !== node && n.type === "entry");
    if (others.length) {
      issues.push(t("issue.manyEntries", { nodes: others.map((n) => n.id).join(", ") }));
    }
    for (const other of graph.nodes ?? []) {
      if (other === node) continue;
      if (kindOf(other).orderPorts(other).some((p) => p.get?.() === node.id)) {
        issues.push(t("issue.intoEntry", { node: other.id }));
      }
    }
    issues.push(...refIssue(graph, node.next, "next"));
    return issues;
  }
});

// ------------------------------------------------------------------- stage

export const StageKind = register(class StageKind extends NodeKind {
  static type = "stage";
  static get title() { return t("kind.stage"); }
  static color = "#4fb8e8";
  static glyph = "▢";

  static defaults(id) { return { id, type: "stage", stage: "", next: null }; }

  static subtitle(node) { return node.stage || t("kind.stage.none"); }

  /** The icon from the stage docstring, or a monogram of its name
   * (`IncrementStage` -> `IS`) so stages can be told apart. */
  static icon(node, env) {
    return env?.stages?.get(node.stage)?.icon || this.iconFallback(node, env);
  }

  static iconFallback(node) {
    if (!node.stage) return this.glyph;
    const caps = node.stage.replace(/Stage$/, "").match(/\p{Lu}/gu);
    return caps ? caps.slice(0, 2).join("") : node.stage.slice(0, 2);
  }

  static iconMono(node, env) {
    return Boolean(env?.stages?.get(node.stage)?.icon_mono);
  }

  /** The docstring's color, else the category's, else the kind's. */
  static accent(node, env) {
    const spec = env?.stages?.get(node.stage);
    return spec?.color || categoryColor(spec?.category) || this.color;
  }

  static description(node, env) {
    return env?.stages?.get(node.stage)?.description ?? "";
  }

  static orderPorts(node) {
    return [{ key: "next", label: "next", get: () => node.next, set: (v) => { node.next = v; } }];
  }

  static dataIns(node) {
    const ins = [];
    for (const row of argRows(node)) {
      if (row.source === "vars") {
        ins.push({ label: `${row.name} ← ${row.value}`, refs: [{ name: row.value }] });
      } else if (row.source === "cel") {
        const refs = celRefs(row.value);
        if (refs.length) {
          ins.push({ label: `${row.name} ← ƒ(${refs.map((r) => r.name).join(",")})`, refs });
        }
      }
    }
    // a computed output reads the frame: `{"total.$": "vars.total + 1"}` reads
    // `total` as it was before this node (see apply_outputs in the core).
    // Without this port the node would seem to write from nowhere
    for (const row of outputRows(node)) {
      if (!row.cel) continue;
      const refs = celRefs(row.src);
      if (refs.length) {
        ins.push({ label: `${row.dest} ← ƒ(${refs.map((r) => r.name).join(",")})`, refs });
      }
    }
    return [...ins, ...super.dataIns(node)];
  }

  static dataOuts(node) {
    const outs = outputRows(node).map((row) => ({
      label: `${row.cel ? "ƒ" : row.src} → ${row.dest}`,
      variable: { name: row.dest },
    }));
    return [...outs, ...super.dataOuts(node)];
  }

  /** Value arguments (`url = "https://…"`, `delta = 10`) and expressions that
   * read no variables (`ƒ 2 + 2`). A long list is shortened. */
  static valueRows(node) {
    const rows = [];
    for (const row of argRows(node)) {
      if (row.source === "const") {
        const text = String(row.value ?? "");
        // show an empty or all-space value (ConcatStage's `separator: " "`)
        // quoted, so it does not look unset
        rows.push({ name: row.name, text: text.trim() === "" ? JSON.stringify(text) : text });
      }
      else if (row.source === "cel" && !celRefs(row.value).length) {
        rows.push({ name: row.name, text: `ƒ ${row.value ?? ""}` });
      }
    }
    const LIMIT = 6;
    if (rows.length <= LIMIT) return rows;
    return [...rows.slice(0, LIMIT - 1),
      { name: "…", text: tn("card.moreValues", rows.length - (LIMIT - 1)) }];
  }

  static acceptVariable(node, variable, env) {
    const spec = env.stages.get(node.stage);
    const known = (spec?.arguments ?? []).map((a) => a.name).filter((n) => n && n !== "*");
    const bind = (argName) => () => {
      const rows = argRows(node).filter((r) => r.name !== argName);
      rows.push({ name: argName, source: "vars", value: variable.name });
      writeArgRows(node, rows);
    };
    const options = known.map((name) => ({
      label: t("accept.argument", { name }), apply: bind(name),
    }));
    options.push({ label: t("accept.argumentOwn"), prompt: t("accept.argumentPrompt"),
                   applyNamed: (n) => bind(n)() });
    return options;
  }

  static fields(node, env) {
    const spec = env.stages.get(node.stage);
    return [
      { kind: "select", group: "main", label: t("field.stage"),
        get: () => node.stage, set: (v) => { node.stage = v; },
        options: ["", ...env.stages.names()] },
      // inputs and outputs come from the stage spec: rows for what the stage
      // declares
      { kind: "spec-args", group: "in", label: t("field.arguments"), node, spec },
      { kind: "spec-outputs", group: "out", label: t("field.outputs"), node, spec },
      { kind: "tags", group: "more", label: t("field.consume"),
        get: () => node.consume ?? [],
        set: (v) => { v.length ? node.consume = v : delete node.consume; } },
      exposeFieldDesc(node),
      retryFieldDesc(node),
      { kind: "stage-spec", group: "more", stage: () => node.stage },
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!node.stage) issues.push(t("issue.noStage"));
    else if (env.stages.loaded && !env.stages.get(node.stage)) {
      issues.push(t("issue.unknownStage", { stage: node.stage }));
    }
    // a required argument left empty; the panel marks it red, the status bar
    // gets the same text
    const spec = env.stages.get(node.stage);
    const filled = new Set(argRows(node).map((r) => r.name));
    for (const arg of spec?.arguments ?? []) {
      if (arg.optional || arg.name === "*" || filled.has(arg.name)) continue;
      issues.push(t("issue.argRequired", { name: arg.name }));
    }
    // an outputs key names a result field; one the stage does not return fails
    // at run time (StageOutputError). The core checks it too
    // (StageNode._validate_output_fields); here it is caught before the run
    const declaredOuts = (spec?.outputs ?? []).map((o) => o.name);
    for (const row of outputRows(node)) {
      if (row.cel) {
        if (!row.src) issues.push(t("issue.outNoExpr", { name: row.dest }));
        continue;
      }
      if (!declaredOuts.length || declaredOuts.includes("*")) continue;
      if (declaredOuts.includes(row.src)) continue;
      issues.push(t("issue.noSuchOutput",
                     { name: row.src, available: declaredOuts.join(", ") }));
    }
    issues.push(...refIssue(graph, node.next, "next"));
    return issues;
  }
});

// --------------------------------------------------------------- condition

export const ConditionKind = register(class ConditionKind extends NodeKind {
  static type = "condition";
  static get title() { return t("kind.condition"); }
  static color = "#e8b85c";
  static glyph = "?";

  static description() { return t("kind.condition.about"); }

  /** Inserted into an edge, a `condition` takes the old target on its "yes"
   * branch, the main road; `else` is the exception. */
  static continuationKey() { return "then"; }

  static defaults(id) { return { id, type: "condition", condition: "", then: null }; }

  static subtitle(node) { return node.condition || t("kind.condition.empty"); }

  static orderPorts(node) {
    return [
      { key: "then", label: "then", get: () => node.then, set: (v) => { node.then = v; } },
      { key: "else", label: "else", get: () => node.else, set: (v) => { node.else = v; } },
    ];
  }

  static dataIns(node) {
    return [...celFieldIns("condition", node.condition), ...super.dataIns(node)];
  }

  static acceptVariable(node, variable) {
    return [{
      label: t("accept.conditionOn", { name: variable.name }),
      apply: () => { node.condition = celVarRef(variable.name); },
    }];
  }

  static fields(node) {
    return [
      { kind: "value", group: "main", label: t("field.condition"), varName: "condition",
        get: () => node.condition, set: (v) => { node.condition = v ?? ""; },
        placeholder: "vars.count > 0" },
      exposeFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!node.condition) issues.push(t("issue.emptyCondition"));
    if (!node.then) issues.push(t("issue.noThen"));
    issues.push(...refIssue(graph, node.then, "then"), ...refIssue(graph, node.else, "else"));
    return issues;
  }
});

// ------------------------------------------------------------------ switch

export const SwitchKind = register(class SwitchKind extends NodeKind {
  static type = "switch";
  static get title() { return t("kind.switch"); }
  static color = "#b07ce0";
  static glyph = "⑂";

  static description() { return t("kind.switch.about"); }

  static defaults(id) { return { id, type: "switch", cases: [] }; }

  static subtitle(node) { return tn("kind.switch.cases", (node.cases ?? []).length); }

  /** With no cases yet, the next node becomes the first case, not `default`. */
  static appendKey(node) { return (node.cases ?? []).length ? "default" : "add-case"; }

  static orderPorts(node) {
    const ports = (node.cases ?? []).map((c) => ({
      key: "case",
      label: `when ${c.when ?? ""}`.slice(0, 24),
      get: () => c.next,
      set: (v) => { c.next = v; },
      removeItem: () => dropItem(node.cases, c),
    }));
    ports.push({
      key: "add-case", label: "+ case", add: true,
      drop: (target) => { (node.cases ??= []).push({ when: "true", next: target }); },
    });
    ports.push({
      key: "default", label: "default",
      get: () => node.default, set: (v) => { node.default = v; },
    });
    return ports;
  }

  static dataIns(node) {
    const seen = new Set();
    const ins = [];
    for (const branch of node.cases ?? []) {
      for (const port of celFieldIns("when", branch.when)) {
        if (seen.has(port.label)) continue;
        seen.add(port.label);
        ins.push(port);
      }
    }
    return [...ins, ...super.dataIns(node)];
  }

  static acceptVariable(node, variable) {
    return [{
      label: t("accept.switchCase", { name: variable.name }),
      apply: () => { (node.cases ??= []).push({ when: celVarRef(variable.name), next: null }); },
    }];
  }

  static fields(node) {
    return [
      { kind: "rows", group: "main", label: t("field.cases"),
        // a case's `when` is CEL; the source column says how it was written,
        // as for a stage argument
        columns: [
          { key: "source", type: "select", width: "104px",
            options: [["vars", t("field.source.vars")], ["const", t("field.source.const")],
              ["cel", t("field.source.cel")]] },
          { key: "when", type: "text", placeholder: t("field.cases.when") },
          { key: "next", type: "node-ref", width: "110px" },
        ],
        get: () => (node.cases ?? []).map((c) => {
          const { source, value } = celSource(c.when);
          return { source, when: value, next: c.next ?? "" };
        }),
        set: (rows) => { node.cases = rows.filter((r) => r.when?.trim() || r.next)
          .map((r) => ({ when: celExpr(r.source ?? "cel", r.when), next: r.next ?? "" })); },
        incomplete: (r) => !r.when?.trim() && !r.next,
        blank: () => ({ source: "vars", when: "", next: "" }) },
      exposeFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!(node.cases ?? []).length) issues.push(t("issue.noCase"));
    for (const c of node.cases ?? []) {
      if (!c.when || !c.next) issues.push(t("issue.caseIncomplete"));
      else issues.push(...refIssue(graph, c.next, "case next"));
    }
    issues.push(...refIssue(graph, node.default, "default"));
    return issues;
  }
});

// ---------------------------------------------------------------- parallel

export const ParallelKind = register(class ParallelKind extends NodeKind {
  static type = "parallel";
  static get title() { return t("kind.parallel"); }
  static color = "#8e8ce8";
  static glyph = "⇉";

  static description(node) {
    return t(node.cancel_on_error === false
      ? "kind.parallel.about.keep" : "kind.parallel.about.cancel");
  }

  static defaults(id) { return { id, type: "parallel", branches: [], next: null }; }

  static subtitle(node) {
    return (node.branches ?? []).map((b) => b.id).join(", ") || t("kind.parallel.none");
  }

  /** With no branches yet, the next node becomes a branch, not what follows
   * the merge. */
  static appendKey(node) { return (node.branches ?? []).length ? "next" : "add-branch"; }

  static orderPorts(node) {
    const ports = (node.branches ?? []).map((b) => ({
      key: "branch",
      label: `▷ ${b.id}`,
      dashed: true,
      get: () => b.entry,
      set: (v) => { b.entry = v; },
      removeItem: () => dropItem(node.branches, b),
    }));
    ports.push({
      key: "add-branch", label: "+ branch", dashed: true, add: true,
      drop: (target) => {
        const branches = (node.branches ??= []);
        branches.push({ id: `b${branches.length + 1}`, entry: target });
      },
    });
    ports.push({ key: "next", label: "next", get: () => node.next, set: (v) => { node.next = v; } });
    return ports;
  }

  static regionEntries(node) {
    return (node.branches ?? []).map((b) => b.entry).filter(Boolean);
  }

  static fields(node) {
    return [
      { kind: "rows", group: "main", label: t("field.branches"),
        columns: [
          { key: "id", type: "text", placeholder: t("field.branches.id"), width: "96px" },
          { key: "entry", type: "node-ref", width: "110px" },
        ],
        get: () => (node.branches ?? []).map((b) => ({ id: b.id ?? "", entry: b.entry ?? "" })),
        set: (rows) => { node.branches = rows.filter((r) => r.id?.trim() && r.entry)
          .map((r) => ({ id: r.id.trim(), entry: r.entry })); },
        incomplete: (r) => !r.id?.trim() || !r.entry,
        blank: () => ({ id: "", entry: "" }) },
      { kind: "check", group: "more", label: t("field.cancelBranches"),
        get: () => node.cancel_on_error !== false,
        set: (v) => { v ? delete node.cancel_on_error : node.cancel_on_error = false; } },
      exposeFieldDesc(node),
      retryFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!(node.branches ?? []).length) issues.push(t("issue.noBranch"));
    for (const b of node.branches ?? []) {
      issues.push(...refIssue(graph, b.entry, t("issue.branchEntry", { id: b.id })));
    }
    issues.push(...refIssue(graph, node.next, "next"));
    return issues;
  }
});

// ------------------------------------------------------------- subpipeline

export const SubpipelineKind = register(class SubpipelineKind extends NodeKind {
  static type = "subpipeline";
  static get title() { return t("kind.subpipeline"); }
  static color = "#d66fa0";
  static glyph = "▣";

  static description() { return t("kind.subpipeline.about"); }

  static defaults(id) { return { id, type: "subpipeline", subpipeline_id: "", next: null }; }

  static subtitle(node) {
    return node.subpipeline_id ? `→ ${node.subpipeline_id}` : t("kind.subpipeline.none");
  }

  static orderPorts(node) {
    return [{ key: "next", label: "next", get: () => node.next, set: (v) => { node.next = v; } }];
  }

  static dataIns(node) {
    const ins = Object.entries(node.inputs ?? {}).map(([child, parent]) => ({
      label: `${child} ← ${parent}`,
      refs: [{ name: parent }],
    }));
    return [...ins, ...super.dataIns(node)];
  }

  static dataOuts(node) {
    const outs = Object.entries(node.artifact_outputs ?? {}).map(([parent, child]) => ({
      label: `${child} → ${parent}`,
      variable: { name: parent },
    }));
    if (node.result_output) {
      outs.push({ label: `result → ${node.result_output}`,
        variable: { name: node.result_output } });
    }
    return [...outs, ...super.dataOuts(node)];
  }

  static acceptVariable(node, variable) {
    return [{
      label: t("accept.intoInputs"),
      prompt: t("accept.intoInputs.prompt"),
      applyNamed: (child) => { (node.inputs ??= {})[child] = variable.name; },
    }];
  }

  static fields(node, env) {
    return [
      { kind: "select", group: "main", label: t("field.subpipeline"),
        get: () => node.subpipeline_id, set: (v) => { node.subpipeline_id = v; },
        options: ["", ...Object.keys(env.model.pipeline.subpipelines ?? {})] },
      { kind: "rows", group: "in", label: t("field.inputs"),
        columns: [
          { key: "child", type: "text", placeholder: t("field.inputs.child"), width: "110px" },
          { key: "arrow", type: "label", text: "←", width: "20px" },
          { key: "parent", type: "text", placeholder: t("field.parentVar") },
        ],
        get: () => Object.entries(node.inputs ?? {}).map(([child, parent]) => ({ child, parent })),
        set: (rows) => {
          const out = {};
          for (const r of rows) if (r.child?.trim() && r.parent?.trim()) out[r.child.trim()] = r.parent.trim();
          Object.keys(out).length ? node.inputs = out : delete node.inputs;
        },
        incomplete: (r) => !r.child?.trim() || !r.parent?.trim(),
        blank: () => ({ child: "", parent: "" }) },
      { kind: "rows", group: "out", label: t("field.artifactOutputs"),
        columns: [
          { key: "parent", type: "text", placeholder: t("field.parentVar"), width: "110px" },
          { key: "arrow", type: "label", text: "←", width: "20px" },
          { key: "child", type: "text", placeholder: t("field.childArtifact") },
        ],
        get: () => Object.entries(node.artifact_outputs ?? {})
          .map(([parent, child]) => ({ parent, child })),
        set: (rows) => {
          const out = {};
          for (const r of rows) if (r.parent?.trim() && r.child?.trim()) out[r.parent.trim()] = r.child.trim();
          Object.keys(out).length ? node.artifact_outputs = out : delete node.artifact_outputs;
        },
        incomplete: (r) => !r.parent?.trim() || !r.child?.trim(),
        blank: () => ({ parent: "", child: "" }) },
      { kind: "text", group: "out", label: t("field.resultOutput"),
        get: () => node.result_output,
        set: (v) => { v ? node.result_output = v : delete node.result_output; } },
      exposeFieldDesc(node),
      retryFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!node.subpipeline_id) issues.push(t("issue.noSubpipeline"));
    else if (!(node.subpipeline_id in (pipeline.subpipelines ?? {}))) {
      issues.push(t("issue.unknownSubpipeline", { id: node.subpipeline_id }));
    }
    issues.push(...refIssue(graph, node.next, "next"));
    return issues;
  }
});

// ---------------------------------------------------------------- terminal

export const TerminalKind = register(class TerminalKind extends NodeKind {
  static type = "terminal";
  static get title() { return t("kind.terminal"); }
  static color = "#4ecb86";
  static glyph = "◉";

  static description() { return t("kind.terminal.about"); }

  static defaults(id) { return { id, type: "terminal" }; }

  static subtitle(node) {
    return t((node.artifacts ?? []).length
      ? "kind.terminal.withArtifacts" : "kind.terminal.plain");
  }

  static dataIns(node) {
    const ins = (node.artifacts ?? []).map((name) => ({
      label: `⭳ ${name}`,
      refs: [{ name }],
    }));
    return [...ins, ...super.dataIns(node)];
  }

  static acceptVariable(node, variable) {
    return [{
      label: t("accept.intoArtifacts", { name: variable.name }),
      apply: () => {
        node.artifacts ??= [];
        if (!node.artifacts.includes(variable.name)) node.artifacts.push(variable.name);
      },
    }];
  }

  static fields(node) {
    return [
      { kind: "rows", group: "main", label: t("field.result"),
        columns: [
          { key: "key", type: "text", placeholder: t("field.result.key"), width: "110px" },
          { key: "value", type: "text", placeholder: t("field.result.value") },
        ],
        get: () => Object.entries(node.result ?? {})
          .map(([key, value]) => ({ key, value: formatLiteral(value) })),
        set: (rows) => {
          const out = {};
          for (const r of rows) if (r.key?.trim()) out[r.key.trim()] = parseLiteral(String(r.value ?? ""));
          Object.keys(out).length ? node.result = out : delete node.result;
        },
        incomplete: (r) => !r.key?.trim(),
        blank: () => ({ key: "", value: "" }) },
      { kind: "tags", group: "out", label: t("field.artifacts"),
        get: () => node.artifacts ?? [],
        set: (v) => { v.length ? node.artifacts = v : delete node.artifacts; } },
      exposeFieldDesc(node),
    ];
  }
});


// -------------------------------------------------------------------- try

export const TryKind = register(class TryKind extends NodeKind {
  static type = "try";
  static get title() { return t("kind.try"); }
  static color = "#e8935c";
  static glyph = "⛑";

  static defaults(id) {
    return { id, type: "try", body: null, except: [{ error_equals: ["*"], next: null }] };
  }

  static subtitle(node) {
    const kinds = (node.except ?? []).map((h) => (h.error_equals ?? ["*"]).join(","));
    return kinds.length ? `except ${kinds.join(" | ")}` : t("kind.try.none");
  }

  static description() { return t("kind.try.about"); }

  /** Inserted into an edge, a `try` takes the old target into its body: the
   * block protects what follows. */
  static continuationKey() { return "body"; }

  static regionEntries(node) {
    return node.body ? [node.body] : [];
  }

  /** Two regions: the body, and the handlers in red (the error color), showing
   * they run only when the body fails. */
  static regionGroups(node) {
    const groups = [];
    if (node.body) groups.push({ entries: [node.body] });
    const handlers = (node.except ?? []).map((h) => h.next).filter(Boolean);
    if (handlers.length) {
      groups.push({
        key: "except", entries: handlers, title: "except",
        glyph: "⚠", color: "#e8697a", rank: 1,
      });
    }
    return groups;
  }

  static orderPorts(node) {
    const ports = [
      { key: "body", label: "body", get: () => node.body, set: (v) => { node.body = v; } },
    ];
    for (const handler of node.except ?? []) {
      ports.push({
        key: "except",
        label: `except ${(handler.error_equals ?? ["*"]).join(",")}`.slice(0, 22),
        dashed: true,
        get: () => handler.next,
        set: (v) => { handler.next = v; },
        removeItem: () => dropItem(node.except, handler),
      });
    }
    ports.push({
      key: "add-except", label: "+ except", dashed: true, add: true,
      drop: (target) => { (node.except ??= []).push({ error_equals: ["*"], next: target }); },
    });
    ports.push({ key: "next", label: "next", get: () => node.next, set: (v) => { node.next = v; } });
    return ports;
  }

  /** The error object the block stores in result_var. */
  static dataOuts(node) {
    const outs = (node.except ?? [])
      .filter((h) => h.result_var)
      .map((h) => ({
        label: `error → ${h.result_var}`,
        variable: { name: h.result_var },
      }));
    return [...outs, ...super.dataOuts(node)];
  }

  static fields(node) {
    return [
      { kind: "rows", group: "main", label: t("field.handlers"),
        columns: [
          { key: "errors", type: "text", placeholder: t("field.handlers.errors") },
          { key: "next", type: "node-ref", width: "104px" },
          { key: "result_var", type: "text", placeholder: t("field.handlers.resultVar"),
            width: "96px" },
        ],
        get: () => (node.except ?? []).map((h) => ({
          errors: (h.error_equals ?? ["*"]).join(","),
          next: h.next ?? "",
          result_var: h.result_var ?? "",
        })),
        set: (rows) => {
          node.except = rows
            .filter((r) => r.errors?.trim())
            .map((r) => ({
              error_equals: r.errors.split(",").map((x) => x.trim()).filter(Boolean),
              next: r.next || null,
              ...(r.result_var?.trim() ? { result_var: r.result_var.trim() } : {}),
            }));
        },
        blank: () => ({ errors: "*", next: "", result_var: "" }) },
      exposeFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!node.body) issues.push(t("issue.noTryBody"));
    else issues.push(...refIssue(graph, node.body, "body"));
    if (!(node.except ?? []).length) issues.push(t("issue.noHandler"));
    for (const handler of node.except ?? []) {
      if (!handler.next) issues.push(t("issue.handlerNoNext"));
      else issues.push(...refIssue(graph, handler.next, "except.next"));
    }
    issues.push(...refIssue(graph, node.next, "next"));
    return issues;
  }
});

// ---------------------------------------------------------------------- map

/** Nodes reachable from `starts` along order edges, not entering `stopAt`.
 * Same walk as in `regions.js`, which imports this module, so it cannot be
 * imported back; both rely on `orderPorts`. */
function reachableFrom(graph, starts, stopAt = new Set()) {
  const byId = new Map((graph.nodes ?? []).map((n) => [n.id, n]));
  const seen = new Set();
  const queue = [...starts];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id) || stopAt.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const port of kindOf(byId.get(id)).orderPorts(byId.get(id))) {
      const target = port.get?.();
      if (target) queue.push(target);
    }
  }
  return seen;
}

export const MapKind = register(class MapKind extends NodeKind {
  static type = "map";
  static get title() { return t("kind.map"); }
  static color = "#9dc45f";
  static glyph = "⟲";

  static description(node) {
    return t(node.mode === "parallel" ? "kind.map.about.parallel" : "kind.map.about.serial");
  }

  static defaults(id) {
    return { id, type: "map", items: "", body: null, item_var: "item", next: null };
  }

  static subtitle(node) {
    const items = node.items || t("kind.map.noItems");
    return `${items} → ${node.item_var || "item"}`;
  }

  /** Inserted into an edge, a `map` takes the old target into its body: the
   * loop repeats what follows. */
  static continuationKey() { return "body"; }

  /** Without a body the next node becomes the body; after that it follows the
   * loop. */
  static appendKey(node) { return node.body ? "next" : "body"; }

  static regionEntries(node) {
    return node.body ? [node.body] : [];
  }

  static orderPorts(node) {
    return [
      { key: "body", label: "body", human: t("port.loopBody"),
        get: () => node.body, set: (v) => { node.body = v; } },
      { key: "next", label: "next", get: () => node.next, set: (v) => { node.next = v; } },
    ];
  }

  /** The list the loop walks. */
  static dataIns(node) {
    return [...celFieldIns("items", node.items), ...super.dataIns(node)];
  }

  /**
   * The loop's writes: the item and its index, which the body reads (without
   * these ports the body's first node would read a variable nobody writes),
   * and the collected lists left after the loop, one entry per item.
   */
  static dataOuts(node) {
    const outs = [{ label: `item → ${node.item_var || "item"}`,
      variable: { name: node.item_var || "item" } }];
    if (node.index_var) {
      outs.push({ label: `index → ${node.index_var}`, variable: { name: node.index_var } });
    }
    for (const [src, dst] of Object.entries(node.collect ?? {})) {
      outs.push({ label: `${src}[] → ${dst}`, variable: { name: dst } });
    }
    return [...outs, ...super.dataOuts(node)];
  }

  static acceptVariable(node, variable) {
    return [{
      label: t("accept.walkList"),
      apply: () => { node.items = celVarRef(variable.name); },
    }];
  }

  static fields(node) {
    return [
      { kind: "value", group: "main", label: t("field.items"), varName: "items",
        get: () => node.items, set: (v) => { node.items = v ?? ""; },
        placeholder: "vars.tickets", valuePlaceholder: '["a", "b"]' },
      { kind: "text", group: "out", label: t("field.itemVar"),
        get: () => node.item_var ?? "", placeholder: "item",
        set: (v) => { v?.trim() ? node.item_var = v.trim() : delete node.item_var; } },
      { kind: "text", group: "out", label: t("field.indexVar"),
        get: () => node.index_var ?? "", placeholder: t("field.indexVar.none"),
        set: (v) => { v?.trim() ? node.index_var = v.trim() : delete node.index_var; } },
      { kind: "rows", group: "out", label: t("field.collect"),
        columns: [
          { key: "src", type: "text", placeholder: t("field.collect.src"), width: "110px" },
          { key: "arrow", type: "label", text: "→", width: "20px" },
          { key: "dst", type: "text", placeholder: t("field.collect.dst") },
        ],
        get: () => Object.entries(node.collect ?? {}).map(([src, dst]) => ({ src, dst })),
        set: (rows) => {
          const out = {};
          for (const r of rows) if (r.src?.trim() && r.dst?.trim()) out[r.src.trim()] = r.dst.trim();
          Object.keys(out).length ? node.collect = out : delete node.collect;
        },
        incomplete: (r) => !r.src?.trim() || !r.dst?.trim(),
        blank: () => ({ src: "", dst: "" }) },
      { kind: "select", group: "main", label: t("field.mapMode"),
        get: () => node.mode ?? "sequential",
        set: (v) => { v === "parallel" ? node.mode = "parallel" : delete node.mode; },
        options: ["sequential", "parallel"] },
      { kind: "check", group: "more", label: t("field.cancelItems"),
        get: () => node.cancel_on_error !== false,
        set: (v) => { v ? delete node.cancel_on_error : node.cancel_on_error = false; } },
      exposeFieldDesc(node),
      retryFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!node.items) issues.push(t("issue.emptyItems"));
    if (!node.body) issues.push(t("issue.noMapBody"));
    else issues.push(...refIssue(graph, node.body, "body"));
    issues.push(...refIssue(graph, node.next, "next"));

    const names = [[node.item_var ?? "item", "item_var"]];
    if (node.index_var) names.push([node.index_var, "index_var"]);
    for (const [name, field] of names) {
      if (!/^[^\W\d]\w*$/u.test(name)) {
        issues.push(t("issue.fieldVarName", { field, name }));
      }
    }
    if (node.index_var && node.index_var === (node.item_var ?? "item")) {
      issues.push(t("issue.sameVarNames"));
    }
    for (const [src, dst] of Object.entries(node.collect ?? {})) {
      for (const name of [src, dst]) {
        if (!/^[^\W\d]\w*$/u.test(name)) issues.push(t("issue.collectName", { name }));
      }
    }
    issues.push(...this.#escapeIssues(node, graph));
    return issues;
  }

  /** The body must be closed: an edge out of it would abandon the remaining
   * items, and in parallel mode there would be no single frame to continue
   * with. The core refuses such a graph; the editor says so before the run. */
  static #escapeIssues(node, graph) {
    if (!node.body || !exists(graph, node.body)) return [];
    const after = node.next ? reachableFrom(graph, [node.next]) : new Set();
    const members = reachableFrom(graph, [node.body], after);
    members.delete(node.id);
    const issues = [];
    for (const id of [...members].sort()) {
      const member = (graph.nodes ?? []).find((n) => n.id === id);
      for (const port of kindOf(member).orderPorts(member)) {
        const target = port.get?.();
        if (!target || members.has(target) || !exists(graph, target)) continue;
        issues.push(t("issue.escapesLoop", { node: id, target }));
      }
    }
    return issues;
  }
});

// -------------------------------------------------------------------- wait

/** A duration as the core reads it: seconds, or a number with s, m, h or d. */
const DURATION = /^\s*\d+(\.\d+)?\s*[smhd]\s*$/;

export function isDuration(value) {
  if (typeof value === "number") return value > 0;
  return typeof value === "string" && (DURATION.test(value) || Number(value) > 0);
}

export const WaitKind = register(class WaitKind extends NodeKind {
  static type = "wait";
  static get title() { return t("kind.wait"); }
  static color = "#5cc6c6";
  static glyph = "⏸";

  static description() { return t("kind.wait.about"); }

  static defaults(id) { return { id, type: "wait", input: "", next: null }; }

  static subtitle(node) {
    if (!node.input) return t("kind.wait.empty");
    return node.timeout != null
      ? t("kind.wait.forUpTo", { input: node.input, timeout: node.timeout })
      : t("kind.wait.for", { input: node.input });
  }

  static orderPorts(node) {
    const ports = [{ key: "next", label: "next", get: () => node.next,
                     set: (v) => { node.next = v; } }];
    // the timeout road exists only with a timeout
    if (node.timeout != null || node.on_timeout) {
      ports.push({ key: "on_timeout", label: "on_timeout", dashed: true,
                   get: () => node.on_timeout,
                   set: (v) => { v ? node.on_timeout = v : delete node.on_timeout; } });
    }
    return ports;
  }

  static dataIns(node) {
    // a computed output reads the frame, as on a stage
    const ins = [];
    for (const row of outputRows(node)) {
      if (!row.cel) continue;
      const refs = celRefs(row.src);
      if (refs.length) {
        ins.push({ label: `${row.dest} ← ƒ(${refs.map((r) => r.name).join(",")})`, refs });
      }
    }
    return [...ins, ...super.dataIns(node)];
  }

  static dataOuts(node) {
    const outs = outputRows(node).map((row) => ({
      label: `${row.cel ? "ƒ" : row.src} → ${row.dest}`,
      variable: { name: row.dest },
    }));
    return [...outs, ...super.dataOuts(node)];
  }

  static fields(node) {
    return [
      { kind: "text", group: "main", label: t("field.waitInput"),
        get: () => node.input ?? "", placeholder: "approval",
        set: (v) => { node.input = (v ?? "").trim(); } },
      { kind: "text", group: "main", label: t("field.waitTimeout"),
        get: () => node.timeout ?? "", placeholder: t("field.waitTimeout.none"),
        set: (v) => {
          const text = (v ?? "").trim();
          if (!text) { delete node.timeout; return; }
          node.timeout = /^\d+(\.\d+)?$/.test(text) ? Number(text) : text;
        } },
      { kind: "rows", group: "out", label: t("field.waitOutputs"),
        columns: [
          { key: "how", type: "select", width: "52px", title: t("field.waitOutputs.how"),
            options: [["field", t("field.waitOutputs.field")], ["cel", "ƒ"]] },
          { key: "src", type: "text", placeholder: t("field.waitOutputs.src"), width: "110px" },
          { key: "arrow", type: "label", text: "→", width: "20px" },
          { key: "dest", type: "text", placeholder: t("field.waitOutputs.dest") },
        ],
        get: () => outputRows(node).map((r) => ({ ...r, how: r.cel ? "cel" : "field" })),
        set: (rows) => writeOutputRows(node, rows.map((r) => ({ ...r, cel: r.how === "cel" }))),
        incomplete: (r) => !r.dest?.trim() || (r.how !== "cel" && !r.src?.trim()),
        blank: () => ({ how: "field", src: "", dest: "" }) },
      exposeFieldDesc(node),
    ];
  }

  static validate(node, graph, pipeline, env) {
    const issues = super.validate(node, graph, pipeline, env);
    if (!node.input) issues.push(t("issue.waitNoInput"));
    if (node.timeout != null && !isDuration(node.timeout)) {
      issues.push(t("issue.waitBadTimeout", { value: String(node.timeout) }));
    }
    if ((node.timeout != null) !== Boolean(node.on_timeout)) {
      issues.push(t("issue.waitTimeoutPair"));
    }
    for (const row of outputRows(node)) {
      if (row.cel && !row.src) issues.push(t("issue.outNoExpr", { name: row.dest }));
    }
    issues.push(...this.#placementIssues(node, graph, pipeline));
    issues.push(...refIssue(graph, node.next, "next"),
                ...refIssue(graph, node.on_timeout, "on_timeout"));
    return issues;
  }

  /** A saved run comes back at a node of the main graph, so the core refuses
   * a wait inside a block or a subpipeline. Said here before the run. */
  static #placementIssues(node, graph, pipeline) {
    if (graph !== pipeline) return [t("issue.waitInSubpipeline")];
    const issues = [];
    for (const block of graph.nodes ?? []) {
      const groups = kindOf(block).regionGroups(block);
      if (!groups?.length) continue;
      // a block's area: reachable from its entries before the node after it
      const after = block.next ? reachableFrom(graph, [block.next]) : new Set();
      const inside = groups.some((g) => reachableFrom(graph, g.entries ?? [], after).has(node.id));
      if (inside && block.id !== node.id) {
        issues.push(t("issue.waitInBlock", { type: block.type, block: block.id }));
      }
    }
    return issues;
  }
});
