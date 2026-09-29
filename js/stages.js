/**
 * The stage library: the specs from the StageFlow backend.
 *
 * The format is what `GET /api/stages` of a backend returns, which is the
 * core's `get_specs()`: `{"stages": {"StageName": spec, ...}}` (a bare object
 * of specs is accepted too).
 */
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
    this.#specs = data?.stages ?? data ?? {};
    this.#source = source;
    this.dispatchEvent(new Event("change"));
  }

  async loadUrl(url) {
    const response = await fetch(url);
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
    if (!graph.entry && !entryNode) push(null, "no entry is set");
    else if (graph.entry && !graph.nodes.some((n) => n.id === graph.entry)) {
      push(null, `entry '${graph.entry}' is not in the graph`);
    } else if (graph.entry && entryNode && graph.entry !== entryNode.id) {
      push(null, `entry '${graph.entry}' does not match the entry node '${entryNode.id}'`);
    }

    const seen = new Set();
    for (const node of graph.nodes ?? []) {
      if (seen.has(node.id)) push(node.id, "duplicate node id");
      seen.add(node.id);
      // said before the run rather than by the run: the backend refuses an
      // unknown type with "Unknown node type", halfway through and by then
      // with a frame already half written
      if (this.#capabilities && !this.#capabilities.supports(node.type)) {
        push(node.id, this.#capabilities.reason(node.type));
      }
      const env = { stages: this.#stages, capabilities: this.#capabilities };
      for (const message of kindOf(node).validate(node, graph, pipeline, env)) {
        push(node.id, message);
      }
    }
  }
}
