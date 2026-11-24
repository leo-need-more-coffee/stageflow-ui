/**
 * What the connected backend can run.
 *
 * `kinds.js` mirrors the core's node types as of the editor's release, so a
 * newer editor can offer a type an older backend refuses mid-run with
 * `Unknown node type`. A version range would not help (a backend may add types
 * of its own), so the editor asks: `GET /api/meta` returns the registry, and
 * types it lacks are marked.
 *
 * An older backend has no `/api/meta`. Then nothing is known and nothing is
 * marked, since a false "unsupported" is worse than the error it would avoid.
 * `known` says which case this is.
 */
import { t } from "./i18n.js";

export class BackendCapabilities extends EventTarget {
  /** null if nothing is known (no /api/meta); otherwise the Set of node types. */
  #nodeTypes = null;
  #version = null;
  #api = null;
  #plan = null;
  #plans = null;
  #planSource = null;
  #limits = null;
  #probed = false;

  get known() { return this.#nodeTypes !== null; }

  get probed() { return this.#probed; }

  /** The core's version, or null when the backend did not say. */
  get version() { return this.#version; }

  /** The version of the backend's HTTP contract, or null. */
  get api() { return this.#api; }

  get nodeTypes() { return this.#nodeTypes ? [...this.#nodeTypes].sort() : null; }

  /** The name of the plan this answer is about, when the backend says. */
  get plan() { return this.#plan; }

  /** Every plan the backend answers about, for offering a choice; the editor
   * does not hard-code plan names. */
  get plans() { return this.#plans; }

  /** Where the plan came from: `"query"` (the editor asked to see it),
   * `"token"` (the caller's own) or `"open"` (no authentication). */
  get planSource() { return this.#planSource; }

  /**
   * Whether the screen shows another plan's allowance rather than the
   * caller's own; the two look the same but only one predicts a run.
   */
  get previewing() { return this.#planSource === "query"; }

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

  /** Unknown counts as supported: only an explicit absence is a no. */
  supports(type) {
    return this.#nodeTypes === null || this.#nodeTypes.has(type);
  }

  /**
   * Why a node type is not offered, for a tooltip.
   *
   * `/api/meta` answers for the caller, so a type may be missing because the
   * core is older or because the caller's plan excludes it, and the answer
   * does not say which. Name the plan when the backend gave one; otherwise
   * only say this backend does not offer it.
   */
  reason(type) {
    if (this.supports(type)) return "";
    if (this.#plan) {
      const shown = this.previewing ? ` ${t("caps.previewNote")}` : "";
      return t("caps.planRefuses", { plan: this.#plan, shown, type });
    }
    return this.#version
      ? t("caps.coreLacks", { version: this.#version, type })
      : t("caps.backendLacks", { type });
  }

  /** One line about the backend for the status bar and connection screen. */
  summary() {
    if (!this.#probed) return "";
    if (!this.known) return t("caps.unknown");
    const shown = this.previewing ? ` ${t("caps.previewShort")}` : "";
    const plan = this.#plan ? t("caps.plan", { plan: this.#plan, shown }) : "";
    return plan + t("caps.summary", {
      version: this.#version, api: this.#api, types: this.#nodeTypes.size,
    });
  }

  /**
   * What the backend's limits refuse about a graph, before it runs: the same
   * checks the core makes at validation. A loop's cost depends on data and
   * is not estimated.
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
          message: t("caps.tooManySteps", { nodes: least, steps }),
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
            message: t("caps.tooManyRetries", { asked: wanted, allowed: attempts }),
          });
        }
        const interval = retrier.interval_seconds ?? 1;
        if (typeof pause === "number" && interval > pause) {
          issues.push({
            node: node.id,
            message: t("caps.retryTooSlow", { asked: interval, allowed: pause }),
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
    this.#plans = Array.isArray(meta?.plans) && meta.plans.length ? [...meta.plans] : null;
    this.#planSource = typeof meta?.plan_source === "string" ? meta.plan_source : null;
    this.#limits = meta?.limits && typeof meta.limits === "object" ? meta.limits : null;
    this.#probed = true;
    this.dispatchEvent(new Event("change"));
  }

  /** Nothing known: an old backend, or an unusable answer. */
  setUnknown() {
    this.#nodeTypes = null;
    this.#version = null;
    this.#api = null;
    this.#plan = null;
    this.#plans = null;
    this.#planSource = null;
    this.#limits = null;
    this.#probed = true;
    this.dispatchEvent(new Event("change"));
  }

  /**
   * Ask the backend. Never throws or blocks; a backend that does not answer
   * is simply one the editor knows nothing about.
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
 * The fewest nodes a run must pass to end: a lower bound, so a graph whose
 * shortest path exceeds the step limit cannot finish at all.
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
