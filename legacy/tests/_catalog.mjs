/**
 * The English catalog, in place, for the tests.
 *
 * The interface's text comes from `i18n/*.json`, fetched by the page. A test
 * has no page and no server, so without this every assertion about a message
 * would be an assertion about a key — which is exactly the kind of test that
 * keeps passing while the interface says `caps.unknown` to a user.
 *
 * Importing this module is enough; it installs the catalog as a side effect,
 * and an ES import is hoisted above the test's own code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FALLBACK, install } from "../js/i18n.js";

const path = fileURLToPath(new URL(`../i18n/${FALLBACK}.json`, import.meta.url));
export const catalog = JSON.parse(readFileSync(path, "utf8"));

install(FALLBACK, catalog);
