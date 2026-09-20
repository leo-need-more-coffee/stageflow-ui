/**
 * Colors derived from data: variables and stage categories.
 *
 * Both are deterministic (a hash of the name -> a hue), so one and the same
 * variable is always the same color in every graph, and stages of one category
 * are recognised by a shared accent. Lightness and saturation are fixed — that
 * keeps the palette inside the theme whatever names turn up.
 */

function hue(text, salt = 0) {
  let hash = salt;
  for (const ch of `${text}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** The color of a variable — it shows the path of that variable through the graph. */
export function varColor(name) {
  return `hsl(${hue(name)} 58% 62%)`;
}

/** Accent of a stage category: `builtin.lists`, `http`, `llm` and the like. */
export function categoryColor(category) {
  if (!category) return null;
  return `hsl(${hue(category, 11)} 52% 62%)`;
}
