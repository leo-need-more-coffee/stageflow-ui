/**
 * Carrying a credential, and being shown a plan.
 *
 * Two things are checked here, and the second one is the one with teeth.
 *
 *   - **The credential goes everywhere or it is useless.** A backend that
 *     wants a header wants it on the stage registry, the secret names, every
 *     command of a run and the event stream. Miss one and the failure is not
 *     a clean 401 on the screen where it can be fixed — it is a debugger that
 *     starts and then silently stops moving. So `Backend.fetch` is the single
 *     door, and the tests below are mostly about nobody having gone round it.
 *   - **A plan is a view, not an entitlement.** `?plan=` goes on the two
 *     questions asked before a run, and must never go on the run: a tenant
 *     who can name their own plan has no ceiling. The editor says which plan
 *     it DREW against so the backend can refuse a mismatch by name, which is
 *     a different field in a different direction.
 *
 * Run: node tests/tenant.mjs
 */
import { Backend, cleanHeaders, mixedContentProblem } from "../js/backend.js";
import { BackendCapabilities } from "../js/capabilities.js";
import { EventStream } from "../js/sse.js";
import { Runner } from "../js/runner.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

/** A response of chunks, the way `fetch` hands a stream over. */
function streaming(chunks) {
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { value: new TextEncoder().encode(chunks[i++]), done: false }
          : { done: true }),
      }),
    },
  };
}

const settle = () => new Promise((done) => setTimeout(done, 10));

// ------------------------------------------------------------- headers

check(Object.keys(cleanHeaders({})).length === 0, "no headers is no headers");
check(cleanHeaders({ Authorization: "  Bearer x  " }).Authorization === "Bearer x",
  "a credential is trimmed, because pasting one brings whitespace");
check(!("" in cleanHeaders({ "": "x" })), "a nameless header is dropped");
check(!("A B" in cleanHeaders({ "A B": "x" })),
  "a name fetch would throw on is dropped rather than thrown on");
check(!("X" in cleanHeaders({ X: "a\nb" })),
  "a value with a newline is dropped: header injection is not a feature");
check(!("X" in cleanHeaders({ X: "   " })), "an empty value is not a header");
check(cleanHeaders({ "X-Api-Key": "k" })["X-Api-Key"] === "k",
  "the name is not assumed to be Authorization");

// ----------------------------------------------------- the credential pair

{
  const b = new Backend("x:1", { auth: { header: " X-Api-Key ", value: " k " } });
  check(b.headers["X-Api-Key"] === "k", "the credential is a header the user named");
  check(b.authenticated, "…and the editor knows it is sending one");
  b.setAuth({ header: "", value: "tok" });
  check(b.headers.Authorization === "tok", "an unnamed header falls back to Authorization");
  b.setAuth(null);
  check(Object.keys(b.headers).length === 0 && !b.authenticated,
    "clearing it sends nothing, rather than sending an empty header");
  check(b.auth.header === "Authorization",
    "…and leaves a name behind, so the field is not blank next time");
}

// ------------------------------------------------- https page, http backend

{
  const real = globalThis.location;
  globalThis.location = { protocol: "https:" };
  check(/https/.test(mixedContentProblem("http://api.example.com")),
    "the hosted editor says why an http backend is unreachable…");
  check(mixedContentProblem("http://127.0.0.1:8765") === "",
    "…and does not say it about loopback, which browsers allow");
  check(mixedContentProblem("http://localhost:8765") === "", "nor about localhost by name");
  check(mixedContentProblem("https://api.example.com") === "", "nor about https");
  globalThis.location = { protocol: "http:" };
  check(mixedContentProblem("http://api.example.com") === "",
    "an editor served over http reaches http backends and says nothing");
  globalThis.location = real;
}

// --------------------------------------------------------- the one door

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), headers: init.headers ?? {}, method: init.method ?? "GET" });
  return { ok: true, status: 200, json: async () => ({ stages: { A: {} } }) };
};

