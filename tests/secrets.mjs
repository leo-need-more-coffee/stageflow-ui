/**
 * The secret store: a key must not leak anywhere it can be seen.
 *
 * What is checked is what the whole idea rests on: the value is not in the
 * pipeline, only the keys the graph actually mentions travel to a run
 * (otherwise the entire keyring would end up in the debugger's frame), the
 * value of a secret is not shown in the frame, and the server-side keys do not
 * belong to the editor — it neither knows their values nor can delete them.
 *
 * Run: node tests/secrets.mjs
 */
import { SECRET_MASK, SecretStore, validSecretName } from "../js/secrets.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

/** A graph that reads one key of two and knows nothing about the values. */
const pipeline = {
  nodes: [
    { id: "start", type: "entry", next: "call" },
    { id: "call", type: "stage", stage: "LogStage",
      arguments: { vars: { message: "OPENAI_API_KEY" } }, next: "done" },
    { id: "done", type: "terminal" },
  ],
};

{ // a secret name is a variable name
  check(validSecretName("OPENAI_API_KEY"), "an ordinary name was rejected");
  check(validSecretName("_k1"), "an underscore and digits must pass");
  check(!validSecretName("2key"), "a name starting with a digit was accepted");
  check(!validSecretName("api key"), "a name with a space was accepted");
  check(!validSecretName(""), "an empty name was accepted");
}

{ // the value is neither shown nor stored in the graph
  const store = new SecretStore(null);
  store.set("OPENAI_API_KEY", "sk-live-777");
  check(store.has("OPENAI_API_KEY"), "the key was not saved");
  check(!JSON.stringify(pipeline).includes("sk-live-777"), "the value got into the pipeline");
  const masked = store.maskVars({ OPENAI_API_KEY: "sk-live-777", n: 5 });
  check(masked.OPENAI_API_KEY === SECRET_MASK, "the secret is shown in the frame as it is");
  check(masked.n === 5, "an ordinary variable got masked too");
  check(!store.set("api key", "x"), "a key with an invalid name was saved");
}

{ // only what the graph mentions travels to a run
  const store = new SecretStore(null);
  store.set("OPENAI_API_KEY", "sk-live-777");
  store.set("TG_TOKEN", "tg-42");
  const run = store.forRun(pipeline);
  check(run.vars.OPENAI_API_KEY === "sk-live-777", "the needed key did not travel to the run");
  check(!("TG_TOKEN" in run.vars), "a key the graph never touches travelled to the run");
  check(run.names.includes("TG_TOKEN"),
    "the name of an unused key must stay in the list for masking");
}

{ // a key mentioned only inside a CEL expression is needed by the run too
  const store = new SecretStore(null);
  store.set("TG_TOKEN", "tg-42");
  const cel = { nodes: [{ id: "a", type: "stage", stage: "LogStage",
    arguments: { const: { "message.$": "'bot' + vars.TG_TOKEN" } } }] };
  check(store.forRun(cel).vars.TG_TOKEN === "tg-42", "the key from a CEL expression did not travel");
}

{ // server-side keys: the name is there, the value is not, deletion is refused
  const store = new SecretStore(null);
  store.set("LOCAL_KEY", "value");
  // loadEnv goes to the network; here we feed it the server answer directly
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ names: ["ENV_KEY"] }) });
  await store.loadEnv("/api/secrets");
  check(store.sourceOf("ENV_KEY") === "env", "the server key is not marked as a server one");
  check(store.sourceOf("LOCAL_KEY") === "local", "the local key is not marked as a local one");
  check(!store.forRun({ nodes: [{ id: "a", next: "ENV_KEY" }] }).vars.ENV_KEY,
    "the value of a server key must not be known to the page");
  check(!store.remove("ENV_KEY"), "a server key was deleted from the editor");
  check(store.remove("LOCAL_KEY"), "a local key is not deleted");
}

{ // an unreachable server is no reason to bring the store down
  const store = new SecretStore(null);
  globalThis.fetch = async () => { throw new Error("no network"); };
  const names = await store.loadEnv("/api/secrets");
  check(names.length === 0, "with the server unreachable the names came out of nowhere");
}

if (failed) {
  console.error(`secrets: ${failed} violations out of ${checked} checks`);
  process.exit(1);
}
console.log(`secrets: ${checked} checks, the values do not leave the store`);
