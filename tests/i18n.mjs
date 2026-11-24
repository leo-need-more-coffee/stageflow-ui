/**
 * Every string the interface asks for exists in every catalog.
 *
 * A missing key does not break anything visibly in a test: `t()` returns the
 * key itself, and the interface says `app.run.steps` to a user. So the
 * sources are scanned for literal keys and each is looked up in each catalog.
 *
 * Run: node tests/i18n.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalogs = Object.fromEntries(Object.keys(JSON.parse(readFileSync(join(root, "public/i18n/index.json"), "utf8")))
  .map((tag) => [tag, JSON.parse(readFileSync(join(root, `public/i18n/${tag}.json`), "utf8"))]));

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) yield path;
  }
}

const used = new Map();
for (const path of files(join(root, "src"))) {
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(/\btn?\(\s*"([a-zA-Z][\w.]*)"/g)) {
    if (!used.has(match[1])) used.set(match[1], path.slice(root.length));
  }
}

let failed = 0;
if (used.size < 200) {
  console.error(`only ${used.size} keys found in src/ — has the scan stopped working?`);
  failed++;
}
for (const [tag, catalog] of Object.entries(catalogs)) {
  for (const [key, where] of used) {
    if (catalog[key] === undefined) {
      failed++;
      console.error(`✗ ${tag}: no "${key}" (${where})`);
    }
  }
}
if (failed) {
  console.error(`i18n: ${failed} missing`);
  process.exit(1);
}
console.log(`i18n: ${used.size} keys, all in ${Object.keys(catalogs).join(", ")}`);