const backend = new Backend("localhost:8765", {
  auth: { header: "Authorization", value: "Bearer tok" }, plan: "pro",
});

check(backend.metaUrl.endsWith("/api/meta?plan=pro"), "?plan= goes on /api/meta");
check(backend.stagesUrl.endsWith("/api/stages?plan=pro"), "?plan= goes on /api/stages");
check(!backend.runUrl.includes("plan"),
  "?plan= does NOT go on the run: naming your own plan is naming your own ceiling");
check(!backend.secretsUrl.includes("plan"), "nor on the secret names");

await backend.fetch(backend.stagesUrl);
check(calls.at(-1).headers.Authorization === "Bearer tok",
  "Backend.fetch attaches the credential");
await backend.fetch(backend.stagesUrl, { headers: { Accept: "text/event-stream" } });
check(calls.at(-1).headers.Authorization === "Bearer tok"
  && calls.at(-1).headers.Accept === "text/event-stream",
  "…and does not lose the caller's own headers doing it");

backend.setPlan(null);
check(backend.metaUrl.endsWith("/api/meta"), "no plan, no parameter");
check(backend.setPlan("basic").metaUrl.endsWith("?plan=basic"), "and it can be swapped live");

// a refusal is reported as one, because it is the failure with a cure
globalThis.fetch = async () => ({
  ok: false, status: 401, json: async () => ({ error: "no credentials" }),
});
let said = "";
try {
  await new Backend("localhost:8765").probe();
} catch (err) {
  said = err.message;
}
check(/no credentials/.test(said) && /401/.test(said),
  `a 401 on the connection screen says so: got "${said}"`);

// ------------------------------------------------------- what is shown

const caps = new BackendCapabilities();
caps.setMeta({
  api: 1, plan: "pro", plan_source: "query", plans: ["basic", "full", "pro"],
  stageflow: "0.12.0", node_types: ["entry", "stage", "terminal"],
  limits: { counters: { steps: 200 }, gauges: {} },
});
check(caps.previewing, "plan_source 'query' means a what-if");
check(/\(preview\)/.test(caps.summary()), "and the status bar says so out loud");
check(/previewed/.test(caps.reason("map")),
  "…as does a tooltip, which must not promise what a run will do");
check(caps.plans.join() === "basic,full,pro", "the plan names come from the backend");

caps.setMeta({ api: 1, plan: "basic", plan_source: "token", plans: ["basic"],
               stageflow: "0.12.0", node_types: ["entry"], limits: {} });
check(!caps.previewing && !/preview/.test(caps.summary()),
  "the caller's own plan is not announced as a preview");
check(caps.reason("map") === "plan 'basic' does not include a 'map' node",
  "and the reason is plain");

caps.setMeta({ api: 1, stageflow: "0.12.0", node_types: ["entry"] });
check(caps.plans === null && caps.planSource === null,
  "a backend with no plans offers no choice, rather than an empty one");
caps.setUnknown();
check(caps.plans === null && caps.planSource === null && !caps.previewing,
  "and a backend that said nothing leaves nothing behind");

// -------------------------------------------------------- event stream

{
  const seen = [];
  const asked = [];
  const chunks = [
    'data: {"index":0,"type":"node_enter"}\n\n',
    ': keep-alive\n\ndata: {"index":1,"ty',       // a frame split across reads
    'pe":"node_exit"}\n\ndata: not json\n\n',
  ];
  const stream = new EventStream("http://b/api/run/run-1/events", {
    fetcher: async (url, init) => { asked.push({ url, init }); return streaming(chunks); },
    onEvent: (event) => seen.push(event.type),
  });
  await settle();
  check(seen.join() === "node_enter,node_exit",
    `frames are reassembled across reads: got ${seen.join()}`);
  check(asked[0].init.headers.Accept === "text/event-stream",
    "the stream is fetched as one");
  check(stream.next === 2, "the resume point is the event after the last seen");
}

