/**
 * The editor's version.
 *
 * A copy of the one in package.json: there is no build step to inject it and
 * the browser cannot read package.json. `tests/capabilities.mjs` checks the
 * two match.
 */
export const VERSION = "0.6.8";
