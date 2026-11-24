/**
 * The stage library: specs from the backend.
 *
 * The format is the backend's `GET /api/stages`, i.e. the core's
 * `get_specs()`: `{"stages": {"StageName": spec, ...}}` (a bare object of
 * specs is accepted too).
 *
 * Spec prose comes in every language the backend has. It is reduced to the
 * reader's language once, on load, so the rest of the editor reads
 * `spec.description` as a string.
 */
import { controlSuccessors } from "./dataflow.js";
import { prose, t } from "./i18n.js";
import { reachable } from "./regions.js";

/**
 * A spec with its prose in the reader's language. Every `description` (of the
 * stage, its arguments, outputs, events and inputs) is resolved; the rest is
 * copied. Resolved before recursing, since a per-locale mapping is itself an
 * object.
 */
function localizeProse(value) {
  if (Array.isArray(value)) return value.map(localizeProse);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = key === "description" ? prose(inner) : localizeProse(inner);
  }
  return out;
}

export class StagesLibrary extends EventTarget {
  #specs = {};
  #source = null;

  get loaded() { return Object.keys(this.#specs).length > 0; }

  get source() { return this.#source; }

  get(name) { return this.#specs[name]; }

  names() { return Object.keys(this.#specs).sort(); }

  byCategory() {
    const categories = new Map();
    for (const name of this.names()) {
      const category = this.#specs[name].category ?? "default";
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category).push(this.#specs[name]);
    }
    return categories;
  }

  setSpecs(data, source = "inline") {
    this.#specs = localizeProse(data?.stages ?? data ?? {});
    this.#source = source;
    this.dispatchEvent(new Event("change"));
  }

  /** @param fetcher `Backend.fetch`, so the credential is sent */
  async loadUrl(url, fetcher = fetch) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    this.setSpecs(await response.json(), url);
  }
}

/** Client-side validation: the core's `Pipeline.collect_errors()` checks,
 * run instantly in the browser. Returns [{graph, node, message}], `graph`
 * null for the root or a subpipeline id. */
export class Validator {
  #stages;
  #capabilities;

  /** @param capabilities what the backend can run (optional, see capabilities.js) */
  constructor(stages, capabilities = null) {
    this.#stages = stages;
    this.#capabilities = capabilities;
  }

  validate(pipeline, kindOf) {
    const issues = [];
    const graphs = [[null, pipeline], ...Object.entries(pipeline.subpipelines ?? {})];
    for (const [key, graph] of graphs) {
      this.#validateGraph(key, graph, pipeline, kindOf, issues);
      // what the backend's limits refuse, reported before the run
      for (const issue of this.#capabilities?.issuesFor(graph, kindOf) ?? []) {
        issues.push({ graph: key, ...issue });
      }
    }
    return issues;
  }

  #validateGraph(key, graph, pipeline, kindOf, issues) {
    const push = (node, message) => issues.push({ graph: key, node, message });

    // `entry` may be unset when there is an entry node
    const entryNode = (graph.nodes ?? []).find((n) => n.type === "entry");
    if (!graph.entry && !entryNode) push(null, t("issue.noEntry"));
    else if (graph.entry && !graph.nodes.some((n) => n.id === graph.entry)) {
      push(null, t("issue.entryMissing", { entry: graph.entry }));
    } else if (graph.entry && entryNode && graph.entry !== entryNode.id) {
      push(null, t("issue.entryMismatch", { entry: graph.entry, node: entryNode.id }));
    }

    this.#noWayOut(graph, push);

    const seen = new Set();
    for (const node of graph.nodes ?? []) {
      if (seen.has(node.id)) push(node.id, t("issue.duplicateId"));
      seen.add(node.id);
      // an unknown type is refused by the backend mid-run; say so now
      if (this.#capabilities && !this.#capabilities.supports(node.type)) {
        push(node.id, this.#capabilities.reason(node.type));
      }
      // a port pointing at its own node is a loop with no way out: nothing
      // between two visits can change the outcome. Cycles through other nodes
      // are ordinary loops and left alone. The panel no longer offers this, so
      // it catches imported JSON
      for (const port of kindOf(node).orderPorts(node)) {
        if (port.get?.() === node.id) {
          push(node.id, t("issue.selfLoop", { port: port.label }));
        }
      }
      const env = { stages: this.#stages, capabilities: this.#capabilities };
      for (const message of kindOf(node).validate(node, graph, pipeline, env)) {
        push(node.id, message);
      }
    }
  }

  /**
   * Nodes a run can enter but never leave: no path from them reaches an end
   * (a `terminal`, an unset port, a body handing control back to its block).
   * Implicit edges count (`controlSuccessors`), or the last node of a `map`
   * body would look trapped.
   *
   * Only nodes reachable from the entry are reported: a detached pair is an
   * unfinished graph, not a mistake.
   *
   * This does not prove the run is infinite (an exception can still leave the
   * loop for a handler), so the message only says the run cannot end from here.
   */
  #noWayOut(graph, push) {
    const nodes = graph.nodes ?? [];
    if (!nodes.length) return;
    const succs = controlSuccessors(graph);
    const canEnd = new Set(
      nodes.filter((n) => !(succs.get(n.id)?.size)).map((n) => n.id),
    );
    for (let grew = true; grew;) {
      grew = false;
      for (const node of nodes) {
        if (canEnd.has(node.id)) continue;
        for (const target of succs.get(node.id) ?? []) {
          if (!canEnd.has(target)) continue;
          canEnd.add(node.id);
          grew = true;
          break;
        }
      }
    }

    const entry = graph.entry ?? nodes.find((n) => n.type === "entry")?.id;
    if (!entry) return;
    const live = reachable(graph, [entry]);
    const trapped = nodes
      .filter((n) => live.has(n.id) && !canEnd.has(n.id))
      .map((n) => n.id);
    if (!trapped.length) return;
    const shown = trapped.slice(0, 8).join(", ") + (trapped.length > 8 ? ", …" : "");
    push(trapped[0], t("issue.noWayOut", { nodes: shown }));
  }
}