{
  // the connection drops once; the resume must not replay what was seen
  const urls = [];
  let attempt = 0;
  const seen = [];
  new EventStream("http://b/api/run/run-1/events", {
    fetcher: async (url) => {
      urls.push(url);
      if (attempt++ === 0) {
        // one good event, then a body that fails mid-read
        return {
          ok: true,
          body: { getReader: () => {
            let served = false;
            return { read: async () => {
              if (served) throw new Error("connection reset");
              served = true;
              return { value: new TextEncoder().encode('data: {"index":0,"type":"a"}\n\n'),
                       done: false };
            } };
          } },
        };
      }
      return streaming(['data: {"index":1,"type":"b"}\n\n']);
    },
    onEvent: (event) => seen.push(event.type),
  });
  await new Promise((done) => setTimeout(done, 1400)); // one reconnect delay
  check(seen.join() === "a,b", `a dropped stream resumes: got ${seen.join()}`);
  check(!urls[0].includes("from="), "the first connection asks for everything");
  check(urls[1]?.includes("from=1"),
    `the second asks for what it missed and no more: ${urls[1]}`);
}

{
  // given up on for good: the run may go on, but this editor has gone blind
  let told = null;
  new EventStream("http://b/events", {
    fetcher: async () => { throw new Error("nope"); },
    onEvent: () => {},
    onError: (err) => { told = err.message; },
  });
  await new Promise((done) => setTimeout(done, 6200)); // five tries, a second apart
  check(told === "nope", `the give-up is reported, not swallowed: got ${told}`);
}

// --------------------------------------------------------------- a run

{
  const sent = [];
  const stub = {
    runUrl: "http://b/api/run",
    fetch: async (url, init = {}) => {
      sent.push({ url: String(url), init });
      if (String(url).endsWith("/events")) return streaming([]);
      return {
        ok: true,
        json: async () => ({ id: "run-1", state: { node: "a" } }),
        headers: { get: () => "application/json" },
      };
    },
  };
  const runner = new Runner(stub);
  await runner.start({ nodes: [] }, { mode: "step", plan: "pro" });
  const start = JSON.parse(sent[0].init.body);
  check(start.plan === "pro",
    "the run says which plan it was DRAWN against, so a mismatch can be named");
  check(sent[0].url === "http://b/api/run", "…and posts to the plain run URL");
  await settle();
  check(sent.some((call) => call.url.includes("/run-1/events")),
    "the event stream goes through the backend too, credential and all");
  runner.stopStream();
}

// ------------------------------------------- swapping a credential in place

{
  // a token that stops working must not take the session with it
  let accept = false;
  const b = new Backend("localhost:8765", { auth: { header: "A", value: "good" } });
  globalThis.fetch = async (url, init = {}) => (
    (init.headers ?? {}).A === "good" || accept
      ? { ok: true, status: 200, json: async () => ({ stages: { S: {} } }) }
      : { ok: false, status: 401, json: async () => ({ error: "nope" }) });
  const editor = {
    backend: b,
    applied: null,
    async setCredential(auth) {   // the shape editor.js implements, in miniature
      const previous = b.auth;
      b.setAuth(auth);
      try {
        return (await b.probe()).count;
      } catch (err) {
        b.setAuth(previous);
        throw err;
      }
    },
  };
  let refused = "";
  try {
    await editor.setCredential({ header: "A", value: "bad" });
  } catch (err) {
    refused = err.message;
  }
  check(/nope/.test(refused), "a credential that is refused is reported as refused");
  check(b.auth.value === "good",
    "…and the working one is put back: a half-applied token fails at the NEXT request");
  accept = true;
  check(await editor.setCredential({ header: "A", value: "fresh" }) === 1,
    "a credential that works is applied without a reload");
  check(b.auth.value === "fresh", "and kept");
}

console.log(failed
  ? `\nchecks failed: ${failed} of ${checked}`
  : `tenants and credentials: all ${checked} checks passed`);
process.exit(failed ? 1 : 0);
