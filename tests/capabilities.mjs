/**
 * Degrading against an older backend.
 *
 * The editor mirrors the core's node registry as it stood when the editor was
 * built, so pointing a new editor at an old backend is the normal case, not
 * the exotic one. Two properties have to hold, and they pull in opposite
 * directions:
 *
 *   - a backend that SAYS it cannot run a type gets that said before the run,
 *     not as "Unknown node type" halfway through one;
 *   - a backend that says NOTHING (no /api/meta — an older one, or somebody
 *     else's) is not second-guessed: nothing is marked, everything works as
 *     it did. A false "unsupported" is worse than the error being avoided.
 *
 * Run: node tests/capabilities.mjs
 */
import "./_catalog.mjs";
import { BackendCapabilities } from "../js/capabilities.js";
import { Validator } from "../js/stages.js";
import { kindOf } from "../js/kinds.js";
import { normalizeBackendUrl } from "../js/backend.js";
import { VERSION } from "../js/version.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

const OLD_CORE = {
  api: 1,
  stageflow: "0.9.0",
  node_types: ["condition", "entry", "parallel", "stage", "subpipeline",
               "switch", "terminal", "try"],
  stages: 17,
};

const stages = { get: () => null, names: () => [], loaded: false };

/** A graph with one map node, which core 0.9 has never heard of. */
function graphWithMap() {
  return {
    entry: "start",
    nodes: [
      { id: "start", type: "entry", variables: {}, next: "loop" },
      { id: "loop", type: "map", items: "vars.xs", body: "work",
        item_var: "x", collect: { y: "ys" }, next: "done" },
      { id: "work", type: "stage", stage: "S", outputs: { value: "y" } },
      { id: "done", type: "terminal", result: {}, artifacts: ["ys"] },
    ],
  };
}

const issuesOf = (caps) => new Validator(stages, caps)
  .validate(graphWithMap(), kindOf)
  .filter((i) => i.node === "loop" && /does not (offer|include)/.test(i.message));

// ------------------------------------------------- a backend that answers

const old = new BackendCapabilities();
old.setMeta(OLD_CORE);

check(old.known, "a backend that answered is known");
check(old.version === "0.9.0", "the core version is kept");
check(old.api === 1, "the api version is kept");
check(old.supports("stage"), "a type the backend lists is supported");
check(!old.supports("map"), "a type the backend does not list is not supported");
check(/0\.9\.0/.test(old.reason("map")), "the reason names the version the user has");
check(/map/.test(old.reason("map")), "the reason names the node type");
check(!/newer/.test(old.reason("map")),
  "and claims nothing about why: /api/meta does not say whether the core is "
  + "old or the allowance narrow");
check(old.reason("stage") === "", "a supported type has no reason to show");
check(issuesOf(old).length === 1, "a map node in the graph is an issue on an old backend");

const fresh = new BackendCapabilities();
fresh.setMeta({ api: 1, stageflow: "0.10.0", node_types: [...OLD_CORE.node_types, "map"] });
check(fresh.supports("map"), "a backend that lists map supports it");
check(issuesOf(fresh).length === 0, "and then the graph raises nothing");

// --------------------------------------------- a backend that says nothing

const silent = new BackendCapabilities();
silent.setUnknown();

check(!silent.known, "a backend without /api/meta is not known");
check(silent.probed, "but it has been asked");
check(silent.supports("map"), "nothing is marked unsupported when nothing is known");
check(silent.nodeTypes === null, "and there is no list to show");
check(issuesOf(silent).length === 0, "an unknown backend raises no issues");
check(/unknown/.test(silent.summary()), "the summary says the version is unknown");

const untouched = new BackendCapabilities();
check(untouched.supports("map"), "before the answer arrives nothing is marked");
check(untouched.summary() === "", "and there is nothing to say yet");

// rubbish instead of an answer is the same as no answer
for (const [what, meta] of Object.entries({
  "an empty object": {},
  "no node_types": { api: 1, stageflow: "0.10.0" },
  "node_types of the wrong shape": { node_types: "map,try" },
  "an empty list": { node_types: [] },
})) {
  const caps = new BackendCapabilities();
  caps.setMeta(meta);
  check(caps.supports("map"), `${what} marks nothing`);
}

// ------------------------------------------------------ the load() contract

const failing = { fetchMeta: async () => { throw new Error("connection refused"); } };
const afterFailure = await new BackendCapabilities().load(failing);
check(!afterFailure.known && afterFailure.probed,
  "a backend that throws is unknown, not an editor that crashed");

const answering = { fetchMeta: async () => OLD_CORE };
const afterAnswer = await new BackendCapabilities().load(answering);
check(!afterAnswer.supports("map"), "load() keeps what the backend said");

