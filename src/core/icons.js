/**
 * Stage icons as the backend gives them: a glyph, an image URL or inline SVG.
 *
 * An icon comes from a stage's docstring on the backend, so it is data from
 * somewhere else: a URL is shown as an image, inline SVG as a data URL, and
 * anything else, `javascript:` included, as text. Nothing is ever executed.
 */

const URL_PREFIXES = ["https://", "http://", "/", "./", "../"];
const DATA_SVG = "data:image/svg+xml";

/**
 * Parse an icon value into {type: "glyph"|"url", value}, or null. `base` is
 * the backend address that a root-relative path (`/static/x.svg`) refers to.
 */
export function resolveIcon(icon, base = "") {
  const raw = String(icon ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("<svg")) {
    return { type: "url", value: `${DATA_SVG};utf8,${encodeURIComponent(raw)}` };
  }
  if (raw.startsWith(DATA_SVG)) return { type: "url", value: raw };
  if (URL_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
    return { type: "url", value: base && raw.startsWith("/") ? `${base}${raw}` : raw };
  }
  return { type: "glyph", value: raw };
}
