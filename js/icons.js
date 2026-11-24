/**
 * Node icons: a glyph, a link to an SVG file, or inline SVG markup.
 *
 * The `icon` of a stage spec can be:
 *   "＋"                                  a glyph (a character or an emoji)
 *   "/icons/globe.svg", "https://…/x.svg" a link to a file
 *   "data:image/svg+xml;…"                a data URI
 *   "<svg …>…</svg>"                      markup in the docstring
 *
 * Security: SVG from a stage registry is never inserted as markup, only as an
 * `<img src>` or a CSS mask, where the browser does not run scripts. Inline
 * markup is turned into a data URI, and schemes such as `javascript:` are
 * refused by an allowlist.
 *
 * `icon_mono` draws the icon as a mask in the node color (for monochrome sets
 * such as lucide); without it the picture keeps its own colors.
 *
 * An absolute path (`/icons/globe.svg`) is resolved against the backend, which
 * serves the icon, not against the page.
 */

const URL_PREFIXES = ["https://", "http://", "/", "./", "../"];
const DATA_SVG = "data:image/svg+xml";

/** Parse an icon value into {type: "glyph"|"url", value}, or null. `base` is
 * the backend address an absolute path is resolved against. */
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
  // anything else (`javascript:` included) is shown as text, never executed
  return { type: "glyph", value: raw };
}

/**
 * Fill the icon container. `fallback` is shown when there is no icon or the
 * picture fails to load.
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
    // a mask: the shape comes from the SVG, the color from the node
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
