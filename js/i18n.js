/**
 * The interface's own text, in the reader's language.
 *
 * Deliberately small: a flat `{key: string}` catalog per locale, fetched as
 * JSON, and one function to read it. There is no build step, no extraction and
 * no library — a language is a file in `i18n/` plus a line in
 * `i18n/index.json`, and nothing in the code names a language except the
 * fallback, which is the language the keys were written in.
 *
 * Two catalogs are held at once, the chosen one and the fallback, so a
 * half-finished translation reads as English where it is unfinished rather than
 * as `toolbar.file`. A key missing from both is returned as itself and
 * complained about in the console — visible while developing, harmless to a
 * reader.
 *
 * Plurals come from `Intl.PluralRules`, which every browser has and which
 * knows that Russian has three forms and English two. A plural entry is an
 * object of the categories that language uses:
 *
 *     "palette.stages": {"one": "{n} stage", "other": "{n} stages"}
 */

/** The language the keys themselves are written in. */
export const FALLBACK = "en";

const STORAGE_KEY = "stageflow-editor:lang";

let chosen = FALLBACK;
let catalog = {};
let fallbackCatalog = {};
let names = { [FALLBACK]: "English" };
const complained = new Set();

/** The locale in force — a tag like `en` or `ru`. */
export function locale() {
  return chosen;
}

/** `{tag: name}` for every catalog on offer, each name in its own language. */
export function locales() {
  return { ...names };
}

/**
 * The tags this reader would prefer, best first.
 *
 * `?lang=` wins because it is a link somebody was handed; then what they chose
 * here last time; then what the browser says, which is the right default for a
 * first visit and the wrong one to keep overriding a choice with.
 */
export function preferred() {
  const query = new URLSearchParams(location.search).get("lang");
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch { /* a private window: no memory, not an error */ }
  return [query, saved, ...(navigator.languages ?? [navigator.language])]
    .filter(Boolean);
}

/** `ru-RU` and `ru_ru` are the same language; `ru-RU` also falls back to `ru`. */
function candidates(tag) {
  const parts = String(tag).replace(/_/g, "-").toLowerCase().split("-");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("-"));
}

/** The best catalog on offer for what the reader asked for. */
export function negotiate(wanted, offered) {
  const have = new Map(Object.keys(offered).map((tag) => [tag.toLowerCase(), tag]));
  for (const tag of [].concat(wanted).filter(Boolean)) {
    for (const candidate of candidates(tag)) {
      if (have.has(candidate)) return have.get(candidate);
    }
  }
  return FALLBACK;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Loads the catalogs and settles on a language. Call once, before anything is
 * drawn — every other function here is synchronous so that rendering code never
 * has to await a word.
 *
 * Nothing here is fatal. A missing manifest or catalog leaves the interface in
 * the language its keys are written in, which is worse than a translation and
 * far better than a blank screen.
 */
export async function loadLocale(wanted = preferred()) {
  try {
    names = await fetchJson("i18n/index.json");
  } catch (err) {
    console.warn("i18n: no catalog index, staying in", FALLBACK, err);
    names = { [FALLBACK]: "English" };
  }
  chosen = negotiate(wanted, names);

  const load = async (tag) => {
    try {
      return await fetchJson(`i18n/${tag}.json`);
    } catch (err) {
      console.warn(`i18n: cannot load ${tag}`, err);
      return {};
    }
  };
  fallbackCatalog = await load(FALLBACK);
  catalog = chosen === FALLBACK ? fallbackCatalog : await load(chosen);
  document.documentElement.lang = chosen;
  return chosen;
}

/**
 * Puts a catalog in place without fetching anything.
 *
 * `loadLocale` is the normal path — it reads the files. This is for the two
 * cases that have no server to read them from: a page that bundles its
 * catalogs (see `docs/embedding.md`), and the tests, which assert on the text
 * the interface actually produces and would otherwise be asserting on keys.
 *
 * The fallback catalog is set alongside, because a half-finished translation
 * has to read as the source language rather than as key names.
 */
export function install(tag, entries, fallbackEntries = null) {
  chosen = tag;
  catalog = entries ?? {};
  fallbackCatalog = fallbackEntries ?? (tag === FALLBACK ? catalog : {});
  names = { ...names, [tag]: names[tag] ?? tag };
  complained.clear();
  if (typeof document !== "undefined") document.documentElement.lang = tag;
  return chosen;
}

/** Remembers a choice and reloads: the whole interface is already drawn. */
export function setLocale(tag) {
  try {
    localStorage.setItem(STORAGE_KEY, tag);
  } catch { /* nothing to remember it in; the reload still applies it once */ }
  const url = new URL(location.href);
  url.searchParams.delete("lang"); // a saved choice, not a link's
  location.replace(url.toString());
}

function entry(key) {
  const found = catalog[key];
  if (found !== undefined) return found;
  const back = fallbackCatalog[key];
  if (back !== undefined) return back;
  if (!complained.has(key)) {
    complained.add(key);
    console.warn("i18n: no string for", key);
  }
  return null;
}

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : whole
  ));
}

