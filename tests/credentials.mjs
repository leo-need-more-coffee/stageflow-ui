/**
 * A credential belongs to the backend it was typed for.
 *
 * The one thing checked here with teeth: a link with `?backend=` pointing
 * somewhere else must not make the editor present a remembered token there.
 * The connection screen tries the address in the link on load, before anybody
 * clicks anything — so whatever credential it reaches for at that moment is
 * the one that leaves the browser.
 *
 * Run: node tests/credentials.mjs
 */
import "./_catalog.mjs";

// ------------------------------------------------- the browser, just enough

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

/** What went out, and with which headers. */
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), headers: { ...(init.headers ?? {}) } });
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ stages: {} }),
    text: async () => "{}",
  };
};

const { attemptConnection, credentialFor, initialConnection, rememberBackend, storedBackend } =
  await import("../src/core/connection.js");

let failed = 0;
let checked = 0;
function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

const KEY = "test-editor";
const HOME = "https://home.example";
const ELSEWHERE = "https://elsewhere.example";
const TOKEN = { header: "Authorization", value: "Bearer home-token" };

const carries = (request, value) => Object.values(request.headers).includes(value);

// ------------------------------------------------------- what is remembered

store.clear();
rememberBackend(KEY, { url: HOME, auth: TOKEN, plan: null });
check(storedBackend(KEY).auth.value === TOKEN.value,
  "the last backend's credential is remembered");
check(storedBackend(KEY, HOME).auth.value === TOKEN.value,
  "and found under its own address");
check(storedBackend(KEY, `${HOME}/api/`).auth.value === TOKEN.value,
  "under the same address however it was typed");
check(storedBackend(KEY, ELSEWHERE).auth.value === "",
  "another address has no credential");

rememberBackend(KEY, { url: ELSEWHERE, auth: { header: "X-Key", value: "other" }, plan: null });
check(storedBackend(KEY, HOME).auth.value === TOKEN.value,
  "connecting to a second backend does not forget the first one's token");
check(storedBackend(KEY, ELSEWHERE).auth.header === "X-Key",
  "and the second keeps its own header name");

rememberBackend(KEY, { url: ELSEWHERE, auth: { header: "X-Key", value: "" }, plan: null });
check(storedBackend(KEY, ELSEWHERE).auth.value === "",
  "a credential cleared is forgotten");

// one `auth` next to the `url`, as stored before credentials were per address
store.clear();
localStorage.setItem(`${KEY}:backend`, JSON.stringify({ url: HOME, auth: TOKEN, plan: "pro" }));
const legacy = storedBackend(KEY);
check(legacy.url === HOME && legacy.auth.value === TOKEN.value && legacy.plan === "pro",
  "the old shape is read as the credential of the url it was stored with");
check(storedBackend(KEY, ELSEWHERE).auth.value === "",
  "and only of that url");

// ------------------------------------------------------- the link attack

// what the connection screen does on load: try the address it starts with,
// with the credential it starts with
async function openWith(url) {
  sent.length = 0;
  const start = initialConnection({ storageKey: KEY, url });
  const { backend } = await attemptConnection(KEY, start.url, start.auth, start.plan);
  return backend;
}

store.clear();
rememberBackend(KEY, { url: HOME, auth: TOKEN, plan: null });
const there = await openWith(ELSEWHERE);
check(sent.length > 0 && sent.every((r) => r.url.startsWith(ELSEWHERE)),
  "a ?backend= link is tried at the address it names");
check(!sent.some((r) => carries(r, TOKEN.value)),
  "and the token remembered for another backend does not go with it");
check(there.auth.value === "", "the backend it connected to holds no credential");
check(storedBackend(KEY, HOME).auth.value === TOKEN.value,
  "and the home backend's token is still there for when it is opened again");

const home = await openWith(HOME);
check(sent.some((r) => carries(r, TOKEN.value)),
  "the remembered backend still gets its own token on load");
check(home.auth.value === TOKEN.value, "and keeps it");

// --------------------------------------- the fields follow the address typed

store.clear();
rememberBackend(KEY, { url: HOME, auth: TOKEN, plan: null });
check(initialConnection({ storageKey: KEY, force: true }).url === "",
  "a forced screen starts empty");
check(credentialFor(KEY, ELSEWHERE).value === "",
  "typing another address finds no credential for it");
check(credentialFor(KEY, HOME).value === TOKEN.value,
  "and typing the remembered one brings its credential back");

if (failed) {
  console.error(`credentials: ${failed} of ${checked} checks failed`);
  process.exit(1);
}
console.log(`credentials: ${checked} checks, a token stays with its backend`);