let events = 0;
const watched = new BackendCapabilities();
watched.addEventListener("change", () => { events += 1; });
await watched.load(answering);
check(events === 1, "the answer arrives as one change event (the views redraw on it)");

// ------------------------------------------------------------- the meta URL

check(normalizeBackendUrl("localhost:8765/api") === "http://localhost:8765",
  "the address is normalised the same way for /api/meta as for the rest");

// ------------------------------------------------------ the backend's limits

const PLAN = {
  api: 1,
  plan: "basic",
  stageflow: "0.12.0",
  node_types: [...OLD_CORE.node_types, "map"],
  stages: 5,
  limits: {
    counters: { seconds: 15, steps: 4 },
    gauges: { concurrency: 2, depth: 1 },
    max_retries: 2,
    max_delay_seconds: 2,
  },
};

const planned = new BackendCapabilities();
planned.setMeta(PLAN);

check(planned.plan === "basic", "the plan name is kept");
check(planned.counterLimit("steps") === 4, "a counter limit is readable");
check(planned.counterLimit("tokens") === null, "an unlimited counter reads null");
check(planned.gaugeLimit("depth") === 1, "a gauge limit is readable");
check(/plan basic/.test(planned.summary()), "the summary names the plan");

// the reason a node is missing: when the plan is known, it is the plan that
// is named. Blaming the core would read as nonsense beside a status bar
// announcing a perfectly recent one — which is exactly how this was found
const narrow = new BackendCapabilities();
narrow.setMeta({ ...PLAN, node_types: ["entry", "stage", "terminal"] });
check(/plan 'basic'/.test(narrow.reason("parallel")),
  "a narrow plan is named as the reason");
check(!/newer|older|core/.test(narrow.reason("parallel")),
  "and the core is not blamed for it");
check(/parallel/.test(narrow.reason("parallel")), "the node type is named");
check(narrow.reason("stage") === "", "an allowed type has no reason");

/** A chain of `n` stages between an entry and a terminal. */
function chain(n, extra = {}) {
  const nodes = [{ id: "start", type: "entry", variables: {}, next: "s0" }];
  for (let i = 0; i < n; i += 1) {
    nodes.push({
      id: `s${i}`, type: "stage", stage: "S", outputs: { value: "v" },
      next: i < n - 1 ? `s${i + 1}` : "done", ...(i === 0 ? extra : {}),
    });
  }
  nodes.push({ id: "done", type: "terminal", result: {}, artifacts: ["v"] });
  return { entry: "start", nodes };
}

const tooLong = planned.issuesFor(chain(5), kindOf);
check(tooLong.length === 1 && /shortest way/.test(tooLong[0].message),
  "a graph longer than the step limit is flagged before the run");
check(planned.issuesFor(chain(2), kindOf).length === 0,
  "a graph that fits is not flagged");

// a long road with a short one beside it is judged by the short one: the
// bound has to be the cheapest path, or working graphs get refused
const branching = {
  entry: "start",
  nodes: [
    { id: "start", type: "entry", variables: {}, next: "pick" },
    { id: "pick", type: "condition", condition: "vars.quick", then: "done", else: "s0" },
    ...chain(10).nodes.slice(1),
  ],
};
check(planned.issuesFor(branching, kindOf).length === 0,
  "a short way out saves a long graph");

const greedy = planned.issuesFor(
  chain(2, { retry: [{ error_equals: ["*"], max_attempts: 9, interval_seconds: 30 }] }),
  kindOf);
check(greedy.length === 2, "both the attempts and the pause are flagged");
check(greedy.every((i) => i.node === "s0"), "and they name the node");

check(new BackendCapabilities().issuesFor(chain(50), kindOf).length === 0,
  "a backend whose limits are unknown is not second-guessed");

const noLimits = new BackendCapabilities();
noLimits.setMeta(OLD_CORE);
check(noLimits.issuesFor(chain(50), kindOf).length === 0,
  "and neither is one that serves no limits");
check(noLimits.limits === null, "no limits means null, not an empty object");

// the validator passes them through with the rest
const withPlan = new Validator(stages, planned)
  .validate(chain(5), kindOf)
  .filter((i) => /shortest way/.test(i.message));
check(withPlan.length === 1, "the validator carries a limit issue like any other");

// ------------------------------------------- the released version number

// the browser cannot read package.json and nothing rewrites the constant at
// build time, so the two are kept honest here
const pkg = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    new URL("../package.json", import.meta.url), "utf8"));
check(VERSION === pkg.version,
  `js/version.js (${VERSION}) and package.json (${pkg.version}) disagree`);

console.log(failed
  ? `\nchecks failed: ${failed} of ${checked}`
  : `backend capabilities: all ${checked} checks passed`);
process.exit(failed ? 1 : 0);
