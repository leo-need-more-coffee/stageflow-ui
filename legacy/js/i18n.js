/**
 * The interface's own text, in the reader's language.
 *
 * A flat `{key: string}` catalog per locale, fetched as JSON; no build step or
 * library. A language is a file in `i18n/` plus a line in `i18n/index.json`.
 *
 * The chosen catalog and the fallback (the language the keys are written in)
 * are both loaded, so an unfinished translation falls back to English rather
 * than showing keys. A key missing from both is returned as is and logged.
 *
 * Plurals use `Intl.PluralRules`; a plural entry is an object of the
 * language's categories:
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

/** The current locale, a tag such as `en` or `ru`. */
export function locale() {
  return chosen;
}

/** `{tag: name}` for every available catalog, each name in its own language. */
export function locales() {
  return { ...names };
}

/**
 * The reader's preferred tags, best first: `?lang=` in the link, then the
 * last choice made here, then the browser's languages.
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

/** `ru-RU` and `ru_ru` are the same; `ru-RU` also falls back to `ru`. */
function candidates(tag) {
  const parts = String(tag).replace(/_/g, "-").toLowerCase().split("-");
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("-"));
}

/** The best available catalog for what the reader wants. */
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
 * Load the catalogs and pick a language. Call once before drawing; everything
 * else here is synchronous. Nothing is fatal: a missing file leaves the keys'
 * own language.
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
 * Install a catalog without fetching, for pages that bundle their catalogs
 * (see `docs/embedding.md`) and for tests. The fallback is installed too.
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

/** Remember a choice and reload, since the interface is already drawn. */
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
 * The string for a key with `{placeholders}` filled in. A missing key is
 * returned as is, so the gap is visible but the interface keeps working.
 */
export function t(key, params = null) {
  const found = entry(key);
  if (found === null) return key;
  if (typeof found === "object") return fill(found.other ?? found.one ?? key, params);
  return fill(found, params);
}

/**
 * Whether a key has a string, for optional text (e.g. some pace presets have
 * a hint and others do not).
 */
export function has(key) {
  return catalog[key] !== undefined || fallbackCatalog[key] !== undefined;
}

/**
 * Prose the editor is given rather than owns, in the reader's language: stage
 * descriptions and those of their arguments and outputs, which only the
 * backend can translate. The backend sends `{"en": "…", "ru": "…"}` and the
 * choice is made here, where the language is known. A plain string is
 * returned as is.
 */
export function prose(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  const tag = negotiate([chosen, FALLBACK], value);
  return value[tag] ?? value[FALLBACK] ?? Object.values(value)[0] ?? "";
}

/**
 * A sentence with elements inside it, split into its parts. The sentence stays
 * one entry with `{slot}` markers, so a translation can reorder them; the
 * result is strings and `{slot: "name"}` objects in that order.
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

/** The plural form for `n`, by the categories of the reader's language. */
export function tn(key, n, params = null) {
  const found = entry(key);
  const all = { n, ...(params ?? {}) };
  if (found === null) return key;
  if (typeof found !== "object") return fill(found, all);
  const category = new Intl.PluralRules(chosen).select(n);
  return fill(found[category] ?? found.other ?? found.one ?? key, all);
}
