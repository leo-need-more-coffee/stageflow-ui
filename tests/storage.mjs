/**
 * Remembering the editor between reloads, without ever taking it down.
 *
 * `localStorage` throws in private windows, over quota and under some site
 * policies, and what is in it may be from another version or not JSON at all.
 * None of that is a reason for the editor not to open.
 *
 * Run: node tests/storage.mjs
 */
import { EditorStore, readJson, removeKey, writeJson } from "../src/core/storage.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

const store = new Map();
let broken = false;
let writes = 0;
globalThis.localStorage = {
  getItem(key) {
    if (broken) throw new Error("SecurityError");
    return store.has(key) ? store.get(key) : null;
  },
  setItem(key, value) {
    if (broken) throw new Error("QuotaExceededError");
    writes += 1;
    store.set(key, value);
  },
  removeItem(key) {
    if (broken) throw new Error("SecurityError");
    store.delete(key);
  },
};

const tick = (ms) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------- JSON in, JSON out

check(writeJson("k", { a: [1, 2] }) === true, "a write says it worked");
check(JSON.stringify(readJson("k")) === '{"a":[1,2]}', "and reads back");
check(readJson("missing") === null, "nothing stored is null");
check(readJson("") === null && writeJson("", 1) === false, "no key, no storage");

store.set("garbage", "{not json");
check(readJson("garbage") === null, "a corrupted record is a clean slate, not a crash");

removeKey("k");
check(readJson("k") === null, "removed");

broken = true;
check(readJson("anything") === null, "storage that throws on read reads as empty");
check(writeJson("k", 1) === false, "storage that throws on write reports it");
removeKey("k"); // must not throw
check(true, "removing from broken storage does not throw");
broken = false;

// ------------------------------------------------------- the editor's record

{
  const editor = new EditorStore("ed", { delay: 20 });
  check(editor.enabled, "a key turns it on");
  check(!new EditorStore(null).enabled && new EditorStore(null).load() === null,
    "without a key it is off and loads nothing");

  writes = 0;
  let n = 0;
  for (let i = 0; i < 5; i += 1) editor.save(() => ({ pipeline: { n: ++n } }));
  await tick(60);
  check(writes === 1, `five quick edits are one write, got ${writes}`);
  check(editor.load()?.pipeline.n === 1,
    "the state is read when the write happens, from the last save's getter");
  check(Number.isInteger(JSON.parse(store.get("ed")).version),
    "the record carries the version of its own shape");

  editor.save(() => ({ pipeline: { n: 99 } }));
  editor.flush(() => ({ pipeline: { n: 100 } }));
  await tick(60);
  check(editor.load().pipeline.n === 100, "flush writes now and cancels the pending one");

  const current = JSON.parse(store.get("ed")).version;
  store.set("ed", JSON.stringify({ version: current + 1, pipeline: { n: 1 } }));
  check(editor.load() === null, "a record from another version is ignored");
  store.set("ed", JSON.stringify({ version: current }));
  check(editor.load() === null, "a record without a pipeline is ignored");
  store.set("ed", JSON.stringify({ version: current, pipeline: { n: 2 } }));
  check(editor.load()?.pipeline.n === 2, "and one of this version with a pipeline is read");

  editor.save(() => ({ pipeline: { n: 7 } }));
  editor.clear();
  await tick(60);
  check(!store.has("ed"), "clear removes the record and the pending write with it");
}

if (failed) {
  console.error(`storage: ${failed} of ${checked} checks failed`);
  process.exit(1);
}
console.log(`storage: ${checked} checks, a broken storage never breaks the editor`);
