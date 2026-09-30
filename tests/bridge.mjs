/**
 * The bridge to an agent: what is read out of the address, and what is done
 * with the token afterwards.
 *
 * The parts that need a socket are tested on the other side of it (the bridge
 * has its own suite in stageflow-mcp, including a real browser). What belongs
 * here is the half that is this editor's own decision: a page without the
 * parameter must behave as though none of this exists, and a token must not be
 * left in the address bar for the history, a bookmark or a screen recording to
 * keep.
 *
 * Run: node tests/bridge.mjs
 */
import "./_catalog.mjs";

// the module reads the tab's own storage; in node there is none, and a stub
// is closer to the truth than making the module ask permission to remember
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { bridgeFromUrl } = await import("../js/bridge.js");
const { EventStream } = await import("../js/sse.js");

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

{ // no parameter, no feature
  check(bridgeFromUrl("", "") === null, "an empty address asks for no bridge");
  check(bridgeFromUrl("?backend=http://x", "") === null,
        "a page with only a backend asks for no bridge");
  check(bridgeFromUrl("?backend=http://x", "#lang=ru") === null,
        "a fragment without a bridge parameter is not a bridge");
}

{ // the address and the token come from different halves of the URL
  const asked = bridgeFromUrl(
    "?backend=https://sf.example&bridge=http://127.0.0.1:7433",
    "#bridge-token=abc123",
  );
  check(asked.url === "http://127.0.0.1:7433", "the bridge address is read from the query");
  check(asked.token === "abc123", "the token is read from the fragment");
}

{ // a bridge without a token is still a bridge, and will be refused by it
  const asked = bridgeFromUrl("?bridge=http://127.0.0.1:7433", "");
  check(asked.url === "http://127.0.0.1:7433", "the address survives a missing token");
  check(asked.token === "", "a missing token is empty rather than undefined");
}

{ // trailing slashes, because people paste addresses
  check(bridgeFromUrl("?bridge=http://127.0.0.1:7433/", "#bridge-token=t").url
        === "http://127.0.0.1:7433",
        "a trailing slash is cut, or every path would come out doubled");
  check(bridgeFromUrl("?bridge=http://127.0.0.1:7433///", "#bridge-token=t").url
        === "http://127.0.0.1:7433", "and so are several");
}

{ // the fragment is not the only thing in the fragment
  const asked = bridgeFromUrl("?bridge=http://127.0.0.1:1", "#lang=ru&bridge-token=t&x=1");
  check(asked.token === "t", "the token is found among other fragment parameters");
}

{ // the token must be readable from a fragment written the usual way
  check(bridgeFromUrl("?bridge=http://h", "bridge-token=t").token === "t",
        "a fragment without its leading # is read the same way");
}

{ // the token survives a reload, because the address bar must not keep it
  //
  // The link carries the token once and the editor takes it out of the
  // address. Without somewhere to put it a reload ends the connection: there
  // is nothing left to authenticate with, and the link is by then somewhere in
  // a chat log.
  store.clear();
  const url = "http://127.0.0.1:7433";
  store.set(`sf-bridge:${url}`, JSON.stringify({ token: "kept", seen: 4 }));

  const afterReload = bridgeFromUrl(`?bridge=${url}`, "");
  check(afterReload.token === "kept", "a reload finds the token the tab kept");

  const freshLink = bridgeFromUrl(`?bridge=${url}`, "#bridge-token=newer");
  check(freshLink.token === "newer", "a link that carries one wins over what was kept");

  store.clear();
  check(bridgeFromUrl(`?bridge=${url}`, "").token === "",
    "nothing kept and nothing in the link is no token, not a stale one");
}

{ // a stream the server ended is not the same thing as one that failed
  //
  // For a run, the end of the stream is the end of the run. For a bridge it is
  // the agent's process going away, and nobody but the caller knows which of
  // the two it asked for.
  const ended = [];
  const empty = () => Promise.resolve({
    ok: true,
    body: new ReadableStream({ start(controller) { controller.close(); } }),
  });
  const stream = new EventStream("http://x/events", {
    fetcher: empty,
    onEvent: () => {},
    onClose: () => ended.push("closed"),
  });
  await new Promise((done) => setTimeout(done, 50));
  check(ended.length === 1, "the server ending the stream is reported once");
  stream.close();

  const quiet = [];
  const second = new EventStream("http://x/events", {
    fetcher: empty,
    onEvent: () => {},
    onClose: () => quiet.push("closed"),
  });
  second.close();
  await new Promise((done) => setTimeout(done, 50));
  check(quiet.length === 0, "closing it ourselves is not the other end going away");
}

if (failed) {
  console.error(`bridge: ${failed} of ${checked} checks failed`);
  process.exit(1);
}
console.log(`bridge: ${checked} checks, the address is read, and the token lives in the tab rather than the address`);
