/**
 * The version of the editor.
 *
 * Duplicated from package.json on purpose: the editor is plain ES modules
 * with no build step, so nothing rewrites a constant at build time and the
 * browser cannot read package.json. `tests/capabilities.mjs` fails if the two
 * ever disagree — the check costs nothing and a release with the wrong number
 * on the connection screen is confusing in exactly the situation the number
 * exists for.
 */
export const VERSION = "0.6.6";
