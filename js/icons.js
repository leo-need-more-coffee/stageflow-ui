/**
 * Node icons: a glyph, a link to an SVG file, or inline SVG markup.
 *
 * The shapes the `icon` value of a stage docstring can take:
 *   "＋"                                  — a glyph (a character or an emoji);
 *   "/icons/globe.svg", "https://…/x.svg" — a link to a file;
 *   "data:image/svg+xml;…"                — a data URI;
 *   "<svg …>…</svg>"                      — markup right in the docstring.
 *
 * SECURITY: foreign SVG never reaches the DOM as markup — only as an
 * `<img src>` or a CSS mask. In both cases the browser does not execute
 * scripts inside the SVG, so an icon from an arbitrary stage registry cannot
 * become XSS. Inline markup is wrapped into a data URI for that, and schemes
 * such as `javascript:` are cut off by an allowlist.
 *
 * The `icon_mono` flag in a stage spec draws the icon as a mask in the node
 * color — that is how monochrome sets (lucide, feather, tabler) fit the theme;
 * without it the picture is shown as it is, keeping its own colors (logos).
 *
 * An absolute path (`/icons/globe.svg`) is resolved against the BACKEND rather
 * than against the page: it is the backend that declared the icon and the
 * backend that serves it, while the editor is static files on another origin.
 */

const URL_PREFIXES = ["https://", "http://", "/", "./", "../"];
const DATA_SVG = "data:image/svg+xml";

/** Parses an icon value: {type: "glyph"|"url", value} or null. `base` is the
 * backend address an absolute path belongs to. */
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
  // everything else (including javascript:, which does not get here as a URL)
  // is shown as text — it cannot possibly be executed
  return { type: "glyph", value: raw };
}

/**
 * Fills the icon container. `fallback` is shown when there is no icon or the
 * picture did not load (a broken link, being offline, a blocker).
 */
export function paintIcon(host, icon, { mono = false, fallback = "", base = "" } = {}) {
  host.textContent = "";
  host.classList.remove("sf-icon-mask");
  host.style.removeProperty("--icon-url");

  const resolved = resolveIcon(icon, base);
  if (!resolved) {
    host.textContent = fallback;
    return host;
  }
  if (resolved.type === "glyph") {
    host.textContent = resolved.value;
    return host;
  }
  if (mono) {
    // a mask: the shape comes from the SVG, the color from the node (--kind-color)
    const escaped = resolved.value.replace(/["\\]/g, (ch) => `\\${ch}`);
    host.style.setProperty("--icon-url", `url("${escaped}")`);
    host.classList.add("sf-icon-mask");
    return host;
  }
  const img = document.createElement("img");
  img.src = resolved.value;
  img.alt = "";
  img.loading = "lazy";
  img.onerror = () => { img.remove(); host.textContent = fallback; };
  host.append(img);
  return host;
}
