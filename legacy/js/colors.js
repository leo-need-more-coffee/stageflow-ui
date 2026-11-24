/**
 * Colors derived from names: variables and stage categories.
 *
 * A hash of the name picks the hue, so a variable has the same color in every
 * graph and stages of one category share an accent. Lightness and saturation
 * are fixed to stay within the theme.
 */

function hue(text, salt = 0) {
  let hash = salt;
  for (const ch of `${text}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** The color of a variable, used for its path through the graph. */
export function varColor(name) {
  return `hsl(${hue(name)} 58% 62%)`;
}

/** The accent of a stage category (`builtin.lists`, `http`, `llm`, ...). */
export function categoryColor(category) {
  if (!category) return null;
  return `hsl(${hue(category, 11)} 52% 62%)`;
}
