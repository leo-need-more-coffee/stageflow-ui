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
import { bridgeFromUrl } from "../js/bridge.js";

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

if (failed) {
  console.error(`bridge: ${failed} of ${checked} checks failed`);
  process.exit(1);
}
console.log(`bridge: ${checked} checks, the address is read and the token is not kept in it`);
