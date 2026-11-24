/**
 * Finding a stage among many by what was typed.
 *
 * Every word typed has to be found somewhere — the name, a part of it
 * (`customer` in LoadCustomerStage), its initials (`lcs`), an argument, the
 * category or the description — or the stage is not shown. Where it was
 * found decides the rank: a hit in the name counts for more than one in the
 * description, so typing the start of a name puts that stage first.
 */

/** `LoadCustomerStage` -> ["load", "customer"]; `http_get` -> ["http", "get"]. */
export function splitName(name) {
  return String(name)
    .replace(/Stage$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.\-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** The words of a query, lower case. */
export function tokensOf(query) {
  return String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * How well a stage matches; 0 when one of the words is nowhere.
 *
 * @param entry {name, description, category, categoryLabel, args}
 */
export function score(entry, tokens) {
  const name = String(entry.name ?? "").toLowerCase();
  const words = entry.words ?? splitName(entry.name ?? "");
  const initials = entry.initials ?? words.map((w) => w[0]).join("");
  const args = (entry.args ?? []).map((a) => String(a).toLowerCase());
  const description = String(entry.description ?? "").toLowerCase();
  const category = `${entry.category ?? ""} ${entry.categoryLabel ?? ""}`.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    if (name === token || words.join("") === token) best = 120;
    else if (name.startsWith(token)) best = 100;
    else if (words.some((w) => w.startsWith(token))) best = 80;
    else if (token.length > 1 && initials.startsWith(token)) best = 70;
    else if (name.includes(token)) best = 50;
    // one or two letters are found inside almost any description; they only
    // count in the name
    else if (token.length < 3) best = 0;
    else if (args.some((a) => a.startsWith(token))) best = 30;
    else if (category.includes(token)) best = 25;
    else if (description.includes(token)) best = 15;
    if (!best) return 0;
    total += best;
  }
  return total;
}

/** The entries that match, best first; ties by name. */
export function rank(entries, query, bonus = () => 0) {
  const tokens = tokensOf(query);
  if (!tokens.length) return entries;
  return entries
    .map((entry) => ({ entry, s: score(entry, tokens) }))
    .filter((x) => x.s > 0)
    .map((x) => ({ ...x, s: x.s + bonus(x.entry) }))
    .sort((a, b) => b.s - a.s || String(a.entry.name).localeCompare(String(b.entry.name)))
    .map((x) => x.entry);
}
