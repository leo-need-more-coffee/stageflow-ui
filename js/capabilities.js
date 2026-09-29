/**
 * What the backend on the other end can actually run.
 *
 * The editor is built against one version of the core and then pointed at
 * whatever backend the user has. `kinds.js` mirrors the core's node registry
 * as it stood when the editor was built, so an editor newer than its backend
 * offers a node type the run will refuse — the mismatch used to surface as
 * `Unknown node type: 'map'` halfway through a run, which names neither the
 * cause nor the cure.
 *
 * A version range would not fix it: a backend with a node type of its own
 * belongs to no range. So the backend is asked what it has —
 * `GET /api/meta` answers with the registry itself — and the editor marks
 * what it cannot offer instead of guessing.
 *
 * An older backend has no such endpoint. Then nothing is known, and nothing
 * is marked: a false "unsupported" on a perfectly good backend is worse than
 * the error we are avoiding. `known` says which of the two situations this is.
 */

export class BackendCapabilities extends EventTarget {
  /** null — nothing is known (no /api/meta); otherwise the Set of node types. */
  #nodeTypes = null;
  #version = null;
  #api = null;
  #plan = null;
  #limits = null;
  #probed = false;

  get known() { return this.#nodeTypes !== null; }

  get probed() { return this.#probed; }

  /** The core's version, or null when the backend did not say. */
  get version() { return this.#version; }

  /** The version of the backend's HTTP contract, or null. */
  get api() { return this.#api; }

  get nodeTypes() { return this.#nodeTypes ? [...this.#nodeTypes].sort() : null; }

  /** The name of the plan this caller is on, when the backend says. */
  get plan() { return this.#plan; }

  /** `{counters, gauges, max_retries, max_delay_seconds}`, or null. */
  get limits() { return this.#limits; }

  /** A cumulative allowance, or null when that meter is not limited. */
  counterLimit(meter) {
    const value = this.#limits?.counters?.[meter];
    return typeof value === "number" ? value : null;
  }

  gaugeLimit(meter) {
    const value = this.#limits?.gauges?.[meter];
    return typeof value === "number" ? value : null;
  }

  /** Unknown means "do not get in the way": only a listed absence is a no. */
  supports(type) {
    return this.#nodeTypes === null || this.#nodeTypes.has(type);
  }

  /** Why a node type is not on offer, in words fit for a tooltip. */
  reason(type) {
    if (this.supports(type)) return "";
    const which = this.#version ? `the backend (core ${this.#version})` : "the backend";
    return `${which} cannot run a '${type}' node — it needs a newer StageFlow`;
  }

  /** One line about the backend for the status bar and the connection screen. */
  summary() {
    if (!this.#probed) return "";
    if (!this.known) return "backend version unknown (it serves no /api/meta)";
    const plan = this.#plan ? `plan ${this.#plan}, ` : "";
    return `${plan}core ${this.#version}, api v${this.#api}, `
      + `${this.#nodeTypes.size} node types`;
  }

  /**
   * What the backend's limits refuse about a graph, before it is run.
   *
   * The same three things the core checks at validation, for the same
   * reason: what is soundly knowable from the JSON. A loop's cost is not —
   * the passes come from the data — so nothing here multiplies anything, and
   * a graph the editor cannot judge is a graph it stays quiet about.
   */
  issuesFor(graph, kindOf) {
    if (!this.#limits) return [];
    const issues = [];

    const steps = this.counterLimit("steps");
    if (steps !== null) {
      const least = shortestRun(graph, kindOf);
      if (least !== null && least > steps) {
        issues.push({
          node: null,
          message: `the shortest way through this graph is ${least} nodes, `
            + `and the backend allows ${steps} steps`,
        });
      }
    }

    const attempts = this.#limits.max_retries;
    const pause = this.#limits.max_delay_seconds;
    for (const node of graph.nodes ?? []) {
      for (const retrier of node.retry ?? []) {
        const wanted = retrier.max_attempts ?? 3;
        if (typeof attempts === "number" && wanted > attempts) {
          issues.push({
            node: node.id,
            message: `retry asks for ${wanted} attempts, `
              + `and the backend allows ${attempts}`,
          });
        }
        const interval = retrier.interval_seconds ?? 1;
        if (typeof pause === "number" && interval > pause) {
          issues.push({
            node: node.id,
            message: `retry waits ${interval}s between attempts, `
              + `and the backend allows ${pause}s`,
          });
        }
      }
    }
    return issues;
  }

  setMeta(meta) {
    const types = meta?.node_types;
    this.#nodeTypes = Array.isArray(types) && types.length ? new Set(types) : null;
    this.#version = meta?.stageflow ?? null;
    this.#api = meta?.api ?? null;
    this.#plan = meta?.plan ?? null;
    this.#limits = meta?.limits && typeof meta.limits === "object" ? meta.limits : null;
    this.#probed = true;
    this.dispatchEvent(new Event("change"));
  }

  /** Nothing was learned — an old backend, or one that answered with rubbish. */
  setUnknown() {
    this.#nodeTypes = null;
    this.#version = null;
    this.#api = null;
    this.#plan = null;
    this.#limits = null;
    this.#probed = true;
    this.dispatchEvent(new Event("change"));
  }

  /**
   * Asks the backend. Never throws and never blocks the editor: a backend
   * that does not answer this is simply one the editor knows nothing about.
   */
  async load(backend) {
    try {
      const meta = await backend.fetchMeta();
      meta ? this.setMeta(meta) : this.setUnknown();
    } catch {
      this.setUnknown();
    }
    return this;
  }
}


/**
 * The fewest nodes a run can pass before it can end.
 *
 * A lower bound, which is what makes it safe to warn by: every real run does
 * at least this much, so a graph whose cheapest path does not fit cannot
 * finish at all. A graph with a long road and a short one is judged by the
 * short one.
 */
export function shortestRun(graph, kindOf) {
  const byId = new Map((graph.nodes ?? []).map((n) => [n.id, n]));
  const entry = graph.entry ?? (graph.nodes ?? []).find((n) => n.type === "entry")?.id;
  if (!entry || !byId.has(entry)) return null;

  const seen = new Set([entry]);
  let frontier = [entry];
  let steps = 1;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const node = byId.get(id);
      const targets = kindOf(node).orderPorts(node)
        .map((port) => port.get?.())
        .filter((target) => target && byId.has(target));
      if (node.type === "terminal" || !targets.length) return steps;
      for (const target of targets) {
        if (!seen.has(target)) {
          seen.add(target);
          next.push(target);
        }
      }
    }
    frontier = next;
    steps += 1;
  }
  return null;
}
