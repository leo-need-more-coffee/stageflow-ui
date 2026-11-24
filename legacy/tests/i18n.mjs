/**
 * The catalogs against the code that reads them.
 *
 * A missing key is not a crash — `t` returns the key itself, on purpose, so an
 * unfinished translation stays usable. The cost of that mercy is that a gap is
 * invisible until somebody opens the right menu and reads `delay.one.hint` off
 * the screen. So the gap is looked for here instead: every key the code asks
 * for by name must exist, every family of computed keys must be complete, and a
 * translation must not invent keys the source language does not have.
 *
 * The computed families are listed by hand, with the values they are built
 * from. That is the point: the list is a second opinion about what the code
 * does, and a family that grows a member without this test growing one is
 * exactly the case that got `status.paused` shipped missing.
 *
 * Run: node tests/i18n.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FALLBACK, has, install } from "../js/i18n.js";

let failed = 0;
let checked = 0;

function check(ok, message) {
  checked += 1;
  if (ok) return;
  failed += 1;
  console.error(`  ✗ ${message}`);
}

const dir = (path) => fileURLToPath(new URL(path, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(dir(path), "utf8"));

const index = readJson("../i18n/index.json");
const catalogs = Object.fromEntries(
  Object.keys(index).map((tag) => [tag, readJson(`../i18n/${tag}.json`)]),
);
const source = catalogs[FALLBACK];

{ // the manifest and the files agree, and the source language is among them
  check(FALLBACK in index, `${FALLBACK} is not in i18n/index.json`);
  const files = readdirSync(dir("../i18n")).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const tag = file.replace(/\.json$/, "");
    if (tag === "index") continue;
    check(tag in index, `i18n/${file} exists but no line in index.json names it`);
  }
  for (const tag of Object.keys(index)) {
    check(files.includes(`${tag}.json`), `index.json offers ${tag} but i18n/${tag}.json is missing`);
    check(typeof index[tag] === "string" && index[tag].length > 0,
      `${tag} has no name to show in the language menu`);
  }
}

{ // the keys the code names outright
  install(FALLBACK, source);
  const used = new Map();       // key -> the file that asks for it
  const computed = new Set();   // template-literal keys, checked by family below
  for (const file of readdirSync(dir("../js")).filter((f) => f.endsWith(".js"))) {
    if (file === "i18n.js") continue;
    const src = readFileSync(dir(`../js/${file}`), "utf8");
    for (const m of src.matchAll(/\b(?:t|tn|has|pieces)\(\s*"([^"]+)"/g)) {
      if (!used.has(m[1])) used.set(m[1], file);
    }
    for (const m of src.matchAll(/\b(?:t|tn|has|pieces)\(\s*`([^`]+)`/g)) {
      computed.add(`${file}: ${m[1]}`);
    }
  }
  check(used.size > 200, `only ${used.size} keys found in js/ — has the scan stopped working?`);
  for (const [key, file] of used) {
    check(has(key), `${file} asks for ${key}, which is in no catalog`);
  }

  // every computed key family, with the values it is built from. A family here
  // that the code no longer builds is harmless; one the code builds and this
  // list does not is the gap this file exists to find.
  const families = [
    ["delay.{}", ["none", "quarter", "half", "one", "two"]],
    ["view.wires.{}", ["off", "focus", "all"]],
    ["view.wires.{}.hint", ["off", "focus", "all"]],
    ["status.{}", ["running", "paused", "finished", "stopped", "failed"]],
    ["settings.{}", ["types", "variables", "metadata"]],
    ["spec.{}", ["arguments", "outputs"]],
    ["bar.{}", ["file", "edit", "view", "run"]],
  ];
  for (const [shape, values] of families) {
    for (const value of values) {
      const key = shape.replace("{}", value);
      check(has(key), `${key} is built by the code and is in no catalog`);
    }
  }

  // the families whose members do NOT all carry a hint: the code must ask
  // `has` before reading one, or a reader sees the key. Guarded by grep rather
  // than by a run, because the alternative is opening the menu.
  const optional = [
    ["js/toolbar.js", "delay.${key}.hint"],
    ["js/rundialog.js", "delay.${key}.hint"],
    // a category the host invented, and the tip after the last one
    ["js/palette.js", "category.${category}"],
    ["js/inspector.js", "panel.tip.${n}"],
  ];
  for (const [file, key] of optional) {
    const src = readFileSync(dir(`../${file}`), "utf8");
    const guarded = src.includes(`has(\`${key}\`)`);
    check(guarded, `${file} reads ${key} without asking has() first — a reader would see the key`);
  }

  check(computed.size > 0, "no computed keys found at all — has the scan stopped working?");
}

{ // the catalogs reach the browser at all
  // The page fetches `i18n/<tag>.json` at runtime, and a fetch that 404s is not
  // a crash: `t` returns the key, on purpose. That mercy hid a deploy which
  // copied `index.html css js` and nothing else — the hosted editor came up
  // with a toolbar reading "bar.file bar.edit" and every label a key. Nothing
  // in the test suite could see it, because the files were all correct; only
  // the list of what gets published was wrong.
  const pages = readFileSync(dir("../.github/workflows/pages.yml"), "utf8");
  const copy = pages.match(/cp -r ([^\n]*) _site\//)?.[1] ?? "";
  for (const needed of ["index.html", "css", "js", "i18n"]) {
    check(copy.split(/\s+/).includes(needed),
      `the pages workflow does not publish ${needed}: "cp -r ${copy} _site/"`);
  }
  check(/^\s+- "i18n\/\*\*"$/m.test(pages),
    "a change to the catalogs alone does not trigger the pages deploy");
}

{ // a translation answers the source language and does not invent keys
  const plural = (value) => value !== null && typeof value === "object";
  for (const [tag, entries] of Object.entries(catalogs)) {
    if (tag === FALLBACK) continue;
    const extra = Object.keys(entries).filter((key) => !(key in source));
    check(extra.length === 0,
      `${tag}.json has keys the source language does not: ${extra.slice(0, 5).join(", ")}`);

    const missing = Object.keys(source).filter((key) => !(key in entries));
    check(missing.length === 0,
      `${tag}.json is missing ${missing.length} keys, e.g. ${missing.slice(0, 5).join(", ")}`);

    // a plural entry stays a plural entry: translated to a bare string, a count
    // would be glued to one form of the noun in every language
    for (const [key, value] of Object.entries(entries)) {
      if (plural(source[key])) {
        check(plural(value), `${tag}.json translated the plural ${key} as a single string`);
        if (plural(value)) {
          check("other" in value || "one" in value,
            `${tag}.json's ${key} has no 'other' or 'one' form to fall back to`);
        }
      } else if (key in source) {
        check(!plural(value), `${tag}.json made ${key} a plural entry, which the source is not`);
      }
    }

    // the placeholders are part of the string: a dropped {name} is a sentence
    // with a hole in it, an invented one is drawn literally
    for (const [key, value] of Object.entries(entries)) {
      const slots = (text) => new Set(
        [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
      );
      const forms = (v) => (plural(v) ? Object.values(v) : [v]);
      const want = new Set(forms(source[key]).flatMap((f) => [...slots(f)]));
      // `n` is supplied by `tn` itself, and a language may need it in a form
      // the source does not
      want.delete("n");
      for (const form of forms(value)) {
        const got = slots(form);
        got.delete("n");
        for (const name of want) {
          check(got.has(name), `${tag}.json's ${key} lost the {${name}} placeholder`);
        }
        for (const name of got) {
          check(want.has(name), `${tag}.json's ${key} invented a {${name}} placeholder`);
        }
      }
    }
  }
}

{ // somebody else's prose: the backend sends every language, the editor picks
  const { prose } = await import("../js/i18n.js");
  const { StagesLibrary } = await import("../js/stages.js");

  install("ru", catalogs.ru ?? source, source);
  check(prose({ en: "Takes a ticket", ru: "Берёт тикет" }) === "Берёт тикет",
    "the reader's language was not picked out of the mapping");
  check(prose({ en: "Takes a ticket" }) === "Takes a ticket",
    "with no Russian in it the fallback language must answer");
  check(prose({ de: "Nimmt ein Ticket" }) === "Nimmt ein Ticket",
    "with neither the choice nor the fallback, the one language there must answer");
  check(prose({ "ru-RU": "Берёт тикет" }) === "Берёт тикет",
    "a regional tag must satisfy a request for the language");
  check(prose("Written once") === "Written once",
    "a bare string is prose in one language and must pass through");
  check(prose("") === "" && prose(null) === "" && prose(undefined) === "",
    "nothing must come out as an empty string, not as 'null' on a card");

  // the whole point of resolving at the boundary: the ten places that draw a
  // description go on reading a string
  const library = new StagesLibrary();
  library.setSpecs({
    stages: {
      ConcatStage: {
        category: "builtin.strings",
        description: { en: "Concatenate parts", ru: "Склеивает части" },
        arguments: [{ name: "parts", description: { en: "Values", ru: "Значения" } }],
        outputs: [{ name: "text", description: "Untranslated" }],
        allowed_events: [{ type: "log", description: { en: "A line", ru: "Строка" } }],
      },
    },
  });
  const spec = library.get("ConcatStage");
  check(spec.description === "Склеивает части", "the stage's own prose was not resolved");
  check(spec.arguments[0].description === "Значения", "an argument's prose was not resolved");
  check(spec.outputs[0].description === "Untranslated",
    "an untranslated description must survive as written");
  check(spec.allowed_events[0].description === "Строка", "an event's prose was not resolved");
  check(spec.category === "builtin.strings", "an identifier must not be touched");
  check(spec.arguments[0].name === "parts", "a field name must not be touched");

  install(FALLBACK, source);
  const english = new StagesLibrary();
  english.setSpecs({ stages: { A: { description: { en: "One", ru: "Один" } } } });
  check(english.get("A").description === "One",
    "in the source language the spec must read in the source language");
}

{ // the language reaches the backend, for the backend's OWN messages
  const { Backend, acceptLanguage } = await import("../js/backend.js");
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push(init.headers ?? {});
    return { ok: true, status: 200, json: async () => ({ stages: {} }) };
  };
  try {
    install(FALLBACK, source);
    check(acceptLanguage() === FALLBACK,
      `in the source language the header is just the tag, got ${acceptLanguage()}`);

    install("ru", catalogs.ru ?? source, source);
    check(acceptLanguage() === `ru, ${FALLBACK};q=0.8`,
      `the fallback must travel behind the choice, got ${acceptLanguage()}`);

    const backend = new Backend("localhost:8765", {
      auth: { header: "Authorization", value: "Bearer tok" },
    });
    await backend.fetch(backend.stagesUrl);
    const sent = calls.at(-1);
    check(sent["Accept-Language"] === `ru, ${FALLBACK};q=0.8`,
      "Backend.fetch did not tell the backend which language to answer in");
    check(sent.Authorization === "Bearer tok",
      "the credential stopped travelling once the language joined it");

    await backend.fetch(backend.stagesUrl, { headers: { "Accept-Language": "de" } });
    check(calls.at(-1)["Accept-Language"] === "de",
      "an explicit Accept-Language must win over the editor's own");
  } finally {
    globalThis.fetch = realFetch;
    install(FALLBACK, source);
  }
}

{ // the fallback is what keeps an unfinished translation readable
  install("zz", { "bar.file": "Файл" }, source);
  check(has("bar.file"), "a key in the chosen catalog was not found");
  check(has("bar.edit"), "a key only in the fallback was not found");
  check(!has("nothing.at.all"), "a key in neither catalog was reported as present");
  install(FALLBACK, source);
}

if (failed) {
  console.error(`i18n: ${failed} violations out of ${checked} checks`);
  process.exit(1);
}
console.log(`i18n: ${checked} checks, the catalogs answer every key the code asks for`);
