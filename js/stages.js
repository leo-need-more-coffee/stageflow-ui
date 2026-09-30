/**
 * The stage library: the specs from the StageFlow backend.
 *
 * The format is what `GET /api/stages` of a backend returns, which is the
 * core's `get_specs()`: `{"stages": {"StageName": spec, ...}}` (a bare object
 * of specs is accepted too).
 *
 * The prose in a spec arrives in every language the backend has, because the
 * backend cannot know which one the reader will pick. It is resolved once here,
 * on the way in, rather than at the dozen places that draw it: the language only
 * changes on a reload, so the specs held in memory can simply be the reader's
 * already — and every consumer goes on reading `spec.description` as a string.
 */
import { controlSuccessors } from "./dataflow.js";
import { prose, t } from "./i18n.js";
import { reachable } from "./regions.js";

/**
 * A spec with its prose reduced to the reader's language.
 *
 * `description` is resolved wherever it appears — on the stage, on every
 * argument, output, event and input — and everything else is copied as it is.
 * Resolved before recursing, because a per-locale mapping is itself an object
 * and walking into one would leave the tags in place.
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

  /** @param fetcher `Backend.fetch`, so the credential comes along; the
   * global one when there is nothing to send */
  async loadUrl(url, fetcher = fetch) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    this.setSpecs(await response.json(), url);
  }
}

/** Client-side pipeline validation: the same cross-checks as in the core's
 * `Pipeline.collect_errors()`, but instantly and without the server.
 * Returns [{graph, node, message}] (graph: null — the root, otherwise the id
 * of a subpipeline). */
export class Validator {
  #stages;
  #capabilities;

  /** @param capabilities what the backend can run (optional; see capabilities.js) */
  constructor(stages, capabilities = null) {
    this.#stages = stages;
    this.#capabilities = capabilities;
  }

  validate(pipeline, kindOf) {
    const issues = [];
    const graphs = [[null, pipeline], ...Object.entries(pipeline.subpipelines ?? {})];
    for (const [key, graph] of graphs) {
      this.#validateGraph(key, graph, pipeline, kindOf, issues);
      // what the backend's own limits refuse about this graph — said here
      // rather than by the run, which is the whole point of knowing them
      for (const issue of this.#capabilities?.issuesFor(graph, kindOf) ?? []) {
        issues.push({ graph: key, ...issue });
      }
    }
    return issues;
  }

  #validateGraph(key, graph, pipeline, kindOf, issues) {
    const push = (node, message) => issues.push({ graph: key, node, message });

    // the entry point may be left unset as a field: an entry node defines it
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
      // said before the run rather than by the run: the backend refuses an
      // unknown type with "Unknown node type", halfway through and by then
      // with a frame already half written
      if (this.#capabilities && !this.#capabilities.supports(node.type)) {
        push(node.id, this.#capabilities.reason(node.type));
      }
      // a port pointing at its OWN node: `then` of a condition at the condition,
      // `next` of a stage at the stage. Whatever the kind, that is a loop with
      // no way out — nothing between two visits can change the decision, since
      // the only node that runs in between is this one. A cycle through other
      // nodes is the ordinary way to write a loop and is left alone. The panel
      // does not offer the node itself any more, so this catches what arrives
      // as JSON.
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
   * Nodes a run can enter but never leave: no path out of them reaches a point
   * where execution ends.
   *
   * A self-reference is the smallest case of this and is named separately; here
   * it is the ordinary one — a loop somebody forgot to give a way out, two or
   * ten nodes around. The ends of the walk are the nodes with nowhere left to
   * go: a `terminal`, a port left unset, a body whose tail hands control back to
   * the block. The implicit transitions count (`controlSuccessors`), or the last
   * node of a `map` body would look trapped while it is the loop working
   * exactly as written.
   *
   * Only what the entry can reach is reported: a detached pair of nodes pointing
   * at each other is a graph half-assembled, not a mistake, and saying so on
   * every keystroke is how a status bar learns to be ignored.
   *
   * It is not a proof of an infinite run — an exception thrown inside the ring
   * still leaves it for a handler — which is why the message says what is
   * certain: from here a run does not END.
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
