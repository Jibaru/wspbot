/**
 * Vendor the official wapi TypeScript SDK into `lib/wapi-sdk/`.
 *
 * The SDK is not published to npm — the documented way to take it is `giget` from the source
 * repository, which is why this is a script rather than a dependency.
 *
 * The second step is not optional. The SDK is written for Node's ESM rules, where a relative
 * import of a TypeScript file is spelled `./http.js`. TypeScript resolves that back to `.ts`
 * under `moduleResolution: "bundler"`, but **Turbopack does not**, so `next build` fails with
 * "Can't resolve './wapi-sdk/index.js'" while `tsc --noEmit` passes. Stripping the suffix from
 * relative specifiers is the whole adaptation; nothing else in the vendored code is touched, so
 * a refresh stays a mechanical two-step rather than a merge.
 *
 *   npm run vendor-wapi-sdk
 *
 * Afterwards, record the upstream commit in AGENTS.md so the copy's age is knowable.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TARGET = "lib/wapi-sdk";
const SOURCE = "gh:crafter-station/wapi/sdk/typescript/src";

console.log(`fetching ${SOURCE} -> ${TARGET}`);
execFileSync("npx", ["--yes", "giget@latest", SOURCE, TARGET, "--force"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

/** Every `.ts` under the vendored tree, recursively. */
const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });

let rewritten = 0;
for (const file of walk(TARGET)) {
  const before = readFileSync(file, "utf8");
  // Relative specifiers only: `./x.js` and `../x.js`. Bare package names are left alone.
  const after = before.replace(/(from\s+"\.\.?\/[^"]+)\.js"/g, '$1"');
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}

console.log(`rewrote relative imports in ${rewritten} file(s)`);

const remaining = walk(TARGET).filter((f) =>
  /from\s+"\.\.?\/[^"]+\.js"/.test(readFileSync(f, "utf8")),
);
if (remaining.length) {
  console.error(`FAIL still carrying .js specifiers: ${remaining.join(", ")}`);
  process.exit(1);
}
console.log("vendored clean");