/**
 * The string for a key, with `{placeholders}` filled in.
 *
 * A key that is nowhere is returned as itself: the interface stays usable and
 * the gap is obvious, which is the right way round for a missing translation.
 */
export function t(key, params = null) {
  const found = entry(key);
  if (found === null) return key;
  if (typeof found === "object") return fill(found.other ?? found.one ?? key, params);
  return fill(found, params);
}

/**
 * Whether there is a string for a key at all.
 *
 * For text that is optional by design rather than missing by accident: several
 * of the run-pace presets carry an explanatory hint and the self-evident ones
 * ("1 s") do not. Without this the caller would have to compare `t(key)` to the
 * key itself to find that out, which reads like a bug even when it is not.
 */
export function has(key) {
  return catalog[key] !== undefined || fallbackCatalog[key] !== undefined;
}

/**
 * One piece of somebody else's prose, in the reader's language.
 *
 * Not for the interface's own text — that is `t`, and its catalogs are here on
 * disk. This is for prose the editor is handed rather than owns: a stage's
 * description and the descriptions of its arguments and outputs come from the
 * backend, whose stages the editor knows nothing about and cannot translate.
 *
 * So the backend sends every language it has — `{"en": "…", "ru": "…"}` — and
 * the choosing happens here, where the reader is. That is the only place it can
 * happen: the language is picked in the editor, possibly long after the specs
 * were fetched, and asking the backend again on every change of mind would make
 * a language a network round trip.
 *
 * A bare string is prose in one language, which is the honest shape for a stage
 * nobody has translated — it comes back as it came in.
 */
export function prose(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  const tag = negotiate([chosen, FALLBACK], value);
  return value[tag] ?? value[FALLBACK] ?? Object.values(value)[0] ?? "";
}

/**
 * A sentence that has elements inside it, cut into the pieces it is built from.
 *
 * Splitting such a sentence into "before" and "after" strings is the mistake
 * this avoids: those two halves cannot be reordered, and a language that puts
 * the link first has nowhere to put it. So the whole sentence stays one entry
 * with `{slot}` in it, and this returns the pieces in the order that entry put
 * them — strings, and `{slot: "name"}` where an element goes.
 *
 *     pieces("connect.none", ["command", "repo"])
 *     // ["No backend at hand? ", {slot: "command"}, " from ", {slot: "repo"}, …]
 */
export function pieces(key, slots = [], params = null) {
  const text = t(key, params);
  if (!slots.length) return [text];
  const pattern = new RegExp(`\\{(${slots.join("|")})\\}`, "g");
  const out = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) out.push(text.slice(at, match.index));
    out.push({ slot: match[1] });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * The plural form for `n`. The categories are whatever the reader's language
 * uses, and `Intl` is what knows which those are.
 */
export function tn(key, n, params = null) {
  const found = entry(key);
  const all = { n, ...(params ?? {}) };
  if (found === null) return key;
  if (typeof found !== "object") return fill(found, all);
  const category = new Intl.PluralRules(chosen).select(n);
  return fill(found[category] ?? found.other ?? found.one ?? key, all);
}
